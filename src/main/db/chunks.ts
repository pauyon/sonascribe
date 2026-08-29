import { randomUUID } from 'node:crypto'
import { getDb } from './index'

/**
 * Chunk embedding rows, for offline semantic search over transcripts.
 *
 * Replaced wholesale per recording (see `replaceChunksForRecording`) rather
 * than patched incrementally — `saveMergedTranscript` already deletes and
 * re-inserts every utterance on each transcription run with fresh ids, so
 * there is nothing stable to patch against.
 */

export interface ChunkForSearch {
  id: string
  recordingId: string
  recordingTitle: string
  startMs: number
  endMs: number
  text: string
  // node:sqlite represents a BLOB column as a Uint8Array, not a Node Buffer.
  embedding: Uint8Array
  modelId: string
}

interface ChunkForSearchRow {
  id: string
  recording_id: string
  recording_title: string
  start_ms: number
  end_ms: number
  text: string
  // node:sqlite represents a BLOB column as a Uint8Array, not a Node Buffer.
  embedding: Uint8Array
  model_id: string
}

function toChunk(row: ChunkForSearchRow): ChunkForSearch {
  return {
    id: row.id,
    recordingId: row.recording_id,
    recordingTitle: row.recording_title,
    startMs: row.start_ms,
    endMs: row.end_ms,
    text: row.text,
    embedding: row.embedding,
    modelId: row.model_id
  }
}

/** Chunks to search against — one recording's, or every recording's when `recordingId` is omitted. */
export function listChunksForSearch(recordingId?: string): ChunkForSearch[] {
  const db = getDb()
  const base = `SELECT c.id, c.recording_id, r.title AS recording_title, c.start_ms, c.end_ms,
                       c.text, c.embedding, c.model_id
                  FROM chunk_embeddings c
                  JOIN recordings r ON r.id = c.recording_id`
  const rows = (
    recordingId
      ? db.prepare(`${base} WHERE c.recording_id = ?`).all(recordingId)
      : db.prepare(base).all()
  ) as unknown as ChunkForSearchRow[]
  return rows.map(toChunk)
}

/** Replaces every chunk for a recording in one transaction — old rows gone, new ones in. */
export function replaceChunksForRecording(
  recordingId: string,
  chunks: Array<{ startMs: number; endMs: number; text: string; embedding: Uint8Array; modelId: string }>
): void {
  const db = getDb()
  db.exec('BEGIN')
  try {
    db.prepare('DELETE FROM chunk_embeddings WHERE recording_id = ?').run(recordingId)

    const insert = db.prepare(
      `INSERT INTO chunk_embeddings (id, recording_id, start_ms, end_ms, text, embedding, model_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const now = Date.now()
    for (const chunk of chunks) {
      insert.run(
        randomUUID(),
        recordingId,
        chunk.startMs,
        chunk.endMs,
        chunk.text,
        chunk.embedding,
        chunk.modelId,
        now
      )
    }

    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}
