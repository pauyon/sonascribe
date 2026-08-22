import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { mediaPath } from '../paths'
import { getDb } from './index'

/**
 * Repoints stored media paths at the current media directory.
 *
 * Track and recording rows hold absolute paths. That breaks whenever the
 * user-data directory moves — a product rename, a migrated Windows profile, a
 * restored backup — leaving rows that point at directories which no longer
 * exist. The audio is still there under the new root, so the paths are rewritten
 * rather than the recordings being treated as lost.
 *
 * Only rows whose file is genuinely missing are touched, and only when the
 * matching file can be found under the current root, so this is a no-op in the
 * normal case.
 */
export function repairMediaPaths(): number {
  const db = getDb()
  const root = mediaPath()
  let repaired = 0

  /**
   * Media lives at <mediaRoot>/<recordingId>/<file>, so the last two segments
   * of a stale path are enough to relocate it.
   */
  const relocate = (stored: string | null): string | null => {
    if (!stored || existsSync(stored)) return null
    const candidate = join(root, basename(dirname(stored)), basename(stored))
    return candidate !== stored && existsSync(candidate) ? candidate : null
  }

  const tracks = db.prepare('SELECT id, wav_path FROM tracks').all() as unknown as Array<{
    id: string
    wav_path: string
  }>
  const updateTrack = db.prepare('UPDATE tracks SET wav_path = ? WHERE id = ?')
  for (const track of tracks) {
    const fixed = relocate(track.wav_path)
    if (fixed) {
      updateTrack.run(fixed, track.id)
      repaired++
    }
  }

  const recordings = db
    .prepare('SELECT id, source_path FROM recordings WHERE source_path IS NOT NULL')
    .all() as unknown as Array<{ id: string; source_path: string }>
  const updateRecording = db.prepare('UPDATE recordings SET source_path = ? WHERE id = ?')
  for (const recording of recordings) {
    const fixed = relocate(recording.source_path)
    if (fixed) {
      updateRecording.run(fixed, recording.id)
      repaired++
    }
  }

  if (repaired > 0) console.log(`[repair] repointed ${repaired} media path(s)`)
  return repaired
}

/**
 * Returns recordings stranded mid-pipeline to a state the user can act on.
 *
 * Jobs live in memory and do not survive the process, but the status written to
 * the database does. A recording interrupted while transcribing — the window
 * closed, the machine slept, a crash — comes back claiming to be transcribing
 * forever, showing a progress bar for a job that no longer exists and a Cancel
 * button where the Transcribe button should be. There is nothing left to cancel
 * and no way to start again.
 *
 * 'queued' rather than 'failed': the audio is intact and the work simply has to
 * be redone, which is what queued means. Nothing was wrong with the recording.
 */
export function resetInterruptedJobs(): number {
  const { changes } = getDb()
    .prepare(
      `UPDATE recordings SET status = 'queued', error = NULL
       WHERE status IN ('transcribing', 'diarizing', 'merging')`
    )
    .run()

  const count = Number(changes)
  if (count > 0) {
    console.log(`[db] reset ${count} recording(s) interrupted mid-transcription`)
  }
  return count
}
