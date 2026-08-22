import { createReadStream } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { readWavInfo } from './wav'

/**
 * Waveform peak extraction.
 *
 * Runs in the main process and returns a small array of amplitudes rather than
 * shipping audio to the renderer. Two reasons: Chromium blocks fetch() to our
 * custom media scheme, and a two-hour 16 kHz mono recording is ~230 MB of PCM
 * that has no business being decoded in the UI process. The renderer receives
 * roughly 2 kB instead.
 *
 * The PCM is streamed, never buffered whole, so peak time is bounded by disk
 * throughput rather than by file size in memory.
 */

/** Enough detail for a full-width waveform without wasting bandwidth. */
export const DEFAULT_BUCKETS = 2000

export interface Peaks {
  /** Normalized 0..1 amplitude per bucket, left to right. */
  values: number[]
  durationMs: number
}

function cachePath(wavPath: string, buckets: number): string {
  return `${wavPath}.${buckets}.peaks.json`
}

/**
 * Computes (or loads) the waveform envelope for a 16-bit PCM WAV.
 *
 * Results are cached beside the audio: peaks never change once the file is
 * written, and recomputing on every editor visit would re-read the whole file.
 */
export async function getPeaks(
  wavPath: string,
  buckets: number = DEFAULT_BUCKETS
): Promise<Peaks> {
  const cached = await readCache(wavPath, buckets)
  if (cached) return cached

  const peaks = await computePeaks(wavPath, buckets)

  // A failed cache write is not worth failing the request over — the peaks are
  // already computed and correct.
  try {
    await writeFile(cachePath(wavPath, buckets), JSON.stringify(peaks))
  } catch (err) {
    console.warn('[peaks] could not cache peaks:', err)
  }

  return peaks
}

async function readCache(wavPath: string, buckets: number): Promise<Peaks | null> {
  try {
    const raw = await readFile(cachePath(wavPath, buckets), 'utf8')
    const parsed = JSON.parse(raw) as Peaks
    if (Array.isArray(parsed.values) && parsed.values.length === buckets) return parsed
    return null
  } catch {
    return null
  }
}

async function computePeaks(wavPath: string, buckets: number): Promise<Peaks> {
  const info = await readWavInfo(wavPath)

  if (info.bitsPerSample !== 16) {
    throw new Error(`Expected 16-bit PCM, got ${info.bitsPerSample}-bit`)
  }

  const bytesPerFrame = (info.bitsPerSample / 8) * info.channels
  const totalFrames = Math.floor(info.dataBytes / bytesPerFrame)
  if (totalFrames === 0) {
    return { values: new Array<number>(buckets).fill(0), durationMs: info.durationMs }
  }

  const framesPerBucket = Math.max(1, Math.ceil(totalFrames / buckets))
  const values = new Array<number>(buckets).fill(0)

  const stream = createReadStream(wavPath, {
    start: info.dataOffset,
    end: info.dataOffset + info.dataBytes - 1
  })

  let frameIndex = 0
  // A chunk boundary can fall mid-frame; hold the remainder for the next chunk.
  let carry: Buffer = Buffer.alloc(0)

  for await (const chunk of stream) {
    const buf: Buffer = carry.length > 0 ? Buffer.concat([carry, chunk as Buffer]) : (chunk as Buffer)
    const usableFrames = Math.floor(buf.length / bytesPerFrame)
    const usableBytes = usableFrames * bytesPerFrame

    for (let f = 0; f < usableFrames; f++) {
      // Mono after normalization, but read channel 0 explicitly so this stays
      // correct if it is ever pointed at a stereo file.
      const sample = buf.readInt16LE(f * bytesPerFrame)
      // 32768 is the magnitude of the most negative 16-bit value, so this maps
      // the full range into 0..1 without ever exceeding it.
      const amplitude = Math.abs(sample) / 32768

      const bucket = Math.min(buckets - 1, Math.floor((frameIndex + f) / framesPerBucket))
      if (amplitude > values[bucket]) values[bucket] = amplitude
    }

    frameIndex += usableFrames
    carry = buf.subarray(usableBytes)
  }

  return { values, durationMs: info.durationMs }
}

/**
 * Largest absolute sample in a 16-bit PCM WAV, normalized to 0..1.
 *
 * Streams the file and caches nothing — this is a yes/no check on whether a
 * track carries any signal, not something to render.
 */
export async function measurePeak(wavPath: string): Promise<number> {
  const info = await readWavInfo(wavPath)
  if (info.bitsPerSample !== 16 || info.dataBytes === 0) return 0

  const stream = createReadStream(wavPath, {
    start: info.dataOffset,
    end: info.dataOffset + info.dataBytes - 1
  })

  let peak = 0
  let carry: Buffer = Buffer.alloc(0)

  for await (const chunk of stream) {
    const buf: Buffer =
      carry.length > 0 ? Buffer.concat([carry, chunk as Buffer]) : (chunk as Buffer)
    // A chunk boundary can split a sample in half.
    const usable = buf.length - (buf.length % 2)
    for (let at = 0; at < usable; at += 2) {
      const amplitude = Math.abs(buf.readInt16LE(at)) / 32768
      if (amplitude > peak) peak = amplitude
    }
    carry = buf.subarray(usable)
  }

  return peak
}

/**
 * Peak and RMS of a 16-bit PCM WAV, both normalized to 0..1.
 *
 * One streaming pass, because the caller wants both and reading a two-hour file
 * twice to learn two numbers is wasteful. RMS is what "how loud does this feel"
 * actually means; peak is what decides how much gain can be applied before
 * clipping. Gain decisions need both.
 */
export async function measureLevels(wavPath: string): Promise<{ peak: number; rms: number }> {
  const info = await readWavInfo(wavPath)
  if (info.bitsPerSample !== 16 || info.dataBytes === 0) return { peak: 0, rms: 0 }

  const stream = createReadStream(wavPath, {
    start: info.dataOffset,
    end: info.dataOffset + info.dataBytes - 1
  })

  let peak = 0
  // Summed as a fraction of full scale rather than raw sample squares: a long
  // recording overflows a float64 accumulator of squared 16-bit integers far
  // sooner than one of values below 1.
  let sumSquares = 0
  let count = 0
  let carry: Buffer = Buffer.alloc(0)

  for await (const chunk of stream) {
    const buf: Buffer =
      carry.length > 0 ? Buffer.concat([carry, chunk as Buffer]) : (chunk as Buffer)
    const usable = buf.length - (buf.length % 2)
    for (let at = 0; at < usable; at += 2) {
      const amplitude = buf.readInt16LE(at) / 32768
      const magnitude = Math.abs(amplitude)
      if (magnitude > peak) peak = magnitude
      sumSquares += amplitude * amplitude
      count++
    }
    carry = buf.subarray(usable)
  }

  return { peak, rms: count > 0 ? Math.sqrt(sumSquares / count) : 0 }
}

/**
 * Below this a track is treated as carrying nothing.
 *
 * System-audio loopback with nothing playing yields exactly 0.0 across every
 * sample; a real microphone, even at low gain, has a noise floor well above
 * -60 dBFS. Set conservatively so a quiet-but-real take is never discarded.
 */
export const SILENCE_PEAK_THRESHOLD = 0.001
