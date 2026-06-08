/**
 * VoxHop Counterparty — AI Pipeline
 *
 * callWhisper()       — STT via faster-whisper
 * callOllamaStream()  — LLM streaming via Ollama /api/chat (NDJSON)
 * callPiper()         — TTS via Piper HTTP, accepts voice parameter
 * injectAudio()       — inject LPCM frames on txTrackId
 * StagedError         — typed error with pipeline stage
 */

import FormData from 'form-data';
import pino from 'pino';
import type WebSocket from 'ws';
import { buildWav } from './audio-utils';
import type { Config } from './config';
import { WhisperResponseSchema, OllamaStreamChunkSchema } from './schemas';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

// ─── StagedError ─────────────────────────────────────────────────────────────

export class StagedError extends Error {
    constructor(
        public readonly stage: 'whisper' | 'ollama' | 'piper' | 'unknown',
        message?: string
    ) {
        super(message ?? `Pipeline stage failed: ${stage}`);
        this.name = 'StagedError';
    }
}

// ─── injectAudio ─────────────────────────────────────────────────────────────

/**
 * Inject audio to the caller via telco-ai-bridge WebSocket.
 * C-04: trackId MUST be txTrackId.
 */
export function injectAudio(
    ws: WebSocket,
    callId: string,
    txTrackId: string,
    pcm16k: Buffer
): void {
    if (ws.readyState !== ws.OPEN) return;

    ws.send(
        JSON.stringify({
            event: 'audio',
            callId,
            trackId: txTrackId,
            payload: pcm16k.toString('base64'),
        })
    );
}

// ─── OllamaMessage type ───────────────────────────────────────────────────────

export type OllamaMessage = { role: 'system' | 'user' | 'assistant'; content: string };

// ─── callWhisper ─────────────────────────────────────────────────────────────

export async function callWhisper(speechBuffer: Buffer, config: Config, language: string): Promise<string> {
    if (speechBuffer.length === 0) {
        throw new StagedError('whisper', 'Zero-length speech buffer from VAD');
    }

    const wavData = buildWav(speechBuffer, 16000, 16, 1);

    const formData = new FormData();
    formData.append('file', wavData, {
        filename: 'audio.wav',
        contentType: 'audio/wav',
    });
    formData.append('model', 'whisper-1');
    formData.append('response_format', 'json');
    // Pass persona language to force transcription (not translation).
    // Without this, Whisper large-v3 auto-detects language and may translate
    // non-English speech to English text instead of preserving the original.
    formData.append('language', language);

    let response: Response;
    try {
        // form-data npm package requires getHeaders() for the multipart boundary.
        // getBuffer() materialises the body as a concrete Buffer — native fetch
        // cannot consume form-data's Node.js Readable stream directly.
        // Double-cast through unknown: TS's BodyInit doesn't include Buffer/Uint8Array
        // by name in Node.js lib typings, but the runtime accepts it as BufferSource.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const formBody = formData.getBuffer() as unknown as BodyInit;
        response = await fetch(`${config.WHISPER_URL}/v1/audio/transcriptions`, {
            method: 'POST',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            headers: formData.getHeaders() as any,
            body: formBody,
            signal: AbortSignal.timeout(config.WHISPER_TIMEOUT_MS),
        });
    } catch (err: unknown) {
        throw new StagedError('whisper', `Whisper request failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!response.ok) {
        throw new StagedError('whisper', `Whisper HTTP ${response.status}`);
    }

    let json: unknown;
    try {
        json = await response.json();
    } catch {
        throw new StagedError('whisper', 'Whisper response is not valid JSON');
    }

    const parsed = WhisperResponseSchema.safeParse(json);
    if (!parsed.success) {
        throw new StagedError('whisper', `Whisper response schema invalid: ${parsed.error.message}`);
    }

    return parsed.data.text;
}

// ─── callOllamaStream ─────────────────────────────────────────────────────────

/**
 * Call Ollama /api/chat with streaming NDJSON.
 *
 * CRITICAL: Uses /api/chat (not /api/generate).
 * Streaming format: { message: { role, content }, done: boolean }
 *
 * NDJSON line buffer: maintains incomplete line across reads to handle
 * TCP chunk splits across JSON line boundaries.
 */
export async function callOllamaStream(
    messages: OllamaMessage[],
    config: Config,
    onToken: (token: string) => void,
): Promise<string> {
    let response: Response;
    try {
        response = await fetch(`${config.OLLAMA_URL}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: config.OLLAMA_MODEL,
                messages,
                stream: true,
                // Disable gemma4 chain-of-thought thinking mode.
                // Thinking generates hundreds of reasoning tokens before every response,
                // adding 10-40s of latency that is unacceptable for real-time voice.
                think: false,
                // Keep model pinned in VRAM indefinitely. The integer -1 is unreliable in
                // some Ollama versions (HelloSurgery precedent); the duration string "-1s"
                // is the safe form that guarantees permanent residency.
                keep_alive: '-1s',
            }),
            signal: AbortSignal.timeout(config.OLLAMA_TIMEOUT_MS),
        });
    } catch (err: unknown) {
        throw new StagedError('ollama', `Ollama request failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!response.ok) throw new StagedError('ollama', `Ollama HTTP ${response.status}`);
    if (!response.body) throw new StagedError('ollama', 'Ollama response body is null');

    // NDJSON streaming — critical: split on '\n', keep incomplete tail across reads
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let lineBuffer = '';
    let fullResponse = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        lineBuffer += decoder.decode(value, { stream: true });
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() ?? ''; // keep incomplete last line
        for (const line of lines) {
            if (!line.trim()) continue;
            let parsed: unknown;
            try { parsed = JSON.parse(line); } catch { continue; }
            const chunk = OllamaStreamChunkSchema.safeParse(parsed);
            if (!chunk.success) continue;
            if (chunk.data.message.content) {
                onToken(chunk.data.message.content);
                fullResponse += chunk.data.message.content;
            }
            if (chunk.data.done) return fullResponse;
        }
    }
    if (!fullResponse) throw new StagedError('ollama', 'Ollama stream ended with empty response');
    return fullResponse;
}

// ─── splitSentences ──────────────────────────────────────────────────────────

/**
 * Split LLM response text into individual sentences for per-sentence Piper synthesis.
 *
 * WHY: Piper's subprocess pool keeps processes alive between requests. The
 * _synthesise_sync function uses 100 ms of stdout silence to detect "done".
 * When Piper synthesises multi-sentence text, the inter-sentence processing gap
 * can exceed 100 ms, causing synthesis to return early (sentence 1 only) while
 * sentence 2 audio remains buffered in the subprocess stdout. The next Piper
 * call then reads that leftover audio first, delivering it to the wrong turn.
 *
 * Sending one sentence per Piper request guarantees each request is self-contained
 * with no cross-turn buffer contamination.
 *
 * Handles: `. ! ?` endings, Spanish ¡ ¿ openers, ellipsis …, and Unicode text.
 * Falls back to the full text as a single element if no boundary is found.
 */
export function splitSentences(text: string): string[] {
    // Split after . ! ? (and their Unicode equivalents) followed by whitespace.
    // Lookbehind keeps the punctuation with the preceding sentence.
    const parts = text
        .split(/(?<=[.!?…])\s+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    return parts.length > 0 ? parts : [text.trim()].filter((s) => s.length > 0);
}

// ─── callPiper ───────────────────────────────────────────────────────────────

/**
 * Call Piper TTS with text and voice parameter.
 * GAP-03: Explicit zero-byte response check.
 * Returns raw 24kHz PCM Buffer.
 */
export async function callPiper(text: string, config: Config, voice: string): Promise<Buffer> {
    let response: Response;
    try {
        response = await fetch(`${config.PIPER_URL}/tts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, voice }),
            signal: AbortSignal.timeout(config.PIPER_TIMEOUT_MS),
        });
    } catch (err: unknown) {
        throw new StagedError('piper', `Piper request failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!response.ok) {
        throw new StagedError('piper', `Piper HTTP ${response.status}`);
    }

    let arrayBuffer: ArrayBuffer;
    try {
        arrayBuffer = await response.arrayBuffer();
    } catch {
        throw new StagedError('piper', 'Failed to read Piper response body');
    }

    const piperPcm = Buffer.from(arrayBuffer);

    // GAP-03: Explicit zero-byte check
    if (piperPcm.length === 0) {
        throw new StagedError('piper', 'Piper returned zero bytes');
    }

    return piperPcm;
}
