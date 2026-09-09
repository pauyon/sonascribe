import { rm } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import type { Recording } from '@shared/types'
import {
  createRecording,
  getRecording,
  setRecordingDuration,
  setRecordingSourcePath,
  setRecordingStatus
} from '../db/recordings'
import { recordingMediaDir } from './storage'
import { emit } from '../ipc/events'
import { normalizeToWav } from './ffmpeg'
import { readWavInfo } from './wav'

/**
 * Ingest: turn a user-supplied media file into a recording with a clean WAV
 * ready to play — the same normalize-to-WAV step a live recording skips
 * entirely (mic+system are already mixed PCM by the time they reach disk),
 * needed here because an import can be any container ffmpeg can decode.
 *
 * Jobs run one at a time. ffmpeg already saturates the available cores on a
 * single transcode, so running several concurrently makes every one of them
 * slower without finishing the batch any sooner.
 */

let queue: Promise<void> = Promise.resolve()

function publish(recordingId: string): void {
  const updated = getRecording(recordingId)
  if (updated) emit('recording:updated', updated)
}

function progress(recordingId: string, fraction: number | null): void {
  emit('import:progress', { recordingId, fraction })
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
 * work continues in the background and reports via events.
 */
export function queueImport(sourcePath: string): Recording {
  const recording = createRecording({
    title: titleFromPath(sourcePath),
    source: 'imported',
    sourcePath: null
  })
  setRecordingStatus(recording.id, 'normalizing')

  // Chain onto the queue, absorbing failures so one bad file cannot stall the
  // rest of the batch.
  queue = queue.then(() => runIngest(recording.id, sourcePath).catch(() => undefined))

  return { ...recording, status: 'normalizing' }
}

async function runIngest(recordingId: string, sourcePath: string): Promise<void> {
  const dir = recordingMediaDir(recordingId)
  const wavPath = join(dir, 'recording.wav')

  try {
    progress(recordingId, 0)
    await normalizeToWav({
      inputPath: sourcePath,
      outputPath: wavPath,
      onProgress: (fraction) => progress(recordingId, fraction)
    })

    const info = await readWavInfo(wavPath)

    setRecordingSourcePath(recordingId, wavPath)
    setRecordingDuration(recordingId, info.durationMs)
    setRecordingStatus(recordingId, 'ready')
    publish(recordingId)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[import] ${recordingId} failed:`, err)
    setRecordingStatus(recordingId, 'failed', message)
    publish(recordingId)
    // Leave no half-written WAV behind to be mistaken for a valid one.
    await rm(wavPath, { force: true })
    throw err
  }
}
