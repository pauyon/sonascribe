import { randomUUID } from 'node:crypto'
import type { CreateRecordingInput, Cut, Marker, Recording } from '@shared/types'
import { getDb } from './index'

/**
 * Repository for the `recordings` table. `db/transcript.ts` owns
 * `utterances`/`words`, `db/speakers.ts` owns `speakers` — both back in use
 * for transcription and speaker detection. `tracks`, `voice_profiles`,
 * `chunk_embeddings`, `screenshots` remain from before this app was
 * stripped to a single-track recorder, still unreferenced by anything in
 * `src/`.
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
  markers: string | null
  transcript_status: string
  transcript_error: string | null
  model_id: string | null
  language: string | null
  transcript_preview: string | null
  speaker_status: string
  speaker_error: string | null
}

function parseJsonArray<T>(json: string | null): T[] {
  if (!json) return []
  try {
    const parsed: unknown = JSON.parse(json)
    return Array.isArray(parsed) ? (parsed as T[]) : []
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
    cuts: parseJsonArray<Cut>(row.cuts),
    markers: parseJsonArray<Marker>(row.markers),
    transcriptStatus: row.transcript_status as Recording['transcriptStatus'],
    transcriptError: row.transcript_error,
    modelId: row.model_id,
    language: row.language,
    transcriptPreview: row.transcript_preview,
    speakerStatus: row.speaker_status as Recording['speakerStatus'],
    speakerError: row.speaker_error
  }
}

export function listRecordings(): Recording[] {
  const rows = getDb()
    .prepare('SELECT * FROM recordings ORDER BY created_at DESC')
    .all() as unknown as RecordingRow[]
  return rows.map(toRecording)
}

/** Every recording id currently in the database — used by media-cleanup's orphan sweep. */
export function listRecordingIds(): string[] {
  const rows = getDb().prepare('SELECT id FROM recordings').all() as unknown as Array<{ id: string }>
  return rows.map((r) => r.id)
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
    cuts: [],
    markers: [],
    transcriptStatus: 'none',
    transcriptError: null,
    modelId: null,
    language: null,
    transcriptPreview: null,
    speakerStatus: 'none',
    speakerError: null
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

export function setTranscriptStatus(
  id: string,
  status: Recording['transcriptStatus'],
  error: string | null = null
): void {
  getDb()
    .prepare('UPDATE recordings SET transcript_status = ?, transcript_error = ? WHERE id = ?')
    .run(status, error, id)
}

/** Marks a transcription complete and records which model/language produced it, plus a short preview snippet for the library card. */
export function setTranscriptComplete(
  id: string,
  modelId: string,
  language: string | null,
  preview: string | null
): void {
  getDb()
    .prepare(
      `UPDATE recordings
       SET transcript_status = 'ready', transcript_error = NULL, model_id = ?, language = ?, transcript_preview = ?
       WHERE id = ?`
    )
    .run(modelId, language, preview, id)
}

export function setSpeakerStatus(id: string, status: Recording['speakerStatus'], error: string | null = null): void {
  getDb()
    .prepare('UPDATE recordings SET speaker_status = ?, speaker_error = ? WHERE id = ?')
    .run(status, error, id)
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

/**
 * Clamps every marker's time to the recording's actual length and sorts by
 * it. Unlike cuts there's nothing to merge — markers are points, not ranges.
 */
function normalizeMarkers(markers: Marker[], durationMs: number): Marker[] {
  return markers
    .map((marker) => ({ ...marker, timeMs: Math.max(0, Math.min(marker.timeMs, durationMs)) }))
    .sort((a, b) => a.timeMs - b.timeMs)
}

/** Replaces a recording's whole marker list — see `normalizeMarkers` for what it enforces. */
export function setRecordingMarkers(id: string, markers: Marker[], durationMs: number): Recording {
  const normalized = normalizeMarkers(markers, durationMs)
  getDb()
    .prepare('UPDATE recordings SET markers = ? WHERE id = ?')
    .run(normalized.length > 0 ? JSON.stringify(normalized) : null, id)
  const updated = getRecording(id)
  if (!updated) throw new Error(`Recording ${id} not found`)
  return updated
}
