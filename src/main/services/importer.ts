import { copyFile, rm } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import type { ImportProgress, Recording } from '@shared/types'
import { createRecording, getRecording } from '../db/recordings'
import {
  createTrack,
  setRecordingDuration,
  setRecordingSourcePath,
  setRecordingStatus
} from '../db/tracks'
import { recordingMediaPath } from '../paths'
import { emit } from '../ipc/events'
import { normalizeToWav } from './ffmpeg'
import { readWavInfo } from './wav'

/**
 * Ingest: turn a user-supplied media file into a recording with a normalized
 * 16 kHz mono track ready for the ML sidecars.
 *
 * Jobs run one at a time. ffmpeg already saturates the available cores on a
 * single transcode, so running several concurrently makes every one of them
 * slower without finishing the batch any sooner — and it would make progress
 * reporting much harder to read.
 */

let queue: Promise<void> = Promise.resolve()

function publish(recordingId: string): void {
  const updated = getRecording(recordingId)
  if (updated) emit('recording:updated', updated)
}

function progress(payload: ImportProgress): void {
  emit('import:progress', payload)
}

/** Strips the extension so "Team sync.mp4" becomes the title "Team sync". */
function titleFromPath(path: string): string {
  const base = basename(path)
  const ext = extname(base)
  return (ext ? base.slice(0, -ext.length) : base) || base
}

/**
 * Registers a file and queues its normalization.
 *
 * Returns as soon as the row exists so the UI can render it immediately; the
 * heavy work continues in the background and reports via events.
 */
export function queueImport(sourcePath: string): Recording {
  const recording = createRecording({
    title: titleFromPath(sourcePath),
    source: 'imported',
    sourcePath
  })
  setRecordingStatus(recording.id, 'normalizing')

  // Chain onto the queue, absorbing failures so one bad file cannot stall the
  // rest of the batch.
  queue = queue.then(() => runIngest(recording.id, sourcePath).catch(() => undefined))

  return { ...recording, status: 'normalizing' }
}

async function runIngest(recordingId: string, sourcePath: string): Promise<void> {
  const dir = recordingMediaPath(recordingId)
  const originalPath = join(dir, `original${extname(sourcePath)}`)
  const wavPath = join(dir, 'audio.wav')

  try {
    // Copy the original in: the user may move or delete the file they picked,
    // and the editor plays the original rather than the downsampled WAV.
    progress({ recordingId, stage: 'copying', fraction: null })
    await copyFile(sourcePath, originalPath)
    setRecordingSourcePath(recordingId, originalPath)

    progress({ recordingId, stage: 'normalizing', fraction: 0 })
    await normalizeToWav({
      inputPath: originalPath,
      outputPath: wavPath,
      normalizeLoudness: true,
      onProgress: (fraction) => progress({ recordingId, stage: 'normalizing', fraction })
    })

    const info = await readWavInfo(wavPath)

    // 'mixed' because an imported file has the speakers already combined — there
    // is no separate mic track to attribute to the local user.
    createTrack({ recordingId, kind: 'mixed', wavPath, durationMs: info.durationMs })
    setRecordingDuration(recordingId, info.durationMs)

    // Transcription lands in Phase 3; until then a normalized file is as far as
    // the pipeline goes, so it parks in 'queued'.
    setRecordingStatus(recordingId, 'queued')
    publish(recordingId)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[import] ${recordingId} failed:`, err)
    setRecordingStatus(recordingId, 'failed', message)
    publish(recordingId)
    // Leave no half-written WAV behind to be mistaken for a valid track.
    await rm(wavPath, { force: true })
    throw err
  }
}
