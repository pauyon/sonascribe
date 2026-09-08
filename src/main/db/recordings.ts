import { randomUUID } from 'node:crypto'
import type { CreateRecordingInput, Cut, Recording } from '@shared/types'
import { getDb } from './index'

/**
 * Repository for the `recordings` table — the only table this app's own code
 * writes to. (Older tables from before the rewrite to a single-track,
 * no-transcription recorder — `tracks`, `speakers`, `utterances`, `words`,
 * `voice_profiles`, `chunk_embeddings`, `screenshots` — are left in the
 * schema untouched rather than dropped: nothing here references them, and an
 * existing recording's `source_path` already points at a playable file
 * without needing any of them.)
 */

interface RecordingRow {
  id: string
  title: string
  created_at: number
  duration_ms: number | null
  source: string
  source_path: string | null
  status: string
  error: string | null
  cuts: string | null
}

function parseCuts(json: string | null): Cut[] {
  if (!json) return []
  try {
    const parsed: unknown = JSON.parse(json)
    return Array.isArray(parsed) ? (parsed as Cut[]) : []
  } catch {
    return []
  }
}

function toRecording(row: RecordingRow): Recording {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    durationMs: row.duration_ms,
    source: row.source as Recording['source'],
    sourcePath: row.source_path,
    status: row.status as Recording['status'],
    error: row.error,
    cuts: parseCuts(row.cuts)
  }
}

export function listRecordings(): Recording[] {
  const rows = getDb()
    .prepare('SELECT * FROM recordings ORDER BY created_at DESC')
    .all() as unknown as RecordingRow[]
  return rows.map(toRecording)
}

export function getRecording(id: string): Recording | null {
  const row = getDb()
    .prepare('SELECT * FROM recordings WHERE id = ?')
    .get(id) as unknown as RecordingRow | undefined
  return row ? toRecording(row) : null
}

export function createRecording(input: CreateRecordingInput): Recording {
  const recording: Recording = {
    id: randomUUID(),
    title: input.title,
    createdAt: Date.now(),
    durationMs: null,
    source: input.source,
    sourcePath: input.sourcePath ?? null,
    status: 'new',
    error: null,
    cuts: []
  }

  getDb()
    .prepare(
      `INSERT INTO recordings (id, title, created_at, duration_ms, source, source_path, status, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      recording.id,
      recording.title,
      recording.createdAt,
      recording.durationMs,
      recording.source,
      recording.sourcePath,
      recording.status,
      recording.error
    )

  return recording
}

export function renameRecording(id: string, title: string): Recording {
  getDb().prepare('UPDATE recordings SET title = ? WHERE id = ?').run(title, id)
  const updated = getRecording(id)
  if (!updated) throw new Error(`Recording ${id} not found`)
  return updated
}

export function deleteRecording(id: string): void {
  // Media files are cleaned up by the caller, which owns the filesystem side.
  getDb().prepare('DELETE FROM recordings WHERE id = ?').run(id)
}

export function setRecordingSourcePath(id: string, sourcePath: string): void {
  getDb().prepare('UPDATE recordings SET source_path = ? WHERE id = ?').run(sourcePath, id)
}

export function setRecordingDuration(id: string, durationMs: number): void {
  getDb().prepare('UPDATE recordings SET duration_ms = ? WHERE id = ?').run(durationMs, id)
}

export function setRecordingStatus(
  id: string,
  status: Recording['status'],
  error: string | null = null
): void {
  getDb().prepare('UPDATE recordings SET status = ?, error = ? WHERE id = ?').run(status, error, id)
}

/**
 * Clamps every region to the recording's actual length, drops anything left
 * with zero or negative length, sorts by start, and merges overlapping or
 * touching regions into one — so every reader (the renderer's compression
 * math, a future export) can assume a clean, sorted, non-overlapping list
 * without re-validating it themselves.
 */
function normalizeCuts(cuts: Cut[], durationMs: number): Cut[] {
  const clamped = cuts
    .map((cut) => ({
      startMs: Math.max(0, Math.min(cut.startMs, durationMs)),
      endMs: Math.max(0, Math.min(cut.endMs, durationMs))
    }))
    .filter((cut) => cut.endMs > cut.startMs)
    .sort((a, b) => a.startMs - b.startMs)

  const merged: Cut[] = []
  for (const cut of clamped) {
    const last = merged[merged.length - 1]
    if (last && cut.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, cut.endMs)
    } else {
      merged.push({ ...cut })
    }
  }
  return merged
}

/** Replaces a recording's whole cut list — see `normalizeCuts` for what it enforces. */
export function setRecordingCuts(id: string, cuts: Cut[], durationMs: number): Recording {
  const normalized = normalizeCuts(cuts, durationMs)
  getDb()
    .prepare('UPDATE recordings SET cuts = ? WHERE id = ?')
    .run(normalized.length > 0 ? JSON.stringify(normalized) : null, id)
  const updated = getRecording(id)
  if (!updated) throw new Error(`Recording ${id} not found`)
  return updated
}
