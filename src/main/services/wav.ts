import { open } from 'node:fs/promises'

/**
 * Minimal RIFF/WAVE header reader.
 *
 * Duration is computed from the header rather than shelling out to ffprobe:
 * for uncompressed PCM it is exact (data bytes / byte rate), which drops an
 * entire second binary from the bundle, the signing surface and the fetch
 * script.
 */

export interface WavInfo {
  sampleRate: number
  channels: number
  bitsPerSample: number
  dataBytes: number
  durationMs: number
  /** Byte offset of the first audio sample, for callers that stream the PCM. */
  dataOffset: number
}

export class InvalidWavError extends Error {
  constructor(message: string) {
    super(`Invalid WAV: ${message}`)
    this.name = 'InvalidWavError'
  }
}

/**
 * Reads the fmt and data chunk headers.
 *
 * Chunks are walked rather than assumed at fixed offsets — ffmpeg emits a LIST
 * metadata chunk before `data`, so the naive "data starts at byte 36" shortcut
 * yields a wrong duration.
 */
export async function readWavInfo(path: string): Promise<WavInfo> {
  const handle = await open(path, 'r')
  try {
    const header = Buffer.alloc(12)
    const { bytesRead } = await handle.read(header, 0, 12, 0)
    if (bytesRead < 12) throw new InvalidWavError('file shorter than RIFF header')
    if (header.toString('ascii', 0, 4) !== 'RIFF') throw new InvalidWavError('missing RIFF tag')
    if (header.toString('ascii', 8, 12) !== 'WAVE') throw new InvalidWavError('not a WAVE file')

    let offset = 12
    let sampleRate = 0
    let channels = 0
    let bitsPerSample = 0
    let dataBytes = 0
    let dataOffset = 0

    const chunkHeader = Buffer.alloc(8)
    for (;;) {
      const read = await handle.read(chunkHeader, 0, 8, offset)
      if (read.bytesRead < 8) break

      const id = chunkHeader.toString('ascii', 0, 4)
      const size = chunkHeader.readUInt32LE(4)
      const body = offset + 8

      if (id === 'fmt ') {
        const fmt = Buffer.alloc(Math.min(size, 16))
        await handle.read(fmt, 0, fmt.length, body)
        if (fmt.length < 16) throw new InvalidWavError('truncated fmt chunk')
        channels = fmt.readUInt16LE(2)
        sampleRate = fmt.readUInt32LE(4)
        bitsPerSample = fmt.readUInt16LE(14)
      } else if (id === 'data') {
        dataBytes = size
        dataOffset = body
        // Everything needed is known; the audio body itself is never read.
        break
      }

      // Chunks are word-aligned: an odd size is followed by a pad byte.
      offset = body + size + (size % 2)
    }

    if (!sampleRate || !channels || !bitsPerSample) {
      throw new InvalidWavError('missing or incomplete fmt chunk')
    }

    const byteRate = sampleRate * channels * (bitsPerSample / 8)
    const durationMs = byteRate > 0 ? Math.round((dataBytes / byteRate) * 1000) : 0

    return { sampleRate, channels, bitsPerSample, dataBytes, durationMs, dataOffset }
  } finally {
    await handle.close()
  }
}
