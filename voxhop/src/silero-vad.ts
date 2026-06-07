/**
 * VoxHop — Silero VAD (Neural Voice Activity Detection)
 *
 * COPIED verbatim from HelloSurgery/gpu-voice-agent/src/silero-vad.ts
 * with the following adaptations:
 *   - Replaced loadLocalVoiceConfig() wiring with Zod-validated env vars
 *   - SileroVADConfig now accepts validated numeric values directly
 *
 * Drop-in VAD using Silero VAD v5 via the avr-vad npm package
 * (wraps onnxruntime-node with the bundled ONNX model).
 *
 * Interface contract: feed(pcm16k: Buffer): Buffer | null
 *   - Returns accumulated speech buffer when turn complete, or null
 *
 * Per C-08: Instances must be pre-warmed via ensureLoaded() before
 * the WebSocket server binds. Cold ONNX init silently drops early frames.
 *
 * Per C-11: commonjs module (avr-vad ESM interop issue with Node.js 20).
 */

import { RealTimeVAD } from 'avr-vad';
import type { RealTimeVADOptions } from 'avr-vad';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

/** Frame size for Silero VAD v5: 1536 samples = 96ms at 16kHz (GAP-05 fix) */
const FRAME_SAMPLES = 1536;
const SAMPLE_RATE = 16000;

export interface SileroVADConfig {
    /** Speech probability threshold (0.0–1.0, default 0.5) */
    vadSpeechThreshold?: number;

    /** Silence duration before end-of-turn, in ms (default 600, env-var validated) */
    vadSilenceDurationMs?: number;

    /** Minimum speech duration before triggering turn, in ms (default 250, env-var validated) */
    vadMinSpeechDurationMs?: number;
}

export class SileroVAD {
    private vad: RealTimeVAD | null = null;
    private initPromise: Promise<void> | null = null;

    // Completed speech segments — set by onSpeechEnd callback, consumed by feed()
    private completedSegment: Buffer | null = null;

    // Config
    private speechThreshold: number;
    private redemptionFrames: number;
    private minSpeechFrames: number;

    constructor(config?: SileroVADConfig) {
        this.speechThreshold = config?.vadSpeechThreshold ?? 0.5;

        // Convert ms-based config to frame counts for avr-vad
        // Frame duration = FRAME_SAMPLES / SAMPLE_RATE = 1536 / 16000 = 96ms
        const frameDurationMs = (FRAME_SAMPLES / SAMPLE_RATE) * 1000; // 96ms
        const silenceDurationMs = config?.vadSilenceDurationMs ?? 600;
        const minSpeechDurationMs = config?.vadMinSpeechDurationMs ?? 250;

        // redemptionFrames: how many frames of silence before triggering end-of-speech
        // 600ms / 96ms ≈ 6.25 → 7 frames
        this.redemptionFrames = Math.ceil(silenceDurationMs / frameDurationMs);

        // minSpeechFrames: minimum frames of speech before accepting as valid
        // 250ms / 96ms ≈ 2.6 → 3 frames
        this.minSpeechFrames = Math.ceil(minSpeechDurationMs / frameDurationMs);

        // Start async initialisation immediately
        this.initPromise = this.init();
    }

    /**
     * Initialise the Silero VAD ONNX model with callback handlers.
     */
    private async init(): Promise<void> {
        try {
            this.vad = await RealTimeVAD.new({
                model: 'legacy',
                sampleRate: SAMPLE_RATE,
                positiveSpeechThreshold: this.speechThreshold,
                negativeSpeechThreshold: this.speechThreshold * 0.7,
                frameSamples: FRAME_SAMPLES,
                redemptionFrames: this.redemptionFrames,
                minSpeechFrames: this.minSpeechFrames,
                preSpeechPadFrames: 1,
                submitUserSpeechOnPause: false,

                onSpeechStart: () => {
                    logger.debug('SileroVAD: speech started');
                },

                onSpeechRealStart: () => {
                    logger.debug('SileroVAD: speech confirmed (past min duration gate)');
                },

                onSpeechEnd: (audio: Float32Array) => {
                    const pcmBuffer = this.float32ToInt16(audio);
                    const durationMs = (audio.length / SAMPLE_RATE) * 1000;

                    logger.info(
                        { durationMs: Math.round(durationMs), samples: audio.length },
                        'SileroVAD: speech segment complete'
                    );

                    this.completedSegment = pcmBuffer;
                },

                onVADMisfire: () => {
                    logger.debug('SileroVAD: misfire (speech too short, discarded)');
                },

                onFrameProcessed: (probs: { isSpeech: number }) => {
                    if (process.env.LOG_LEVEL === 'trace') {
                        logger.trace({ isSpeech: probs.isSpeech.toFixed(3) }, 'SileroVAD: frame');
                    }
                },
            } as Partial<RealTimeVADOptions>);

            this.vad.start();
            logger.info(
                {
                    threshold: this.speechThreshold,
                    redemptionFrames: this.redemptionFrames,
                    minSpeechFrames: this.minSpeechFrames,
                },
                'SileroVAD: ONNX model loaded (legacy, in-process)'
            );
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            logger.error({ error: message }, 'SileroVAD: failed to load ONNX model');
            throw err;
        }
    }

    /**
     * Feed PCM audio and detect end-of-speech.
     *
     * Interface contract (per SD-03):
     *   - Input:  Buffer of int16 LE PCM samples at 16kHz
     *   - Output: Buffer of accumulated speech when turn complete, or null
     *
     * The completedSegment is returned on the next feed() call after onSpeechEnd fires.
     * At 20ms audio chunks this adds at most 20ms latency — imperceptible in conversation.
     */
    feed(pcm16k: Buffer): Buffer | null {
        // Check for completed speech segment from previous processing
        if (this.completedSegment) {
            const result = this.completedSegment;
            this.completedSegment = null;
            return result;
        }

        // If model hasn't loaded yet, skip processing
        if (!this.vad) return null;

        // Convert int16 LE → Float32 normalised [-1.0, 1.0]
        const float32 = this.int16ToFloat32(pcm16k);

        // Feed to avr-vad (async, but we consume results via callback)
        this.vad.processAudio(float32).catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            logger.warn({ error: message }, 'SileroVAD: processAudio error');
        });

        return null;
    }

    /**
     * Reset VAD state. Called when session ends or between turns.
     */
    reset(): void {
        this.completedSegment = null;
        if (this.vad) {
            this.vad.reset();
        }
    }

    /**
     * Ensure the ONNX model is loaded. Call this during startup BEFORE
     * binding the WebSocket server (C-08).
     */
    async ensureLoaded(): Promise<void> {
        if (this.initPromise) {
            await this.initPromise;
            this.initPromise = null;
        }
    }

    /**
     * Clean up ONNX runtime resources.
     */
    async destroy(): Promise<void> {
        if (this.vad) {
            await this.vad.destroy();
            this.vad = null;
        }
    }

    // ─── Audio Format Conversion ─────────────────────────────────────────────

    /**
     * Convert Buffer of int16 LE samples to Float32Array normalised [-1.0, 1.0].
     */
    private int16ToFloat32(pcm: Buffer): Float32Array {
        const numSamples = pcm.length / 2;
        const float32 = new Float32Array(numSamples);
        for (let i = 0; i < numSamples; i++) {
            float32[i] = pcm.readInt16LE(i * 2) / 32768;
        }
        return float32;
    }

    /**
     * Convert Float32Array [-1.0, 1.0] back to Buffer of int16 LE samples.
     */
    private float32ToInt16(audio: Float32Array): Buffer {
        const buffer = Buffer.alloc(audio.length * 2);
        for (let i = 0; i < audio.length; i++) {
            const sample = Math.max(-1, Math.min(1, audio[i]));
            buffer.writeInt16LE(Math.round(sample * 32767), i * 2);
        }
        return buffer;
    }
}
