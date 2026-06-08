/**
 * VoxHop Counterparty — Wire Protocol Schemas
 *
 * All schemas are Counterparty-local — no imports from voxhop/src/schemas.ts.
 * Service boundary law: schema duplication is intentional.
 */
import { z } from 'zod';

// PersonaSchema — MUST be identical to voxhop-simulator PersonaSchema.
// Deliberately duplicated per service boundary law.
// When persona fields change, both files must be updated in the same commit.
export const PersonaSchema = z.object({
  id:                 z.string().min(1),
  name:               z.string().min(1),
  language:           z.string().min(1),
  piperVoice:         z.string().min(1),
  systemPrompt:       z.string().min(1),
  conversationOpener: z.string().optional(),
});
export type Persona = z.infer<typeof PersonaSchema>;

// CallInitiatedSchema — extends base with required customData.persona
// If customData is absent or persona fails validation, handler closes WS with code 1008.
export const CallInitiatedSchema = z.object({
  event:      z.literal('call_initiated'),
  callId:     z.string().min(1),
  timestamp:  z.string(),
  customData: z.object({
    persona: PersonaSchema,
  }),
});
export type CallInitiated = z.infer<typeof CallInitiatedSchema>;

// MediaStartedSchema — SINGLE caller track only.
// Uses z.literal('caller') — NOT z.enum(['caller', 'called']).
// The Counterparty IS the called party; only the caller's track arrives.
export const MediaStartedSchema = z.object({
  event:      z.literal('media_started'),
  callId:     z.string().min(1),
  tracks:     z.array(z.object({
    trackId:  z.string().min(1),
    track:    z.literal('caller'),
  })).min(1),
  txTrackId:  z.string().min(1),
  mediaFormat: z.object({
    encoding:        z.literal('audio/x-raw'),
    sampleRate:      z.literal(16000),
    channels:        z.literal(1),
    bitDepth:        z.literal(16),
    payloadEncoding: z.literal('base64'),
  }),
  timestamp: z.string(),
});
export type MediaStarted = z.infer<typeof MediaStartedSchema>;

// AudioFrameSchema — incoming caller audio
export const AudioFrameSchema = z.object({
  event:     z.literal('audio'),
  callId:    z.string(),
  trackId:   z.string(),
  payload:   z.string(), // base64-encoded S16LE 16kHz PCM
  timestamp: z.string().optional(),
  sequence:  z.number().optional(),
});
export type AudioFrame = z.infer<typeof AudioFrameSchema>;

// OllamaStreamChunkSchema — Engineering correction:
// /api/chat streaming returns { message: { role, content }, done } NOT { response, done }.
// { response, done } is the /api/generate format.
export const OllamaStreamChunkSchema = z.object({
  message: z.object({
    role:    z.string(),
    content: z.string(),
  }),
  done: z.boolean(),
});
export type OllamaStreamChunk = z.infer<typeof OllamaStreamChunkSchema>;

// WhisperResponseSchema — allow empty string; empty transcript is handled by
// the caller as a silent no-op (VAD false positive), not a pipeline error.
export const WhisperResponseSchema = z.object({
  text: z.string(),
});
export type WhisperResponse = z.infer<typeof WhisperResponseSchema>;

// GenericFrameSchema — for event-type routing before full parse
export const GenericFrameSchema = z.object({
  event:   z.string(),
  callId:  z.string().optional(),
  trackId: z.string().optional(),
  payload: z.string().optional(),
});
export type GenericFrame = z.infer<typeof GenericFrameSchema>;
