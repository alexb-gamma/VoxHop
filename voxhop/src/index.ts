/**
 * VoxHop — Entry Point
 *
 * Startup sequence (STRICT ORDER per §4.4.1):
 *   1. validateConfig() — Zod env validation, process.exit on failure (C-07)
 *   2. Pre-warm VAD instances via ensureLoaded() BEFORE binding WS server (C-08)
 *   3. Load comfort clip via readFileSync — process.exit if missing or 0 bytes (C-09)
 *   4. startWebServer() — only after all above succeed
 *
 * If any startup step fails, process exits with non-zero code and the
 * WebSocket server port is NEVER bound (NEG-21, NEG-22).
 */

import pino from 'pino';
import { validateConfig } from './config';
import { SileroVAD } from './silero-vad';
import { loadComfortClip } from './comfort';
import { VoxHopRedis } from './redis';
import { VoxHopMetrics } from './metrics';
import { startWebServer } from './web-server';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

async function main(): Promise<void> {
    logger.info('VoxHop starting...');

    // ─── Step 1: Validate environment configuration (C-07) ────────────────
    logger.info('Step 1/4: Validating environment configuration...');
    const config = validateConfig();
    logger.info({ port: config.PORT }, 'Configuration validated successfully');

    // ─── Step 2: Pre-warm VAD ONNX model (C-08) ───────────────────────────
    // Pre-warm TWO instances (caller + called) to detect any ONNX init failures
    // before accepting any connections. Cold init silently drops early frames.
    logger.info('Step 2/4: Pre-warming Silero VAD ONNX model...');
    const callerVadWarm = new SileroVAD({
        vadSilenceDurationMs: config.VAD_SILENCE_THRESHOLD_MS,
        vadMinSpeechDurationMs: config.VAD_MIN_SPEECH_MS,
    });
    const calledVadWarm = new SileroVAD({
        vadSilenceDurationMs: config.VAD_SILENCE_THRESHOLD_MS,
        vadMinSpeechDurationMs: config.VAD_MIN_SPEECH_MS,
    });

    try {
        await Promise.all([
            callerVadWarm.ensureLoaded(),
            calledVadWarm.ensureLoaded(),
        ]);
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ error: message }, 'VoxHop startup failed: VAD ONNX model failed to load');
        process.exit(1);
    }

    // Destroy the warm-up instances — per-call instances are created in call-handler.ts
    await Promise.all([callerVadWarm.destroy(), calledVadWarm.destroy()]);
    logger.info('Silero VAD ONNX model pre-warmed successfully');

    // ─── Step 3: Load comfort clip (C-09) ─────────────────────────────────
    // loadComfortClip() calls process.exit if file missing or 0 bytes (NEG-21, NEG-22)
    logger.info(`Step 3/4: Loading comfort clip from ${config.COMFORT_CLIP_PATH}...`);
    const comfortClipBuffer = loadComfortClip(config.COMFORT_CLIP_PATH);

    // ─── Initialise Redis and Metrics ─────────────────────────────────────
    const redis = new VoxHopRedis(config.REDIS_URL);
    const metrics = new VoxHopMetrics();

    // ─── Step 4: Start WebSocket server (C-01) ────────────────────────────
    logger.info('Step 4/4: Starting WebSocket server...');
    startWebServer(config, redis, metrics, comfortClipBuffer);

    logger.info(
        {
            port: config.PORT,
            redisUrl: config.REDIS_URL,
            whisperUrl: config.WHISPER_URL,
            ollamaUrl: config.OLLAMA_URL,
            piperUrl: config.PIPER_URL,
            comfortClipPath: config.COMFORT_CLIP_PATH,
            vadSilenceThresholdMs: config.VAD_SILENCE_THRESHOLD_MS,
            vadMinSpeechMs: config.VAD_MIN_SPEECH_MS,
        },
        'VoxHop ready — waiting for telco-ai-bridge connections on /ws/calls'
    );

    // ─── Graceful shutdown ────────────────────────────────────────────────
    const shutdown = async (signal: string): Promise<void> => {
        logger.info({ signal }, 'VoxHop shutting down gracefully...');
        await redis.disconnect();
        logger.info('Shutdown complete');
        process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    process.on('unhandledRejection', (reason, promise) => {
        logger.error({ reason, promise }, 'Unhandled promise rejection — this is a bug');
        // Do NOT crash on unhandledRejection in production — log and continue
        // A crashed VoxHop process drops ALL concurrent calls on the instance
    });
}

main().catch(err => {
    logger.error({ err }, 'VoxHop main() threw unexpectedly');
    process.exit(1);
});
