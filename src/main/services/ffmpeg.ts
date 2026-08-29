import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { measureLevels } from './peaks'
import { resolveSidecar } from './sidecars'

/**
 * ffmpeg invocation for the ingest step.
 *
 * Every entry point (import now, recording later) funnels through
 * normalizeToWav so the ML sidecars only ever see one audio format.
 */

/** Whisper requires 16 kHz mono PCM; these are not tunable knobs. */
export const TARGET_SAMPLE_RATE = 16_000
export const TARGET_CHANNELS = 1

export class FfmpegError extends Error {
  constructor(
    message: string,
    readonly stderrTail: string
  ) {
    super(message)
    this.name = 'FfmpegError'
  }
}

export interface NormalizeOptions {
  inputPath: string
  outputPath: string
  /**
   * Lift a quiet recording to a level the ML engines can work with.
   *
   * Applied to the copy the engines read, never to the archived capture. A quiet
   * source — an XLR interface with the gain low, which is easy to do now that
   * automatic gain control is off by default — can otherwise sit far below the
   * level the models expect and transcribe as nothing at all.
   *
   * This was EBU R128 loudness normalisation (`loudnorm`) and is now a measured
   * linear gain, because loudnorm can render audio untranscribable while leaving
   * every level meter looking healthy. Measured on a 16 kHz mono speech clip:
   * passthrough yielded 28 tokens, the same clip through loudnorm yielded 0, and
   * a plain gain to the same loudness yielded 38. Its output was 6 dB louder
   * with no clipping and the same envelope — nothing a meter would flag. A
   * linear gain cannot do that: it scales the waveform and changes nothing else.
   */
  normalizeLoudness?: boolean
  /** Fractional progress 0..1, or null while the total duration is still unknown. */
  onProgress?: (fraction: number | null) => void
  signal?: AbortSignal
}

/** `Duration: 00:04:31.52` from ffmpeg's banner. */
const DURATION_RE = /Duration:\s*(\d+):(\d{2}):(\d{2})\.(\d{2})/

function parseDurationMs(stderr: string): number | null {
  const m = DURATION_RE.exec(stderr)
  if (!m) return null
  const [, h, min, s, cs] = m
  return (
    Number(h) * 3_600_000 + Number(min) * 60_000 + Number(s) * 1000 + Number(cs) * 10
  )
}

interface RunOptions {
  onProgress?: (fraction: number | null) => void
  signal?: AbortSignal
  /**
   * Resolve with everything ffmpeg printed rather than the empty string.
   *
   * Off by default: a long transcode prints a great deal that nobody reads, and
   * holding all of it costs memory for nothing. Filters that report their
   * findings on stderr — silencedetect, volumedetect — need it.
   */
  capture?: boolean
  /** Directory to create before running, for commands that write into a new one. */
  ensureDir?: string
}

/**
 * Runs ffmpeg to completion, translating its output into progress and errors.
 *
 * Shared by every invocation so that abort handling, the stderr tail kept for
 * diagnostics, and the `-progress` parsing exist once rather than per call
 * site.
 */
function runFfmpeg(args: string[], options: RunOptions = {}): Promise<string> {
  const { onProgress, signal } = options

  return new Promise<string>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Aborted'))
      return
    }

    let child: ReturnType<typeof spawn>
    try {
      if (options.ensureDir) mkdirSync(options.ensureDir, { recursive: true })
      child = spawn(resolveSidecar('ffmpeg'), args, { windowsHide: true })
    } catch (err) {
      reject(err)
      return
    }

    let totalMs: number | null = null
    let stderrTail = ''
    let stdoutBuffer = ''
    let captured = ''
    let settled = false

    const onAbort = (): void => {
      child.kill()
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      fn()
    }

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      // Keep only the tail: a failing ffmpeg can emit a great deal, and only the
      // last few lines carry the actual error.
      stderrTail = (stderrTail + text).slice(-4000)
      if (options.capture) captured += text
      if (totalMs === null) {
        totalMs = parseDurationMs(stderrTail)
      }
    })

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString()
      const lines = stdoutBuffer.split('\n')
      // The trailing element is a partial line; hold it for the next chunk.
      stdoutBuffer = lines.pop() ?? ''

      for (const line of lines) {
        const [key, value] = line.split('=')
        if (key !== 'out_time_us' || !value) continue
        const outUs = Number(value)
        if (!Number.isFinite(outUs) || outUs < 0) continue
        if (totalMs && totalMs > 0) {
          onProgress?.(Math.min(1, outUs / 1000 / totalMs))
        } else {
          onProgress?.(null)
        }
      }
    })

    child.on('error', (err) => {
      finish(() => reject(err))
    })

    child.on('close', (code, signalName) => {
      finish(() => {
        if (signal?.aborted) {
          reject(new Error('Aborted'))
        } else if (code === 0) {
          onProgress?.(1)
          resolve(captured)
        } else {
          reject(
            new FfmpegError(
              `ffmpeg exited with ${signalName ? `signal ${signalName}` : `code ${code}`}`,
              stderrTail.trim().split('\n').slice(-6).join('\n')
            )
          )
        }
      })
    })
  })
}

/** Arguments common to every invocation: quiet banner, no stdin, progress on stdout. */
export function baseArgs(): string[] {
  return [
    '-hide_banner',
    // Without this ffmpeg can block forever waiting on stdin if it decides to
    // prompt (e.g. an overwrite question that -y should have covered).
    '-nostdin'
  ]
}

/** Trailing arguments: machine-readable progress on stdout, stderr for diagnostics. */
function progressArgs(): string[] {
  return ['-progress', 'pipe:1', '-nostats', '-y']
}

/**
 * Runs ffmpeg and resolves with everything it printed.
 *
 * For the filters whose whole purpose is what they write to stderr, and for
 * one-shot commands whose progress nobody is watching.
 */
export function runFfmpegCapture(
  args: string[],
  options: { signal?: AbortSignal; ensureDir?: string } = {}
): Promise<string> {
  return runFfmpeg(args, { ...options, capture: true })
}

/**
 * Decodes any ffmpeg-readable input to 16 kHz mono 16-bit PCM WAV.
 *
 * Video inputs work unchanged: `-vn` drops the video stream and the audio track
 * is transcoded as usual, so mp4/mov/mkv need no separate code path.
 */
export async function normalizeToWav(options: NormalizeOptions): Promise<void> {
  await runFfmpeg(
    [
      ...baseArgs(),
      '-i',
      options.inputPath,
      '-vn',
      '-ac',
      String(TARGET_CHANNELS),
      '-ar',
      String(TARGET_SAMPLE_RATE),
      '-c:a',
      'pcm_s16le',
      ...progressArgs(),
      options.outputPath
    ],
    { onProgress: options.onProgress, signal: options.signal }
  )

  if (options.normalizeLoudness) {
    await applyGain(options.outputPath, options.signal)
  }
}

/** Target RMS for the ML copy, in dBFS. Around where speech corpora sit. */
const TARGET_RMS_DB = -20
/** Ceiling the gain must not push the loudest sample past. */
const TARGET_PEAK_DB = -1.5
/** Below this the gain is not worth a second pass over the file. */
const MIN_USEFUL_GAIN_DB = 1
/** Above this the source is noise being amplified, not speech being rescued. */
const MAX_GAIN_DB = 30

const toDb = (amplitude: number): number => 20 * Math.log10(amplitude)

/**
 * Raises a quiet 16 kHz mono WAV toward a workable level, in place.
 *
 * Measured first, then applied as one constant multiplier — the gain is chosen
 * so that neither the RMS target nor the peak ceiling is exceeded, so it can
 * never clip. Everything the engines rely on (relative dynamics, spectral
 * balance, timing) is untouched; only the volume knob moves.
 *
 * Deliberately not a compressor, a limiter or a loudness normaliser. Those
 * reshape the waveform, and reshaping it is what broke transcription before.
 */
async function applyGain(wavPath: string, signal?: AbortSignal): Promise<void> {
  const { peak, rms } = await measureLevels(wavPath)
  if (peak <= 0 || rms <= 0) return

  const gainDb = Math.min(TARGET_RMS_DB - toDb(rms), TARGET_PEAK_DB - toDb(peak), MAX_GAIN_DB)
  if (gainDb < MIN_USEFUL_GAIN_DB) return

  // ffmpeg cannot read and write the same file, so the gained copy is written
  // beside it and moved over the original once it is complete. A crash mid-pass
  // leaves the un-gained file intact rather than a truncated one.
  const gainedPath = `${wavPath}.gain.wav`
  try {
    await runFfmpeg(
      [
        ...baseArgs(),
        '-i',
        wavPath,
        '-af',
        `volume=${gainDb.toFixed(2)}dB`,
        '-ac',
        String(TARGET_CHANNELS),
        '-ar',
        String(TARGET_SAMPLE_RATE),
        '-c:a',
        'pcm_s16le',
        ...progressArgs(),
        gainedPath
      ],
      { signal }
    )
    await rename(gainedPath, wavPath)
    console.log(`[ffmpeg] applied ${gainDb.toFixed(1)} dB of gain to ${wavPath}`)
  } catch (err) {
    await rm(gainedPath, { force: true }).catch(() => undefined)
    // The un-gained file is still perfectly usable; a quiet transcript beats no
    // transcript, and the caller has no better recovery than carrying on.
    console.warn('[ffmpeg] could not apply gain, continuing with the original level:', err)
  }
}

export interface MixOptions {
  /** Two or more captures to sum, in playback-priority order. */
  inputPaths: string[]
  outputPath: string
  onProgress?: (fraction: number | null) => void
  signal?: AbortSignal
}

/**
 * Sums several captures into a single playback file.
 *
 * The per-source tracks stay on disk and remain what the ML pipeline reads —
 * attributing the microphone to the local user outright depends on it never
 * being mixed. This file exists so that *listening* to a recording gives both
 * ends of the conversation, which is what a mix is good for and transcription
 * is not.
 *
 * `amix` normalizes by default, dividing every input by the number of inputs:
 * two tracks would each land 6 dB down and the result would sound quiet beside
 * either track alone. normalize=0 keeps each at its captured level and
 * `alimiter` catches the moments where the two sum past full scale — hard
 * clipping is the only other outcome, and it is audible. `level=disabled` stops
 * the limiter applying make-up gain of its own, which would undo normalize=0.
 *
 * duration=longest so a track that stopped early cannot truncate the others.
 * Every track is driven by one AudioContext and starts at t=0, so summing them
 * needs no offset.
 */
export async function mixToWav(options: MixOptions): Promise<void> {
  if (options.inputPaths.length < 2) {
    throw new Error('mixToWav needs at least two inputs')
  }

  await runFfmpeg(
    [
      ...baseArgs(),
      ...options.inputPaths.flatMap((path) => ['-i', path]),
      '-filter_complex',
      `amix=inputs=${options.inputPaths.length}:duration=longest:normalize=0,alimiter=limit=0.95:level=disabled`,
      '-ac',
      String(TARGET_CHANNELS),
      '-c:a',
      'pcm_s16le',
      ...progressArgs(),
      options.outputPath
    ],
    { onProgress: options.onProgress, signal: options.signal }
  )
}

export interface ExtractSegment {
  startMs: number
  endMs: number
}

/**
 * Cuts several ranges out of one WAV and joins them into a new file, in the
 * order given.
 *
 * Used to build a voice-profile sample from a speaker's own lines: rather than
 * recording a fresh clip, the cleanest few lines already on disk are stitched
 * together into one anchor.
 */
export async function extractSegmentsToWav(options: {
  inputPath: string
  segments: ExtractSegment[]
  outputPath: string
  signal?: AbortSignal
}): Promise<void> {
  const { inputPath, segments, outputPath, signal } = options
  if (segments.length === 0) {
    throw new Error('extractSegmentsToWav needs at least one segment')
  }

  const trims = segments.map(
    (s, i) =>
      `[0:a]atrim=start=${(s.startMs / 1000).toFixed(3)}:end=${(s.endMs / 1000).toFixed(3)},asetpts=PTS-STARTPTS[s${i}]`
  )
  const labels = segments.map((_, i) => `[s${i}]`).join('')
  const filter = [...trims, `${labels}concat=n=${segments.length}:v=0:a=1[out]`].join(';')

  await runFfmpeg(
    [
      ...baseArgs(),
      '-i',
      inputPath,
      '-filter_complex',
      filter,
      '-map',
      '[out]',
      '-ac',
      String(TARGET_CHANNELS),
      '-ar',
      String(TARGET_SAMPLE_RATE),
      '-c:a',
      'pcm_s16le',
      ...progressArgs(),
      outputPath
    ],
    { signal }
  )
}

export interface ConcatPart {
  inputPath: string
  durationMs: number
}

export interface ConcatResult {
  /** Start time of each part in the concatenated output, in the same order as `parts`. */
  offsets: number[]
}

/**
 * Concatenates several tracks into one WAV with real silence between them, for
 * joint diarization across tracks that were captured separately.
 *
 * The gap has to be actual silence in the audio, not just a timestamp offset:
 * the segmentation model ends a speech segment where it hears quiet, and a
 * hard cut straight from one track into the next gives it nothing to stop at,
 * so a segment can bridge the seam and merge two different tracks' voices into
 * one. `durationMs` is trusted rather than probed from the output — the parts'
 * own recorded lengths already fix the geometry, so the offsets are exact
 * without a second pass over the file.
 */
export async function concatToWav(options: {
  parts: ConcatPart[]
  gapMs: number
  outputPath: string
  signal?: AbortSignal
}): Promise<ConcatResult> {
  const { parts, gapMs, outputPath, signal } = options
  if (parts.length < 2) {
    throw new Error('concatToWav needs at least two parts')
  }

  const gapSec = (gapMs / 1000).toFixed(3)
  const lastIndex = parts.length - 1
  // Every part but the last gets silence appended to its own end; the concat
  // filter then simply runs them back to back.
  const padded = parts.slice(0, lastIndex).map((_, i) => `[${i}:a]apad=pad_dur=${gapSec}[a${i}]`)
  const labels = parts.slice(0, lastIndex).map((_, i) => `[a${i}]`).join('') + `[${lastIndex}:a]`
  const filter = [...padded, `${labels}concat=n=${parts.length}:v=0:a=1[out]`].join(';')

  await runFfmpeg(
    [
      ...baseArgs(),
      ...parts.flatMap((p) => ['-i', p.inputPath]),
      '-filter_complex',
      filter,
      '-map',
      '[out]',
      '-ac',
      String(TARGET_CHANNELS),
      '-ar',
      String(TARGET_SAMPLE_RATE),
      '-c:a',
      'pcm_s16le',
      ...progressArgs(),
      outputPath
    ],
    { signal }
  )

  const offsets: number[] = []
  let cursor = 0
  for (const part of parts) {
    offsets.push(cursor)
    cursor += part.durationMs + gapMs
  }
  return { offsets }
}
