/**
 * VoxHop Counterparty — Call Handler
 *
 * CounterpartyCallHandler manages the full lifecycle of one AI call:
 *   - call_initiated: parse persona from customData
 *   - media_started: init VAD, inject conversation opener
 *   - audio frames: feed VAD → run turn pipeline (half-duplex lock)
 *   - call_ended / WS close: cleanup
 *
 * CRITICAL: processingTurn must be set SYNCHRONOUSLY before any await.
 * JavaScript single-thread guarantees no concurrent message event fires
 * until current synchronous code completes.
 */

import pino from 'pino';
import type WebSocket from 'ws';
import { SileroVAD } from './silero-vad';
import { callWhisper, callOllamaStream, callPiper, splitSentences, injectAudio, StagedError, type OllamaMessage } from './pipeline';
import { downsampleTo16k } from './audio-utils';
import { CallInitiatedSchema, MediaStartedSchema, GenericFrameSchema, type Persona, type GenericFrame } from './schemas';
import type { Config } from './config';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

export class CounterpartyCallHandler {
    // ── Call session identity ────────────────────────────────────────────────
    private callId: string | null = null;
    private txTrackId: string | null = null;
    private rxTrackId: string | null = null;
    private persona: Persona | null = null;
    private isActive: boolean = true;
    private readonly startTime: number = Date.now();
    private readonly callLog: pino.Logger;

    // ── Pipeline half-duplex lock ────────────────────────────────────────────
    // Must be set SYNCHRONOUSLY before any await in handleAudioFrame().
    // Released in the finally block of runTurn().
    private processingTurn: boolean = false;

    // ── Conversation history — 50-turn FIFO ─────────────────────────────────
    // Cap at 100 entries (50 exchanges × 2 roles). shift() from front when exceeded.
    private conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [];

    // ── Per-call VAD instance ────────────────────────────────────────────────
    private vad: SileroVAD | null = null;

    // ── /events WebSocket reference ──────────────────────────────────────────
    // Set by server.ts when the Simulator connects to /events?callId=<uuid>.
    private eventsWs: WebSocket | null = null;

    constructor(
        private readonly audioWs: WebSocket,
        private readonly config: Config,
    ) {
        this.callLog = logger.child({ handler: 'CounterpartyCallHandler' });
    }

    /** Called by server.ts when an /events client connects with matching callId. */
    setEventsWs(ws: WebSocket): void {
        this.eventsWs = ws;
    }

    /** Expose callId for /events upgrade routing validation. */
    getCallId(): string | null {
        return this.callId;
    }

    /** Attach message/close/error handlers to the audio WebSocket. */
    start(): void {
        this.audioWs.on('message', (data: unknown) => {
            try {
                const raw = typeof data === 'string' ? data : (data as Buffer).toString('utf8');
                const parsed: unknown = JSON.parse(raw);
                this.handleMessage(parsed);
            } catch {
                // silently ignore non-JSON frames
            }
        });

        this.audioWs.on('close', () => {
            this.callLog.info({ callId: this.callId }, '/gamma/audio WebSocket closed');
            this.cleanup().catch(err => logger.error({ err }, 'cleanup error on ws.close'));
        });

        this.audioWs.on('error', (err: Error) => {
            this.callLog.error({ err, callId: this.callId }, '/gamma/audio WebSocket error');
        });
    }

    private handleMessage(parsed: unknown): void {
        const frame = GenericFrameSchema.safeParse(parsed);
        if (!frame.success) return;

        if (frame.data.event === 'audio') {
            this.handleAudioFrame(frame.data);
            return;
        }

        this.handleLifecycleEvent(frame.data.event, parsed);
    }

    private handleLifecycleEvent(event: string, raw: unknown): void {
        switch (event) {
            case 'call_initiated':
                this.handleCallInitiated(raw);
                break;
            case 'call_answered':
                this.callLog.debug({ callId: this.callId }, 'call_answered received');
                break;
            case 'media_started':
                this.handleMediaStarted(raw);
                break;
            case 'call_ended':
                this.callLog.info({ callId: this.callId }, 'call_ended received — cleaning up');
                this.cleanup().catch(err => logger.error({ err }, 'cleanup error on call_ended'));
                break;
            default:
                // silently discard unknown events (NEG-P2-07)
                break;
        }
    }

    private handleCallInitiated(raw: unknown): void {
        // NEG-P2-05: ignore if callId already set (first call wins)
        if (this.callId !== null) return;

        const result = CallInitiatedSchema.safeParse(raw);
        if (!result.success) {
            this.callLog.error({ errors: result.error.flatten() }, 'call_initiated schema invalid — closing WS 1008');
            this.audioWs.close(1008, 'Invalid call_initiated: missing or invalid persona');
            return;
        }

        this.callId = result.data.callId;
        this.persona = result.data.customData.persona;
        this.callLog.info({ callId: this.callId, persona: this.persona.name }, 'call_initiated accepted');
    }

    private handleMediaStarted(raw: unknown): void {
        if (!this.callId || !this.persona) {
            this.callLog.warn('media_started received before valid call_initiated — ignoring');
            return;
        }

        const result = MediaStartedSchema.safeParse(raw);
        if (!result.success) {
            this.callLog.error({ errors: result.error.flatten() }, 'media_started schema invalid — closing WS 1008');
            this.audioWs.close(1008, 'Invalid media_started');
            return;
        }

        this.rxTrackId = result.data.tracks[0].trackId;
        this.txTrackId = result.data.txTrackId;

        // Init VAD (ONNX model cached from startup warmup — ensureLoaded() is fast)
        this.vad = new SileroVAD({
            vadSilenceDurationMs: this.config.VAD_SILENCE_THRESHOLD_MS,
            vadMinSpeechDurationMs: this.config.VAD_MIN_SPEECH_MS,
        });
        this.vad.ensureLoaded().catch(err => logger.error({ err }, 'VAD ensureLoaded error'));

        this.callLog.info({ callId: this.callId, rxTrackId: this.rxTrackId, txTrackId: this.txTrackId }, 'media_started — VAD initialised');

        // Fire opener injection (does NOT set processingTurn)
        this.injectOpener().catch(err =>
            this.emitEvent({ event: 'pipeline_error', stage: 'opener', message: String(err) })
        );
    }

    /**
     * Conversation opener — synthesised immediately on media_started.
     * Does NOT set processingTurn. Failure emits pipeline_error but does NOT abort call.
     *
     * Uses splitSentences() for the same reason as runTurn(): Piper's subprocess pool
     * keeps processes alive between requests and uses 100 ms stdout silence to detect
     * "done". Multi-sentence text causes early cut-off, leaving sentence 2 buffered in
     * the subprocess stdout where it bleeds into the first user-turn Piper call.
     */
    private async injectOpener(): Promise<void> {
        if (!this.persona?.conversationOpener || !this.isActive) return;
        if (!this.callId || !this.txTrackId) return;

        try {
            const sentences = splitSentences(this.persona.conversationOpener);
            const pcmChunks: Buffer[] = [];
            for (const sentence of sentences) {
                const piperPcm = await callPiper(sentence, this.config, this.persona.piperVoice);
                pcmChunks.push(downsampleTo16k(piperPcm, 24000));
            }
            const fullPcm = Buffer.concat(pcmChunks);
            injectAudio(this.audioWs, this.callId, this.txTrackId, fullPcm);
            this.callLog.info({ callId: this.callId }, 'Conversation opener injected');
        } catch (err: unknown) {
            const stage = err instanceof StagedError ? err.stage : 'unknown';
            const message = err instanceof Error ? err.message : String(err);
            this.callLog.error({ stage, message }, 'Conversation opener failed');
            throw err;
        }
    }

    private handleAudioFrame(frame: GenericFrame): void {
        if (!this.callId || !this.txTrackId || !this.rxTrackId || !this.vad) return;
        if (frame.trackId !== this.rxTrackId) return; // discard non-caller tracks
        if (!frame.payload) return;

        // ── HALF-DUPLEX LOCK CHECK — top of handler, before any async ──────────
        if (this.processingTurn) return; // silently discard (NEG-P2-20)

        const decoded = Buffer.from(frame.payload, 'base64');
        if (decoded.length === 0) return; // NEG-P2-06: zero-length payload guard

        const speechBuffer = this.vad.feed(decoded);
        if (speechBuffer) {
            // ── SET LOCK SYNCHRONOUSLY before any await ────────────────────────
            // JavaScript single-thread: no concurrent message event fires until
            // this synchronous frame completes.
            this.processingTurn = true;
            void this.runTurn(speechBuffer);
        }
    }

    private async runTurn(speechBuffer: Buffer): Promise<void> {
        const t0 = Date.now();
        try {
            // Stage 1: Whisper STT
            let transcript: string;
            try {
                transcript = await callWhisper(speechBuffer, this.config, this.persona!.language);
            } catch (err: unknown) {
                const stage = err instanceof StagedError ? err.stage : 'unknown';
                this.emitEvent({ event: 'pipeline_error', stage, message: String(err), timestamp: Date.now() });
                return;
            }

            // Empty transcript = VAD false positive (noise burst with no recognisable speech).
            // Treat as a silent no-op: release the lock and wait for the next real utterance.
            // Do NOT emit pipeline_error — that would kill the call UI for a non-fatal event.
            if (!transcript.trim()) {
                this.callLog.debug({ callId: this.callId }, 'Whisper returned empty transcript — VAD false positive, skipping turn');
                return;
            }
            const t1 = Date.now();
            this.emitEvent({ event: 'transcript', role: 'user', text: transcript, timestamp: Date.now() });

            // Build chat messages: system prompt + conversation history + current input
            const messages: OllamaMessage[] = [
                { role: 'system', content: this.persona!.systemPrompt },
                ...this.conversationHistory,
                { role: 'user', content: transcript },
            ];

            // Stage 2: Ollama streaming
            let fullResponse: string;
            try {
                fullResponse = await callOllamaStream(
                    messages,
                    this.config,
                    (token) => this.emitEvent({ event: 'llm_token', token, timestamp: Date.now() }),
                );
            } catch (err: unknown) {
                const stage = err instanceof StagedError ? err.stage : 'unknown';
                this.emitEvent({ event: 'pipeline_error', stage, message: String(err), timestamp: Date.now() });
                return;
            }
            const t2 = Date.now();
            this.emitEvent({ event: 'transcript', role: 'counterparty', text: fullResponse, timestamp: Date.now() });

            // Update 50-turn FIFO history (100 entry cap)
            this.conversationHistory.push({ role: 'user', content: transcript });
            this.conversationHistory.push({ role: 'assistant', content: fullResponse });
            while (this.conversationHistory.length > 100) this.conversationHistory.shift();

            // Stage 3: Piper TTS — one call per sentence to avoid subprocess buffer contamination.
            // Sending the full multi-sentence text in one request causes Piper's 100 ms silence
            // detector to cut off after sentence 1, leaving sentence 2 buffered in the subprocess
            // stdout. That leftover audio then bleeds into the next turn's synthesis request.
            // Splitting into sentences and making separate requests keeps each call self-contained.
            const sentences = splitSentences(fullResponse);
            const pcmChunks: Buffer[] = [];
            try {
                for (const sentence of sentences) {
                    const piperPcm = await callPiper(sentence, this.config, this.persona!.piperVoice);
                    pcmChunks.push(downsampleTo16k(piperPcm, 24000));
                }
            } catch (err: unknown) {
                const stage = err instanceof StagedError ? err.stage : 'unknown';
                this.emitEvent({ event: 'pipeline_error', stage, message: String(err), timestamp: Date.now() });
                return;
            }
            const t3 = Date.now();

            // Concatenate all sentence PCM buffers and inject as a single audio event.
            const fullPcm = Buffer.concat(pcmChunks);
            injectAudio(this.audioWs, this.callId!, this.txTrackId!, fullPcm);
            const t4 = Date.now();

            this.emitEvent({
                event: 'turn_latency',
                sttMs: t1 - t0, llmMs: t2 - t1, ttsMs: t3 - t2, totalMs: t4 - t0,
                timestamp: Date.now(),
            });
        } finally {
            // ALWAYS release lock — even on early return from stage failure
            this.processingTurn = false;
        }
    }

    private emitEvent(payload: unknown): void {
        if (this.eventsWs?.readyState === 1 /* WebSocket.OPEN */) {
            this.eventsWs.send(JSON.stringify(payload));
        }
    }

    async cleanup(): Promise<void> {
        if (!this.isActive) return;
        this.isActive = false;
        this.conversationHistory = [];
        if (this.vad) {
            await this.vad.destroy();
            this.vad = null;
        }
        const durationMs = Date.now() - this.startTime;
        this.callLog.info({ callId: this.callId, durationMs }, 'Call ended — cleanup complete');
    }
}
