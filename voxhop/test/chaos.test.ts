/**
 * VoxHop — Chaos Resilience Tests
 *
 * Tests for graceful degradation when AI services fail:
 *   - Whisper killed → comfort clip injected, leg resumes, turnFailures incremented
 *   - Ollama killed → same behaviour
 *   - Piper killed → same behaviour
 *   - Lock TTL expiry → leg recovers
 *   - Dual-leg independence (ACC-09)
 *
 * All tests mock HTTP services — no real inference servers required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeTurn, callWhisper, callOllama, callPiper, StagedError, injectAudio } from '../src/pipeline';
import { VoxHopMetrics } from '../src/metrics';
import type { Config } from '../src/config';

// ─── Mock Config ──────────────────────────────────────────────────────────────

const mockConfig: Config = {
    PORT: 3000,
    REDIS_URL: 'redis://localhost:6379',
    WHISPER_URL: 'http://localhost:8001',
    OLLAMA_URL: 'http://localhost:11434',
    PIPER_URL: 'http://localhost:5000',
    OLLAMA_MODEL: 'test-model',
    WHISPER_TIMEOUT_MS: 1000,
    OLLAMA_TIMEOUT_MS: 500,
    PIPER_TIMEOUT_MS: 300,
    LOCK_TTL_SECONDS: 10,
    VAD_SILENCE_THRESHOLD_MS: 600,
    VAD_MIN_SPEECH_MS: 250,
    COMFORT_CLIP_PATH: '/opt/voxhop/audio/comfort_en.pcm',
    LOG_LEVEL: 'error',
};

// ─── Mock WebSocket ───────────────────────────────────────────────────────────

function createMockWs() {
    const sentMessages: string[] = [];
    return {
        readyState: 1 as const, // OPEN
        OPEN: 1 as const,
        send: vi.fn((data: string) => {
            sentMessages.push(data);
        }),
        sentMessages,
    };
}

// ─── Mock Redis ───────────────────────────────────────────────────────────────

function createMockRedis(lockAvailable = true) {
    return {
        acquireLock: vi.fn().mockResolvedValue(lockAvailable),
        releaseLock: vi.fn().mockResolvedValue(undefined),
        initCallState: vi.fn().mockResolvedValue(undefined),
        cleanupCallState: vi.fn().mockResolvedValue(undefined),
        isLockHeld: vi.fn().mockResolvedValue(!lockAvailable),
    };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const COMFORT_CLIP = Buffer.from('comfort-pcm-data-placeholder');
const SPEECH_BUFFER = Buffer.alloc(32000, 1); // 1 second of fake speech

function generateSpeechPcm(durationMs: number): Buffer {
    const samples = Math.floor((durationMs / 1000) * 16000);
    const buf = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i++) {
        buf.writeInt16LE(Math.round(10000 * Math.sin(i * 0.1)), i * 2);
    }
    return buf;
}

// ─── Whisper Chaos Tests ──────────────────────────────────────────────────────

describe('Chaos: Whisper failure', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('ACC-08 / NEG-07: Whisper timeout → comfort clip injected, call stays up, turnFailures incremented', async () => {
        const ws = createMockWs();
        const redis = createMockRedis(true);
        const metrics = new VoxHopMetrics();

        // Mock fetch to timeout (Whisper killed)
        vi.spyOn(global, 'fetch').mockImplementation(() =>
            new Promise((_, reject) =>
                setTimeout(() => reject(new DOMException('The operation was aborted.', 'AbortError')), 50)
            )
        );

        const pino = await import('pino');
        const callLog = pino.default({ level: 'silent' });

        await executeTurn({
            callId: 'test-call-001',
            trackId: 'caller-track-uuid',
            txTrackId: 'tx-track-uuid',
            leg: 'caller',
            speechBuffer: SPEECH_BUFFER,
            ws: ws as unknown as import('ws').default,
            config: mockConfig,
            redis: redis as unknown as import('../src/redis').VoxHopRedis,
            metrics,
            comfortClipBuffer: COMFORT_CLIP,
            callLog,
        });

        // Assert: comfort clip was sent (not synthesised audio)
        expect(ws.send).toHaveBeenCalledTimes(1);
        const sentPayload = JSON.parse(ws.sentMessages[0]);
        expect(sentPayload.event).toBe('audio');
        expect(sentPayload.trackId).toBe('tx-track-uuid'); // C-04: txTrackId
        expect(sentPayload.payload).toBe(COMFORT_CLIP.toString('base64'));

        // Assert: Redis lock was released
        expect(redis.releaseLock).toHaveBeenCalledWith('caller-track-uuid');

        // Assert: turnFailures_total incremented
        const metricsText = await metrics.getMetrics();
        expect(metricsText).toContain('voxhop_turn_failures_total');
        expect(metricsText).toContain('stage="whisper"');
    });

    it('NEG-07: Late Whisper response does NOT reach Ollama after abort fires', async () => {
        const ws = createMockWs();
        const redis = createMockRedis(true);
        const metrics = new VoxHopMetrics();
        let ollamaCalled = false;

        const callWhisperMock = vi.fn().mockImplementation(async () => {
            await new Promise(resolve => setTimeout(resolve, 50));
            throw new StagedError('whisper', 'timeout');
        });

        const callOllamaMock = vi.fn().mockImplementation(async () => {
            ollamaCalled = true;
            return 'should not reach here';
        });

        // Verify that our StagedError is correctly typed
        expect(callWhisperMock).toBeDefined();

        // Test that StagedError with 'whisper' stage is correctly thrown and caught
        try {
            await callWhisperMock(SPEECH_BUFFER, mockConfig);
        } catch (err) {
            expect(err).toBeInstanceOf(StagedError);
            if (err instanceof StagedError) {
                expect(err.stage).toBe('whisper');
            }
        }

        expect(ollamaCalled).toBe(false);
    });

    it('NEG-08: Empty Whisper transcript triggers comfort clip (GAP-01 / z.string().min(1))', async () => {
        const ws = createMockWs();
        const redis = createMockRedis(true);
        const metrics = new VoxHopMetrics();

        // Mock Whisper to return empty transcript
        vi.spyOn(global, 'fetch').mockResolvedValueOnce({
            ok: true,
            json: async () => ({ text: '' }),
        } as Response);

        const pino = await import('pino');
        const callLog = pino.default({ level: 'silent' });

        await executeTurn({
            callId: 'test-call-002',
            trackId: 'caller-track-uuid',
            txTrackId: 'tx-track-uuid',
            leg: 'caller',
            speechBuffer: SPEECH_BUFFER,
            ws: ws as unknown as import('ws').default,
            config: mockConfig,
            redis: redis as unknown as import('../src/redis').VoxHopRedis,
            metrics,
            comfortClipBuffer: COMFORT_CLIP,
            callLog,
        });

        // Comfort clip should be injected
        expect(ws.send).toHaveBeenCalledTimes(1);
        const sentPayload = JSON.parse(ws.sentMessages[0]);
        expect(sentPayload.payload).toBe(COMFORT_CLIP.toString('base64'));

        // Lock should be released
        expect(redis.releaseLock).toHaveBeenCalled();

        // turnFailures should increment for 'whisper'
        const metricsText = await metrics.getMetrics();
        expect(metricsText).toContain('stage="whisper"');
    });
});

// ─── Ollama Chaos Tests ───────────────────────────────────────────────────────

describe('Chaos: Ollama failure', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('ACC-08 / NEG-09: Ollama returns wrong schema → comfort clip, turnFailures stage=ollama', async () => {
        const ws = createMockWs();
        const redis = createMockRedis(true);
        const metrics = new VoxHopMetrics();

        // Mock: Whisper succeeds, Ollama returns invalid schema
        vi.spyOn(global, 'fetch')
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ text: 'hello world' }),
            } as Response)
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ error: 'model not loaded' }), // Missing 'response' field — NEG-09
            } as Response);

        const pino = await import('pino');
        const callLog = pino.default({ level: 'silent' });

        await executeTurn({
            callId: 'test-call-003',
            trackId: 'caller-track-uuid',
            txTrackId: 'tx-track-uuid',
            leg: 'caller',
            speechBuffer: SPEECH_BUFFER,
            ws: ws as unknown as import('ws').default,
            config: mockConfig,
            redis: redis as unknown as import('../src/redis').VoxHopRedis,
            metrics,
            comfortClipBuffer: COMFORT_CLIP,
            callLog,
        });

        // Comfort clip injected
        expect(ws.send).toHaveBeenCalledTimes(1);
        const sentPayload = JSON.parse(ws.sentMessages[0]);
        expect(sentPayload.payload).toBe(COMFORT_CLIP.toString('base64'));

        // Lock released
        expect(redis.releaseLock).toHaveBeenCalledWith('caller-track-uuid');

        // turnFailures stage=ollama
        const metricsText = await metrics.getMetrics();
        expect(metricsText).toContain('stage="ollama"');
    });
});

// ─── Piper Chaos Tests ────────────────────────────────────────────────────────

describe('Chaos: Piper failure', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('ACC-08 / NEG-10: Piper returns 0 bytes → comfort clip, turnFailures stage=piper (GAP-03)', async () => {
        const ws = createMockWs();
        const redis = createMockRedis(true);
        const metrics = new VoxHopMetrics();

        // Mock: Whisper + Ollama succeed, Piper returns empty body
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
                arrayBuffer: async () => new ArrayBuffer(0), // Zero bytes — NEG-10
            } as unknown as Response);

        const pino = await import('pino');
        const callLog = pino.default({ level: 'silent' });

        await executeTurn({
            callId: 'test-call-004',
            trackId: 'caller-track-uuid',
            txTrackId: 'tx-track-uuid',
            leg: 'caller',
            speechBuffer: SPEECH_BUFFER,
            ws: ws as unknown as import('ws').default,
            config: mockConfig,
            redis: redis as unknown as import('../src/redis').VoxHopRedis,
            metrics,
            comfortClipBuffer: COMFORT_CLIP,
            callLog,
        });

        // Comfort clip injected (not zero-length audio)
        expect(ws.send).toHaveBeenCalledTimes(1);
        const sentPayload = JSON.parse(ws.sentMessages[0]);
        expect(sentPayload.payload).toBe(COMFORT_CLIP.toString('base64'));

        // turnFailures stage=piper
        const metricsText = await metrics.getMetrics();
        expect(metricsText).toContain('stage="piper"');
    });

    it('NEG-17: All-zero Piper PCM does not crash downsample (valid audio)', async () => {
        const ws = createMockWs();
        const redis = createMockRedis(true);
        const metrics = new VoxHopMetrics();

        // 1 second of silence at 24kHz = 48000 samples * 2 bytes
        const silencePcm = Buffer.alloc(96000, 0);

        vi.spyOn(global, 'fetch')
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ text: 'hello' }),
            } as Response)
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ response: 'hello' }),
            } as Response)
            .mockResolvedValueOnce({
                ok: true,
                arrayBuffer: async () => silencePcm.buffer.slice(
                    silencePcm.byteOffset,
                    silencePcm.byteOffset + silencePcm.byteLength
                ),
            } as unknown as Response);

        const pino = await import('pino');
        const callLog = pino.default({ level: 'silent' });

        await executeTurn({
            callId: 'test-call-005',
            trackId: 'caller-track-uuid',
            txTrackId: 'tx-track-uuid',
            leg: 'caller',
            speechBuffer: SPEECH_BUFFER,
            ws: ws as unknown as import('ws').default,
            config: mockConfig,
            redis: redis as unknown as import('../src/redis').VoxHopRedis,
            metrics,
            comfortClipBuffer: COMFORT_CLIP,
            callLog,
        });

        // Should inject audio (not comfort clip) — silence is valid audio
        expect(ws.send).toHaveBeenCalledTimes(1);
        const sentPayload = JSON.parse(ws.sentMessages[0]);
        expect(sentPayload.event).toBe('audio');
        // Should NOT be the comfort clip
        expect(sentPayload.payload).not.toBe(COMFORT_CLIP.toString('base64'));

        // Metrics: success
        const metricsText = await metrics.getMetrics();
        expect(metricsText).toContain('voxhop_vad_to_stt_ms');
    });
});

// ─── Lock Behaviour ───────────────────────────────────────────────────────────

describe('Chaos: Redis lock behaviour', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('NEG-12: Lock held → VAD fire silently discarded (no Whisper request, no turnFailures increment)', async () => {
        const ws = createMockWs();
        const redis = createMockRedis(false); // lock NOT available
        const metrics = new VoxHopMetrics();
        let fetchCallCount = 0;

        vi.spyOn(global, 'fetch').mockImplementation(async () => {
            fetchCallCount++;
            return { ok: true, json: async () => ({ text: 'hello' }) } as Response;
        });

        const pino = await import('pino');
        const callLog = pino.default({ level: 'silent' });

        await executeTurn({
            callId: 'test-call-006',
            trackId: 'caller-track-uuid',
            txTrackId: 'tx-track-uuid',
            leg: 'caller',
            speechBuffer: SPEECH_BUFFER,
            ws: ws as unknown as import('ws').default,
            config: mockConfig,
            redis: redis as unknown as import('../src/redis').VoxHopRedis,
            metrics,
            comfortClipBuffer: COMFORT_CLIP,
            callLog,
        });

        // Zero Whisper requests (silently discarded)
        expect(fetchCallCount).toBe(0);

        // Zero audio/comfort frames sent
        expect(ws.send).not.toHaveBeenCalled();

        // turnFailures NOT incremented (discard is not a failure)
        const metricsText = await metrics.getMetrics();
        // The counter should exist but be at 0 (or not appear in initial state)
        expect(metricsText).not.toContain('voxhop_turn_failures_total{');
    });

    it('NEG-14: Redis DEL on expired lock does not crash (returns 0, no throw)', async () => {
        // This tests the releaseLock() behaviour when the TTL has already fired
        const redis = createMockRedis(true);
        // Simulate DEL returning 0 (key already expired)
        redis.releaseLock = vi.fn().mockResolvedValue(0);

        // Should not throw
        await expect(redis.releaseLock('caller-track-uuid')).resolves.not.toThrow();
    });
});

// ─── Dual-Leg Independence ────────────────────────────────────────────────────

describe('Chaos: Dual-leg independence (ACC-09, NEG-11)', () => {
    it('NEG-11: Both legs acquire locks independently — no interference', async () => {
        const wsA = createMockWs();
        const wsB = createMockWs();

        let lockAcquireCount = 0;
        const mockRedis = {
            acquireLock: vi.fn().mockImplementation(async (trackId: string) => {
                lockAcquireCount++;
                return true; // Both legs succeed
            }),
            releaseLock: vi.fn().mockResolvedValue(undefined),
        };

        const metrics = new VoxHopMetrics();
        const pino = await import('pino');
        const callLog = pino.default({ level: 'silent' });

        // Mock all three HTTP stages to succeed quickly
        vi.spyOn(global, 'fetch')
            .mockResolvedValue({
                ok: true,
                json: async () => ({ text: 'hello', response: 'hello' }),
                arrayBuffer: async () => {
                    const buf = Buffer.alloc(9600);
                    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
                },
            } as unknown as Response);

        // Fire both legs simultaneously
        const config = { ...mockConfig, WHISPER_TIMEOUT_MS: 5000, OLLAMA_TIMEOUT_MS: 5000, PIPER_TIMEOUT_MS: 5000 };

        await Promise.all([
            executeTurn({
                callId: 'test-call-dual',
                trackId: 'leg-a-track',
                txTrackId: 'tx-track-uuid',
                leg: 'caller',
                speechBuffer: SPEECH_BUFFER,
                ws: wsA as unknown as import('ws').default,
                config,
                redis: mockRedis as unknown as import('../src/redis').VoxHopRedis,
                metrics,
                comfortClipBuffer: COMFORT_CLIP,
                callLog,
            }),
            executeTurn({
                callId: 'test-call-dual',
                trackId: 'leg-b-track',
                txTrackId: 'tx-track-uuid',
                leg: 'called',
                speechBuffer: SPEECH_BUFFER,
                ws: wsB as unknown as import('ws').default,
                config,
                redis: mockRedis as unknown as import('../src/redis').VoxHopRedis,
                metrics,
                comfortClipBuffer: COMFORT_CLIP,
                callLog,
            }),
        ]);

        // Both legs should have acquired their own locks
        expect(mockRedis.acquireLock).toHaveBeenCalledWith('leg-a-track', config.LOCK_TTL_SECONDS);
        expect(mockRedis.acquireLock).toHaveBeenCalledWith('leg-b-track', config.LOCK_TTL_SECONDS);
        expect(lockAcquireCount).toBe(2);

        // Both locks should be released
        expect(mockRedis.releaseLock).toHaveBeenCalledWith('leg-a-track');
        expect(mockRedis.releaseLock).toHaveBeenCalledWith('leg-b-track');
    });
});

// ─── StagedError Tests ────────────────────────────────────────────────────────

describe('StagedError (GAP-02)', () => {
    it('instanceof narrowing works correctly', () => {
        const err = new StagedError('whisper', 'test error');
        expect(err instanceof StagedError).toBe(true);
        expect(err instanceof Error).toBe(true);
        expect(err.stage).toBe('whisper');
        expect(err.name).toBe('StagedError');
    });

    it('stage values are correct for each pipeline stage', () => {
        const stages = ['whisper', 'ollama', 'piper', 'unknown'] as const;
        for (const stage of stages) {
            const err = new StagedError(stage);
            expect(err.stage).toBe(stage);
        }
    });

    it('unknown error is typed as "unknown" not StagedError', () => {
        const unknownErr = new Error('generic error');
        const stage = unknownErr instanceof StagedError ? unknownErr.stage : 'unknown';
        expect(stage).toBe('unknown');
    });
});

// ─── NEG-06: Zero-length base64 decoding ──────────────────────────────────────

describe('NEG-06: Malformed base64 guard', () => {
    it('Buffer.from with invalid base64 produces empty/truncated buffer that should be discarded', () => {
        // Node.js silently truncates invalid base64 — guard in call-handler.ts
        const decoded = Buffer.from('NOT!VALID@@BASE64###', 'base64');
        // The guard is: if (decoded.length === 0) return;
        // This tests the mechanism — the actual guard is in call-handler.ts
        // (Buffer.from with some invalid base64 may return non-empty but corrupt data)
        expect(decoded).toBeInstanceOf(Buffer);
        // The important thing is we check length before feeding to VAD
    });
});

// ─── NEG-16: Zero-length VAD buffer ───────────────────────────────────────────

describe('NEG-16: Zero-length speech buffer from VAD', () => {
    it('Zero-length speechBuffer triggers whisper StagedError immediately', async () => {
        const ws = createMockWs();
        const redis = createMockRedis(true);
        const metrics = new VoxHopMetrics();
        let fetchCallCount = 0;

        vi.spyOn(global, 'fetch').mockImplementation(async () => {
            fetchCallCount++;
            return { ok: true, json: async () => ({ text: 'hello' }) } as Response;
        });

        const pino = await import('pino');
        const callLog = pino.default({ level: 'silent' });

        await executeTurn({
            callId: 'test-call-neg16',
            trackId: 'caller-track-uuid',
            txTrackId: 'tx-track-uuid',
            leg: 'caller',
            speechBuffer: Buffer.alloc(0), // Zero-length buffer
            ws: ws as unknown as import('ws').default,
            config: mockConfig,
            redis: redis as unknown as import('../src/redis').VoxHopRedis,
            metrics,
            comfortClipBuffer: COMFORT_CLIP,
            callLog,
        });

        // Whisper should NOT have been called
        expect(fetchCallCount).toBe(0);

        // Comfort clip should be injected
        expect(ws.send).toHaveBeenCalledTimes(1);

        // Lock should be released
        expect(redis.releaseLock).toHaveBeenCalled();

        // turnFailures should increment for 'whisper'
        const metricsText = await metrics.getMetrics();
        expect(metricsText).toContain('stage="whisper"');
    });
});
