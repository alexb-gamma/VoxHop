/**
 * VoxHop Counterparty — Audio Utilities
 *
 * Copied verbatim from voxhop/src/audio-utils.ts.
 * No cross-package imports permitted (service boundary law).
 * When audio-utils.ts changes in voxhop/src/, update this file in the same commit.
 */

/**
 * Downsample int16 PCM from any source rate to 16kHz via linear decimation.
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
 * Required for Whisper POST /v1/audio/transcriptions.
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
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE((sampleRate * channels * bitsPerSample) / 8, 28);
    header.writeUInt16LE((channels * bitsPerSample) / 8, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36);
    header.writeUInt32LE(dataLen, 40);
    return Buffer.concat([header, pcmData]);
}
