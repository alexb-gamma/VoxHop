/**
 * VoxHop — Latency Instrumentation Tests
 *
 * Verifies that:
 *   - All 4 histograms emit values per turn
 *   - outcome labels are correct (success, whisper_timeout, etc.)
 *   - turnFailures_total increments on failure with correct stage label
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VoxHopMetrics } from '../src/metrics';
import { executeTurn } from '../src/pipeline';
import type { Config } from '../src/config';

// ─── Mock Config ──────────────────────────────────────────────────────────────

const mockConfig: Config = {
    PORT: 3000,
    REDIS_URL: 'redis://localhost:6379',
    WHISPER_URL: 'http://localhost:8001',
    OLLAMA_URL: 'http://localhost:11434',
    PIPER_URL: 'http://localhost:5000',
    OLLAMA_MODEL: 'test-model',
    WHISPER_TIMEOUT_MS: 5000,
    OLLAMA_TIMEOUT_MS: 5000,
    PIPER_TIMEOUT_MS: 5000,
    LOCK_TTL_SECONDS: 10,
    VAD_SILENCE_THRESHOLD_MS: 600,
    VAD_MIN_SPEECH_MS: 250,
    COMFORT_CLIP_PATH: '/opt/voxhop/audio/comfort_en.pcm',
    LOG_LEVEL: 'error',
};

const COMFORT_CLIP = Buffer.from('comfort-pcm-data');
const SPEECH_BUFFER = Buffer.alloc(32000, 1);

function createMockWs() {
    return {
        readyState: 1 as const,
        OPEN: 1 as const,
        send: vi.fn(),
    };
}

function createMockRedis() {
    return {
        acquireLock: vi.fn().mockResolvedValue(true),
        releaseLock: vi.fn().mockResolvedValue(undefined),
    };
}

// ─── Success Path: All 4 Histograms ──────────────────────────────────────────

describe('Metrics: Success path — all 4 histograms emit', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('ACC-07: All 4 histograms emit real values on successful turn', async () => {
        const metrics = new VoxHopMetrics();
        const ws = createMockWs();
        const redis = createMockRedis();

        // Piper returns 1 second of 24kHz silence
        const piperPcm = Buffer.alloc(96000, 0);

        vi.spyOn(global, 'fetch')
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ text: 'hello world' }),
            } as Response)
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ response: 'hello world' }),
            } as Response)
            .mockResolvedValueOnce({
                ok: true,
                arrayBuffer: async () => piperPcm.buffer.slice(
                    piperPcm.byteOffset,
                    piperPcm.byteOffset + piperPcm.byteLength
                ),
            } as unknown as Response);

        const pino = await import('pino');
        const callLog = pino.default({ level: 'silent' });

        await executeTurn({
            callId: 'test-metrics-001',
            trackId: 'caller-track',
            txTrackId: 'tx-track',
            leg: 'caller',
            speechBuffer: SPEECH_BUFFER,
            ws: ws as unknown as import('ws').default,
            config: mockConfig,
            redis: redis as unknown as import('../src/redis').VoxHopRedis,
            metrics,
            comfortClipBuffer: COMFORT_CLIP,
            callLog,
        });

        const metricsText = await metrics.getMetrics();

        // All 4 histograms must be present and have observations
        expect(metricsText).toContain('voxhop_vad_to_stt_ms');
        expect(metricsText).toContain('voxhop_stt_to_llm_first_token_ms');
        expect(metricsText).toContain('voxhop_llm_to_tts_first_byte_ms');
        expect(metricsText).toContain('voxhop_tts_to_inject_ms');

        // Outcome label should be 'success'
        expect(metricsText).toContain('outcome="success"');

        // Leg label should be 'caller'
        expect(metricsText).toContain('leg="caller"');

        // _count should be 1 for at least one histogram
        expect(metricsText).toMatch(/voxhop_vad_to_stt_ms_count{[^}]*} 1/);
    });

    it('Labels include both leg values correctly', async () => {
        const metrics = new VoxHopMetrics();
        const now = Date.now();

        // Emit directly via emitTurn to verify label routing without pipeline complexity
        metrics.emitTurn({
            t0: now,
            t1: now + 100,
            t2: now + 200,
            t3: now + 350,
            t4: now + 360,
            leg: 'caller',
            outcome: 'success',
        });

        metrics.emitTurn({
            t0: now,
            t1: now + 120,
            t2: now + 220,
            t3: now + 380,
            t4: now + 395,
            leg: 'called',
            outcome: 'success',
        });

        const metricsText = await metrics.getMetrics();

        expect(metricsText).toContain('leg="caller"');
        expect(metricsText).toContain('leg="called"');
    });
});

// ─── Failure Path: turnFailures_total ─────────────────────────────────────────

describe('Metrics: Failure path — turnFailures_total increments', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('turnFailures_total{stage="whisper"} increments when Whisper times out', async () => {
        const metrics = new VoxHopMetrics();
        const ws = createMockWs();
        const redis = createMockRedis();

        vi.spyOn(global, 'fetch').mockRejectedValueOnce(
            new DOMException('AbortError', 'AbortError')
        );

        const pino = await import('pino');
        const callLog = pino.default({ level: 'silent' });

        await executeTurn({
            callId: 'test-fail-whisper',
            trackId: 'caller-track',
            txTrackId: 'tx-track',
            leg: 'caller',
            speechBuffer: SPEECH_BUFFER,
            ws: ws as unknown as import('ws').default,
            config: mockConfig,
            redis: redis as unknown as import('../src/redis').VoxHopRedis,
            metrics,
            comfortClipBuffer: COMFORT_CLIP,
            callLog,
        });

        const metricsText = await metrics.getMetrics();
        expect(metricsText).toContain('voxhop_turn_failures_total');
        expect(metricsText).toContain('stage="whisper"');
        expect(metricsText).toMatch(/voxhop_turn_failures_total{[^}]*stage="whisper"[^}]*} 1/);
    });

    it('turnFailures_total{stage="ollama"} increments when Ollama returns invalid schema', async () => {
        const metrics = new VoxHopMetrics();
        const ws = createMockWs();
        const redis = createMockRedis();

        vi.spyOn(global, 'fetch')
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ text: 'valid transcript' }),
            } as Response)
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ error: 'model not loaded' }), // Invalid schema
            } as Response);

        const pino = await import('pino');
        const callLog = pino.default({ level: 'silent' });

        await executeTurn({
            callId: 'test-fail-ollama',
            trackId: 'caller-track',
            txTrackId: 'tx-track',
            leg: 'caller',
            speechBuffer: SPEECH_BUFFER,
            ws: ws as unknown as import('ws').default,
            config: mockConfig,
            redis: redis as unknown as import('../src/redis').VoxHopRedis,
            metrics,
            comfortClipBuffer: COMFORT_CLIP,
            callLog,
        });

        const metricsText = await metrics.getMetrics();
        expect(metricsText).toContain('stage="ollama"');
        expect(metricsText).toMatch(/voxhop_turn_failures_total{[^}]*stage="ollama"[^}]*} 1/);
    });

    it('turnFailures_total{stage="piper"} increments when Piper returns 0 bytes', async () => {
        const metrics = new VoxHopMetrics();
        const ws = createMockWs();
        const redis = createMockRedis();

        vi.spyOn(global, 'fetch')
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ text: 'valid transcript' }),
            } as Response)
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ response: 'valid echo' }),
            } as Response)
            .mockResolvedValueOnce({
                ok: true,
                arrayBuffer: async () => new ArrayBuffer(0), // Zero bytes
            } as unknown as Response);

        const pino = await import('pino');
        const callLog = pino.default({ level: 'silent' });

        await executeTurn({
            callId: 'test-fail-piper',
            trackId: 'caller-track',
            txTrackId: 'tx-track',
            leg: 'caller',
            speechBuffer: SPEECH_BUFFER,
            ws: ws as unknown as import('ws').default,
            config: mockConfig,
            redis: redis as unknown as import('../src/redis').VoxHopRedis,
            metrics,
            comfortClipBuffer: COMFORT_CLIP,
            callLog,
        });

        const metricsText = await metrics.getMetrics();
        expect(metricsText).toContain('stage="piper"');
        expect(metricsText).toMatch(/voxhop_turn_failures_total{[^}]*stage="piper"[^}]*} 1/);
    });

    it('Multiple failures increment counter independently per stage', async () => {
        const metrics = new VoxHopMetrics();

        // Whisper failure
        metrics.emitFailure({ stage: 'whisper', leg: 'caller' });
        metrics.emitFailure({ stage: 'whisper', leg: 'caller' });
        // Ollama failure
        metrics.emitFailure({ stage: 'ollama', leg: 'called' });
        // Piper failure
        metrics.emitFailure({ stage: 'piper', leg: 'caller' });

        const metricsText = await metrics.getMetrics();

        // whisper counter should be 2
        expect(metricsText).toMatch(/voxhop_turn_failures_total{[^}]*stage="whisper"[^}]*leg="caller"[^}]*} 2|voxhop_turn_failures_total{[^}]*leg="caller"[^}]*stage="whisper"[^}]*} 2/);

        // ollama counter should be 1
        expect(metricsText).toContain('stage="ollama"');

        // piper counter should be 1
        expect(metricsText).toContain('stage="piper"');
    });

    it('voxhop_vad_to_stt_ms histogram emits on both success and failure', async () => {
        const metrics = new VoxHopMetrics();
        const now = Date.now();

        // Emit on success
        metrics.emitTurn({
            t0: now,
            t1: now + 200,
            t2: now + 300,
            t3: now + 450,
            t4: now + 460,
            leg: 'caller',
            outcome: 'success',
        });

        // Emit on failure (partial)
        metrics.emitTurnOnFailure({
            t0: now,
            t1: now + 1001, // whisper timed out at ~1001ms
            leg: 'caller',
            outcome: 'whisper_timeout',
        });

        const metricsText = await metrics.getMetrics();

        // prom-client stores separate time series per label combination.
        // outcome="success" series has count=1, outcome="whisper_timeout" series has count=1.
        // Both should appear in the output.
        expect(metricsText).toContain('outcome="success"');
        expect(metricsText).toContain('outcome="whisper_timeout"');
        // Both series should have observations
        expect(metricsText).toMatch(/voxhop_vad_to_stt_ms_count{[^}]*outcome="success"[^}]*} 1/);
        expect(metricsText).toMatch(/voxhop_vad_to_stt_ms_count{[^}]*outcome="whisper_timeout"[^}]*} 1/);
    });

    it('C-04: Audio injection uses txTrackId not callerTrackId', async () => {
        const ws = createMockWs();

        const piperPcm = Buffer.alloc(9600, 0);

        vi.spyOn(global, 'fetch')
            .mockResolvedValue({
                ok: true,
                json: async () => ({ text: 'test', response: 'test' }),
                arrayBuffer: async () => piperPcm.buffer.slice(
                    piperPcm.byteOffset,
                    piperPcm.byteOffset + piperPcm.byteLength
                ),
            } as unknown as Response);

        const metrics = new VoxHopMetrics();
        const redis = createMockRedis();
        const pino = await import('pino');
        const callLog = pino.default({ level: 'silent' });

        await executeTurn({
            callId: 'test-c04',
            trackId: 'caller-track-id',       // The leg's own trackId
            txTrackId: 'tx-injection-track',   // The injection trackId (MUST be used)
            leg: 'caller',
            speechBuffer: SPEECH_BUFFER,
            ws: ws as unknown as import('ws').default,
            config: mockConfig,
            redis: redis as unknown as import('../src/redis').VoxHopRedis,
            metrics,
            comfortClipBuffer: COMFORT_CLIP,
            callLog,
        });

        // Assert C-04: injected frame uses txTrackId, not callerTrackId
        expect(ws.send).toHaveBeenCalledTimes(1);
        const sentFrame = JSON.parse((ws.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as string);
        expect(sentFrame.trackId).toBe('tx-injection-track'); // txTrackId
        expect(sentFrame.trackId).not.toBe('caller-track-id'); // NOT the leg trackId
    });
});

// ─── Direct Metric Tests ──────────────────────────────────────────────────────

describe('VoxHopMetrics: Direct API tests', () => {
    it('emitTurn emits all 4 histogram observations', async () => {
        const metrics = new VoxHopMetrics();
        const now = Date.now();

        metrics.emitTurn({
            t0: now,
            t1: now + 150,
            t2: now + 250,
            t3: now + 400,
            t4: now + 410,
            leg: 'caller',
            outcome: 'success',
        });

        const text = await metrics.getMetrics();

        // All 4 histograms should have _count = 1
        expect(text).toMatch(/voxhop_vad_to_stt_ms_count{[^}]*} 1/);
        expect(text).toMatch(/voxhop_stt_to_llm_first_token_ms_count{[^}]*} 1/);
        expect(text).toMatch(/voxhop_llm_to_tts_first_byte_ms_count{[^}]*} 1/);
        expect(text).toMatch(/voxhop_tts_to_inject_ms_count{[^}]*} 1/);
    });

    it('emitFailure increments turnFailures_total correctly', async () => {
        const metrics = new VoxHopMetrics();

        metrics.emitFailure({ stage: 'whisper', leg: 'caller' });
        metrics.emitFailure({ stage: 'ollama', leg: 'called' });
        metrics.emitFailure({ stage: 'piper', leg: 'caller' });

        const text = await metrics.getMetrics();

        expect(text).toContain('voxhop_turn_failures_total');
        expect(text).toContain('stage="whisper"');
        expect(text).toContain('stage="ollama"');
        expect(text).toContain('stage="piper"');
    });

    it('getContentType returns valid Prometheus content type', () => {
        const metrics = new VoxHopMetrics();
        expect(metrics.getContentType()).toContain('text/plain');
    });
});
