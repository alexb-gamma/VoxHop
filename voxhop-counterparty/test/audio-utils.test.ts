import { describe, it, expect } from 'vitest';
import { downsampleTo16k, buildWav } from '../src/audio-utils';

describe('downsampleTo16k', () => {
    it('returns empty buffer for empty input', () => {
        const result = downsampleTo16k(Buffer.alloc(0), 24000);
        expect(result.length).toBe(0);
    });

    it('produces correct output sample count from 24kHz input', () => {
        // 24kHz → 16kHz: ratio = 1.5, so output = floor(input / 1.5)
        // Create 300 samples at 24kHz (600 bytes)
        const inputSamples = 300;
        const input = Buffer.alloc(inputSamples * 2);
        const result = downsampleTo16k(input, 24000);
        const expectedSamples = Math.floor(inputSamples / 1.5);
        expect(result.length).toBe(expectedSamples * 2);
    });
});

describe('buildWav', () => {
    it('produces 44-byte header + input data length', () => {
        const pcm = Buffer.alloc(100);
        const wav = buildWav(pcm, 16000);
        expect(wav.length).toBe(44 + 100);
    });

    it('has correct RIFF/WAVE magic bytes', () => {
        const pcm = Buffer.alloc(16);
        const wav = buildWav(pcm, 16000);
        expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
        expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    });
});
