import { randomUUID } from 'node:crypto'
import type {
  CreateRecordingInput,
  Recording,
  RecordingSummary,
  Screenshot,
  Speaker,
  Track,
  TranscriptBundle,
  TranscriptWordSpan,
  Utterance
} from '@shared/types'
import { getDb } from './index'

/**
 * Repository for recordings and their transcript rows.
 *
 * All SQL in the app lives in the db/ directory. Callers deal in domain types
 * from @shared/types; the snake_case-to-camelCase mapping stays here.
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
  model_id: string | null
  language: string | null
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
    modelId: row.model_id,
    language: row.language
  }
}

/**
 * Recordings for the library, each with the opening of its transcript.
 *
 * Built in SQL rather than by loading every transcript and discarding most of
 * it: a two-hour recording is thousands of utterance rows and the card shows a
 * few hundred characters. The limit applies before the concatenation, so the
 * cost does not grow with the length of the recording.
 */
export function listRecordings(): RecordingSummary[] {
  const rows = getDb()
    .prepare(
      `SELECT r.*,
              (SELECT group_concat(text, ' ')
                 FROM (SELECT text FROM utterances
                        WHERE recording_id = r.id
                        ORDER BY start_ms
                        LIMIT 6)) AS preview
         FROM recordings r
        ORDER BY r.created_at DESC`
    )
    .all() as unknown as Array<RecordingRow & { preview: string | null }>

  return rows.map((row) => ({
    ...toRecording(row),
    preview: row.preview ? row.preview.slice(0, 400) : null
  }))
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
    modelId: null,
    language: null
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
  // Child rows go via ON DELETE CASCADE; media files are cleaned up by the
  // caller, which owns the filesystem side.
  getDb().prepare('DELETE FROM recordings WHERE id = ?').run(id)
}

export function getTranscriptBundle(id: string): TranscriptBundle | null {
  const recording = getRecording(id)
  if (!recording) return null

  const db = getDb()

  const trackRows = db
    .prepare('SELECT * FROM tracks WHERE recording_id = ?')
    .all(id) as unknown as Array<{
    id: string
    recording_id: string
    kind: string
    wav_path: string
    duration_ms: number | null
  }>

  const speakerRows = db
    .prepare('SELECT * FROM speakers WHERE recording_id = ? ORDER BY cluster_id')
    .all(id) as unknown as Array<{
    id: string
    recording_id: string
    cluster_id: number
    display_name: string
    color: string
  }>

  const screenshotRows = db
    .prepare('SELECT * FROM screenshots WHERE recording_id = ? ORDER BY timestamp_ms')
    .all(id) as unknown as Array<{
    id: string
    recording_id: string
    timestamp_ms: number
    display_label: string
  }>

  const utteranceRows = db
    .prepare('SELECT * FROM utterances WHERE recording_id = ? ORDER BY start_ms')
    .all(id) as unknown as Array<{
    id: string
    recording_id: string
    speaker_id: string | null
    start_ms: number
    end_ms: number
    text: string
    edited: number
    confidence: number | null
  }>

  const tracks: Track[] = trackRows.map((r) => ({
    id: r.id,
    recordingId: r.recording_id,
    kind: r.kind as Track['kind'],
    wavPath: r.wav_path,
    durationMs: r.duration_ms
  }))

  const speakers: Speaker[] = speakerRows.map((r) => ({
    id: r.id,
    recordingId: r.recording_id,
    clusterId: r.cluster_id,
    displayName: r.display_name,
    color: r.color
  }))

  const screenshots: Screenshot[] = screenshotRows.map((r) => ({
    id: r.id,
    recordingId: r.recording_id,
    timestampMs: r.timestamp_ms,
    displayLabel: r.display_label
  }))

  /*
   * Word timings, fetched in one query and grouped in memory.
   *
   * They were written at transcription time and then never read: the editor
   * could only follow along a line at a time, because a line was all it had.
   * One query for the whole recording rather than one per utterance — a long
   * transcript is thousands of rows either way, and thousands of statements is
   * the slow way to fetch them.
   */
  const wordRows = db
    .prepare(
      `SELECT w.utterance_id, w.start_ms, w.end_ms, w.text
         FROM words w
         JOIN utterances u ON u.id = w.utterance_id
        WHERE u.recording_id = ?
        ORDER BY w.start_ms`
    )
    .all(id) as unknown as Array<{
    utterance_id: string
    start_ms: number
    end_ms: number
    text: string
  }>

  const wordsByUtterance = new Map<string, TranscriptWordSpan[]>()
  for (const row of wordRows) {
    const list = wordsByUtterance.get(row.utterance_id)
    const word = { startMs: row.start_ms, endMs: row.end_ms, text: row.text }
    if (list) list.push(word)
    else wordsByUtterance.set(row.utterance_id, [word])
  }

  const utterances: Utterance[] = utteranceRows.map((r) => ({
    id: r.id,
    recordingId: r.recording_id,
    speakerId: r.speaker_id,
    startMs: r.start_ms,
    endMs: r.end_ms,
    text: r.text,
    edited: r.edited === 1,
    confidence: r.confidence,
    // Absent for a line a human has retyped: the words it was built from no
    // longer describe the text on screen.
    words: r.edited === 1 ? [] : (wordsByUtterance.get(r.id) ?? [])
  }))


  return { recording, tracks, speakers, utterances, screenshots }
}
