/**
 * VoxHop Counterparty — Configuration
 *
 * Zod-validated environment variables. No Redis, no lock TTL, no comfort clip.
 * Timeouts are longer than Track 1 — real LLM generation takes seconds.
 */
import { z } from 'zod';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

const ConfigSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),

  // Inference service URLs
  WHISPER_URL: z.string().url().default('http://localhost:8001'),
  OLLAMA_URL:  z.string().url().default('http://localhost:11434'),
  PIPER_URL:   z.string().url().default('http://localhost:5000'),

  // Ollama model
  OLLAMA_MODEL: z.string().default('gemma4'),

  // Timeouts (ms) — realistic for conversational pipeline (NOT echo-mode)
  WHISPER_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  OLLAMA_TIMEOUT_MS:  z.coerce.number().int().positive().default(30000),
  PIPER_TIMEOUT_MS:   z.coerce.number().int().positive().default(10000),

  // VAD (same validated ranges as Track 1)
  VAD_SILENCE_THRESHOLD_MS: z.coerce.number().int().min(200).max(2000).default(600),
  VAD_MIN_SPEECH_MS:        z.coerce.number().int().min(50).max(1000).default(250),

  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
});

export type Config = z.infer<typeof ConfigSchema>;

export function validateConfig(): Config {
  const result = ConfigSchema.safeParse(process.env);
  if (!result.success) {
    logger.error({ errors: result.error.flatten() }, 'Counterparty startup failed: invalid configuration');
    process.exit(1);
  }
  return result.data;
}
