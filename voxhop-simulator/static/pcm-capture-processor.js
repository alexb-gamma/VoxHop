/**
 * pcm-capture-processor.js — AudioWorklet PCM capture processor (Phase 2)
 *
 * Phase 1: Posts {type:'pcm-capture-ready'} on init.
 * Phase 2: Streams Float32 audio frames to main thread for WebSocket relay.
 */
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.port.postMessage({ type: 'pcm-capture-ready' });
  }

  process(inputs) {
    const input = inputs[0];
    if (input && input[0] && input[0].length > 0) {
      // Transfer ownership for zero-copy — copy needed as input is reused by AudioWorklet
      const channelData = input[0].slice();
      this.port.postMessage({ type: 'audio-frame', data: channelData }, [channelData.buffer]);
    }
    return true;
  }
}

registerProcessor('pcm-capture-processor', PcmCaptureProcessor);
