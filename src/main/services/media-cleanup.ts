import { rm } from 'node:fs/promises'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { getDb } from '../db'
import { mediaPath, recordingMediaPath } from '../paths'

/**
 * Keeps the media directory in step with the database.
 *
 * Audio lives on disk and is only referenced by row, so deleting a recording
 * without deleting its directory leaks it permanently — invisibly, and at a few
 * hundred megabytes per hour of capture.
 */

/**
 * Removes a recording's audio. Safe to call for a recording that has none.
 *
 * Retried briefly because a sidecar cancelled a moment earlier may still hold
 * the file open, and Windows refuses to delete an open file rather than
 * deferring it the way Unix does. A few hundred milliseconds is enough for a
 * killed process to release its handles.
 *
 * Giving up is not fatal: sweepOrphanedMedia removes directories with no
 * surviving recording at the next start, so the space is reclaimed either way.
 */
export async function deleteRecordingMedia(recordingId: string): Promise<void> {
  const dir = recordingMediaPath(recordingId)

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true })
      return
    } catch (err) {
      if (attempt === 3) {
        console.warn(`[media] could not remove ${recordingId} yet; leaving it for the sweep:`, err)
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
}

/**
 * Removes media directories with no surviving recording.
 *
 * Covers anything stranded by an earlier version, a crash between the row
 * delete and the file delete, or a database restored from an older backup.
 */
export async function sweepOrphanedMedia(): Promise<number> {
  const root = mediaPath()

  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return 0
  }

  const live = new Set(
    (getDb().prepare('SELECT id FROM recordings').all() as unknown as Array<{ id: string }>).map(
      (r) => r.id
    )
  )

  let removed = 0
  for (const entry of entries) {
    if (live.has(entry)) continue
    try {
      await rm(join(root, entry), { recursive: true, force: true })
      removed++
    } catch (err) {
      console.error(`[media] could not remove orphan ${entry}:`, err)
    }
  }

  if (removed > 0) console.log(`[media] removed ${removed} orphaned media director(ies)`)
  return removed
}
