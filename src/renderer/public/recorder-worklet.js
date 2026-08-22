/**
 * Captures raw PCM from an audio graph.
 *
 * Used instead of MediaRecorder so the audio never goes through a WebM/Opus
 * encode-decode round trip on its way to disk. The AudioContext is created at
 * 16 kHz, so the browser resamples for us and what arrives here is already the
 * exact format whisper.cpp wants.
 *
 * Served from public/ rather than a blob: URL because the renderer's CSP is
 * script-src 'self', and worklet modules are subject to it.
 */

// ~256 ms at 16 kHz. Small enough that the level meter stays responsive, large
// enough that IPC is not woken 125 times a second.
const BLOCK_SIZE = 4096

class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buffer = new Int16Array(BLOCK_SIZE)
    this.offset = 0
    this.peak = 0
  }

  flush() {
    if (this.offset === 0) return
    // Copy: the underlying buffer is reused, and a transfer would detach it.
    const chunk = this.buffer.slice(0, this.offset)
    this.port.postMessage({ samples: chunk, peak: this.peak }, [chunk.buffer])
    this.offset = 0
    this.peak = 0
  }

  process(inputs) {
    const channel = inputs[0]?.[0]
    // No input connected yet, or the source ended. Returning true keeps the
    // node alive so recording survives a momentary gap.
    if (!channel) return true

    for (let i = 0; i < channel.length; i++) {
      const sample = channel[i]
      const magnitude = sample < 0 ? -sample : sample
      if (magnitude > this.peak) this.peak = magnitude

      // Clamp before scaling: values outside [-1, 1] are legal in Web Audio and
      // would wrap around when written as 16-bit.
      const clamped = sample > 1 ? 1 : sample < -1 ? -1 : sample
      // Asymmetric scaling matches the 16-bit range, whose negative side
      // reaches one step further than its positive side.
      this.buffer[this.offset++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff

      if (this.offset === BLOCK_SIZE) this.flush()
    }

    return true
  }
}

registerProcessor('recorder-processor', RecorderProcessor)
