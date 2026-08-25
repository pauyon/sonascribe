import { join } from 'node:path'
import type { Screenshot } from '@shared/types'
import { getDb } from './index'
import { recordingMediaPath } from '../paths'

/** Screenshot rows — one per image, tied to a recording and an elapsed time. */

interface ScreenshotRow {
  id: string
  recording_id: string
  timestamp_ms: number
  display_label: string
  file_name: string
  created_at: number
}

function toScreenshot(row: ScreenshotRow): Screenshot {
  return {
    id: row.id,
    recordingId: row.recording_id,
    timestampMs: row.timestamp_ms,
    displayLabel: row.display_label
  }
}

export function insertScreenshot(input: {
  id: string
  recordingId: string
  timestampMs: number
  displayLabel: string
  fileName: string
}): Screenshot {
  getDb()
    .prepare(
      `INSERT INTO screenshots (id, recording_id, timestamp_ms, display_label, file_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(input.id, input.recordingId, input.timestampMs, input.displayLabel, input.fileName, Date.now())

  return {
    id: input.id,
    recordingId: input.recordingId,
    timestampMs: input.timestampMs,
    displayLabel: input.displayLabel
  }
}

export function listScreenshots(recordingId: string): Screenshot[] {
  const rows = getDb()
    .prepare('SELECT * FROM screenshots WHERE recording_id = ? ORDER BY timestamp_ms')
    .all(recordingId) as unknown as ScreenshotRow[]
  return rows.map(toScreenshot)
}

/** Looks up a single screenshot's absolute file path. Used by the media protocol handler. */
export function getScreenshotPath(id: string): string | null {
  const row = getDb()
    .prepare('SELECT recording_id, file_name FROM screenshots WHERE id = ?')
    .get(id) as { recording_id: string; file_name: string } | undefined
  if (!row) return null
  return join(recordingMediaPath(row.recording_id), row.file_name)
}

/** Deletes the row and returns its file's absolute path, so the caller can remove it too. */
export function deleteScreenshot(id: string): string | null {
  const path = getScreenshotPath(id)
  if (path == null) return null
  getDb().prepare('DELETE FROM screenshots WHERE id = ?').run(id)
  return path
}
