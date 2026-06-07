/**
 * VoxHop — Environment Configuration
 *
 * Zod schema for all environment variables. Process exits with
 * descriptive error on any invalid value (C-07 schema #1).
 */

import { z } from 'zod';
import pino from 'pino';

const logger = pino({ level: 'info' });

const ConfigSchema = z.object({
    // Server
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),

    // Redis
    REDIS_URL: z.string().url().default('redis://localhost:6379'),

    // Inference service URLs
    WHISPER_URL: z.string().url().default('http://localhost:8001'),
    OLLAMA_URL: z.string().url().default('http://localhost:11434'),
    PIPER_URL: z.string().url().default('http://localhost:5000'),

    // Ollama model
    OLLAMA_MODEL: z.string().default('gemma2:2b'),

    // Timeouts (ms)
    WHISPER_TIMEOUT_MS: z.coerce.number().int().positive().default(1000),
    OLLAMA_TIMEOUT_MS: z.coerce.number().int().positive().default(500),
    PIPER_TIMEOUT_MS: z.coerce.number().int().positive().default(300),

    // Redis lock TTL (seconds)
    LOCK_TTL_SECONDS: z.coerce.number().int().min(1).max(300).default(10),

    // VAD configuration (validated ranges per §3.2)
    VAD_SILENCE_THRESHOLD_MS: z.coerce
        .number()
        .int()
        .min(200, { message: 'VAD_SILENCE_THRESHOLD_MS must be >= 200ms' })
        .max(2000, { message: 'VAD_SILENCE_THRESHOLD_MS must be <= 2000ms' })
        .default(600),

    VAD_MIN_SPEECH_MS: z.coerce
        .number()
        .int()
        .min(50, { message: 'VAD_MIN_SPEECH_MS must be >= 50ms' })
        .max(1000, { message: 'VAD_MIN_SPEECH_MS must be <= 1000ms' })
        .default(250),

    // Comfort clip
    COMFORT_CLIP_PATH: z.string().default('/opt/voxhop/audio/comfort_en.pcm'),

    // Logging
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
});

export type Config = z.infer<typeof ConfigSchema>;

/**
 * Validate and return the environment configuration.
 * Calls process.exit(1) on validation failure with descriptive error.
 */
export function validateConfig(): Config {
    const result = ConfigSchema.safeParse(process.env);
    if (!result.success) {
        logger.error(
            { errors: result.error.flatten() },
            'VoxHop startup failed: invalid environment configuration'
        );
        logger.error({ validationErrors: result.error.message }, 'Configuration validation errors');
        process.exit(1);
    }
    return result.data;
}
