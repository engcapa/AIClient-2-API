import { Readable } from 'stream';
import { jest } from '@jest/globals';
import '../src/converters/register-converters.js';
import { handleAPIRequests } from '../src/services/api-manager.js';

const mockGenerateContent = jest.fn();

jest.mock('../src/services/service-manager.js', () => ({
    getProviderPoolManager: jest.fn(() => null),
    getApiServiceWithFallback: jest.fn(async () => ({
        service: { generateContent: mockGenerateContent },
        actualProviderType: 'openai-codex-oauth'
    }))
}));

jest.mock('../src/utils/logger.js', () => ({
    __esModule: true,
    default: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn()
    }
}));

function makeMultipartRequest(parts) {
    const boundary = '----aiclient2api-test-boundary';
    const chunks = [];

    for (const part of parts) {
        chunks.push(Buffer.from(`--${boundary}\r\n`));
        if (part.file) {
            chunks.push(Buffer.from(
                `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n` +
                `Content-Type: ${part.contentType}\r\n\r\n`
            ));
            chunks.push(Buffer.from(part.value));
            chunks.push(Buffer.from('\r\n'));
        } else {
            chunks.push(Buffer.from(
                `Content-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value}\r\n`
            ));
        }
    }

    chunks.push(Buffer.from(`--${boundary}--\r\n`));

    const body = Buffer.concat(chunks);
    const req = Readable.from(body);
    req.headers = {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'content-length': String(body.length)
    };
    req.complete = true;
    return req;
}

function makeResponse() {
    return {
        statusCode: null,
        headers: null,
        body: '',
        writableEnded: false,
        writeHead(statusCode, headers) {
            this.statusCode = statusCode;
            this.headers = headers;
        },
        end(body = '') {
            this.body = body;
            this.writableEnded = true;
        }
    };
}

describe('/v1/images/edits multipart handling', () => {
    beforeEach(() => {
        mockGenerateContent.mockReset();
        mockGenerateContent.mockResolvedValue({
            response: {
                output: [{
                    type: 'image_generation_call',
                    result: 'generated-image-b64',
                    output_format: 'png'
                }]
            }
        });
    });

    test('preserves multiple image[] files as multiple Codex input_image parts', async () => {
        const req = makeMultipartRequest([
            { name: 'model', value: 'gpt-image-2' },
            { name: 'prompt', value: 'blend these references' },
            { name: 'image[]', file: true, filename: 'first.png', contentType: 'image/png', value: 'first-image' },
            { name: 'image[]', file: true, filename: 'second.png', contentType: 'image/png', value: 'second-image' }
        ]);
        const res = makeResponse();

        const handled = await handleAPIRequests(
            'POST',
            '/v1/images/edits',
            req,
            res,
            { MODEL_PROVIDER: 'openai-codex-oauth' },
            null,
            null,
            null
        );

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(mockGenerateContent).toHaveBeenCalledTimes(1);

        const [, requestBody] = mockGenerateContent.mock.calls[0];
        const imageParts = requestBody.input[0].content.filter(part => part.type === 'input_image');

        expect(imageParts).toHaveLength(2);
        expect(imageParts[0].image_url).toContain(Buffer.from('first-image').toString('base64'));
        expect(imageParts[1].image_url).toContain(Buffer.from('second-image').toString('base64'));
    });

    test('preserves multiple image files as multiple Codex input_image parts', async () => {
        const req = makeMultipartRequest([
            { name: 'model', value: 'gpt-image-2' },
            { name: 'prompt', value: 'blend these references' },
            { name: 'image', file: true, filename: 'first.png', contentType: 'image/png', value: 'first-image' },
            { name: 'image', file: true, filename: 'second.png', contentType: 'image/png', value: 'second-image' }
        ]);
        const res = makeResponse();

        const handled = await handleAPIRequests(
            'POST',
            '/v1/images/edits',
            req,
            res,
            { MODEL_PROVIDER: 'openai-codex-oauth' },
            null,
            null,
            null
        );

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(mockGenerateContent).toHaveBeenCalledTimes(1);

        const [, requestBody] = mockGenerateContent.mock.calls[0];
        const imageParts = requestBody.input[0].content.filter(part => part.type === 'input_image');

        expect(imageParts).toHaveLength(2);
        expect(imageParts[0].image_url).toContain(Buffer.from('first-image').toString('base64'));
        expect(imageParts[1].image_url).toContain(Buffer.from('second-image').toString('base64'));
    });
});
