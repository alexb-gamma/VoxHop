/**
 * VoxHop Counterparty — Entry Point
 *
 * Startup sequence (§7.9):
 *   1. validateConfig() — fail fast on invalid env
 *   2. VAD ONNX pre-warm — BEFORE port bind
 *   3. server.listen()
 *
 * Port MUST NOT bind if either step 1 or 2 fails.
 */

import pino from 'pino';
import { validateConfig } from './config';
import { SileroVAD } from './silero-vad';
import { startServer } from './server';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

async function main(): Promise<void> {
    logger.info('voxhop-counterparty starting...');

    // Step 1: Config validation
    const config = validateConfig();

    // Step 2: VAD ONNX warm-up (BEFORE port bind)
    logger.info('Pre-warming Silero VAD ONNX model...');
    const warmupVad = new SileroVAD({
        vadSilenceDurationMs: config.VAD_SILENCE_THRESHOLD_MS,
        vadMinSpeechDurationMs: config.VAD_MIN_SPEECH_MS,
    });
    try {
        await warmupVad.ensureLoaded();
    } catch (err: unknown) {
        logger.error({ err }, 'VAD ONNX model failed to load — aborting startup');
        process.exit(1);
    }
    await warmupVad.destroy();
    logger.info('Silero VAD ONNX model pre-warmed successfully');

    // Step 3: Start server (port binds here — after all pre-conditions satisfied)
    const server = startServer(config);
    server.listen(config.PORT, () => {
        logger.info({ port: config.PORT }, 'voxhop-counterparty listening');
    });

    // Graceful shutdown
    const shutdown = async (signal: string): Promise<void> => {
        logger.info({ signal }, 'Shutting down...');
        server.close(() => process.exit(0));
    };
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT',  () => void shutdown('SIGINT'));
}

main().catch(err => { logger.error({ err }, 'main() threw'); process.exit(1); });
