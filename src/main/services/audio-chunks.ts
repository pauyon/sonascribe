import { readdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { runFfmpegCapture, baseArgs, TARGET_CHANNELS, TARGET_SAMPLE_RATE } from './ffmpeg'
import { readWavInfo } from './wav'

/**
 * Splits long audio into windows a speech engine can actually hold.
 *
 * parakeet-cli decodes a whole file in one pass and its memory grows with the
 * length of that file: measured on a 2 h 25 m recording it reached 20.8 GB
 * resident and 66 GB of commit, which no ordinary machine can satisfy. The
 * process does not fail loudly when it cannot — it exits successfully having
 * printed no tokens, which the pipeline could only read as "no speech", so a
 * recording full of conversation was reported as silent.
 *
 * Memory tracks the length of the file handed over, at roughly 800 MB per
 * minute of audio once the model itself is loaded. Ten-minute windows measured
 * 10.1 GB resident, where the whole file wanted 66 GB and got nothing done.
 * whisper.cpp windows audio internally and needs none of this; only the Parakeet
 * path does.
 */

/**
 * Window length that keeps the engine's memory use bounded.
 *
 * Five minutes rather than ten so two windows can run at once inside a sane
 * memory budget: at roughly 800 MB per minute plus the model, a ten-minute
 * window measured 10.1 GB and two of them would not fit alongside everything
 * else on a normal machine.
 */
export const CHUNK_TARGET_MS = 5 * 60 * 1000

/** Marks a directory as ours, so the startup sweep can recognise one. */
const CHUNK_DIR_PREFIX = 'sonascribe-chunks-'

/**
 * Audio shorter than this is handed over whole.
 *
 * Splitting is not free — it re-encodes, and every boundary is a chance to lose
 * a word across the seam — so it is only worth doing once a file is long enough
 * to be a problem.
 */
export const CHUNK_THRESHOLD_MS = 10 * 60 * 1000

/** How far from an ideal boundary a silence may be and still be preferred to it. */
const BOUNDARY_SEARCH_MS = 90 * 1000

export interface AudioChunk {
  /** Offset of this window in the original recording, for rebasing timestamps. */
  startMs: number
  endMs: number
  path: string
}

/** `[silencedetect @ ...] silence_start: 123.456` */
const SILENCE_START_RE = /silence_start:\s*([\d.]+)/
/** `[silencedetect @ ...] silence_end: 125.1 | silence_duration: 1.6` */
const SILENCE_END_RE = /silence_end:\s*([\d.]+)/

/**
 * Finds the quiet stretches, so windows can be cut where nobody is talking.
 *
 * Cutting at a fixed ten minutes lands mid-word roughly whenever ten minutes
 * lands mid-word, and both halves of that word are then mistranscribed. One
 * cheap non-ML pass over the audio buys boundaries that fall in the gaps
 * instead.
 *
 * -50 dB over 0.4 s is a pause between sentences, not the gap between two words
 * — the aim is a handful of good boundaries, not every hesitation.
 */
async function findSilences(wavPath: string, signal?: AbortSignal): Promise<Array<{ startMs: number; endMs: number }>> {
  const output = await runFfmpegCapture(
    [...baseArgs(), '-i', wavPath, '-af', 'silencedetect=noise=-50dB:d=0.4', '-f', 'null', '-'],
    { signal }
  )

  const silences: Array<{ startMs: number; endMs: number }> = []
  let pendingStart: number | null = null

  for (const line of output.split('\n')) {
    const start = SILENCE_START_RE.exec(line)
    if (start) {
      pendingStart = Number(start[1]) * 1000
      continue
    }
    const end = SILENCE_END_RE.exec(line)
    if (end && pendingStart != null) {
      silences.push({ startMs: pendingStart, endMs: Number(end[1]) * 1000 })
      pendingStart = null
    }
  }

  return silences
}

/**
 * Chooses the cut points for one file.
 *
 * Each boundary starts at a multiple of the target length and then moves to the
 * middle of the nearest silence within the search window. Falling back to the
 * exact offset is fine: a boundary in the middle of speech costs at most the
 * word it lands on, where not splitting at all costs the entire recording.
 */
export function planBoundaries(
  durationMs: number,
  silences: Array<{ startMs: number; endMs: number }>,
  targetMs = CHUNK_TARGET_MS
): number[] {
  const boundaries: number[] = []

  for (let at = targetMs; at < durationMs; at += targetMs) {
    let best: number | null = null
    let bestDistance = BOUNDARY_SEARCH_MS

    for (const silence of silences) {
      const middle = (silence.startMs + silence.endMs) / 2
      const distance = Math.abs(middle - at)
      // Never move a boundary backwards past one already chosen, or the windows
      // would overlap and duplicate speech.
      if (distance < bestDistance && middle > (boundaries[boundaries.length - 1] ?? 0)) {
        bestDistance = distance
        best = middle
      }
    }

    boundaries.push(Math.round(best ?? at))
  }

  return boundaries
}

/**
 * Cuts the audio into windows on disk.
 *
 * The pieces are written to the system temp directory, not beside the
 * recording: they are scratch, and a crash mid-transcription must not leave
 * fragments in the user's media folder that later look like tracks.
 */
export async function splitAudio(
  wavPath: string,
  options: { targetMs?: number; signal?: AbortSignal } = {}
): Promise<AudioChunk[]> {
  const info = await readWavInfo(wavPath)
  const targetMs = options.targetMs ?? CHUNK_TARGET_MS

  if (info.durationMs <= CHUNK_THRESHOLD_MS) {
    return [{ startMs: 0, endMs: info.durationMs, path: wavPath }]
  }

  const silences = await findSilences(wavPath, options.signal)
  const boundaries = planBoundaries(info.durationMs, silences, targetMs)
  const edges = [0, ...boundaries, info.durationMs]

  const dir = join(tmpdir(), `${CHUNK_DIR_PREFIX}${randomUUID()}`)

  // Each cut is an independent seek-and-copy over the same read-only source
  // file, so there is nothing to serialize here — running them together
  // rather than one at a time is a straightforward win on a recording split
  // into many chunks.
  return Promise.all(
    edges.slice(0, -1).map((startMs, i) => {
      const endMs = edges[i + 1]
      const path = join(dir, `chunk-${String(i).padStart(3, '0')}.wav`)

      return runFfmpegCapture(
        [
          ...baseArgs(),
          // Before -i so ffmpeg seeks rather than decoding and discarding; on PCM
          // this is exact, so the offsets stay sample-accurate.
          '-ss',
          (startMs / 1000).toFixed(3),
          '-t',
          ((endMs - startMs) / 1000).toFixed(3),
          '-i',
          wavPath,
          '-ac',
          String(TARGET_CHANNELS),
          '-ar',
          String(TARGET_SAMPLE_RATE),
          '-c:a',
          'pcm_s16le',
          '-y',
          path
        ],
        { signal: options.signal, ensureDir: dir }
      ).then(() => ({ startMs, endMs, path }))
    })
  )
}

/** Removes the scratch directory a split produced. Never throws. */
export async function discardChunks(chunks: AudioChunk[], originalPath: string): Promise<void> {
  const dirs = new Set(
    chunks.filter((c) => c.path !== originalPath).map((c) => join(c.path, '..'))
  )
  for (const dir of dirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

/**
 * Removes chunk directories left by an interrupted transcription.
 *
 * The split files are deleted in a `finally` when a job ends, but a job killed
 * with the app never reaches it: quitting mid-transcription strands a few
 * hundred megabytes of scratch WAVs in the temp directory. Jobs do not survive
 * a restart, so anything found here at startup belongs to a run that is already
 * over and is safe to remove.
 */
export async function sweepOrphanedChunks(): Promise<number> {
  let entries: string[]
  try {
    entries = readdirSync(tmpdir())
  } catch {
    return 0
  }

  let removed = 0
  for (const entry of entries) {
    if (!entry.startsWith(CHUNK_DIR_PREFIX)) continue
    try {
      await rm(join(tmpdir(), entry), { recursive: true, force: true })
      removed++
    } catch (err) {
      console.warn(`[chunks] could not remove ${entry}:`, err)
    }
  }

  if (removed > 0) console.log(`[chunks] removed ${removed} stranded chunk director(ies)`)
  return removed
}
