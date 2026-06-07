/**
 * VoxHop — Prometheus Metrics
 *
 * Four Prometheus histograms per §3.6 + turnFailures_total counter.
 *
 * Histograms (all per-turn, all with leg + outcome labels):
 *   voxhop_vad_to_stt_ms          — VAD fire to Whisper response received
 *   voxhop_stt_to_llm_first_token_ms — Whisper complete to Ollama first token
 *   voxhop_llm_to_tts_first_byte_ms  — Ollama complete to Piper first audio byte
 *   voxhop_tts_to_inject_ms       — Piper first byte to WebSocket audio frame sent
 *
 * Counter:
 *   voxhop_turn_failures_total — incremented on any pipeline stage failure
 *     Labels: stage (whisper|ollama|piper|unknown), leg (caller|called)
 */

import { Registry, Histogram, Counter } from 'prom-client';

// ─── Types ────────────────────────────────────────────────────────────────────

export type Leg = 'caller' | 'called';
export type Outcome =
    | 'success'
    | 'whisper_timeout'
    | 'ollama_timeout'
    | 'piper_timeout'
    | 'error';

export interface TurnMetricParams {
    t0: number; // VAD fire
    t1: number; // Whisper complete
    t2: number; // Ollama complete
    t3: number; // Piper complete
    t4: number; // Audio injected
    leg: Leg;
    outcome: Outcome;
}

export interface FailureMetricParams {
    stage: string;
    leg: Leg;
}

// ─── Registry & Metrics ───────────────────────────────────────────────────────

export class VoxHopMetrics {
    readonly registry: Registry;

    private readonly vadToSttMs: Histogram<'leg' | 'outcome'>;
    private readonly sttToLlmMs: Histogram<'leg' | 'outcome'>;
    private readonly llmToTtsMs: Histogram<'leg' | 'outcome'>;
    private readonly ttsToInjectMs: Histogram<'leg' | 'outcome'>;
    private readonly turnFailuresTotal: Counter<'stage' | 'leg'>;

    constructor() {
        this.registry = new Registry();

        // Latency buckets tuned for per-stage ranges (ms)
        const latencyBuckets = [50, 100, 200, 300, 500, 750, 1000, 1500, 2000];

        const labelNames: ('leg' | 'outcome')[] = ['leg', 'outcome'];

        this.vadToSttMs = new Histogram({
            name: 'voxhop_vad_to_stt_ms',
            help: 'Latency from VAD fire to Whisper STT response received (ms)',
            labelNames,
            buckets: latencyBuckets,
            registers: [this.registry],
        });

        this.sttToLlmMs = new Histogram({
            name: 'voxhop_stt_to_llm_first_token_ms',
            help: 'Latency from Whisper complete to Ollama first token received (ms)',
            labelNames,
            buckets: latencyBuckets,
            registers: [this.registry],
        });

        this.llmToTtsMs = new Histogram({
            name: 'voxhop_llm_to_tts_first_byte_ms',
            help: 'Latency from Ollama complete to Piper first audio byte received (ms)',
            labelNames,
            buckets: latencyBuckets,
            registers: [this.registry],
        });

        this.ttsToInjectMs = new Histogram({
            name: 'voxhop_tts_to_inject_ms',
            help: 'Latency from Piper first byte to WebSocket audio frame sent (ms)',
            labelNames,
            buckets: latencyBuckets,
            registers: [this.registry],
        });

        this.turnFailuresTotal = new Counter({
            name: 'voxhop_turn_failures_total',
            help: 'Total pipeline turn failures by stage and leg',
            labelNames: ['stage', 'leg'],
            registers: [this.registry],
        });
    }

    /**
     * Emit per-turn latency histograms on a successful turn.
     * All four histograms are emitted regardless of outcome.
     */
    emitTurn(params: TurnMetricParams): void {
        const { t0, t1, t2, t3, t4, leg, outcome } = params;
        const labels = { leg, outcome };

        this.vadToSttMs.observe(labels, t1 - t0);
        this.sttToLlmMs.observe(labels, t2 - t1);
        this.llmToTtsMs.observe(labels, t3 - t2);
        this.ttsToInjectMs.observe(labels, t4 - t3);
    }

    /**
     * Emit a turn failure: increment turnFailures_total and emit partial histograms.
     * Called when any pipeline stage times out or returns an error.
     */
    emitFailure(params: FailureMetricParams): void {
        const { stage, leg } = params;
        this.turnFailuresTotal.inc({ stage, leg });
    }

    /**
     * Emit histograms for a failed turn (partial timing data).
     * Emits what latency data is available up to the point of failure.
     */
    emitTurnOnFailure(params: {
        t0: number;
        t1?: number;
        t2?: number;
        t3?: number;
        t4?: number;
        leg: Leg;
        outcome: Outcome;
    }): void {
        const { t0, t1, t2, t3, t4, leg, outcome } = params;
        const labels = { leg, outcome };
        const now = Date.now();

        // Emit whatever latency data we have
        this.vadToSttMs.observe(labels, (t1 ?? now) - t0);
        if (t1 !== undefined) {
            this.sttToLlmMs.observe(labels, (t2 ?? now) - t1);
        }
        if (t2 !== undefined) {
            this.llmToTtsMs.observe(labels, (t3 ?? now) - t2);
        }
        if (t3 !== undefined) {
            this.ttsToInjectMs.observe(labels, (t4 ?? now) - t3);
        }
    }

    /**
     * Return Prometheus metrics text (for /metrics HTTP endpoint).
     */
    async getMetrics(): Promise<string> {
        return this.registry.metrics();
    }

    /**
     * Return the content type for the /metrics endpoint.
     */
    getContentType(): string {
        return this.registry.contentType;
    }
}
