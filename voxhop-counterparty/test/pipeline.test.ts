import { describe, it, expect, vi, beforeEach } from 'vitest';
import { callWhisper, callOllamaStream, callPiper, StagedError } from '../src/pipeline';
import type { Config } from '../src/config';

const mockConfig: Config = {
    PORT: 3001,
    WHISPER_URL: 'http://localhost:8001',
    OLLAMA_URL: 'http://localhost:11434',
    PIPER_URL: 'http://localhost:5000',
    OLLAMA_MODEL: 'gemma4',
    WHISPER_TIMEOUT_MS: 10000,
    OLLAMA_TIMEOUT_MS: 30000,
    PIPER_TIMEOUT_MS: 10000,
    VAD_SILENCE_THRESHOLD_MS: 600,
    VAD_MIN_SPEECH_MS: 250,
    LOG_LEVEL: 'info',
};

function makeReadableStream(chunks: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream({
        start(controller) {
            for (const chunk of chunks) {
                controller.enqueue(encoder.encode(chunk));
            }
            controller.close();
        },
    });
}

describe('callWhisper', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('throws StagedError("whisper") on AbortError (timeout)', async () => {
        vi.stubGlobal('fetch', () => Promise.reject(new DOMException('The operation was aborted.', 'AbortError')));
        const speechBuffer = Buffer.alloc(100);
        await expect(callWhisper(speechBuffer, mockConfig)).rejects.toMatchObject({
            stage: 'whisper',
        });
        expect((await callWhisper(speechBuffer, mockConfig).catch(e => e)) instanceof StagedError).toBe(true);
    });

    it('throws StagedError("whisper") on HTTP 500', async () => {
        vi.stubGlobal('fetch', () => Promise.resolve({ ok: false, status: 500 } as Response));
        const speechBuffer = Buffer.alloc(100);
        const err = await callWhisper(speechBuffer, mockConfig).catch(e => e);
        expect(err instanceof StagedError).toBe(true);
        expect(err.stage).toBe('whisper');
    });

    it('throws StagedError("whisper") on empty transcript', async () => {
        vi.stubGlobal('fetch', () => Promise.resolve({
            ok: true,
            json: async () => ({ text: '' }),
        } as Response));
        const speechBuffer = Buffer.alloc(100);
        const err = await callWhisper(speechBuffer, mockConfig).catch(e => e);
        expect(err instanceof StagedError).toBe(true);
        expect(err.stage).toBe('whisper');
    });
});

describe('callOllamaStream', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('accumulates tokens from NDJSON stream', async () => {
        const ndjson = [
            '{"message":{"role":"assistant","content":"Hello"},"done":false}\n',
            '{"message":{"role":"assistant","content":" world"},"done":true}\n',
        ];
        vi.stubGlobal('fetch', () => Promise.resolve({
            ok: true,
            body: makeReadableStream(ndjson),
        } as Response));

        const tokens: string[] = [];
        const result = await callOllamaStream(
            [{ role: 'user', content: 'Hi' }],
            mockConfig,
            (token) => tokens.push(token),
        );
        expect(result).toBe('Hello world');
        expect(tokens).toEqual(['Hello', ' world']);
    });

    it('handles NDJSON line split across chunk boundary', async () => {
        // Split a JSON line mid-way across two chunks
        const chunks = [
            '{"message":{"role":"assistant","content":"He',
            'llo"},"done":false}\n{"message":{"role":"assistant","content":" world"},"done":true}\n',
        ];
        vi.stubGlobal('fetch', () => Promise.resolve({
            ok: true,
            body: makeReadableStream(chunks),
        } as Response));

        const tokens: string[] = [];
        const result = await callOllamaStream(
            [{ role: 'user', content: 'Hi' }],
            mockConfig,
            (token) => tokens.push(token),
        );
        expect(result).toBe('Hello world');
    });

    it('throws StagedError("ollama") on HTTP 500', async () => {
        vi.stubGlobal('fetch', () => Promise.resolve({ ok: false, status: 500 } as Response));
        const err = await callOllamaStream([], mockConfig, () => {}).catch(e => e);
        expect(err instanceof StagedError).toBe(true);
        expect(err.stage).toBe('ollama');
    });
});

describe('callPiper', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('throws StagedError("piper") on zero-byte response (GAP-03)', async () => {
        vi.stubGlobal('fetch', () => Promise.resolve({
            ok: true,
            arrayBuffer: async () => new ArrayBuffer(0),
        } as Response));
        const err = await callPiper('Hello', mockConfig, 'en_GB-alan-medium').catch(e => e);
        expect(err instanceof StagedError).toBe(true);
        expect(err.stage).toBe('piper');
    });

    it('sends { text, voice } body', async () => {
        let capturedBody: unknown;
        vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
            capturedBody = JSON.parse(init?.body as string);
            return Promise.resolve({
                ok: true,
                arrayBuffer: async () => new ArrayBuffer(100),
            } as Response);
        });
        await callPiper('Test text', mockConfig, 'en_GB-alan-medium');
        expect(capturedBody).toMatchObject({ text: 'Test text', voice: 'en_GB-alan-medium' });
    });
});
