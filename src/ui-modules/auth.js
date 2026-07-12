import { atomicWriteFile } from '../utils/file-lock.js';
import { existsSync } from 'fs';
import logger from '../utils/logger.js';
import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { CONFIG } from '../core/config-manager.js';
import { getClientIp } from '../utils/common.js';
import { PASSWORD } from '../utils/constants.js';

// Token存储到本地文件中
const TOKEN_STORE_FILE = path.join(process.cwd(), 'configs', 'token-store.json');

/**
 * 默认密码（当 pwd 文件不存在时使用，仅首次启动时写入 PBKDF2 哈希）
 */
const DEFAULT_PASSWORD = 'admin123';

/**
 * 生成 PBKDF2 格式的密码哈希
 * @param {string} password - 明文密码
 * @returns {Promise<string>} pbkdf2:salt:hash 格式
 */
async function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = await new Promise((resolve, reject) =>
        crypto.pbkdf2(password, salt, PASSWORD.PBKDF2_ITERATIONS, PASSWORD.PBKDF2_KEYLEN, PASSWORD.PBKDF2_DIGEST,
            (err, key) => err ? reject(err) : resolve(key.toString('hex'))
        )
    );
    return `pbkdf2:${salt}:${hash}`;
}

/**
 * 读取密码文件内容，始终返回 PBKDF2 格式。
 * - 文件不存在/为空 → 自动创建，写入默认密码的 PBKDF2 哈希
 * - 文件内容是明文 → 自动升级为 PBKDF2 哈希（保证磁盘上永远是哈希，可以安全提交到 git）
 * - 已经是 PBKDF2 格式 → 直接返回
 */
export async function readPasswordFile() {
    const pwdFilePath = path.join(process.cwd(), 'configs', 'pwd');
    try {
        const password = await fs.readFile(pwdFilePath, 'utf8');
        const trimmedPassword = password.trim();

        if (!trimmedPassword) {
            // 空文件 → 写入默认密码的 PBKDF2 哈希
            logger.info('[Auth] Password file is empty, initializing with default password (PBKDF2)...');
            const hashed = await hashPassword(DEFAULT_PASSWORD);
            await atomicWriteFile(pwdFilePath, hashed, { encoding: 'utf-8', mode: 0o600 });
            return hashed;
        }

        if (!trimmedPassword.startsWith('pbkdf2:')) {
            // 旧格式明文 → 自动升级为 PBKDF2 哈希（安全提交 git）
            logger.warn('[Auth] Migrating plaintext password to PBKDF2 hash format...');
            const hashed = await hashPassword(trimmedPassword);
            await atomicWriteFile(pwdFilePath, hashed, { encoding: 'utf-8', mode: 0o600 });
            logger.info('[Auth] Password migrated to PBKDF2 format — safe for git.');
            return hashed;
        }

        return trimmedPassword;
    } catch (error) {
        if (error.code === 'ENOENT') {
            // 文件不存在 → 创建并写入默认密码的 PBKDF2 哈希
            logger.info('[Auth] Password file does not exist, creating with default password (PBKDF2)...');
            try {
                const hashed = await hashPassword(DEFAULT_PASSWORD);
                await atomicWriteFile(pwdFilePath, hashed, { encoding: 'utf-8', mode: 0o600 });
                logger.info('[Auth] Created pwd file with PBKDF2 hash — safe for git.');
                return hashed;
            } catch (writeError) {
                logger.error('[Auth] Failed to create pwd file:', writeError.message);
                return null;
            }
        }
        logger.error('[Auth] Failed to read password file:', error.code || error.message);
        return null;
    }
}

/**
 * 验证登录凭据
 */
export async function validateCredentials(password) {
    const storedPassword = await readPasswordFile();
    if (!storedPassword || !password) return false;

    // 新格式：pbkdf2:salt:hash
    if (storedPassword.startsWith('pbkdf2:')) {
        const parts = storedPassword.split(':');
        if (parts.length !== 3) return false;
        const [, salt, storedHash] = parts;
        const inputHash = await new Promise((resolve, reject) =>
            crypto.pbkdf2(password.trim(), salt, PASSWORD.PBKDF2_ITERATIONS, PASSWORD.PBKDF2_KEYLEN, PASSWORD.PBKDF2_DIGEST, (err, key) =>
                err ? reject(err) : resolve(key.toString('hex'))
            )
        );
        return crypto.timingSafeEqual(Buffer.from(inputHash, 'hex'), Buffer.from(storedHash, 'hex'));
    }

    // 明文密码不安全，拒绝验证。请通过 UI (Settings → Admin Password) 重设密码升级为 PBKDF2 哈希格式。
    logger.warn('[Auth] Rejected: password stored in plaintext (insecure for git). Update via UI to PBKDF2 hash format.');
    return false;
}

/**
 * 解析请求体JSON，带大小限制防止 DoS
 * @param {http.IncomingMessage} req
 * @param {number} maxBytes 最大允许字节数，默认 10KB（登录接口够用）
 */
function parseRequestBody(req, maxBytes = 10 * 1024) {
    return new Promise((resolve, reject) => {
        // 1. 先检查 Content-Length header，快速拒绝超大请求（零读取开销）
        const contentLength = parseInt(req.headers['content-length'] || '0', 10);
        if (!isNaN(contentLength) && contentLength > maxBytes) {
            req.resume(); // drain & discard，避免连接挂起
            return reject(Object.assign(new Error('Request body too large'), { code: 'BODY_TOO_LARGE' }));
        }

        let body = '';
        let received = 0;

        req.on('data', chunk => {
            received += chunk.length;
            if (received > maxBytes) {
                // 超限：立即销毁连接，不再累积数据
                req.destroy();
                return reject(Object.assign(new Error('Request body too large'), { code: 'BODY_TOO_LARGE' }));
            }
            body += chunk.toString();
        });

        req.on('end', () => {
            try {
                resolve(body.trim() ? JSON.parse(body) : {});
            } catch (error) {
                reject(new Error('Invalid JSON format'));
            }
        });

        req.on('error', reject);
    });
}

/**
 * 生成简单的token
 */
function generateToken() {
    return crypto.randomBytes(32).toString('hex');
}

 /**
 * 生成token过期时间
 */
function getExpiryTime() {
    const now = Date.now();
    const expiry = (CONFIG.LOGIN_EXPIRY || 3600) * 1000; // 使用配置的过期时间，默认1小时
    return now + expiry;
}


/**
 * 读取token存储文件
 */
async function readTokenStore() {
    try {
        if (existsSync(TOKEN_STORE_FILE)) {
            const content = await fs.readFile(TOKEN_STORE_FILE, 'utf8');
            return JSON.parse(content);
        } else {
            // 如果文件不存在，创建一个默认的token store
            await writeTokenStore({ tokens: {} });
            return { tokens: {} };
        }
    } catch (error) {
        logger.error('[Token Store] Failed to read token store file:', error);
        return { tokens: {} };
    }
}

/**
 * 写入token存储文件
 */
async function writeTokenStore(tokenStore) {
    try {
        await atomicWriteFile(TOKEN_STORE_FILE, JSON.stringify(tokenStore, null, 2), { encoding: 'utf8', mode: 0o600 });
    } catch (error) {
        logger.error('[Token Store] Failed to write token store file:', error);
    }
}

/**
 * 验证简单token
 */
export async function verifyToken(token) {
    const tokenStore = await readTokenStore();
    const tokenInfo = tokenStore.tokens[token];
    if (!tokenInfo) {
        return null;
    }
    
    // 检查是否过期
    if (Date.now() > tokenInfo.expiryTime) {
        await deleteToken(token);
        return null;
    }
    
    return tokenInfo;
}

/**
 * 保存token到本地文件
 */
async function saveToken(token, tokenInfo) {
    const tokenStore = await readTokenStore();
    tokenStore.tokens[token] = tokenInfo;
    await writeTokenStore(tokenStore);
}

/**
 * 删除token
 */
async function deleteToken(token) {
    const tokenStore = await readTokenStore();
    if (tokenStore.tokens[token]) {
        delete tokenStore.tokens[token];
        await writeTokenStore(tokenStore);
    }
}

/**
 * 管理登录尝试频率和锁定
 */
class LoginAttemptManager {
    constructor() {
        this.attempts = new Map(); // IP -> { count, lastAttempt, lockoutUntil }
    }

    /**
     * 获取 IP 的状态
     */
    getIpStatus(ip) {
        if (!this.attempts.has(ip)) {
            this.attempts.set(ip, { count: 0, lastAttempt: 0, lockoutUntil: 0 });
        }
        return this.attempts.get(ip);
    }

    /**
     * 检查是否被锁定
     */
    isLockedOut(ip) {
        const status = this.getIpStatus(ip);
        if (status.lockoutUntil > Date.now()) {
            return {
                locked: true,
                remainingTime: Math.ceil((status.lockoutUntil - Date.now()) / 1000)
            };
        }
        // 如果锁定时间已过，重置失败次数
        if (status.lockoutUntil > 0 && status.lockoutUntil <= Date.now()) {
            status.count = 0;
            status.lockoutUntil = 0;
        }
        return { locked: false };
    }

    /**
     * 检查是否请求过于频繁
     */
    isTooFrequent(ip) {
        const status = this.getIpStatus(ip);
        const minInterval = CONFIG.LOGIN_MIN_INTERVAL || 1000;
        const now = Date.now();
        if (now - status.lastAttempt < minInterval) {
            return true;
        }
        status.lastAttempt = now;
        return false;
    }

    /**
     * 记录一次失败
     */
    recordFailure(ip) {
        const status = this.getIpStatus(ip);
        status.count++;
        const maxAttempts = CONFIG.LOGIN_MAX_ATTEMPTS || 5;
        const lockoutDuration = (CONFIG.LOGIN_LOCKOUT_DURATION || 1800) * 1000;

        if (status.count >= maxAttempts) {
            status.lockoutUntil = Date.now() + lockoutDuration;
            logger.warn(`[Auth] IP ${ip} locked out due to too many failed login attempts (${status.count})`);
            return true;
        }
        return false;
    }

    /**
     * 成功后重置
     */
    reset(ip) {
        this.attempts.delete(ip);
    }
}

const loginAttemptManager = new LoginAttemptManager();

/**
 * 清理过期的token
 */
export async function cleanupExpiredTokens() {
    const tokenStore = await readTokenStore();
    const now = Date.now();
    let hasChanges = false;
    
    for (const token in tokenStore.tokens) {
        if (now > tokenStore.tokens[token].expiryTime) {
            delete tokenStore.tokens[token];
            hasChanges = true;
        }
    }
    
    if (hasChanges) {
        await writeTokenStore(tokenStore);
    }
}

/**
 * 检查token验证
 * 支持 Authorization Header 或 URL 参数 token (用于 SSE)
 */
export async function checkAuth(req) {
    let token = null;
    
    // 1. 检查 Authorization header
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7);
    }
    
    // 2. 检查 URL 参数 (用于 EventSource/SSE)
    if (!token && req.url) {
        try {
            const url = new URL(req.url, 'http://localhost');
            token = url.searchParams.get('token');
        } catch (e) {
            // 解析失败忽略
        }
    }
    
    if (!token) {
        return false;
    }

    const tokenInfo = await verifyToken(token);
    
    return tokenInfo !== null;
}

/**
 * 处理登录请求
 */
export async function handleLoginRequest(req, res) {
    if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            success: false, 
            message: 'Only POST requests are supported',
            messageCode: 'login.error.postOnly'
        }));
        return true;
    }

    const ip = getClientIp(req, CONFIG);
    
    // 1. 检查锁定状态
    const lockout = loginAttemptManager.isLockedOut(ip);
    if (lockout.locked) {
        logger.warn(`[Auth] Login attempt from locked IP: ${ip}, reason: account_locked, remaining: ${lockout.remainingTime}s`);
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            success: false, 
            message: `Account temporarily locked due to too many failed attempts. Please try again in ${lockout.remainingTime} seconds.`,
            messageCode: 'login.error.locked',
            messageParams: { time: lockout.remainingTime }
        }));
        return true;
    }

    // 2. 频率限制
    if (loginAttemptManager.isTooFrequent(ip)) {
        logger.warn(`[Auth] Login attempt too frequent from IP: ${ip}, reason: rate_limit`);
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            success: false, 
            message: 'Too many requests, please slow down.',
            messageCode: 'login.error.tooFrequent'
        }));
        return true;
    }

    try {
        const requestData = await parseRequestBody(req);
        const { password } = requestData;
        
        if (!password) {
            logger.warn(`[Auth] Login failed from IP: ${ip}, reason: empty_password`);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
                success: false, 
                message: 'Password cannot be empty',
                messageCode: 'login.error.empty'
            }));
            return true;
        }

        const isValid = await validateCredentials(password);
        
        if (isValid) {
            logger.info(`[Auth] Login successful from IP: ${ip}`);
            // 登录成功，重置计数
            loginAttemptManager.reset(ip);

            // Generate simple token
            const token = generateToken();
            const loginExpiry = CONFIG.LOGIN_EXPIRY || 3600;
            const expiryTime = Date.now() + (loginExpiry * 1000);
            
            // Store token info to local file
            await saveToken(token, {
                username: 'admin',
                loginTime: Date.now(),
                expiryTime
            });

             res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                message: 'Login successful',
                token,
                expiresIn: `${loginExpiry} seconds`
            }));
        } else {
            // 登录失败，记录
            const isLocked = loginAttemptManager.recordFailure(ip);
            const status = loginAttemptManager.getIpStatus(ip);
            const maxAttempts = CONFIG.LOGIN_MAX_ATTEMPTS || 5;
            const remaining = maxAttempts - status.count;
            const lockoutDuration = CONFIG.LOGIN_LOCKOUT_DURATION || 1800;

            logger.warn(`[Auth] Login failed from IP: ${ip}, reason: incorrect_password, remaining_attempts: ${Math.max(0, remaining)}${isLocked ? ', result: locked' : ''}`);

            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                message: isLocked 
                    ? `Incorrect password. Account locked for ${Math.ceil(lockoutDuration / 60)} minutes.` 
                    : `Incorrect password. ${remaining} attempts remaining.`,
                messageCode: isLocked ? 'login.error.incorrectWithLock' : 'login.error.incorrectWithRemaining',
                messageParams: isLocked ? { time: Math.ceil(lockoutDuration / 60) } : { count: remaining }
            }));
        }

    } catch (error) {
        logger.error('[Auth] Login processing error:', error);
        const isJsonError = error.message === 'Invalid JSON format';
        const isBodyTooLarge = error.code === 'BODY_TOO_LARGE';

        if (isBodyTooLarge) {
            res.writeHead(413, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                message: 'Request body too large',
                messageCode: 'login.error.bodyTooLarge'
            }));
        } else {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                message: error.message || 'Server error',
                messageCode: isJsonError ? 'login.error.invalidJson' : undefined
            }));
        }
    }
    return true;
}

// 定时清理过期token
setInterval(cleanupExpiredTokens, 5 * 60 * 1000); // 每5分钟清理一次


