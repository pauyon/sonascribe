import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { getRecording, setSpeakerStatus } from '../db/recordings'
import { getAllWords, saveSpeakerMergedTranscript } from '../db/transcript'
import { ensureSpeaker } from '../db/speakers'
import { resampleForAsr } from './ffmpeg'
import { diarize, minDurationOnFor, SPLITTING_PRESETS, DiarizationError } from './diarize'
import { absorbTinySpeakers, mergeWordsWithSpeakers, minSpeakerSpeechFor } from './merge'
import { hasBundledModel, hasSidecar } from './sidecars'
import { triggerReindex } from './search'
import { emit } from '../ipc/events'
import { createJobQueue } from './job-queue'

/**
 * Serial job queue for speaker detection — deliberately its own module
 * rather than a second "kind" on `services/jobs.ts`'s queue. Diarization is
 * a distinct pipeline (its own binary, its own progress/error shape, and it
 * runs against an *existing* transcript rather than producing one), and this
 * codebase already prefers a purpose-built module per pipeline
 * (`whisper.ts`/`parakeet.ts` are separate runners, not one generic engine)
 * over a shared abstraction two call shapes barely fit. The queue/cancel/
 * progress bookkeeping itself has no pipeline-specific meaning though, so
 * that part is shared with `jobs.ts` via `./job-queue`.
 */

export class SpeakerJobError extends Error {}

function publishRecording(recordingId: string): void {
  const updated = getRecording(recordingId)
  if (updated) emit('recording:updated', updated)
}

const jobQueue = createJobQueue({
  logLabel: '[speakers]',
  onDropped: (recordingId) => {
    setSpeakerStatus(recordingId, 'none')
    publishRecording(recordingId)
  }
})

function progress(recordingId: string, fraction: number | null): void {
  jobQueue.setProgress(recordingId, fraction)
  emit('speaker:progress', { recordingId, fraction })
}

export function isSpeakerDetectionActive(recordingId: string): boolean {
  return jobQueue.isActive(recordingId)
}

export function listActiveSpeakerDetections(): Array<{ recordingId: string; fraction: number | null }> {
  return jobQueue.listActive()
}

export function cancelAllSpeakerDetections(): number {
  return jobQueue.cancelAll()
}

export function cancelSpeakerDetection(recordingId: string): boolean {
  return jobQueue.cancel(recordingId)
}

/**
 * Queues speaker detection for a recording — only meaningful once it has a
 * transcript. Reuses whichever `speakers` rows detection last created for
 * this recording (matched by cluster index — see `db/speakers.ts::
 * ensureSpeaker`), so a rename/recolor survives a re-run as long as the
 * diarizer keeps assigning the same clusters, which it does for the same
 * audio and settings.
 */
export function queueSpeakerDetection(recordingId: string): void {
  if (jobQueue.isActive(recordingId)) {
    throw new SpeakerJobError('Speaker detection is already running for this recording')
  }

  const recording = getRecording(recordingId)
  if (!recording) throw new SpeakerJobError('Recording not found')
  if (!recording.sourcePath) throw new SpeakerJobError('This recording has no audio yet')
  if (recording.transcriptStatus !== 'ready') {
    throw new SpeakerJobError('Transcribe this recording before detecting speakers')
  }

  if (!hasSidecar('sherpa-onnx-offline-speaker-diarization')) {
    throw new SpeakerJobError('The speaker-detection helper is missing. Run "npm run sidecars".')
  }
  if (!hasBundledModel('segmentation.onnx') || !hasBundledModel('speaker-embedding.onnx')) {
    throw new SpeakerJobError('The speaker-detection models are missing. Run "npm run sidecars".')
  }

  const sourcePath = recording.sourcePath
  const durationMs = recording.durationMs ?? undefined

  const controller = new AbortController()
  setSpeakerStatus(recordingId, 'queued')
  publishRecording(recordingId)

  const run = async (): Promise<void> => {
    if (controller.signal.aborted) return

    setSpeakerStatus(recordingId, 'detecting')
    publishRecording(recordingId)
    progress(recordingId, null)

    const diarizeTempPath = join(tmpdir(), `sonascribe-diarize-${randomUUID()}.wav`)

    try {
      const words = getAllWords(recordingId)
      if (words.length === 0) {
        throw new SpeakerJobError('There is no transcript to detect speakers in')
      }

      await resampleForAsr(sourcePath, diarizeTempPath, controller.signal)
      if (controller.signal.aborted) return

      const preset = SPLITTING_PRESETS.balanced
      const segments = await diarize({
        wavPath: diarizeTempPath,
        durationMs,
        threshold: preset.threshold,
        minDurationOn: minDurationOnFor(preset.minDurationOn, durationMs),
        onProgress: (fraction) => progress(recordingId, fraction),
        signal: controller.signal
      })
      if (controller.signal.aborted) return

      let merged = mergeWordsWithSpeakers(words, segments)
      merged = absorbTinySpeakers(merged, minSpeakerSpeechFor(durationMs))

      const speakerIdByCluster = new Map<number, string>()
      for (const u of merged) {
        if (u.speaker == null || speakerIdByCluster.has(u.speaker)) continue
        speakerIdByCluster.set(u.speaker, ensureSpeaker(recordingId, u.speaker).id)
      }

      saveSpeakerMergedTranscript(recordingId, merged, speakerIdByCluster)
      triggerReindex(recordingId)
      setSpeakerStatus(recordingId, 'ready')
      publishRecording(recordingId)
    } catch (err) {
      if (controller.signal.aborted) {
        setSpeakerStatus(recordingId, 'none')
        publishRecording(recordingId)
        return
      }

      const message =
        err instanceof DiarizationError
          ? `${err.message}\n${err.stderrTail}`
          : err instanceof Error
            ? err.message
            : String(err)

      setSpeakerStatus(recordingId, 'failed', message)
      publishRecording(recordingId)
    } finally {
      await rm(diarizeTempPath, { force: true }).catch(() => undefined)
    }
  }

  jobQueue.enqueue({ recordingId, controller, run })
}
