import type { ActiveJob, JobProgress, JobStage } from '@shared/types'
import { getRecording } from '../db/recordings'
import { listTracks, setRecordingStatus } from '../db/tracks'
import { saveMergedTranscript } from '../db/transcript'
import { ensureSpeaker } from '../db/speakers'
import { runAutoEnrollment } from './profiles'
import { reindexRecording } from './search'
import {
  getDiarizationEnabled,
  getLanguage,
  getMicSoloSpeaker,
  getSelectedModelId,
  getSpeakerCount,
  getSpeakerSplitting
} from '../db/settings'
import { findModel } from '@shared/models'
import { emit } from '../ipc/events'
import { resolveModelPath } from './models'
import { TranscriptionError, engineSidecar } from './transcription'
import { DiarizationError, SPLITTING_PRESETS } from './diarize'
import { absorbTinySpeakers, minSpeakerSpeechFor } from './merge'
import { hasBundledModel, hasSidecar } from './sidecars'
import { runTranscriptionPipeline } from './transcription-pipeline'

/**
 * Serial job queue for the transcription pipeline.
 *
 * Jobs run one at a time. whisper.cpp already uses every core it is given, so
 * running two transcriptions at once makes both slower and finishes the pair no
 * sooner — and it would make progress reporting meaningless. Cancellation is a
 * kill of the child process, which is the main reason the ML engines are
 * sidecars rather than in-process addons.
 */

interface QueuedJob {
  recordingId: string
  controller: AbortController
  run: () => Promise<void>
}

const queue: QueuedJob[] = []
const controllers = new Map<string, AbortController>()

/**
 * Latest progress per in-flight recording.
 *
 * Progress is pushed to the renderer as it happens, but an event is only seen by
 * whoever is listening at that moment. A screen that opens midway through a job
 * — or reopens after the user navigated away — has missed every event so far and
 * would otherwise show an empty bar and a clock starting from zero for a job
 * twenty minutes old. Keeping the current value here makes it answerable.
 */
const activeJobs = new Map<string, ActiveJob>()

let running = false


export class JobError extends Error {}

function publishRecording(recordingId: string): void {
  const updated = getRecording(recordingId)
  if (updated) emit('recording:updated', updated)
}

function progress(recordingId: string, stage: JobStage, fraction: number | null): void {
  const payload: JobProgress = { recordingId, stage, fraction }
  const existing = activeJobs.get(recordingId)
  activeJobs.set(recordingId, {
    recordingId,
    startedAt: existing?.startedAt ?? Date.now(),
    progress: payload
  })
  emit('job:progress', payload)
}

/** True when a job for this recording is queued or in flight. */
export function isJobActive(recordingId: string): boolean {
  return controllers.has(recordingId)
}

export function listActiveJobs(): ActiveJob[] {
  return [...controllers.keys()].map(
    (recordingId) =>
      activeJobs.get(recordingId) ?? { recordingId, startedAt: Date.now(), progress: null }
  )
}


/**
 * Aborts every job in flight, for when the app is going away.
 *
 * The sidecars are separate processes and nothing kills them implicitly: quit
 * the app mid-transcription and parakeet-cli keeps running with the whole
 * window's audio in memory — 10 GB with no window left to show for it, until the
 * user finds it in Task Manager.
 *
 * Keys are snapshotted first because cancelJob mutates the map it iterates.
 */
export function cancelAllJobs(): number {
  const ids = [...controllers.keys()]
  for (const id of ids) cancelJob(id)
  if (ids.length > 0) console.log(`[jobs] cancelled ${ids.length} job(s) on shutdown`)
  return ids.length
}

export function cancelJob(recordingId: string): boolean {
  const controller = controllers.get(recordingId)
  if (!controller) return false
  controller.abort()

  // If it has not started yet, drop it from the queue so it never runs.
  const index = queue.findIndex((j) => j.recordingId === recordingId)
  if (index !== -1) {
    queue.splice(index, 1)
    controllers.delete(recordingId)
    activeJobs.delete(recordingId)
    setRecordingStatus(recordingId, 'queued')
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
        console.error(`[jobs] ${job.recordingId} failed:`, err)
      } finally {
        controllers.delete(job.recordingId)
        activeJobs.delete(job.recordingId)
      }
    }
  } finally {
    running = false
  }
}

/**
 * Queues transcription for a recording.
 *
 * Throws synchronously for conditions the user can fix immediately — no model
 * chosen, model not downloaded, nothing to transcribe — so the UI can say so
 * rather than showing a job that fails a moment later.
 */
export async function queueTranscription(recordingId: string): Promise<void> {
  if (controllers.has(recordingId)) {
    throw new JobError('This recording is already being transcribed')
  }

  // The recording is claimed here, synchronously, rather than after the checks
  // below. Those checks await, and the guard above used to sit on the far side
  // of that await: two starts arriving within the same tick — a double click, a
  // click racing a retry — both passed it and both queued. The recording was
  // then transcribed twice end to end, at twice the memory and twice the wait,
  // and because `controllers` is keyed by recording the second registration
  // simply overwrote the first, so nothing downstream could see it had happened.
  const controller = new AbortController()
  controllers.set(recordingId, controller)

  try {
    await prepareAndQueue(recordingId, controller)
  } catch (err) {
    // A start that never became a job must release its claim, or the recording
    // can never be transcribed again without a restart.
    controllers.delete(recordingId)
    activeJobs.delete(recordingId)
    throw err
  }
}

async function prepareAndQueue(
  recordingId: string,
  controller: AbortController
): Promise<void> {
  const recording = getRecording(recordingId)
  if (!recording) throw new JobError('Recording not found')

  const tracks = listTracks(recordingId)
  if (tracks.length === 0) {
    throw new JobError('This recording has no audio to transcribe')
  }

  const modelId = getSelectedModelId()
  if (!modelId) throw new JobError('No transcription model selected')

  const spec = findModel(modelId)
  if (!spec) throw new JobError(`Unknown model: ${modelId}`)

  const modelPath = await resolveModelPath(modelId)
  if (!modelPath) {
    throw new JobError(`${spec.label} is not downloaded yet`)
  }

  // Each engine has its own helper binary; say which one is missing rather than
  // letting the spawn fail deep inside the job.
  const sidecar = engineSidecar(spec.engine)
  if (!hasSidecar(sidecar)) {
    throw new JobError(`The ${sidecar} helper is missing. Run "npm run sidecars".`)
  }

  const language = getLanguage()

  // Diarization is skipped rather than failed when the helper or its models are
  // absent: a transcript without speaker labels is still worth having.
  const diarizationEnabled =
    getDiarizationEnabled() &&
    hasSidecar('sherpa-onnx-offline-speaker-diarization') &&
    hasBundledModel('segmentation.onnx') &&
    hasBundledModel('speaker-embedding.onnx')
  const numSpeakers = getSpeakerCount()
  const splitting = SPLITTING_PRESETS[getSpeakerSplitting()]
  // Only skip diarizing the microphone when the user has said it carries just
  // their own voice. Several people around one mic is at least as common.
  const micIsSolo = getMicSoloSpeaker()

  // Stamped now rather than at the first progress event, so the elapsed time a
  // screen shows counts from when the user pressed the button.
  activeJobs.set(recordingId, { recordingId, startedAt: Date.now(), progress: null })

  setRecordingStatus(recordingId, 'queued')
  publishRecording(recordingId)

  queue.push({
    recordingId,
    controller,
    run: async () => {
      if (controller.signal.aborted) return

      setRecordingStatus(recordingId, 'transcribing')
      publishRecording(recordingId)
      progress(recordingId, 'transcribing', 0)

      try {
        // How long the recording actually is, which decides how suspicious the
        // absorption pass below should be of a speaker who barely says anything.
        const longestTrackMs = Math.max(0, ...tracks.map((t) => t.durationMs ?? 0))

        const {
          utterances: merged,
          resolvedLanguage,
          failedTracks,
          matchedProfiles,
          forcedCount
        } = await runTranscriptionPipeline({
          recordingId,
          tracks,
          engine: spec.engine,
          modelPath,
          language,
          diarizationEnabled,
          micIsSolo,
          numSpeakers,
          splitting,
          signal: controller.signal,
          setStage: (stage) => {
            setRecordingStatus(recordingId, stage)
            publishRecording(recordingId)
          },
          progress: (stage, fraction) => progress(recordingId, stage, fraction)
        })
        if (controller.signal.aborted) return

        // Only when nothing anywhere produced speech is this a real failure —
        // and what to say about it depends on whether the audio was silent.
        if (merged.length === 0) {
          throw new JobError(
            failedTracks.length > 0
              ? 'This recording has audio in it, but transcription returned nothing. That usually means the engine ran out of memory. Try a shorter section, or a smaller model from the Models page.'
              : 'No speech was found in this recording. Check that the right input device was selected and that the audio is not silent.'
          )
        }

        // Half a conversation with no explanation is worse than a slow one.
        if (failedTracks.length > 0) {
          console.warn(
            `[jobs] transcript is incomplete: no text from ${failedTracks.join(' and ')} despite audible signal`
          )
        }

        setRecordingStatus(recordingId, 'merging')
        publishRecording(recordingId)
        progress(recordingId, 'merging', null)

        // Both tracks start at t=0, so ordering by start time interleaves the
        // local and remote halves of the conversation correctly.
        merged.sort((a, b) => a.startMs - b.startMs)

        // Fold away clusters too small to be a person. Done before speaker rows
        // exist so a cough never gets as far as being called "Speaker 7".
        //
        // Skipped when a count was honoured: the user asserted the headcount and
        // the clusterer was capped by it, so a thin cluster is one of the speakers
        // they told us about, not an artefact to tidy away.
        const cleaned =
          forcedCount == null
            ? absorbTinySpeakers(merged, minSpeakerSpeechFor(longestTrackMs))
            : merged
        if (cleaned.length !== merged.length) {
          console.log(
            `[jobs] absorbed negligible speakers: ${merged.length} utterances -> ${cleaned.length}`
          )
        }

        // Map cluster indices to speaker rows, creating any that are new. A
        // cluster an anchor claimed is created under that profile's name
        // instead of "Speaker N". Existing rows are reused, so renames (and a
        // profile link from a previous run) survive a re-run.
        const speakerIds = new Map<number, string>()
        for (const utterance of cleaned) {
          if (utterance.speaker == null || speakerIds.has(utterance.speaker)) continue
          speakerIds.set(
            utterance.speaker,
            ensureSpeaker(recordingId, utterance.speaker, matchedProfiles.get(utterance.speaker)).id
          )
        }

        saveMergedTranscript({
          recordingId,
          modelId,
          language: resolvedLanguage,
          utterances: cleaned.map((u) => ({
            startMs: u.startMs,
            endMs: u.endMs,
            text: u.text,
            confidence: u.confidence,
            speakerId: u.speaker == null ? null : (speakerIds.get(u.speaker) ?? null),
            trackId: u.trackId,
            words: u.words.map((w) => ({
              startMs: w.startMs,
              endMs: w.endMs,
              text: w.text
            }))
          }))
        })

        // Background bookkeeping, not part of the transcript itself — a
        // failure here must never turn a finished transcription into a failed
        // job, so it's isolated and only ever logged.
        try {
          await runAutoEnrollment(recordingId)
        } catch (err) {
          console.warn(`[jobs] voice-profile enrollment failed for ${recordingId}:`, err)
        }

        // Same reasoning: a search index that failed to build is not a
        // reason to fail a finished transcription.
        try {
          await reindexRecording(recordingId)
        } catch (err) {
          console.warn(`[jobs] search indexing failed for ${recordingId}:`, err)
        }

        setRecordingStatus(recordingId, 'ready')
        publishRecording(recordingId)
      } catch (err) {
        if (controller.signal.aborted) {
          // A cancelled job returns to 'queued' so it can simply be retried.
          setRecordingStatus(recordingId, 'queued')
          publishRecording(recordingId)
          return
        }

        // Both sidecar errors carry the tail of the child's stderr, which is
        // where the actual cause is; the message alone is just an exit code.
        const message =
          err instanceof TranscriptionError || err instanceof DiarizationError
            ? `${err.message}\n${err.stderrTail}`
            : err instanceof Error
              ? err.message
              : String(err)

        setRecordingStatus(recordingId, 'failed', message)
        publishRecording(recordingId)
        throw err
      }
    }
  })

  void drain()
}
