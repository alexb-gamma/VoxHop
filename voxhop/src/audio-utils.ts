/**
 * VoxHop — Audio Utilities
 *
 * downsampleTo16k() COPIED verbatim from HelloSurgery/gpu-voice-agent/src/audio-utils.ts
 * buildWav() COPIED verbatim from HelloSurgery/gpu-voice-agent/src/audio-utils.ts (RE-07 fix)
 *
 * These are the ONLY audio utilities required in Track 1:
 *   - downsampleTo16k(): Piper 24kHz output → 16kHz for telco-ai-bridge injection
 *   - buildWav(): Wrap raw PCM in WAV header for faster-whisper POST /v1/audio/transcriptions
 *
 * No other audio conversion is performed in VoxHop Track 1.
 * Audio arrives from telco-ai-bridge already at 16kHz S16LE mono.
 */

/**
 * Downsample int16 PCM from any source rate to 16kHz via linear decimation.
 * Per C-GAM-04 (HelloSurgery): canonical implementation — do NOT duplicate elsewhere.
 *
 * @param pcmSrc - Source PCM buffer (int16 LE, arbitrary sample rate)
 * @param srcRate - Source sample rate in Hz (e.g. 24000 for Piper output)
 * @returns int16 LE PCM buffer at 16kHz
 */
export function downsampleTo16k(pcmSrc: Buffer, srcRate: number): Buffer {
    if (pcmSrc.length === 0) return Buffer.alloc(0);

    const inputSamples = pcmSrc.length / 2;
    const ratio = srcRate / 16000;
    const outputSamples = Math.floor(inputSamples / ratio);
    const out = Buffer.alloc(outputSamples * 2);

    for (let i = 0; i < outputSamples; i++) {
        const srcIdx = Math.round(i * ratio);
        const clampedIdx = Math.min(srcIdx, inputSamples - 1);
        out.writeInt16LE(pcmSrc.readInt16LE(clampedIdx * 2), i * 2);
    }

    return out;
}

/**
 * Build a complete WAV file from raw PCM data.
 * Required for Whisper POST /v1/audio/transcriptions (RE-07 fix).
 * faster-whisper expects a valid audio file, not raw PCM bytes.
 *
 * @param pcmData - Raw PCM data (int16 LE)
 * @param sampleRate - Sample rate in Hz (16000 for VoxHop internal format)
 * @param bitsPerSample - Bits per sample (default 16)
 * @param channels - Number of channels (default 1, mono)
 * @returns Complete WAV file buffer
 */
export function buildWav(
    pcmData: Buffer,
    sampleRate: number,
    bitsPerSample: number = 16,
    channels: number = 1
): Buffer {
    const dataLen = pcmData.length;
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataLen, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16); // fmt chunk size
    header.writeUInt16LE(1, 20); // PCM format
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE((sampleRate * channels * bitsPerSample) / 8, 28); // byte rate
    header.writeUInt16LE((channels * bitsPerSample) / 8, 32); // block align
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36);
    header.writeUInt32LE(dataLen, 40);
    return Buffer.concat([header, pcmData]);
}
