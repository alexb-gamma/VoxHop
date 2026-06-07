/**
 * VoxHop — Zod Schemas for telco-ai-bridge WebSocket Protocol
 *
 * Three mandatory schemas per C-07:
 *   1. CallInitiatedSchema — call lifecycle event
 *   2. MediaStartedSchema  — media format + track IDs (C-02: tracks[] array)
 *   3. WhisperResponseSchema / OllamaResponseSchema — inference responses
 *
 * Protocol facts confirmed from telco-ai-bridge source:
 *   - media-worker/rx.go buildMediaStartedFrame: tracks[] array
 *   - media-worker/rx.go buildAudioFrame: event, callId, trackId, payload
 *   - media-worker/session.go buildLifecycleFrame: callId is bridge-assigned
 */

import { z } from 'zod';

// ─── Lifecycle Events ────────────────────────────────────────────────────────

export const CallInitiatedSchema = z.object({
    event: z.literal('call_initiated'),
    callId: z.string().min(1),
    timestamp: z.string(),
});

export type CallInitiated = z.infer<typeof CallInitiatedSchema>;

/**
 * MediaStartedSchema — C-02 compliant.
 * Uses tracks[] array, NOT flat callerTrackId/calledTrackId fields.
 * txTrackId is required — audio injection is impossible without it.
 */
export const MediaStartedSchema = z.object({
    event: z.literal('media_started'),
    callId: z.string().min(1),
    tracks: z
        .array(
            z.object({
                trackId: z.string().min(1),
                track: z.enum(['caller', 'called']),
            })
        )
        .min(1),
    txTrackId: z.string().min(1),
    mediaFormat: z.object({
        encoding: z.literal('audio/x-raw'),
        sampleRate: z.literal(16000),
        channels: z.literal(1),
        bitDepth: z.literal(16),
        payloadEncoding: z.literal('base64'),
    }),
    timestamp: z.string(),
});

export type MediaStarted = z.infer<typeof MediaStartedSchema>;

export const CallEndedSchema = z.object({
    event: z.literal('call_ended'),
    callId: z.string(),
    timestamp: z.string(),
});

export type CallEnded = z.infer<typeof CallEndedSchema>;

// ─── Audio Frames ────────────────────────────────────────────────────────────

export const AudioFrameSchema = z.object({
    event: z.literal('audio'),
    callId: z.string(),
    trackId: z.string(),
    track: z.string().optional(),
    sequence: z.number().optional(),
    timestamp: z.string().optional(),
    payload: z.string(), // base64-encoded S16LE 16kHz PCM
});

export type AudioFrame = z.infer<typeof AudioFrameSchema>;

// ─── Generic Frame (for routing) ─────────────────────────────────────────────

export const GenericFrameSchema = z.object({
    event: z.string(),
    callId: z.string().optional(),
    trackId: z.string().optional(),
    payload: z.string().optional(),
});

export type GenericFrame = z.infer<typeof GenericFrameSchema>;

// ─── Inference Response Schemas (C-07 schemas #2/#3) ─────────────────────────

/**
 * WhisperResponseSchema — GAP-01: uses z.string().min(1) not z.string().
 * Empty transcripts must trigger the comfort clip path (NEG-08).
 */
export const WhisperResponseSchema = z.object({
    text: z.string().min(1, { message: 'Whisper returned empty transcript' }),
});

export type WhisperResponse = z.infer<typeof WhisperResponseSchema>;

/**
 * OllamaResponseSchema — non-streaming (C-12: stream: false).
 */
export const OllamaResponseSchema = z.object({
    response: z.string().min(1, { message: 'Ollama returned empty response' }),
});

export type OllamaResponse = z.infer<typeof OllamaResponseSchema>;
