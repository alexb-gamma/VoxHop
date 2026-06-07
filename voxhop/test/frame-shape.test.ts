/**
 * VoxHop — Frame Shape Tests
 *
 * Zod schema parse/reject tests against telco-ai-bridge frame samples.
 * Validates C-02, C-03, GAP-01 compliance.
 */

import { describe, it, expect } from 'vitest';
import {
    CallInitiatedSchema,
    MediaStartedSchema,
    WhisperResponseSchema,
    OllamaResponseSchema,
} from '../src/schemas';

// ─── call_initiated ───────────────────────────────────────────────────────────

describe('CallInitiatedSchema', () => {
    it('parses a valid call_initiated frame (C-03: bridge-assigned callId)', () => {
        const frame = {
            event: 'call_initiated',
            callId: 'bridge-call-abc123',
            timestamp: '2026-06-05T12:00:00.000Z',
        };
        const result = CallInitiatedSchema.safeParse(frame);
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.callId).toBe('bridge-call-abc123');
            expect(result.data.event).toBe('call_initiated');
        }
    });

    it('rejects call_initiated with missing callId', () => {
        const frame = {
            event: 'call_initiated',
            timestamp: '2026-06-05T12:00:00.000Z',
        };
        const result = CallInitiatedSchema.safeParse(frame);
        expect(result.success).toBe(false);
    });

    it('rejects call_initiated with wrong event type', () => {
        const frame = {
            event: 'media_started',
            callId: 'abc123',
            timestamp: '2026-06-05T12:00:00.000Z',
        };
        const result = CallInitiatedSchema.safeParse(frame);
        expect(result.success).toBe(false);
    });
});

// ─── media_started ────────────────────────────────────────────────────────────

describe('MediaStartedSchema', () => {
    const validMediaStarted = {
        event: 'media_started',
        callId: 'bridge-call-abc123',
        tracks: [
            { trackId: 'track-caller-uuid', track: 'caller' },
            { trackId: 'track-called-uuid', track: 'called' },
        ],
        txTrackId: 'tx-track-uuid-inject',
        mediaFormat: {
            encoding: 'audio/x-raw',
            sampleRate: 16000,
            channels: 1,
            bitDepth: 16,
            payloadEncoding: 'base64',
        },
        timestamp: '2026-06-05T12:00:00.000Z',
    };

    it('parses valid media_started with tracks[] array (C-02)', () => {
        const result = MediaStartedSchema.safeParse(validMediaStarted);
        expect(result.success).toBe(true);
        if (result.success) {
            // Confirm C-02 pattern: extract via tracks.find()
            const callerTrackId = result.data.tracks.find(t => t.track === 'caller')?.trackId;
            const calledTrackId = result.data.tracks.find(t => t.track === 'called')?.trackId;
            expect(callerTrackId).toBe('track-caller-uuid');
            expect(calledTrackId).toBe('track-called-uuid');
            expect(result.data.txTrackId).toBe('tx-track-uuid-inject');
        }
    });

    it('rejects media_started without txTrackId (NEG-01)', () => {
        const frame = { ...validMediaStarted };
        const { txTrackId: _, ...frameWithoutTx } = frame;
        const result = MediaStartedSchema.safeParse(frameWithoutTx);
        expect(result.success).toBe(false);
    });

    it('rejects media_started with sampleRate: 8000 (NEG-02)', () => {
        const frame = {
            ...validMediaStarted,
            mediaFormat: {
                ...validMediaStarted.mediaFormat,
                sampleRate: 8000,
            },
        };
        const result = MediaStartedSchema.safeParse(frame);
        expect(result.success).toBe(false);
        if (!result.success) {
            const errorPaths = result.error.issues.map(i => i.path.join('.'));
            expect(errorPaths.some(p => p.includes('sampleRate'))).toBe(true);
        }
    });

    it('rejects media_started with wrong encoding (NEG-02)', () => {
        const frame = {
            ...validMediaStarted,
            mediaFormat: {
                ...validMediaStarted.mediaFormat,
                encoding: 'audio/pcma',
            },
        };
        const result = MediaStartedSchema.safeParse(frame);
        expect(result.success).toBe(false);
    });

    it('rejects media_started with channels: 2 (NEG-02)', () => {
        const frame = {
            ...validMediaStarted,
            mediaFormat: {
                ...validMediaStarted.mediaFormat,
                channels: 2,
            },
        };
        const result = MediaStartedSchema.safeParse(frame);
        expect(result.success).toBe(false);
    });

    it('rejects media_started with empty tracks array', () => {
        const frame = {
            ...validMediaStarted,
            tracks: [],
        };
        const result = MediaStartedSchema.safeParse(frame);
        expect(result.success).toBe(false);
    });

    it('rejects media_started with invalid track label', () => {
        const frame = {
            ...validMediaStarted,
            tracks: [
                { trackId: 'track-uuid', track: 'unknown_leg' },
            ],
        };
        const result = MediaStartedSchema.safeParse(frame);
        expect(result.success).toBe(false);
    });
});

// ─── WhisperResponseSchema (GAP-01) ──────────────────────────────────────────

describe('WhisperResponseSchema', () => {
    it('parses a valid Whisper response', () => {
        const resp = { text: 'Hello, how are you?' };
        const result = WhisperResponseSchema.safeParse(resp);
        expect(result.success).toBe(true);
    });

    it('rejects empty transcript "" (GAP-01 / NEG-08)', () => {
        const resp = { text: '' };
        const result = WhisperResponseSchema.safeParse(resp);
        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error.issues[0].message).toContain('empty transcript');
        }
    });

    it('rejects response with missing text field', () => {
        const resp = { transcript: 'hello' };
        const result = WhisperResponseSchema.safeParse(resp);
        expect(result.success).toBe(false);
    });

    it('parses Whisper response with extra fields (language, etc.)', () => {
        const resp = { text: 'test phrase', language: 'en', duration: 1.5 };
        const result = WhisperResponseSchema.safeParse(resp);
        expect(result.success).toBe(true);
    });
});

// ─── OllamaResponseSchema ─────────────────────────────────────────────────────

describe('OllamaResponseSchema', () => {
    it('parses a valid Ollama response', () => {
        const resp = { response: 'Hello, how are you?', done: true };
        const result = OllamaResponseSchema.safeParse(resp);
        expect(result.success).toBe(true);
    });

    it('rejects Ollama error response missing response field (NEG-09)', () => {
        const resp = { error: 'model not loaded' };
        const result = OllamaResponseSchema.safeParse(resp);
        expect(result.success).toBe(false);
    });

    it('rejects Ollama response with empty response field', () => {
        const resp = { response: '' };
        const result = OllamaResponseSchema.safeParse(resp);
        expect(result.success).toBe(false);
    });
});
