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
import { createJobQueue } from './job-queue'

/**
 * Serial job queue for transcription.
 *
 * Jobs run one at a time — the engine already uses every core it is given
 * (Parakeet's own worker pool included), so running two transcriptions at
 * once would make both slower rather than finish the pair any sooner, and it
 * would make progress reporting meaningless. Cancellation is a kill of the
 * child process, which is the reason the ASR engines are sidecars rather
 * than in-process addons.
 *
 * The queue/cancel/progress bookkeeping itself is shared with
 * `speaker-jobs.ts` via `./job-queue` — only the transcription pipeline
 * (below) is specific to this file.
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

function publishRecording(recordingId: string): void {
  const updated = getRecording(recordingId)
  if (updated) emit('recording:updated', updated)
}

const jobQueue = createJobQueue({
  logLabel: '[transcription]',
  onDropped: (recordingId) => {
    setTranscriptStatus(recordingId, 'none')
    publishRecording(recordingId)
  }
})

function progress(recordingId: string, fraction: number | null): void {
  jobQueue.setProgress(recordingId, fraction)
  emit('transcript:progress', { recordingId, fraction })
}

/** True when a transcription for this recording is queued or in flight. */
export function isTranscriptionActive(recordingId: string): boolean {
  return jobQueue.isActive(recordingId)
}

export function getActiveTranscriptionProgress(recordingId: string): number | null | undefined {
  return jobQueue.getProgress(recordingId)
}

/**
 * Every recording currently queued or transcribing, with its latest known
 * progress. The source of truth a freshly (re)mounted page reads from —
 * this lives in the main process, so it survives the renderer navigating
 * away and back, unlike component-local progress state.
 */
export function listActiveTranscriptions(): Array<{ recordingId: string; fraction: number | null }> {
  return jobQueue.listActive()
}

/**
 * Aborts every job in flight, for when the app is going away.
 *
 * The engines are separate processes and nothing kills them implicitly:
 * quit the app mid-transcription and parakeet-cli keeps running with a
 * whole window's audio in memory until the user finds it in Task Manager.
 */
export function cancelAllTranscriptions(): number {
  return jobQueue.cancelAll()
}

export function cancelTranscription(recordingId: string): boolean {
  return jobQueue.cancel(recordingId)
}

/**
 * Queues transcription for a recording using the currently selected engine
 * and model.
 *
 * Throws synchronously for conditions the user can fix immediately — no
 * model chosen, model not downloaded, missing sidecar, already running — so
 * the UI can say so rather than showing a job that fails a moment later.
 * Everything here runs synchronously up to `jobQueue.enqueue`, which is what
 * actually claims the recording: two starts arriving in the same tick — a
 * double click, a click racing a retry — must not both pass the "already
 * running" check and queue the same recording twice, and since nothing here
 * awaits, no other call can interleave before the claim happens.
 */
export function queueTranscription(recordingId: string): void {
  if (jobQueue.isActive(recordingId)) {
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

  jobQueue.enqueue({ recordingId, controller, run })
}
