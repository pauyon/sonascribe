import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { defaultModelForEngine, DEFAULT_ENGINE, findModel } from '@shared/models'
import { getRecording, setSpeakerStatus, setTranscriptComplete, setTranscriptStatus } from '../db/recordings'
import { saveTranscript } from '../db/transcript'
import {
  getModelIdForEngine,
  getTranscriptionEngine,
  getTranscriptionLanguage
} from '../db/settings'
import { resampleForAsr } from './ffmpeg'
import { resolveModelPath } from './models'
import { engineSidecar, TranscriptionError, type TranscriptSegment } from './transcription'
import { transcribeWithWhisper } from './whisper'
import { transcribeWithParakeet } from './parakeet'
import { hasSidecar } from './sidecars'
import { triggerReindex } from './search'
import { emit } from '../ipc/events'

/**
 * Serial job queue for transcription.
 *
 * Jobs run one at a time — the engine already uses every core it is given
 * (Parakeet's own worker pool included), so running two transcriptions at
 * once would make both slower rather than finish the pair any sooner, and it
 * would make progress reporting meaningless. Cancellation is a kill of the
 * child process, which is the reason the ASR engines are sidecars rather
 * than in-process addons.
 */

export class JobError extends Error {}

/** How much of a transcript's start is worth showing on a library card. */
const PREVIEW_MAX_CHARS = 140

/** Joins the transcript's first stretch of text, truncated at a word boundary rather than mid-word. */
function buildPreview(segments: TranscriptSegment[]): string | null {
  const full = segments
    .map((s) => s.text)
    .join(' ')
    .trim()
  if (!full) return null
  if (full.length <= PREVIEW_MAX_CHARS) return full
  const cut = full.slice(0, PREVIEW_MAX_CHARS)
  const lastSpace = cut.lastIndexOf(' ')
  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trim()}…`
}

interface QueuedJob {
  recordingId: string
  controller: AbortController
  run: () => Promise<void>
}

const queue: QueuedJob[] = []
const controllers = new Map<string, AbortController>()
/** Latest progress per in-flight recording, so a page opened mid-job sees where things stand instead of a blank bar. */
const activeProgress = new Map<string, number | null>()
let running = false

function publishRecording(recordingId: string): void {
  const updated = getRecording(recordingId)
  if (updated) emit('recording:updated', updated)
}

function progress(recordingId: string, fraction: number | null): void {
  activeProgress.set(recordingId, fraction)
  emit('transcript:progress', { recordingId, fraction })
}

/** True when a transcription for this recording is queued or in flight. */
export function isTranscriptionActive(recordingId: string): boolean {
  return controllers.has(recordingId)
}

export function getActiveTranscriptionProgress(recordingId: string): number | null | undefined {
  return activeProgress.get(recordingId)
}

/**
 * Every recording currently queued or transcribing, with its latest known
 * progress. The source of truth a freshly (re)mounted page reads from —
 * this lives in the main process, so it survives the renderer navigating
 * away and back, unlike component-local progress state.
 */
export function listActiveTranscriptions(): Array<{ recordingId: string; fraction: number | null }> {
  return [...activeProgress.entries()].map(([recordingId, fraction]) => ({
    recordingId,
    fraction: fraction ?? null
  }))
}

/**
 * Aborts every job in flight, for when the app is going away.
 *
 * The engines are separate processes and nothing kills them implicitly:
 * quit the app mid-transcription and parakeet-cli keeps running with a
 * whole window's audio in memory until the user finds it in Task Manager.
 */
export function cancelAllTranscriptions(): number {
  const ids = [...controllers.keys()]
  for (const id of ids) cancelTranscription(id)
  if (ids.length > 0) console.log(`[transcription] cancelled ${ids.length} job(s) on shutdown`)
  return ids.length
}

export function cancelTranscription(recordingId: string): boolean {
  const controller = controllers.get(recordingId)
  if (!controller) return false
  controller.abort()

  // If it has not started yet, drop it from the queue so it never runs —
  // the job itself won't get a chance to reset the status otherwise.
  const index = queue.findIndex((j) => j.recordingId === recordingId)
  if (index !== -1) {
    queue.splice(index, 1)
    controllers.delete(recordingId)
    activeProgress.delete(recordingId)
    setTranscriptStatus(recordingId, 'none')
    publishRecording(recordingId)
  }
  return true
}

async function drain(): Promise<void> {
  if (running) return
  running = true
  try {
    while (queue.length > 0) {
      const job = queue.shift()
      if (!job) break
      try {
        await job.run()
      } catch (err) {
        console.error(`[transcription] ${job.recordingId} failed:`, err)
      } finally {
        controllers.delete(job.recordingId)
        activeProgress.delete(job.recordingId)
      }
    }
  } finally {
    running = false
  }
}

/**
 * Queues transcription for a recording using the currently selected engine
 * and model.
 *
 * Throws synchronously for conditions the user can fix immediately — no
 * model chosen, model not downloaded, missing sidecar, already running — so
 * the UI can say so rather than showing a job that fails a moment later. The
 * recording is claimed (`controllers.set`) before anything async runs: two
 * starts arriving in the same tick — a double click, a click racing a retry
 * — must not both pass the "already running" check and queue the same
 * recording twice.
 */
export function queueTranscription(recordingId: string): void {
  if (controllers.has(recordingId)) {
    throw new JobError('This recording is already being transcribed')
  }

  const recording = getRecording(recordingId)
  if (!recording) throw new JobError('Recording not found')
  if (!recording.sourcePath) throw new JobError('This recording has no audio to transcribe yet')

  const engine = getTranscriptionEngine() ?? DEFAULT_ENGINE
  const modelId = getModelIdForEngine(engine) ?? defaultModelForEngine(engine)
  const spec = findModel(modelId)
  if (!spec) throw new JobError('No transcription model selected')

  // Each engine has its own helper binary; say which one is missing rather
  // than letting the spawn fail deep inside the job.
  const sidecar = engineSidecar(engine)
  if (!hasSidecar(sidecar)) {
    throw new JobError(`The ${sidecar} helper is missing. Run "npm run sidecars".`)
  }

  const language = getTranscriptionLanguage()
  const sourcePath = recording.sourcePath

  const controller = new AbortController()
  controllers.set(recordingId, controller)
  activeProgress.set(recordingId, null)
  setTranscriptStatus(recordingId, 'queued')
  publishRecording(recordingId)

  const run = async (): Promise<void> => {
    if (controller.signal.aborted) return

    setTranscriptStatus(recordingId, 'transcribing')
    publishRecording(recordingId)
    progress(recordingId, null)

    const asrTempPath = join(tmpdir(), `sonascribe-asr-${randomUUID()}.wav`)

    try {
      const modelPath = await resolveModelPath(modelId)
      if (!modelPath) throw new JobError(`${spec.label} is not downloaded yet`)
      if (controller.signal.aborted) return

      await resampleForAsr(sourcePath, asrTempPath, controller.signal)
      if (controller.signal.aborted) return

      const runner = engine === 'parakeet' ? transcribeWithParakeet : transcribeWithWhisper
      const result = await runner({
        wavPath: asrTempPath,
        modelPath,
        language,
        onProgress: (fraction) => progress(recordingId, fraction),
        signal: controller.signal
      })
      if (controller.signal.aborted) return

      if (result.segments.length === 0) {
        throw new JobError(
          'No speech was found in this recording. Check that the audio is not silent.'
        )
      }

      saveTranscript(recordingId, result.segments)
      triggerReindex(recordingId)
      // A fresh transcription means entirely new utterance rows — whatever
      // speaker detection previously produced no longer has anything to
      // point at (db/transcript.ts::saveTranscript already dropped the
      // speaker rows themselves).
      setSpeakerStatus(recordingId, 'none')
      setTranscriptComplete(
        recordingId,
        modelId,
        result.language ?? (language === 'auto' ? null : language),
        buildPreview(result.segments)
      )
      publishRecording(recordingId)
    } catch (err) {
      if (controller.signal.aborted) {
        // Cancelled — nothing to show, and the recording can simply be
        // retranscribed from scratch.
        setTranscriptStatus(recordingId, 'none')
        publishRecording(recordingId)
        return
      }

      // TranscriptionError carries the tail of the child's stderr, which is
      // where the actual cause is; the message alone is just an exit code.
      const message =
        err instanceof TranscriptionError
          ? `${err.message}\n${err.stderrTail}`
          : err instanceof Error
            ? err.message
            : String(err)

      setTranscriptStatus(recordingId, 'failed', message)
      publishRecording(recordingId)
    } finally {
      await rm(asrTempPath, { force: true }).catch(() => undefined)
    }
  }

  queue.push({ recordingId, controller, run })
  void drain()
}
