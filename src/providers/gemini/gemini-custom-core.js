import logger from '../../utils/logger.js';
import https from 'https';
import http from 'http';
import { API_ACTIONS } from '../../utils/common.js';
import { getProviderModels } from '../provider-models.js';
import { MODEL_PROVIDER } from '../../utils/common.js';
import { getProxyConfigForProvider } from '../../utils/proxy-utils.js';

// --- Constants ---
const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const GEMINI_CUSTOM_MODELS = getProviderModels(MODEL_PROVIDER.GEMINI_CUSTOM);

/**
 * 检查模型是否支持 thinking 功能
 */
function modelSupportsThinking(modelName) {
    return modelName && modelName.includes('thinking');
}

/**
 * 规范化 Gemini thinking 请求
 */
function normalizeGeminiThinkingRequest(modelName, requestBody) {
    if (!modelSupportsThinking(modelName)) return requestBody;

    const thinkingConfig = requestBody?.generationConfig?.thinkingConfig;
    if (!thinkingConfig) return requestBody;

    const thinkingLevel = thinkingConfig.thinkingLevel;
    const budget = thinkingConfig.thinkingBudget;
    const thinkingRequested =
        thinkingLevel !== undefined ||
        (budget !== undefined && budget !== 0);

    if (thinkingRequested && thinkingConfig.includeThoughts === undefined) {
        thinkingConfig.includeThoughts = true;
    }

    return requestBody;
}

/**
 * 转换为 Gemini API 响应格式
 */
function toGeminiApiResponse(geminiResponse) {
    if (!geminiResponse) return null;
    const compliantResponse = { candidates: geminiResponse.candidates };
    if (geminiResponse.usageMetadata) compliantResponse.usageMetadata = geminiResponse.usageMetadata;
    if (geminiResponse.promptFeedback) compliantResponse.promptFeedback = geminiResponse.promptFeedback;
    if (geminiResponse.automaticFunctionCallingHistory) compliantResponse.automaticFunctionCallingHistory = geminiResponse.automaticFunctionCallingHistory;
    return compliantResponse;
}

/**
 * 确保请求体中的内容都有 role 属性
 */
function ensureRolesInContents(requestBody) {
    delete requestBody.model;

    if (requestBody.system_instruction) {
        requestBody.systemInstruction = requestBody.system_instruction;
        delete requestBody.system_instruction;
    }

    if (requestBody.systemInstruction && !requestBody.systemInstruction.role) {
        requestBody.systemInstruction.role = 'user';
    }

    if (requestBody.contents && Array.isArray(requestBody.contents)) {
        requestBody.contents.forEach(content => {
            if (!content.role) {
                content.role = 'user';
            }
        });
    }
    return requestBody;
}

/**
 * Gemini Custom API Service
 * 使用 API Key 认证的 Gemini API 服务
 */
export class GeminiCustomApiService {
    constructor(config) {
        this.config = config;
        this.apiKey = config.GEMINI_API_KEY;
        this.baseUrl = config.GEMINI_BASE_URL || DEFAULT_BASE_URL;
        this.uuid = config.uuid;

        if (!this.apiKey) {
            throw new Error('GEMINI_API_KEY is required for Gemini Custom provider');
        }

        logger.info(`[Gemini Custom] Initialized with base URL: ${this.baseUrl}`);
    }

    /**
     * 发起 HTTP/HTTPS 请求
     */
    async makeRequest(url, options, body = null) {
        return new Promise((resolve, reject) => {
            const urlObj = new URL(url);
            const isHttps = urlObj.protocol === 'https:';
            const client = isHttps ? https : http;

            // 获取代理配置
            const proxyConfig = getProxyConfigForProvider(this.config.MODEL_PROVIDER || MODEL_PROVIDER.GEMINI_CUSTOM);
            if (proxyConfig) {
                options.agent = proxyConfig.agent;
            }

            const req = client.request(url, options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        try {
                            resolve(JSON.parse(data));
                        } catch (e) {
                            resolve(data);
                        }
                    } else {
                        reject(new Error(`HTTP ${res.statusCode}: ${data}`));
                    }
                });
            });

            req.on('error', reject);

            if (body) {
                req.write(typeof body === 'string' ? body : JSON.stringify(body));
            }

            req.end();
        });
    }

    /**
     * 发起流式 HTTP/HTTPS 请求
     */
    async *makeStreamRequest(url, options, body = null) {
        const urlObj = new URL(url);
        const isHttps = urlObj.protocol === 'https:';
        const client = isHttps ? https : http;

        // 获取代理配置
        const proxyConfig = getProxyConfigForProvider(this.config.MODEL_PROVIDER || MODEL_PROVIDER.GEMINI_CUSTOM);
        if (proxyConfig) {
            options.agent = proxyConfig.agent;
        }

        const req = client.request(url, options);

        const responsePromise = new Promise((resolve, reject) => {
            req.on('response', resolve);
            req.on('error', reject);
        });

        if (body) {
            req.write(typeof body === 'string' ? body : JSON.stringify(body));
        }
        req.end();

        const res = await responsePromise;

        if (res.statusCode < 200 || res.statusCode >= 300) {
            let errorData = '';
            for await (const chunk of res) {
                errorData += chunk.toString();
            }
            throw new Error(`HTTP ${res.statusCode}: ${errorData}`);
        }

        let buffer = '';
        for await (const chunk of res) {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || trimmed === 'data: [DONE]') continue;

                if (trimmed.startsWith('data: ')) {
                    try {
                        const jsonStr = trimmed.substring(6);
                        const data = JSON.parse(jsonStr);
                        yield data;
                    } catch (e) {
                        logger.warn(`[Gemini Custom] Failed to parse SSE data: ${e.message}`);
                    }
                }
            }
        }

        // 处理剩余的 buffer
        if (buffer.trim()) {
            const trimmed = buffer.trim();
            if (trimmed.startsWith('data: ') && trimmed !== 'data: [DONE]') {
                try {
                    const jsonStr = trimmed.substring(6);
                    const data = JSON.parse(jsonStr);
                    yield data;
                } catch (e) {
                    logger.warn(`[Gemini Custom] Failed to parse final SSE data: ${e.message}`);
                }
            }
        }
    }

    /**
     * 生成内容（非流式）
     */
    async generateContent(model, requestBody) {
        // 临时存储 monitorRequestId
        if (requestBody._monitorRequestId) {
            this.config._monitorRequestId = requestBody._monitorRequestId;
            delete requestBody._monitorRequestId;
        }
        if (requestBody._requestBaseUrl) {
            delete requestBody._requestBaseUrl;
        }

        let baseModel = model;
        if (!GEMINI_CUSTOM_MODELS.includes(model)) {
            logger.warn(`[Gemini Custom] Model '${model}' not in configured list. Using as-is: '${model}'`);
        }

        const processedRequestBody = normalizeGeminiThinkingRequest(
            baseModel,
            ensureRolesInContents({ ...requestBody })
        );

        const url = `${this.baseUrl}/models/${baseModel}:generateContent?key=${this.apiKey}`;
        const options = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            }
        };

        logger.info(`[Gemini Custom] Generating content with model: ${baseModel}`);

        try {
            const response = await this.makeRequest(url, options, processedRequestBody);
            return toGeminiApiResponse(response);
        } catch (error) {
            logger.error(`[Gemini Custom] Generate content failed: ${error.message}`);
            throw error;
        }
    }

    /**
     * 生成内容（流式）
     */
    async *generateContentStream(model, requestBody) {
        // 临时存储 monitorRequestId
        if (requestBody._monitorRequestId) {
            this.config._monitorRequestId = requestBody._monitorRequestId;
            delete requestBody._monitorRequestId;
        }
        if (requestBody._requestBaseUrl) {
            delete requestBody._requestBaseUrl;
        }

        let baseModel = model;
        if (!GEMINI_CUSTOM_MODELS.includes(model)) {
            logger.warn(`[Gemini Custom] Model '${model}' not in configured list. Using as-is: '${model}'`);
        }

        const processedRequestBody = normalizeGeminiThinkingRequest(
            baseModel,
            ensureRolesInContents({ ...requestBody })
        );

        const url = `${this.baseUrl}/models/${baseModel}:streamGenerateContent?alt=sse&key=${this.apiKey}`;
        const options = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            }
        };

        logger.info(`[Gemini Custom] Streaming content with model: ${baseModel}`);

        try {
            const stream = this.makeStreamRequest(url, options, processedRequestBody);
            for await (const chunk of stream) {
                yield toGeminiApiResponse(chunk);
            }
        } catch (error) {
            logger.error(`[Gemini Custom] Stream generate content failed: ${error.message}`);
            throw error;
        }
    }

    /**
     * 列出可用模型
     */
    async listModels() {
        const url = `${this.baseUrl}/models?key=${this.apiKey}`;
        const options = {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        };

        try {
            logger.info('[Gemini Custom] Fetching available models');
            const response = await this.makeRequest(url, options);

            if (response.models && Array.isArray(response.models)) {
                const modelIds = response.models
                    .filter(m => m.name && m.supportedGenerationMethods?.includes('generateContent'))
                    .map(m => m.name.replace('models/', ''));

                logger.info(`[Gemini Custom] Found ${modelIds.length} models`);
                return modelIds;
            }

            return GEMINI_CUSTOM_MODELS;
        } catch (error) {
            logger.error(`[Gemini Custom] List models failed: ${error.message}`);
            // 返回默认模型列表作为后备
            return GEMINI_CUSTOM_MODELS;
        }
    }

    /**
     * 刷新令牌（Gemini Custom 使用 API Key，无需刷新）
     */
    async refreshToken() {
        return Promise.resolve();
    }

    /**
     * 强制刷新令牌（Gemini Custom 使用 API Key，无需刷新）
     */
    async forceRefreshToken() {
        return Promise.resolve();
    }

    /**
     * 检查令牌是否即将过期（Gemini Custom 使用 API Key，永不过期）
     */
    isExpiryDateNear() {
        return false;
    }
}
