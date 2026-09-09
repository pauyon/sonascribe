import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { resolveSidecar } from './sidecars'

/**
 * ffmpeg invocation for the one thing this app still needs it for: turning an
 * imported file into a clean WAV. A live recording never touches ffmpeg —
 * mic and system audio are mixed in the browser's own audio graph and
 * written straight to disk (see lib/capture.ts and services/recorder.ts).
 */

/** A plain recorder has no ML model dictating a sample rate; this just keeps every imported file in one predictable format for playback and waveform peaks. */
export const TARGET_SAMPLE_RATE = 48_000
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
   * Resolve with everything ffmpeg printed rather than the empty string. Off
   * by default: a long transcode prints a great deal that nobody reads, and
   * holding all of it costs memory for nothing. Filters that report their
   * findings on stderr — silencedetect — need it.
   */
  capture?: boolean
  /** Directory to create before running, for commands that write into a new one. */
  ensureDir?: string
}

/**
 * Runs ffmpeg to completion, translating its output into progress and
 * errors. Resolves with whatever was printed when `capture` is set,
 * otherwise the empty string.
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

/**
 * Runs ffmpeg and resolves with everything it printed.
 *
 * For filters whose whole purpose is what they write to stderr (silence
 * detection) and one-shot commands nobody is watching progress on.
 */
export function runFfmpegCapture(
  args: string[],
  options: { signal?: AbortSignal; ensureDir?: string } = {}
): Promise<string> {
  return runFfmpeg(args, { ...options, capture: true })
}

/**
 * Decodes any ffmpeg-readable input to mono 16-bit PCM WAV.
 *
 * Video inputs work unchanged: `-vn` drops the video stream and the audio
 * track is transcoded as usual, so mp4/mov/mkv need no separate code path.
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
      '-progress',
      'pipe:1',
      '-nostats',
      '-y',
      options.outputPath
    ],
    { onProgress: options.onProgress, signal: options.signal }
  )
}

/** Sample rate whisper.cpp/Parakeet require — unrelated to `TARGET_SAMPLE_RATE` above, which is this app's own playback/recording format. */
export const ASR_SAMPLE_RATE = 16_000
export const ASR_CHANNELS = 1

/**
 * Resamples a recording's own WAV (48 kHz, for playback quality) down to
 * what the ASR engines require, into a scratch temp file — never the
 * recording's own file, which stays untouched either way.
 */
export async function resampleForAsr(
  inputPath: string,
  outputPath: string,
  signal?: AbortSignal
): Promise<void> {
  await runFfmpeg(
    [
      ...baseArgs(),
      '-i',
      inputPath,
      '-ac',
      String(ASR_CHANNELS),
      '-ar',
      String(ASR_SAMPLE_RATE),
      '-c:a',
      'pcm_s16le',
      '-y',
      outputPath
    ],
    { signal }
  )
}
