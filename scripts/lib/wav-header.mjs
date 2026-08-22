import { open } from 'node:fs/promises'

/**
 * Standalone WAV header reader for the smoke test.
 *
 * Deliberately a separate implementation from src/main/services/wav.ts: a test
 * that reuses the code under test would pass even if both agreed on the wrong
 * answer. This one is written straight from the RIFF spec.
 */
export async function readWavHeader(path) {
  const handle = await open(path, 'r')
  try {
    const riff = Buffer.alloc(12)
    await handle.read(riff, 0, 12, 0)
    if (riff.toString('ascii', 0, 4) !== 'RIFF' || riff.toString('ascii', 8, 12) !== 'WAVE') {
      throw new Error('not a RIFF/WAVE file')
    }

    let offset = 12
    let sampleRate = 0
    let channels = 0
    let bitsPerSample = 0
    let dataBytes = 0
    const chunk = Buffer.alloc(8)

    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, 8, offset)
      if (bytesRead < 8) break
      const id = chunk.toString('ascii', 0, 4)
      const size = chunk.readUInt32LE(4)

      if (id === 'fmt ') {
        const fmt = Buffer.alloc(16)
        await handle.read(fmt, 0, 16, offset + 8)
        channels = fmt.readUInt16LE(2)
        sampleRate = fmt.readUInt32LE(4)
        bitsPerSample = fmt.readUInt16LE(14)
      } else if (id === 'data') {
        dataBytes = size
        break
      }
      offset += 8 + size + (size % 2)
    }

    const byteRate = sampleRate * channels * (bitsPerSample / 8)
    return {
      sampleRate,
      channels,
      bitsPerSample,
      dataBytes,
      durationMs: byteRate ? Math.round((dataBytes / byteRate) * 1000) : 0
    }
  } finally {
    await handle.close()
  }
}
