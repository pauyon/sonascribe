import { open, mkdir, rm, writeFile } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { cpus, tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { TrackKind } from '@shared/types'
import { findAsrModel } from '@shared/models'
import { getLanguage, getSelectedModelId } from '../db/settings'
import { resolveModelPath } from './models'
import { transcribeWithParakeet } from './parakeet'
import { transcribeWithWhisper } from './whisper'
import type { TranscriptionResult, TranscriptWord } from './transcription'
import { runFfmpegCapture, baseArgs, normalizeToWav } from './ffmpeg'
import { measurePeak, SILENCE_PEAK_THRESHOLD } from './peaks'

/**
 * Transcribes a recording while it is still being recorded.
 *
 * The engine costs roughly an eighth of real time — measured, a 30-second window
 * takes 3.8 s — so the machine sits idle through most of a recording while a
 * full pass waits for the end of it. Windowing the audio as it arrives spends
 * that idle time instead, and the transcript is done about when the speaker
 * stops rather than half an hour later.
 *
 * Windows are transcribed once and kept, not shown as a rough preview and redone:
 * they are cut at silences, so the result is what a batch pass would have
 * produced. The job that runs on stop picks them up and has only speakers left to
 * work out — clustering is the one part that cannot be done live, since a voice
 * cannot be known to be new until every other voice has been heard.
 */

/**
 * How much audio to hand the engine at once.
 *
 * Every window pays a fixed ~2.3 s to start the engine and load the model,
 * whatever its length, and that sets the floor on how live this can feel.
 * Measured, as a share of real time spent transcribing: 5 s windows cost 49%,
 * 8 s cost 32%, 10 s cost 27%, 15 s cost 22%, 30 s cost 17%.
 *
 * Ten seconds is where the curve flattens. Text lands about 13 seconds behind
 * the speaker rather than the 35 that 45-second windows gave, and going shorter
 * spends most of the extra CPU on starting the engine rather than on audio.
 *
 * Genuinely word-by-word output is not reachable this way at all: it needs a
 * streaming model that emits partial hypotheses as audio arrives, where this one
 * transcribes a finished file and returns once.
 */
const WINDOW_MS = 10_000

/**
 * Audio held back from the newest end of the file.
 *
 * The final moment of a recording in progress is mid-word by definition. A margin
 * means each window ends somewhere the speaker had already stopped.
 */
const TAIL_MARGIN_MS = 1_500

/** How often to look for enough new audio to be worth a window. */
const TICK_MS = 3_000

/** A window shorter than this is mostly engine startup, so it waits. */
const MIN_WINDOW_MS = 6_000

/** Bytes per millisecond of 16-bit mono PCM. */
const bytesPerMs = (sampleRate: number): number => (sampleRate * 2) / 1000

/** Where the PCM starts in the files WavWriter produces. */
const HEADER_BYTES = 44

interface LiveTrack {
  kind: TrackKind
  path: string
  sampleRate: number
  /** Milliseconds already transcribed, and so where the next window starts. */
  consumedMs: number
  words: TranscriptWord[]
}

interface LiveSession {
  recordingId: string
  tracks: LiveTrack[]
  dir: string
  timer: NodeJS.Timeout | null
  /** Set while a window is in the engine, so ticks cannot overlap. */
  busy: boolean
  stopped: boolean
  modelPath: string
  engine: 'whisper' | 'parakeet'
  language: string
  onWindow?: (kind: TrackKind, window: { startMs: number; endMs: number; text: string }) => void
}

let session: LiveSession | null = null

/**
 * Claimed before the awaits in startLiveTranscription, and cleared after.
 *
 * The guard there checks `session`, which is only assigned once the model path
 * has been resolved and the scratch directory made — both awaits. Two starts
 * arriving in that window both passed the check, and the first session's timer
 * was then orphaned: never cleared, ticking every few seconds against a file it
 * no longer owned, for the rest of the process.
 */
let starting = false


interface LiveResult {
  words: TranscriptWord[]
  /**
   * Milliseconds of audio actually put through the engine.
   *
   * Coverage has to be measured by what was processed, not by where the last
   * word landed. People stop talking before they press stop, so a recording that
   * ends in a pause would look half transcribed and be thrown away — which is
   * exactly what happened to a 13-second take whose speech ended at 6.6 s.
   */
  processedMs: number
}

/** Completed results, waiting for the job that runs after the recording stops. */
const finished = new Map<string, Map<TrackKind, LiveResult>>()


/** Canonical 44-byte header for a slice of 16-bit mono PCM. */
function wavHeader(dataBytes: number, sampleRate: number): Buffer {
  const header = Buffer.alloc(HEADER_BYTES)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + dataBytes, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(dataBytes, 40)
  return header
}

/**
 * Copies a byte range out of the capture into a playable WAV.
 *
 * Read by byte offset rather than through a WAV reader on purpose: the capture is
 * still open and its header still says the payload is empty, because WavWriter
 * patches those fields only on close. The data begins at a known offset in a
 * known format, so the bytes can simply be taken.
 */
async function sliceToWav(
  sourcePath: string,
  startMs: number,
  endMs: number,
  sampleRate: number,
  outPath: string
): Promise<number> {
  const perMs = bytesPerMs(sampleRate)
  // Aligned to whole samples; half a sample would shift every one after it.
  const start = HEADER_BYTES + Math.floor((startMs * perMs) / 2) * 2
  const end = HEADER_BYTES + Math.floor((endMs * perMs) / 2) * 2
  const length = Math.max(0, end - start)

  const handle = await open(sourcePath, 'r')
  try {
    const pcm = Buffer.alloc(length)
    const { bytesRead } = await handle.read(pcm, 0, length, start)
    const body = pcm.subarray(0, bytesRead)
    await writeFile(outPath, Buffer.concat([wavHeader(body.length, sampleRate), body]))
    return body.length / perMs
  } finally {
    await handle.close()
  }
}

/** `silence_start: 12.34` */
const SILENCE_START_RE = /silence_start:\s*([\d.]+)/

/**
 * Where to end a window so it does not cut through a word.
 *
 * Only silences in the last third count: moving the boundary earlier to reach one
 * leaves audio for the next window to redo, and the point of a window is to make
 * progress. Null when the speaker never paused, in which case the caller takes
 * the whole candidate — one clipped word beats stalling forever.
 */
async function silenceCut(wavPath: string, candidateMs: number): Promise<number | null> {
  const output = await runFfmpegCapture([
    ...baseArgs(),
    '-i',
    wavPath,
    '-af',
    'silencedetect=noise=-45dB:d=0.25',
    '-f',
    'null',
    '-'
  ]).catch(() => '')

  let best: number | null = null
  for (const line of output.split('\n')) {
    const match = SILENCE_START_RE.exec(line)
    if (!match) continue
    const at = Number(match[1]) * 1000
    if (at >= Math.max(MIN_WINDOW_MS, candidateMs * 0.66) && at < candidateMs) best = at
  }
  return best
}

function transcribeSlice(current: LiveSession, wavPath: string): Promise<TranscriptionResult> {
  const options = {
    wavPath,
    modelPath: current.modelPath,
    language: current.language,
    // Half the machine: the other half belongs to the recording this is serving.
    threads: Math.max(1, Math.floor(cpus().length / 2))
  }
  return current.engine === 'parakeet'
    ? transcribeWithParakeet(options)
    : transcribeWithWhisper(options)
}

/** Transcribes whatever new audio is ready on one track. True if it did any. */
async function advance(current: LiveSession, track: LiveTrack, final: boolean): Promise<boolean> {
  let availableMs: number
  try {
    availableMs = Math.max(0, statSync(track.path).size - HEADER_BYTES) / bytesPerMs(track.sampleRate)
  } catch {
    return false
  }

  const limitMs = final ? availableMs : availableMs - TAIL_MARGIN_MS
  if (limitMs - track.consumedMs < (final ? 1 : MIN_WINDOW_MS)) return false

  const startedAt = track.consumedMs
  const candidateEnd = Math.min(limitMs, startedAt + WINDOW_MS)
  const slicePath = join(current.dir, `${track.kind}-${Math.round(startedAt)}.wav`)
  await sliceToWav(track.path, startedAt, candidateEnd, track.sampleRate, slicePath)

  // The final pass takes everything left; there is no next window to hand a
  // remainder to.
  let endMs = candidateEnd
  if (!final) {
    const cut = await silenceCut(slicePath, candidateEnd - startedAt)
    if (cut != null && startedAt + cut < candidateEnd) {
      endMs = startedAt + cut
      await sliceToWav(track.path, startedAt, endMs, track.sampleRate, slicePath)
    }
  }

  // The capture is at the hardware's rate — 48 kHz on most machines — and the
  // engines take 16 kHz mono. The batch path normalises tracks before ASR; a
  // window has to be normalised too, or the engine is handed audio at three
  // times the rate it expects and returns nothing at all.
  const readyPath = `${slicePath}.16k.wav`
  try {
    await normalizeToWav({ inputPath: slicePath, outputPath: readyPath, normalizeLoudness: true })
  } catch (err) {
    console.warn(`[live] ${track.kind} window at ${Math.round(startedAt / 1000)}s could not be prepared:`, err)
    track.consumedMs = endMs
    await rm(slicePath, { force: true }).catch(() => undefined)
    return true
  }

  // Nothing to transcribe in silence, and the engine charges the same 2.3 s to
  // discover that. System audio is silent for most of a recording that is not a
  // call, so skipping those windows roughly halves the cost of a two-track take.
  const peak = await measurePeak(readyPath).catch(() => 1)
  if (peak < SILENCE_PEAK_THRESHOLD) {
    track.consumedMs = endMs
    await rm(slicePath, { force: true }).catch(() => undefined)
    await rm(readyPath, { force: true }).catch(() => undefined)
    return true
  }

  try {
    const result = await transcribeSlice(current, readyPath)

    const fresh: TranscriptWord[] = []
    for (const segment of result.segments) {
      for (const word of segment.words) {
        fresh.push({
          ...word,
          startMs: word.startMs + startedAt,
          endMs: word.endMs + startedAt
        })
      }
    }
    track.words.push(...fresh)

    console.log(
      `[live] ${track.kind} ${Math.round(startedAt / 1000)}-${Math.round(endMs / 1000)}s -> ${fresh.length} words`
    )

    if (fresh.length > 0) {
      current.onWindow?.(track.kind, {
        startMs: fresh[0].startMs,
        endMs: fresh[fresh.length - 1].endMs,
        text: fresh.map((word) => word.text).join(' ').replace(/\s+([,.!?])/g, '$1')
      })
    }
  } catch (err) {
    // A failed window is not fatal: the audio is safe on disk, and the job on
    // stop falls back to a full pass whenever live coverage comes up short.
    console.warn(`[live] ${track.kind} window at ${Math.round(startedAt / 1000)}s failed:`, err)
  } finally {
    // Advanced either way, so a window that cannot be transcribed is not retried
    // forever while the recording runs on ahead of it.
    track.consumedMs = endMs
    await rm(slicePath, { force: true }).catch(() => undefined)
    await rm(readyPath, { force: true }).catch(() => undefined)
  }
  return true
}

export interface StartLiveInput {
  recordingId: string
  tracks: Array<{ kind: TrackKind; path: string }>
  sampleRate: number
  onWindow?: (kind: TrackKind, window: { startMs: number; endMs: number; text: string }) => void
}

/**
 * Begins transcribing a recording as it is captured.
 *
 * False when it cannot run — no model chosen, or not downloaded yet — which is
 * not an error: the recording proceeds and is transcribed on stop as before.
 */
export async function startLiveTranscription(input: StartLiveInput): Promise<boolean> {
  if (session || starting) return false
  starting = true

  try {
    return await openSession(input)
  } finally {
    starting = false
  }
}

async function openSession(input: StartLiveInput): Promise<boolean> {
  const modelId = getSelectedModelId()
  const spec = modelId ? findAsrModel(modelId) : null
  if (!modelId || !spec) return false
  const modelPath = await resolveModelPath(modelId)
  if (!modelPath) return false

  const dir = join(tmpdir(), `sonascribe-live-${randomUUID()}`)
  await mkdir(dir, { recursive: true })

  const current: LiveSession = {
    recordingId: input.recordingId,
    dir,
    timer: null,
    busy: false,
    stopped: false,
    modelPath,
    engine: spec.engine,
    language: getLanguage(),
    onWindow: input.onWindow,
    tracks: input.tracks.map((track) => ({
      kind: track.kind,
      path: track.path,
      sampleRate: input.sampleRate,
      consumedMs: 0,
      words: []
    }))
  }
  session = current

  current.timer = setInterval(() => {
    void tick(current)
  }, TICK_MS)

  console.log(`[live] transcribing ${input.tracks.length} track(s) as they record`)
  return true
}

async function tick(current: LiveSession): Promise<void> {
  if (current.busy || current.stopped) return
  current.busy = true
  try {
    for (const track of current.tracks) {
      if (current.stopped) break
      // Looped so a backlog is worked off rather than one window per tick.
      while (!current.stopped && (await advance(current, track, false))) {
        /* keep going while there is enough audio */
      }
    }
  } finally {
    current.busy = false
  }
}

/**
 * Finishes the outstanding audio and keeps the words for the job that follows.
 *
 * Called once the writers are closed, so the files are complete and the last
 * partial window can be taken in full.
 */
export async function finishLiveTranscription(recordingId: string): Promise<void> {
  const current = session
  if (!current || current.recordingId !== recordingId) return
  session = null

  if (current.timer) clearInterval(current.timer)
  // Let a window already in the engine finish rather than cutting it off.
  while (current.busy) await new Promise((resolve) => setTimeout(resolve, 200))

  for (const track of current.tracks) {
    while (await advance(current, track, true)) {
      /* drain the tail */
    }
  }

  const byKind = new Map<TrackKind, LiveResult>()
  for (const track of current.tracks) {
    if (track.words.length > 0) {
      byKind.set(track.kind, { words: track.words, processedMs: track.consumedMs })
    }
  }
  if (byKind.size > 0) finished.set(recordingId, byKind)

  await rm(current.dir, { recursive: true, force: true }).catch(() => undefined)
  const summary = [...byKind]
    .map(([kind, result]) => `${kind}=${result.words.length} words`)
    .join(' ')
  console.log(`[live] finished: ${summary || 'nothing transcribed'}`)
}

/** Abandons the session for a cancelled recording. */
export async function discardLiveTranscription(recordingId: string): Promise<void> {
  const current = session
  if (!current || current.recordingId !== recordingId) return
  session = null
  current.stopped = true
  if (current.timer) clearInterval(current.timer)
  finished.delete(recordingId)
  await rm(current.dir, { recursive: true, force: true }).catch(() => undefined)
}

/**
 * Hands over the live words for a track, when they cover enough of it.
 *
 * Coverage is checked because a session can fall behind or lose a window to a
 * failure, and part of a transcript presented as the whole of one is worse than
 * waiting for a full pass. Taken rather than read: they are good once, and a
 * re-transcribe has to go through the engine again.
 */
export function takeLiveWords(
  recordingId: string,
  kind: TrackKind,
  trackDurationMs: number
): TranscriptWord[] | null {
  const byKind = finished.get(recordingId)
  const result = byKind?.get(kind)
  if (!byKind || !result || result.words.length === 0) return null

  // Measured against audio processed, not against the last word: silence at the
  // end of a recording is normal and says nothing about how much was covered.
  if (trackDurationMs > 0 && result.processedMs < trackDurationMs * 0.9) {
    console.log(
      `[live] ${kind} processed only ${Math.round((result.processedMs / trackDurationMs) * 100)}% of the track; using a full pass instead`
    )
    return null
  }

  byKind.delete(kind)
  if (byKind.size === 0) finished.delete(recordingId)
  return result.words
}

/** Whether a finished recording already has a transcript waiting to be used. */
export function hasLiveWords(recordingId: string): boolean {
  return (finished.get(recordingId)?.size ?? 0) > 0
}

/** Removes live results for recordings that were never transcribed. */
export function forgetLiveWords(recordingId: string): void {
  finished.delete(recordingId)
}
