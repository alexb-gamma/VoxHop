import { describe, it, expect } from 'vitest';
import {
    CallInitiatedSchema,
    MediaStartedSchema,
    OllamaStreamChunkSchema,
    PersonaSchema,
    WhisperResponseSchema,
} from '../src/schemas';

const validPersona = {
    id: 'en-james',
    name: 'James',
    language: 'en',
    piperVoice: 'en_GB-alan-medium',
    systemPrompt: 'You are James, a helpful insurance agent.',
    conversationOpener: 'Good afternoon, Harrington Insurance.',
};

const validCallInitiated = {
    event: 'call_initiated',
    callId: 'call-abc-123',
    timestamp: '2026-06-07T10:00:00Z',
    customData: { persona: validPersona },
};

describe('CallInitiatedSchema', () => {
    it('accepts valid payload with customData.persona', () => {
        const result = CallInitiatedSchema.safeParse(validCallInitiated);
        expect(result.success).toBe(true);
    });

    it('rejects payload missing customData entirely', () => {
        const result = CallInitiatedSchema.safeParse({ event: 'call_initiated', callId: 'x', timestamp: '...' });
        expect(result.success).toBe(false);
    });

    it('rejects customData.persona with missing piperVoice', () => {
        const { piperVoice: _, ...personaWithoutPiperVoice } = validPersona;
        const result = CallInitiatedSchema.safeParse({
            ...validCallInitiated,
            customData: { persona: personaWithoutPiperVoice },
        });
        expect(result.success).toBe(false);
    });
});

const validMediaStarted = {
    event: 'media_started',
    callId: 'call-abc-123',
    tracks: [{ trackId: 'track-001', track: 'caller' }],
    txTrackId: 'tx-track-001',
    mediaFormat: {
        encoding: 'audio/x-raw',
        sampleRate: 16000,
        channels: 1,
        bitDepth: 16,
        payloadEncoding: 'base64',
    },
    timestamp: '2026-06-07T10:00:00Z',
};

describe('MediaStartedSchema', () => {
    it('accepts track: "caller"', () => {
        const result = MediaStartedSchema.safeParse(validMediaStarted);
        expect(result.success).toBe(true);
    });

    it('rejects track: "called" — z.literal("caller") enforcement', () => {
        const result = MediaStartedSchema.safeParse({
            ...validMediaStarted,
            tracks: [{ trackId: 'track-001', track: 'called' }],
        });
        expect(result.success).toBe(false);
    });

    it('rejects missing txTrackId', () => {
        const { txTrackId: _, ...withoutTx } = validMediaStarted;
        const result = MediaStartedSchema.safeParse(withoutTx);
        expect(result.success).toBe(false);
    });

    it('rejects sampleRate: 8000 (not z.literal(16000))', () => {
        const result = MediaStartedSchema.safeParse({
            ...validMediaStarted,
            mediaFormat: { ...validMediaStarted.mediaFormat, sampleRate: 8000 },
        });
        expect(result.success).toBe(false);
    });
});

describe('OllamaStreamChunkSchema', () => {
    it('accepts /api/chat format with content', () => {
        const result = OllamaStreamChunkSchema.safeParse({
            message: { role: 'assistant', content: 'Hello' },
            done: false,
        });
        expect(result.success).toBe(true);
    });

    it('accepts done:true with empty content', () => {
        const result = OllamaStreamChunkSchema.safeParse({
            message: { role: 'assistant', content: '' },
            done: true,
        });
        expect(result.success).toBe(true);
    });

    it('rejects /api/generate format { response, done }', () => {
        const result = OllamaStreamChunkSchema.safeParse({ response: 'Hello', done: false });
        expect(result.success).toBe(false);
    });
});

describe('PersonaSchema', () => {
    it('rejects object missing piperVoice', () => {
        const { piperVoice: _, ...without } = validPersona;
        const result = PersonaSchema.safeParse(without);
        expect(result.success).toBe(false);
    });
});

describe('WhisperResponseSchema', () => {
    it('rejects empty text { text: "" }', () => {
        const result = WhisperResponseSchema.safeParse({ text: '' });
        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error.issues[0].message).toContain('empty transcript');
        }
    });

    it('accepts non-empty text', () => {
        const result = WhisperResponseSchema.safeParse({ text: 'Hello world' });
        expect(result.success).toBe(true);
    });
});
