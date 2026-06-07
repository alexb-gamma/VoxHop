/**
 * pcm-capture-processor.js — AudioWorklet PCM capture processor (Phase 1 scaffold)
 *
 * Placed in public/ so Vite copies it to dist/ verbatim (ER-03):
 *   - Dev:  served by Vite at /pcm-capture-processor.js
 *   - Prod: served by NestJS static from /static/pcm-capture-processor.js
 *
 * Phase 1: Posts {type:'pcm-capture-ready'} on init to trigger WORKLET_READY dispatch.
 * Phase 2: Will accumulate PCM frames and post to main thread for WebSocket streaming.
 */
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // Signal to App.tsx that the worklet loaded successfully (§6.4 WORKLET_READY action)
    this.port.postMessage({ type: 'pcm-capture-ready' });
  }

  /**
   * process() — receives PCM audio frames from the mic stream.
   *
   * Phase 1: Captures frames but does not transmit (no WebSocket yet).
   * Phase 2: Will buffer and post PCM chunks to main thread for streaming.
   *
   * Returning true keeps the processor alive indefinitely.
   */
  process(inputs) {
    // Phase 1: forward-only capture — frames received but not yet transmitted
    // Phase 2: accumulate and post to main thread via this.port.postMessage()
    const input = inputs[0];
    if (input && input.length > 0) {
      // PCM data is available at input[0] (mono) — Phase 2 will stream this
      void input;
    }
    return true; // keep processor alive
  }
}

registerProcessor('pcm-capture-processor', PcmCaptureProcessor);
