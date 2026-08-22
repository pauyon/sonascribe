import { createWriteStream, type WriteStream } from 'node:fs'
import { open } from 'node:fs/promises'


/**
 * Streams 16-bit PCM to a WAV file as it arrives.
 *
 * The format is whatever the caller captured — recordings are kept at the
 * hardware's own rate, and the 16 kHz mono copy the ML sidecars need is derived
 * from them later. Hard-coding 16 kHz here would silently cap every recording
 * at telephone bandwidth.
 *
 * A RIFF header declares the payload size up front, which is unknowable while
 * still recording. The usual fix is used here: write a header with placeholder
 * sizes, append samples as they stream in, then patch the two length fields on
 * close. That keeps memory flat regardless of recording length — an hour of
 * 16 kHz mono is ~115 MB that never needs to be held at once.
 */

const HEADER_BYTES = 44
const BITS_PER_SAMPLE = 16

function buildHeader(dataBytes: number, sampleRate: number, channels: number): Buffer {
  const header = Buffer.alloc(HEADER_BYTES)
  const byteRate = sampleRate * channels * (BITS_PER_SAMPLE / 8)
  const blockAlign = channels * (BITS_PER_SAMPLE / 8)

  header.write('RIFF', 0, 'ascii')
  // Everything after this field: 4 (WAVE) + 24 (fmt chunk) + 8 (data header).
  header.writeUInt32LE(36 + dataBytes, 4)
  header.write('WAVE', 8, 'ascii')

  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16) // PCM fmt chunk length
  header.writeUInt16LE(1, 20) // format 1 = uncompressed PCM
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(BITS_PER_SAMPLE, 34)

  header.write('data', 36, 'ascii')
  header.writeUInt32LE(dataBytes, 40)

  return header
}

export class WavWriter {
  private stream: WriteStream
  private dataBytes = 0
  private closed = false

  constructor(
    readonly path: string,
    readonly sampleRate: number,
    readonly channels = 1
  ) {
    this.stream = createWriteStream(path)
    // Placeholder sizes; patched in close().
    this.stream.write(buildHeader(0, sampleRate, channels))
  }

  /** Appends one block of little-endian 16-bit samples. */
  write(samples: Buffer): void {
    if (this.closed) throw new Error('Cannot write to a closed WavWriter')
    this.dataBytes += samples.byteLength
    this.stream.write(samples)
  }

  get durationMs(): number {
    const byteRate = this.sampleRate * this.channels * (BITS_PER_SAMPLE / 8)
    return Math.round((this.dataBytes / byteRate) * 1000)
  }

  get bytesWritten(): number {
    return this.dataBytes
  }

  /** Flushes, then rewrites the two length fields now that the total is known. */
  async close(): Promise<{ durationMs: number; bytes: number }> {
    if (this.closed) return { durationMs: this.durationMs, bytes: this.dataBytes }
    this.closed = true

    await new Promise<void>((resolve, reject) => {
      this.stream.end((err?: Error | null) => (err ? reject(err) : resolve()))
    })

    const handle = await open(this.path, 'r+')
    try {
      const sizes = Buffer.alloc(4)
      sizes.writeUInt32LE(36 + this.dataBytes, 0)
      await handle.write(sizes, 0, 4, 4)
      sizes.writeUInt32LE(this.dataBytes, 0)
      await handle.write(sizes, 0, 4, 40)
    } finally {
      await handle.close()
    }

    return { durationMs: this.durationMs, bytes: this.dataBytes }
  }
}
