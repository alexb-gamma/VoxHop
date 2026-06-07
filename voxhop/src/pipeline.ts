/**
 * VoxHop — Pipeline Execution
 *
 * executeTurn() — single linear async function with one try/catch (SD-01).
 * Five sub-functions. No event-driven stage chaining.
 *
 * Call flow:
 *   1. Acquire Redis lock (discard if already held)
 *   2. callWhisper() → transcript (1000ms timeout)
 *   3. callOllama() → echo text (500ms timeout)
 *   4. callPiper() → 24kHz PCM (300ms timeout)
 *   5. downsampleTo16k() → inject audio (txTrackId — C-04)
 *
 * On any failure: inject comfort clip, emit failure metric, release lock.
 *
 * GAP-02: StagedError uses instanceof narrowing, NOT catch (err: StagedError)
 * GAP-03: callPiper() checks zero-byte response explicitly
 * C-04:   Audio injection uses txTrackId
 * C-10:   AbortSignal.timeout() for all HTTP timeouts
 * C-12:   Ollama stream: false
 */

import FormData from 'form-data';
import pino from 'pino';
import type WebSocket from 'ws';
import { downsampleTo16k, buildWav } from './audio-utils';
import { injectComfortClip } from './comfort';
import type { VoxHopRedis } from './redis';
import type { VoxHopMetrics, Leg } from './metrics';
import type { Config } from './config';
import { WhisperResponseSchema, OllamaResponseSchema } from './schemas';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

// ─── StagedError ─────────────────────────────────────────────────────────────

/**
 * Typed error carrying the pipeline stage where the failure occurred.
 * GAP-02: Use instanceof narrowing — catch (err: StagedError) is a TS compile error.
 */
export class StagedError extends Error {
    constructor(
        public readonly stage: 'whisper' | 'ollama' | 'piper' | 'unknown',
        message?: string
    ) {
        super(message ?? `Pipeline stage failed: ${stage}`);
        this.name = 'StagedError';
    }
}

// ─── Echo system prompt ───────────────────────────────────────────────────────

const ECHO_SYSTEM_PROMPT =
    'You are a transcript relay. Output ONLY the exact text provided. No additions. No changes. No punctuation modifications.';

// ─── Inject audio ─────────────────────────────────────────────────────────────

/**
 * Inject audio to the caller via telco-ai-bridge WebSocket.
 * C-04: trackId MUST be txTrackId — not the caller/called trackId.
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
            trackId: txTrackId, // C-04: MUST be txTrackId
            payload: pcm16k.toString('base64'),
        })
    );
}

// ─── Stage Functions ──────────────────────────────────────────────────────────

/**
 * Call Whisper STT.
 * - Wraps PCM in WAV header for faster-whisper (RE-07)
 * - 1000ms AbortSignal.timeout() (C-10)
 * - Validates response via WhisperResponseSchema (C-07, GAP-01)
 * - Throws StagedError('whisper') on timeout, HTTP error, or empty transcript
 */
export async function callWhisper(speechBuffer: Buffer, config: Config): Promise<string> {
    if (speechBuffer.length === 0) {
        // NEG-16: Zero-length VAD buffer — treat as whisper failure
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

    let response: Response;
    try {
        response = await fetch(`${config.WHISPER_URL}/v1/audio/transcriptions`, {
            method: 'POST',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            body: formData as any,
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
        // GAP-01: Empty transcript also fails here — min(1) rejects ""
        throw new StagedError('whisper', `Whisper response schema invalid: ${parsed.error.message}`);
    }

    return parsed.data.text;
}

/**
 * Call Ollama LLM (echo mode).
 * - Non-streaming: stream: false (C-12)
 * - 500ms AbortSignal.timeout() (C-10)
 * - Logs transcript vs. Ollama output side-by-side (ACC-05)
 * - Validates response via OllamaResponseSchema
 * - Throws StagedError('ollama') on timeout, HTTP error, or invalid response
 */
export async function callOllama(
    transcript: string,
    config: Config,
    callLog?: pino.Logger
): Promise<string> {
    let response: Response;
    try {
        response = await fetch(`${config.OLLAMA_URL}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: config.OLLAMA_MODEL,
                prompt: transcript,
                system: ECHO_SYSTEM_PROMPT,
                stream: false, // C-12: non-streaming in Track 1
            }),
            signal: AbortSignal.timeout(config.OLLAMA_TIMEOUT_MS),
        });
    } catch (err: unknown) {
        throw new StagedError('ollama', `Ollama request failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!response.ok) {
        throw new StagedError('ollama', `Ollama HTTP ${response.status}`);
    }

    let json: unknown;
    try {
        json = await response.json();
    } catch {
        throw new StagedError('ollama', 'Ollama response is not valid JSON');
    }

    const parsed = OllamaResponseSchema.safeParse(json);
    if (!parsed.success) {
        throw new StagedError('ollama', `Ollama response schema invalid: ${parsed.error.message}`);
    }

    const echoText = parsed.data.response;

    // ACC-05: Log transcript vs. Ollama output side-by-side
    const log = callLog ?? logger;
    log.info({ transcript, echoText }, 'Ollama echo — transcript vs output');

    return echoText;
}

/**
 * Call Piper TTS.
 * - 300ms AbortSignal.timeout() (C-10)
 * - GAP-03: Explicit zero-byte response check
 * - Returns raw 24kHz PCM Buffer
 * - Throws StagedError('piper') on timeout, HTTP error, or empty response
 */
export async function callPiper(echoText: string, config: Config): Promise<Buffer> {
    let response: Response;
    try {
        response = await fetch(`${config.PIPER_URL}/tts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: echoText }),
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

    // GAP-03: Explicit zero-byte check (NEG-10)
    if (piperPcm.length === 0) {
        throw new StagedError('piper', 'Piper returned zero-byte audio response');
    }

    return piperPcm;
}

// ─── Main Turn Executor ───────────────────────────────────────────────────────

/**
 * Execute a single pipeline turn: Whisper → Ollama → Piper → inject.
 *
 * SD-01: Single linear async function with one try/catch. Five sub-functions.
 * No event-driven stage chaining.
 *
 * The function returns immediately (no throw) — all errors are caught internally
 * and result in comfort clip injection. Callers use .catch() for unhandled errors only.
 */
export async function executeTurn(params: {
    callId: string;
    trackId: string;
    txTrackId: string;
    leg: Leg;
    speechBuffer: Buffer;
    ws: WebSocket;
    config: Config;
    redis: VoxHopRedis;
    metrics: VoxHopMetrics;
    comfortClipBuffer: Buffer;
    callLog: pino.Logger;
}): Promise<void> {
    const {
        callId,
        trackId,
        txTrackId,
        leg,
        speechBuffer,
        ws,
        config,
        redis,
        metrics,
        comfortClipBuffer,
        callLog,
    } = params;

    // Acquire Redis lock — silently discard if already held by in-flight turn
    const acquired = await redis.acquireLock(trackId, config.LOCK_TTL_SECONDS);
    if (!acquired) {
        callLog.debug({ trackId }, 'VAD fire discarded — processing lock held');
        return;
    }

    const t0 = Date.now();
    let t1: number | undefined;
    let t2: number | undefined;
    let t3: number | undefined;

    try {
        const transcript = await callWhisper(speechBuffer, config);
        t1 = Date.now();

        const echoText = await callOllama(transcript, config, callLog);
        t2 = Date.now();

        const piperPcm = await callPiper(echoText, config);
        t3 = Date.now();

        const pcm16k = downsampleTo16k(piperPcm, 24000);
        injectAudio(ws, callId, txTrackId, pcm16k);
        const t4 = Date.now();

        metrics.emitTurn({ t0, t1, t2, t3, t4, leg, outcome: 'success' });

        callLog.info(
            {
                trackId,
                leg,
                vadToSttMs: t1 - t0,
                sttToLlmMs: t2 - t1,
                llmToTtsMs: t3 - t2,
                ttsToInjectMs: t4 - t3,
                totalMs: t4 - t0,
                outcome: 'success',
            },
            'Turn complete'
        );
    } catch (err: unknown) {
        // GAP-02: instanceof narrowing — NOT catch (err: StagedError)
        const stage = err instanceof StagedError ? err.stage : 'unknown';
        const message = err instanceof Error ? err.message : String(err);

        callLog.warn(
            { trackId, leg, stage, error: message },
            'Pipeline stage failed — injecting comfort clip'
        );

        injectComfortClip(ws, callId, txTrackId, comfortClipBuffer);
        metrics.emitFailure({ stage, leg });

        // Also emit partial histogram data for the failed turn
        const outcome = (
            stage === 'whisper'
                ? 'whisper_timeout'
                : stage === 'ollama'
                ? 'ollama_timeout'
                : stage === 'piper'
                ? 'piper_timeout'
                : 'error'
        ) as import('./metrics').Outcome;

        metrics.emitTurnOnFailure({ t0, t1, t2, t3, leg, outcome });
    } finally {
        // Always release the lock — explicit release is primary (TTL is safety net)
        await redis.releaseLock(trackId);
    }
}
