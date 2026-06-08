/**
 * VoxHop Simulator — InboundAudioTranscoder
 *
 * CRITICAL: This is a plain class — NOT @Injectable().
 * One instance per CallSession. Never a singleton.
 * Stateful sampleAccumulator handles frame-boundary alignment across calls.
 *
 * Reference: HelloSurgery/scripts/gamma-simulator-web.ts lines 658–692
 */
export class InboundAudioTranscoder {
  // Stateful accumulator — holds cross-frame Float32 remainders
  // Critical: must be per-session instance, not singleton
  private sampleAccumulator: number[] = [];

  /**
   * Inbound: Float32 48kHz binary frame → S16LE 16kHz Buffer
   * Algorithm: 3:1 decimation (take every 3rd sample, scale to int16)
   *
   * @returns S16LE 16kHz buffer, or null if insufficient samples accumulated
   */
  processInbound(data: Buffer): Buffer | null {
    const float32 = new Float32Array(data.buffer, data.byteOffset, data.length / 4);
    for (let i = 0; i < float32.length; i++) this.sampleAccumulator.push(float32[i]);
    if (this.sampleAccumulator.length < 3) return null;
    const outSamplesCount = Math.floor(this.sampleAccumulator.length / 3);
    const pcmBuffer = Buffer.alloc(outSamplesCount * 2);
    for (let i = 0; i < outSamplesCount; i++) {
      const val = this.sampleAccumulator[i * 3];
      const intVal = Math.max(-32768, Math.min(32767, Math.round(val * 32767)));
      pcmBuffer.writeInt16LE(intVal, i * 2);
    }
    // Preserve remainder to prevent sample boundary phase clicks
    this.sampleAccumulator = this.sampleAccumulator.slice(outSamplesCount * 3);
    return pcmBuffer;
  }

  /**
   * Outbound: base64 S16LE 16kHz → Float32 48kHz ArrayBuffer (for browser)
   * Algorithm: 1:3 linear interpolation upsampling
   *
   * @param payload - base64-encoded S16LE 16kHz PCM
   * @returns Float32 48kHz ArrayBuffer ready for browser AudioBufferSourceNode
   */
  static upsampleToFloat32(payload: string): ArrayBuffer {
    const pcmBuffer = Buffer.from(payload, 'base64');
    const inputSamplesCount = pcmBuffer.length / 2;
    const outFloat32 = new Float32Array(inputSamplesCount * 3);
    for (let i = 0; i < inputSamplesCount; i++) {
      const current = pcmBuffer.readInt16LE(i * 2) / 32768;
      const next = i < inputSamplesCount - 1 ? pcmBuffer.readInt16LE((i + 1) * 2) / 32768 : current;
      outFloat32[i * 3]     = current;
      outFloat32[i * 3 + 1] = current + (next - current) * (1 / 3);
      outFloat32[i * 3 + 2] = current + (next - current) * (2 / 3);
    }
    return outFloat32.buffer;
  }

  reset(): void { this.sampleAccumulator = []; }
}
