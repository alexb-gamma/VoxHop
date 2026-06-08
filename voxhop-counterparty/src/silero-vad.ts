/**
 * VoxHop Counterparty — Silero VAD (Neural Voice Activity Detection)
 *
 * Copied verbatim from voxhop/src/silero-vad.ts.
 * No cross-package imports permitted (service boundary law).
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

/** Frame size for Silero VAD v5: 1536 samples = 96ms at 16kHz */
const FRAME_SAMPLES = 1536;
const SAMPLE_RATE = 16000;

export interface SileroVADConfig {
    /** Speech probability threshold (0.0–1.0, default 0.5) */
    vadSpeechThreshold?: number;

    /** Silence duration before end-of-turn, in ms (default 600) */
    vadSilenceDurationMs?: number;

    /** Minimum speech duration before triggering turn, in ms (default 250) */
    vadMinSpeechDurationMs?: number;
}

export class SileroVAD {
    private vad: RealTimeVAD | null = null;
    private initPromise: Promise<void> | null = null;

    private completedSegment: Buffer | null = null;

    private speechThreshold: number;
    private redemptionFrames: number;
    private minSpeechFrames: number;

    constructor(config?: SileroVADConfig) {
        this.speechThreshold = config?.vadSpeechThreshold ?? 0.5;

        const frameDurationMs = (FRAME_SAMPLES / SAMPLE_RATE) * 1000; // 96ms
        const silenceDurationMs = config?.vadSilenceDurationMs ?? 600;
        const minSpeechDurationMs = config?.vadMinSpeechDurationMs ?? 250;

        this.redemptionFrames = Math.ceil(silenceDurationMs / frameDurationMs);
        this.minSpeechFrames = Math.ceil(minSpeechDurationMs / frameDurationMs);

        this.initPromise = this.init();
    }

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

    feed(pcm16k: Buffer): Buffer | null {
        if (this.completedSegment) {
            const result = this.completedSegment;
            this.completedSegment = null;
            return result;
        }

        if (!this.vad) return null;

        const float32 = this.int16ToFloat32(pcm16k);

        this.vad.processAudio(float32).catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            logger.warn({ error: message }, 'SileroVAD: processAudio error');
        });

        return null;
    }

    reset(): void {
        this.completedSegment = null;
        if (this.vad) {
            this.vad.reset();
        }
    }

    async ensureLoaded(): Promise<void> {
        if (this.initPromise) {
            await this.initPromise;
            this.initPromise = null;
        }
    }

    async destroy(): Promise<void> {
        if (this.vad) {
            await this.vad.destroy();
            this.vad = null;
        }
    }

    private int16ToFloat32(pcm: Buffer): Float32Array {
        const numSamples = pcm.length / 2;
        const float32 = new Float32Array(numSamples);
        for (let i = 0; i < numSamples; i++) {
            float32[i] = pcm.readInt16LE(i * 2) / 32768;
        }
        return float32;
    }

    private float32ToInt16(audio: Float32Array): Buffer {
        const buffer = Buffer.alloc(audio.length * 2);
        for (let i = 0; i < audio.length; i++) {
            const sample = Math.max(-1, Math.min(1, audio[i]));
            buffer.writeInt16LE(Math.round(sample * 32767), i * 2);
        }
        return buffer;
    }
}
