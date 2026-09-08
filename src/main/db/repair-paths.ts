import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { getMediaRoot } from '../services/storage'
import { getDb } from './index'

/**
 * Repoints stored media paths at the current media directory.
 *
 * Recording rows hold absolute paths. That breaks whenever the user-data
 * directory moves — a product rename, a migrated Windows profile, a restored
 * backup — leaving rows that point at directories which no longer exist. The
 * audio is still there under the new root, so the path is rewritten rather
 * than the recording being treated as lost.
 *
 * Only rows whose file is genuinely missing are touched, and only when the
 * matching file can be found under the current root, so this is a no-op in the
 * normal case.
 */
export function repairMediaPaths(): number {
  const db = getDb()
  const root = getMediaRoot()
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
 * Returns recordings stranded mid-finalize to a state the user can act on.
 *
 * A recording interrupted while `normalizing` — the window closed, the
 * machine slept, a crash — comes back claiming to be normalizing forever,
 * with no process left actually finishing that work.
 *
 * 'ready' when the audio file already exists (a crash after the file was
 * written but before the row was updated), 'failed' otherwise — there's
 * nothing left to retry automatically the way a transcription job used to be
 * re-queued.
 */
export function resetInterruptedRecordings(): number {
  const db = getDb()
  const stranded = db
    .prepare(`SELECT id, source_path, duration_ms FROM recordings WHERE status = 'normalizing'`)
    .all() as unknown as Array<{ id: string; source_path: string | null; duration_ms: number | null }>
  if (stranded.length === 0) return 0

  const toReady = db.prepare(`UPDATE recordings SET status = 'ready', error = NULL WHERE id = ?`)
  const toFailed = db.prepare(`UPDATE recordings SET status = 'failed', error = ? WHERE id = ?`)

  for (const { id, source_path: sourcePath } of stranded) {
    if (sourcePath && existsSync(sourcePath)) {
      toReady.run(id)
    } else {
      toFailed.run('Interrupted before any audio was saved', id)
    }
  }

  console.log(`[db] resolved ${stranded.length} recording(s) interrupted mid-finalize`)
  return stranded.length
}
