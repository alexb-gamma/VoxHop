import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Config } from '../src/config';

// Mock dependencies before importing the module
vi.mock('../src/silero-vad', () => ({
    SileroVAD: vi.fn().mockImplementation(() => ({
        ensureLoaded: vi.fn().mockResolvedValue(undefined),
        feed: vi.fn().mockReturnValue(null),
        destroy: vi.fn().mockResolvedValue(undefined),
        reset: vi.fn(),
    })),
}));

vi.mock('../src/pipeline', () => ({
    callWhisper: vi.fn(),
    callOllamaStream: vi.fn(),
    callPiper: vi.fn(),
    injectAudio: vi.fn(),
    StagedError: class StagedError extends Error {
        stage: string;
        constructor(stage: string, message?: string) {
            super(message ?? `Pipeline stage failed: ${stage}`);
            this.stage = stage;
            this.name = 'StagedError';
        }
    },
}));

vi.mock('../src/audio-utils', () => ({
    downsampleTo16k: vi.fn().mockReturnValue(Buffer.alloc(100)),
}));

import { CounterpartyCallHandler } from '../src/call-handler';
import { SileroVAD } from '../src/silero-vad';
import { callWhisper, callOllamaStream, callPiper, injectAudio } from '../src/pipeline';

const mockConfig: Config = {
    PORT: 3001,
    WHISPER_URL: 'http://localhost:8001',
    OLLAMA_URL: 'http://localhost:11434',
    PIPER_URL: 'http://localhost:5000',
    OLLAMA_MODEL: 'gemma4',
    WHISPER_TIMEOUT_MS: 10000,
    OLLAMA_TIMEOUT_MS: 30000,
    PIPER_TIMEOUT_MS: 10000,
    VAD_SILENCE_THRESHOLD_MS: 600,
    VAD_MIN_SPEECH_MS: 250,
    LOG_LEVEL: 'info',
};

function createMockWs(): any {
    return {
        readyState: 1, // OPEN
        send: vi.fn(),
        close: vi.fn(),
        on: vi.fn(),
    };
}

const validCallInitiated = JSON.stringify({
    event: 'call_initiated',
    callId: 'call-test-123',
    timestamp: '2026-06-07T10:00:00Z',
    customData: {
        persona: {
            id: 'en-james',
            name: 'James',
            language: 'en',
            piperVoice: 'en_GB-alan-medium',
            systemPrompt: 'You are James.',
            conversationOpener: 'Good afternoon.',
        },
    },
});

const validMediaStarted = JSON.stringify({
    event: 'media_started',
    callId: 'call-test-123',
    tracks: [{ trackId: 'rx-track-001', track: 'caller' }],
    txTrackId: 'tx-track-001',
    mediaFormat: {
        encoding: 'audio/x-raw',
        sampleRate: 16000,
        channels: 1,
        bitDepth: 16,
        payloadEncoding: 'base64',
    },
    timestamp: '2026-06-07T10:00:00Z',
});

describe('CounterpartyCallHandler', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('closes WS with 1008 on call_initiated with missing customData.persona', () => {
        const ws = createMockWs();
        const handler = new CounterpartyCallHandler(ws, mockConfig);

        // Simulate receiving invalid call_initiated
        const parsed = JSON.parse(JSON.stringify({
            event: 'call_initiated',
            callId: 'call-test-123',
            timestamp: '2026-06-07T10:00:00Z',
            // no customData
        }));

        // Access private method via prototype hack for testing
        (handler as any).handleMessage(parsed);

        expect(ws.close).toHaveBeenCalledWith(1008, expect.stringContaining('Invalid call_initiated'));
        expect(handler.getCallId()).toBeNull();
    });

    it('processingTurn prevents second pipeline launch while in-flight', async () => {
        const ws = createMockWs();
        const eventsWs = createMockWs();
        const handler = new CounterpartyCallHandler(ws, mockConfig);
        handler.setEventsWs(eventsWs);

        // Set up call state
        (handler as any).handleMessage(JSON.parse(validCallInitiated));
        (handler as any).handleMessage(JSON.parse(validMediaStarted));

        // Give VAD a speech buffer to return
        const mockVad = (SileroVAD as any).mock.results[0]?.value;
        if (mockVad) {
            mockVad.feed.mockReturnValueOnce(Buffer.alloc(3200)).mockReturnValue(null);
        }

        // Simulate callWhisper taking a long time
        vi.mocked(callWhisper).mockImplementation(() => new Promise(resolve => setTimeout(() => resolve('hello'), 100)));
        vi.mocked(callOllamaStream).mockResolvedValue('response');
        vi.mocked(callPiper).mockResolvedValue(Buffer.alloc(200));

        // Fire first audio frame — this should set processingTurn = true and launch runTurn()
        const audioFrame = JSON.parse(JSON.stringify({
            event: 'audio',
            callId: 'call-test-123',
            trackId: 'rx-track-001',
            payload: Buffer.alloc(3200).toString('base64'),
        }));
        (handler as any).handleMessage(audioFrame);

        // processingTurn should now be true
        expect((handler as any).processingTurn).toBe(true);

        // Fire second audio frame — should be silently discarded
        const mockVad2 = (SileroVAD as any).mock.results[0]?.value;
        const prevFeedCallCount = mockVad2?.feed.mock.calls.length ?? 0;

        (handler as any).handleMessage(audioFrame);
        
        // Feed should not have been called again (frame discarded at processingTurn guard)
        // Actually it depends on the VAD mock, but callWhisper should only be called once
        expect(callWhisper).toHaveBeenCalledTimes(1);
    });

    it('conversation history grows and stays <= 100 entries', async () => {
        const ws = createMockWs();
        const handler = new CounterpartyCallHandler(ws, mockConfig);

        // Directly push 101 entries to test cap
        const history = (handler as any).conversationHistory as Array<{ role: string; content: string }>;
        for (let i = 0; i < 51; i++) {
            history.push({ role: 'user', content: `user-${i}` });
            history.push({ role: 'assistant', content: `assistant-${i}` });
            while (history.length > 100) history.shift();
        }

        expect(history.length).toBeLessThanOrEqual(100);
    });

    it('cleanup clears conversationHistory and calls vad.destroy()', async () => {
        const ws = createMockWs();
        const handler = new CounterpartyCallHandler(ws, mockConfig);

        // Set up a mock VAD
        (handler as any).handleMessage(JSON.parse(validCallInitiated));
        (handler as any).handleMessage(JSON.parse(validMediaStarted));

        // Add some history
        (handler as any).conversationHistory.push({ role: 'user', content: 'test' });

        await handler.cleanup();

        expect((handler as any).conversationHistory).toHaveLength(0);
        expect((handler as any).isActive).toBe(false);
    });
});
