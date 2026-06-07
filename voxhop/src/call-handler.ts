/**
 * VoxHop — Call Handler
 *
 * VoxHopCallHandler manages the lifecycle of a single telco-ai-bridge call.
 *
 * State (SD-02):
 *   - legs: Map<trackId, LegState> — no leg management class hierarchy
 *   - isActive: boolean guard — prevents sends to closed WebSocket
 *
 * Message routing (SD-03):
 *   - ws.on('message') dispatches directly via legs.get(frame.trackId)
 *   - No EventEmitter between decoder and VAD dispatcher
 *
 * Key behaviours:
 *   - call_initiated: reads bridge-assigned callId (C-03, RF-03)
 *   - media_started: validates via Zod (C-02), txTrackId absent → WS close (NEG-01)
 *   - audio frames: routes by trackId, feeds VAD, dispatches executeTurn
 *   - call_ended / ws.close: explicit Redis cleanup (GAP-04, NEG-19, NEG-20)
 *
 * NEG-04: Second call_initiated is ignored — only first callId is accepted.
 * NEG-05: Unknown trackId audio frames are silently discarded.
 * NEG-06: Zero-length base64 payload is discarded before VAD feed.
 */

import type WebSocket from 'ws';
import pino from 'pino';
import { SileroVAD } from './silero-vad';
import type { VoxHopRedis } from './redis';
import type { VoxHopMetrics, Leg } from './metrics';
import type { Config } from './config';
import { executeTurn } from './pipeline';
import {
    CallInitiatedSchema,
    MediaStartedSchema,
    CallEndedSchema,
    GenericFrameSchema,
} from './schemas';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

// ─── Types ────────────────────────────────────────────────────────────────────

interface LegState {
    vad: SileroVAD;
    leg: Leg;
}

// ─── Frame Parser ─────────────────────────────────────────────────────────────

function parseFrame(raw: unknown): { event: string; callId?: string; trackId?: string; payload?: string } | null {
    try {
        const text = raw instanceof Buffer ? raw.toString('utf-8') : String(raw);
        const obj = JSON.parse(text) as unknown;
        const result = GenericFrameSchema.safeParse(obj);
        if (!result.success) return null;
        return result.data;
    } catch {
        return null;
    }
}

// ─── VoxHopCallHandler ────────────────────────────────────────────────────────

export class VoxHopCallHandler {
    private callId: string | null = null;
    private txTrackId: string | null = null;
    private legs: Map<string, LegState> = new Map();
    private isActive: boolean = true;
    private startTime: number = Date.now();
    private callLog: pino.Logger;

    constructor(
        private readonly ws: WebSocket,
        private readonly redis: VoxHopRedis,
        private readonly config: Config,
        private readonly comfortClipBuffer: Buffer,
        private readonly metrics: VoxHopMetrics
    ) {
        this.callLog = logger.child({ handler: 'VoxHopCallHandler' });
    }

    start(): void {
        this.ws.on('message', (raw) => {
            this.handleMessage(raw);
        });

        this.ws.on('close', (code, reason) => {
            this.callLog.info({ code, reason: reason.toString() }, 'WebSocket closed');
            this.cleanup().catch(err => {
                this.callLog.error({ err }, 'cleanup() error on ws.close');
            });
        });

        this.ws.on('error', (err) => {
            this.callLog.error({ err }, 'WebSocket error');
        });

        this.callLog.info('Call handler started — awaiting call_initiated');
    }

    private handleMessage(raw: unknown): void {
        const frame = parseFrame(raw);
        if (!frame) {
            // Silently discard unparseable frames
            return;
        }

        if (frame.event !== 'audio') {
            this.handleLifecycleEvent(frame, raw);
            return;
        }

        // ─── Audio frame routing (SD-03) ──────────────────────────────────

        if (!this.callId || !this.txTrackId) {
            // Audio arrived before media_started — discard (NEG-03 adjacent)
            return;
        }

        const trackId = frame.trackId;
        if (!trackId) return;

        const legState = this.legs.get(trackId);
        if (!legState) {
            // NEG-05: Unknown trackId — silently discard, no per-frame error log
            return;
        }

        const payload = frame.payload;
        if (!payload) return;

        const decoded = Buffer.from(payload, 'base64');

        // NEG-06: Guard against empty/malformed base64 payload
        if (decoded.length === 0) return;

        // SD-03: Direct vad.feed() return value — no EventEmitter
        const speechBuffer = legState.vad.feed(decoded);
        if (speechBuffer) {
            const callId = this.callId;
            const txTrackId = this.txTrackId;
            const legLog = this.callLog.child({ trackId, leg: legState.leg });

            executeTurn({
                callId,
                trackId,
                txTrackId,
                leg: legState.leg,
                speechBuffer,
                ws: this.ws,
                config: this.config,
                redis: this.redis,
                metrics: this.metrics,
                comfortClipBuffer: this.comfortClipBuffer,
                callLog: legLog,
            }).catch(err => {
                this.callLog.error({ err }, 'executeTurn unhandled error');
            });
        }
    }

    private handleLifecycleEvent(frame: ReturnType<typeof parseFrame>, raw: unknown): void {
        if (!frame) return;

        switch (frame.event) {
            case 'call_initiated':
                this.handleCallInitiated(raw);
                break;

            case 'media_started':
                this.handleMediaStarted(raw);
                break;

            case 'call_ended':
                this.handleCallEnded(raw);
                break;

            default:
                this.callLog.debug({ event: frame.event }, 'Unknown lifecycle event — ignoring');
        }
    }

    private handleCallInitiated(raw: unknown): void {
        // NEG-04: If callId already set, ignore subsequent call_initiated
        if (this.callId !== null) {
            this.callLog.warn(
                { existingCallId: this.callId },
                'Ignoring second call_initiated — call already established (NEG-04)'
            );
            return;
        }

        try {
            const text = raw instanceof Buffer ? raw.toString('utf-8') : String(raw);
            const obj = JSON.parse(text) as unknown;
            const result = CallInitiatedSchema.safeParse(obj);

            if (!result.success) {
                this.callLog.error(
                    { errors: result.error.flatten() },
                    'call_initiated schema validation failed'
                );
                return;
            }

            // C-03: Read callId from bridge — NEVER generate our own
            this.callId = result.data.callId;
            this.callLog = logger.child({ callId: this.callId });

            this.redis.initCallState(this.callId).catch(err => {
                this.callLog.error({ err }, 'Failed to initialise Redis call state');
            });

            this.callLog.info({ callId: this.callId }, 'Call initiated — Redis state written');
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            this.callLog.error({ error: message }, 'Error processing call_initiated');
        }
    }

    private handleMediaStarted(raw: unknown): void {
        // NEG-03: Ignore media_started if call_initiated not received
        if (this.callId === null) {
            this.callLog.warn(
                'media_started received before call_initiated — discarding (NEG-03)'
            );
            return;
        }

        try {
            const text = raw instanceof Buffer ? raw.toString('utf-8') : String(raw);
            const obj = JSON.parse(text) as unknown;
            const result = MediaStartedSchema.safeParse(obj);

            if (!result.success) {
                // NEG-02: Schema validation failure — fatal, close WebSocket immediately
                this.callLog.error(
                    { errors: result.error.flatten() },
                    'media_started schema validation failed — closing WebSocket (NEG-02)'
                );
                this.isActive = false;
                this.ws.close(1008, 'Invalid media format');
                return;
            }

            const frame = result.data;

            // txTrackId is required — guaranteed by schema (Zod rejects if absent per NEG-01)
            this.txTrackId = frame.txTrackId;

            // C-02: Extract track IDs from tracks[] array
            const callerTrack = frame.tracks.find(t => t.track === 'caller');
            const calledTrack = frame.tracks.find(t => t.track === 'called');

            if (!callerTrack || !calledTrack) {
                this.callLog.error(
                    { tracks: frame.tracks },
                    'media_started missing caller or called track — closing WebSocket'
                );
                this.isActive = false;
                this.ws.close(1008, 'Missing caller or called track');
                return;
            }

            // Initialise per-leg VAD instances
            // Note: VAD instances are pre-warmed in index.ts startup sequence (C-08)
            // Here we create new instances per call — they need no pre-warming since
            // the ONNX model is cached by avr-vad
            const callerVad = new SileroVAD({
                vadSilenceDurationMs: this.config.VAD_SILENCE_THRESHOLD_MS,
                vadMinSpeechDurationMs: this.config.VAD_MIN_SPEECH_MS,
            });

            const calledVad = new SileroVAD({
                vadSilenceDurationMs: this.config.VAD_SILENCE_THRESHOLD_MS,
                vadMinSpeechDurationMs: this.config.VAD_MIN_SPEECH_MS,
            });

            // Pre-warm the per-call VAD instances
            Promise.all([callerVad.ensureLoaded(), calledVad.ensureLoaded()]).catch(err => {
                this.callLog.error({ err }, 'Failed to pre-warm per-call VAD instances');
            });

            this.legs.set(callerTrack.trackId, { vad: callerVad, leg: 'caller' });
            this.legs.set(calledTrack.trackId, { vad: calledVad, leg: 'called' });

            this.callLog.info(
                {
                    callId: this.callId,
                    callerTrackId: callerTrack.trackId,
                    calledTrackId: calledTrack.trackId,
                    txTrackId: this.txTrackId,
                    mediaFormat: frame.mediaFormat,
                },
                'media_started — dual-leg VAD initialised'
            );
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            this.callLog.error({ error: message }, 'Error processing media_started');
        }
    }

    private handleCallEnded(raw: unknown): void {
        this.callLog.info('call_ended received — cleaning up');
        this.cleanup().catch(err => {
            this.callLog.error({ err }, 'cleanup() error on call_ended');
        });
    }

    /**
     * Clean up call state on call_ended or WebSocket close.
     *
     * GAP-04 / NEG-19 / NEG-20:
     *   1. Set isActive = false to prevent new sends
     *   2. Release all leg locks FIRST (before cleanupCallState)
     *   3. Delete call Redis state
     *   4. Emit structured call-summary log
     */
    async cleanup(): Promise<void> {
        if (!this.isActive) return;
        this.isActive = false;

        const callId = this.callId;

        // GAP-04: Release all leg locks FIRST — before deleting call state
        for (const [trackId] of this.legs) {
            try {
                await this.redis.releaseLock(trackId);
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                this.callLog.warn({ trackId, error: message }, 'Failed to release leg lock during cleanup');
            }
        }

        // Destroy all VAD instances
        for (const [, legState] of this.legs) {
            legState.vad.destroy().catch(() => {
                // Ignore VAD destroy errors during cleanup
            });
        }

        this.legs.clear();

        // Clean up Redis call state
        if (callId) {
            try {
                await this.redis.cleanupCallState(callId);
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                this.callLog.warn({ callId, error: message }, 'Failed to cleanup Redis call state');
            }
        }

        const durationMs = Date.now() - this.startTime;
        this.callLog.info(
            { callId, durationMs },
            'Call ended — cleanup complete'
        );
    }
}
