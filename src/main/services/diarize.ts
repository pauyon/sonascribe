import { spawn } from 'node:child_process'
import { cpus } from 'node:os'
import { dirname } from 'node:path'
import type { SpeakerSplitting } from '@shared/types'
import { resolveBundledModel, resolveSidecar } from './sidecars'

/**
 * Runs sherpa-onnx's offline speaker diarization CLI.
 *
 * Two models are involved: pyannote-segmentation-3.0 decides *when* somebody is
 * speaking, and a speaker-embedding network decides *who*. Embeddings are then
 * clustered — either into a known number of speakers, or by a distance
 * threshold when the count is unknown.
 */

export interface SpeakerSegment {
  startMs: number
  endMs: number
  /** Cluster index from the diarizer: 0, 1, 2… */
  speaker: number
}

export class DiarizationError extends Error {
  constructor(
    message: string,
    readonly stderrTail: string
  ) {
    super(message)
    this.name = 'DiarizationError'
  }
}

export interface DiarizeOptions {
  wavPath: string
  /**
   * Speaker count when known. More accurate than thresholding — most meetings
   * know their own headcount.
   *
   * A ceiling rather than an exact figure, despite the flag's name: measured
   * against this sidecar, asking for 3 clusters on audio holding two voices
   * returns 2, and asking for 5 returns 4. It stops the count running away
   * without inventing speakers to fill a quota.
   */
  numSpeakers?: number | null
  /**
   * Distance threshold used when the count is unknown. Lower splits more
   * eagerly (more speakers), higher merges more.
   */
  threshold?: number
  /**
   * Segments shorter than this many seconds are discarded before clustering.
   *
   * This is the second half of the over-splitting problem and the easier half to
   * miss. A 0.3 s blip — a cough, a keystroke, half a "mm-hm", a word of
   * crosstalk — is long enough to become a segment but far too short for a
   * reliable speaker embedding, so it clusters as its own person. Discarding
   * those costs a little real speech at the margins and removes most invented
   * speakers.
   */
  minDurationOn?: number
  /**
   * Length of the audio, used to temper minDurationOn.
   *
   * Optional: without it the preset value is used unchanged.
   */
  durationMs?: number
  /**
   * Threads for both neural networks.
   *
   * sherpa-onnx defaults each to 1, and the app never overrode it, so speaker
   * identification ran on a single core while the other seven sat idle. Passing
   * a real number halved the time on an 8-core machine with byte-identical
   * output.
   */
  threads?: number
  /**
   * Segmentation window shift, as a fraction of the window size.
   *
   * The library default of 0.1 means each window advances by a tenth of its
   * length — 90% overlap, and roughly ten times the segmentation work needed.
   *
   * Measured against sherpa's own reference recordings: 0.1 and 0.25 both return
   * the right count for their 2-speaker and 4-speaker clips, while 0.25 is 2.2×
   * faster; 0.5 is faster still and finds only 3 of the 4 speakers. So 0.25 is
   * the point where the saving stops being free.
   */
  windowShiftRatio?: number
  onProgress?: (fraction: number) => void

  signal?: AbortSignal
}

/**
 * Clustering presets for when the speaker count is unknown.
 *
 * These numbers are measured, not guessed. Against sherpa-onnx's own reference
 * recordings — a 2-speaker clip and a 4-speaker clip — 'balanced' is the only
 * setting that returns the right count for both. The library's own defaults
 * (0.5 / 0.3) report 8 speakers for the 4-speaker clip, and worse on real
 * conference audio; 'merge' fuses that clip down to 3.
 */
export const SPLITTING_PRESETS: Record<
  SpeakerSplitting,
  { threshold: number; minDurationOn: number }
> = {
  merge: { threshold: 0.95, minDurationOn: 1.0 },
  balanced: { threshold: 0.9, minDurationOn: 0.7 },
  split: { threshold: 0.7, minDurationOn: 0.3 }
}

/**
 * Softens the minimum segment length on short recordings.
 *
 * Discarding sub-second segments is what stops a long meeting fragmenting into
 * a tail of invented speakers — the problem it was raised to solve grows with
 * length, because there is more crosstalk and more noise to mistake for people.
 *
 * On a short take it does the opposite. A 7-second recording where the second
 * person says one word for 0.39 s loses that person entirely: their whole
 * contribution is shorter than the threshold. There is no tail of junk clusters
 * to guard against in seven seconds, so the guard is not worth its cost.
 *
 * Below a minute the floor drops to 0.25 s, which is short enough to keep a
 * one-word reply; it eases back to the preset value by the two-minute mark.
 */
export function minDurationOnFor(preset: number, durationMs?: number): number {
  if (durationMs == null || durationMs >= 120_000) return preset
  const SHORT = 0.25
  if (durationMs <= 60_000) return Math.min(preset, SHORT)
  // Between one and two minutes, ease from the short floor up to the preset.
  const t = (durationMs - 60_000) / 60_000
  return Math.min(preset, SHORT + (preset - SHORT) * t)
}

/** Fastest shift that still gets both reference recordings right. See windowShiftRatio. */

const DEFAULT_WINDOW_SHIFT_RATIO = 0.25

/** Leave a couple of cores for the rest of the machine; this is not the only thing running. */
function defaultThreads(): number {
  return Math.max(1, Math.min(8, cpus().length - 2))
}

/** `progress 42.86%` */

const PROGRESS_RE = /progress\s+([\d.]+)%/
/** `1.583 -- 3.406 speaker_00` — times are seconds. */
const SEGMENT_RE = /^\s*([\d.]+)\s*--\s*([\d.]+)\s+speaker_(\d+)\s*$/

export function diarize(options: DiarizeOptions): Promise<SpeakerSegment[]> {
  const {
    wavPath,
    numSpeakers,
    threshold = SPLITTING_PRESETS.balanced.threshold,
    minDurationOn = minDurationOnFor(SPLITTING_PRESETS.balanced.minDurationOn, options.durationMs),
    threads = defaultThreads(),
    windowShiftRatio = DEFAULT_WINDOW_SHIFT_RATIO,
    onProgress,
    signal
  } = options

  return new Promise<SpeakerSegment[]>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Aborted'))
      return
    }

    let exe: string
    let segmentationModel: string
    let embeddingModel: string
    try {
      exe = resolveSidecar('sherpa-onnx-offline-speaker-diarization')
      segmentationModel = resolveBundledModel('segmentation.onnx')
      embeddingModel = resolveBundledModel('speaker-embedding.onnx')
    } catch (err) {
      reject(err)
      return
    }

    const args = [
      `--segmentation.pyannote-model=${segmentationModel}`,
      `--embedding.model=${embeddingModel}`,
      // num-clusters and cluster-threshold are mutually exclusive: passing a
      // positive cluster count makes the threshold irrelevant.
      ...(numSpeakers && numSpeakers > 0
        ? [`--clustering.num-clusters=${numSpeakers}`]
        : [`--clustering.cluster-threshold=${threshold}`]),
      // Applied whether or not the count is known: a sub-second segment yields
      // an unreliable embedding either way, and with a fixed cluster count it
      // drags a real speaker's centroid around instead of forming its own.
      `--min-duration-on=${minDurationOn}`,
      `--segmentation.num-threads=${threads}`,
      `--embedding.num-threads=${threads}`,
      `--segmentation.pyannote-window-shift-ratio=${windowShiftRatio}`,
      wavPath
    ]

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(exe, args, {
        windowsHide: true,
        // The executable loads its shared libraries from its own directory;
        // starting it elsewhere can leave the loader unable to find them.
        cwd: dirname(exe)
      })
    } catch (err) {
      reject(err)
      return
    }

    const segments: SpeakerSegment[] = []
    let stderrTail = ''
    let buffer = ''
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

    // Progress and results both arrive on stdout/stderr depending on build, so
    // both streams go through the same line parser.
    const consume = (chunk: Buffer): void => {
      const text = chunk.toString()
      stderrTail = (stderrTail + text).slice(-6000)

      buffer += text
      const lines = buffer.split('\n')
      // The trailing element may be a partial line.
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const progress = PROGRESS_RE.exec(line)
        if (progress) {
          onProgress?.(Math.min(1, Number(progress[1]) / 100))
          continue
        }
        const segment = SEGMENT_RE.exec(line)
        if (segment) {
          segments.push({
            startMs: Math.round(Number(segment[1]) * 1000),
            endMs: Math.round(Number(segment[2]) * 1000),
            speaker: Number(segment[3])
          })
        }
      }
    }

    child.stdout?.on('data', consume)
    child.stderr?.on('data', consume)

    child.on('error', (err) => finish(() => reject(err)))

    child.on('close', (code, signalName) => {
      finish(() => {
        if (signal?.aborted) {
          reject(new Error('Aborted'))
          return
        }
        if (code !== 0) {
          reject(
            new DiarizationError(
              `diarization exited with ${signalName ? `signal ${signalName}` : `code ${code}`}`,
              stderrTail.trim().split('\n').slice(-8).join('\n')
            )
          )
          return
        }
        // Flush a final line with no trailing newline.
        if (buffer.trim()) consume(Buffer.from('\n'))
        onProgress?.(1)
        segments.sort((a, b) => a.startMs - b.startMs)
        resolve(segments)
      })
    })
  })
}
