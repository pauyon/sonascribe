import { getUtterances } from '../db/transcript'
import { listChunksForSearch, replaceChunksForRecording, getChunkIndexStats } from '../db/chunks'
import { listRecordings } from '../db/recordings'
import { chunkUtterances } from './chunking'
import { embedChunks, embedQuery } from './ollama'
import { getRagEmbeddingModel } from '../db/settings'
import { emit } from '../ipc/events'
import type { RagIndexStatus } from '@shared/ollama'

/**
 * Offline semantic search over transcripts — embed once at index time, embed
 * the query at search time, rank by cosine similarity. No vector database:
 * `node:sqlite` has no extension loading enabled, and personal-scale
 * transcript data (even thousands of chunks across every recording) is
 * trivially searched by brute force in plain JS.
 */

export interface SearchResult {
  recordingId: string
  recordingTitle: string
  text: string
  startMs: number
  endMs: number
  score: number
}

/** How many results a search returns at most, ranked best first. */
const TOP_K = 5

/**
 * How far below the top score a result can fall before it's dropped.
 *
 * Cosine similarity doesn't separate "genuinely relevant" from "vaguely
 * on-topic" as cleanly as a fixed floor would assume. A margin below
 * whatever the best result actually scored at least trims the long flat
 * tail of "technically ranked, not actually close" results without
 * pretending the raw number means "confident" on its own.
 */
const SCORE_MARGIN = 0.08

/**
 * Rebuilds a recording's search index from its current transcript.
 *
 * A no-op, not an error, when no embedding model is configured yet — most
 * recordings will reindex silently in the background before the user has
 * ever opened Settings' Knowledge Base card. Best-effort by every caller
 * (see the reindex hook points in jobs.ts, speaker-jobs.ts, ipc/index.ts):
 * a failed reindex must never fail the transcription/edit that triggered it.
 */
export async function reindexRecording(recordingId: string): Promise<void> {
  const embeddingModel = getRagEmbeddingModel()
  if (!embeddingModel) return

  const utterances = getUtterances(recordingId)
  const chunks = chunkUtterances(utterances)
  if (chunks.length === 0) {
    replaceChunksForRecording(recordingId, [])
    return
  }

  const vectors = await embedChunks(
    chunks.map((chunk) => chunk.text),
    embeddingModel
  )
  replaceChunksForRecording(
    recordingId,
    chunks.map((chunk, i) => ({
      startMs: chunk.startMs,
      endMs: chunk.endMs,
      text: chunk.text,
      embedding: float32ToBytes(vectors[i]),
      modelId: embeddingModel
    }))
  )
}

/** Fire-and-forget reindex for the four write paths that change a recording's utterances — never blocks or fails the caller. */
export function triggerReindex(recordingId: string): void {
  void reindexRecording(recordingId).catch((err) => console.error('[rag] reindex failed:', err))
}

function float32ToBytes(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength)
}

function bytesToFloat32(bytes: Uint8Array): Float32Array {
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / Float32Array.BYTES_PER_ELEMENT)
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

/** Searches one recording's chunks, or every recording's when `recordingId` is omitted — the latter is what makes the library-wide Ask screen work. */
export async function searchChunks(query: string, recordingId?: string): Promise<SearchResult[]> {
  const trimmed = query.trim()
  const embeddingModel = getRagEmbeddingModel()
  if (!trimmed || !embeddingModel) return []

  const chunks = listChunksForSearch(recordingId)
  if (chunks.length === 0) return []

  const queryVector = await embedQuery(trimmed, embeddingModel)

  const ranked = chunks
    .map((chunk) => ({
      recordingId: chunk.recordingId,
      recordingTitle: chunk.recordingTitle,
      text: chunk.text,
      startMs: chunk.startMs,
      endMs: chunk.endMs,
      score: cosineSimilarity(queryVector, bytesToFloat32(chunk.embedding))
    }))
    .sort((a, b) => b.score - a.score)

  const topScore = ranked[0]?.score ?? 0
  return ranked.filter((r) => r.score >= topScore - SCORE_MARGIN).slice(0, TOP_K)
}

/** Chunk/recording counts for the Settings "N chunks indexed" line. */
export function getRagIndexStatus(): RagIndexStatus {
  const { chunkCount, indexedRecordings } = getChunkIndexStats()
  const totalRecordings = listRecordings().filter((r) => r.transcriptStatus === 'ready').length
  return { chunkCount, indexedRecordings, totalRecordings }
}

let reindexAllRunning = false

/**
 * Reindexes every recording with a ready transcript, one at a time — the
 * Settings "Reindex now" button, for a model change or after this feature
 * is first configured (nothing was indexed before an embedding model
 * existed to index it with). A per-recording failure is logged and skipped
 * rather than aborting the whole pass, same best-effort spirit as the
 * automatic per-edit reindex hooks.
 */
export async function reindexAllRecordings(): Promise<void> {
  if (reindexAllRunning) return
  reindexAllRunning = true
  try {
    const targets = listRecordings().filter((r) => r.transcriptStatus === 'ready')
    for (let i = 0; i < targets.length; i++) {
      emit('rag:indexProgress', { completed: i, total: targets.length, done: false })
      try {
        await reindexRecording(targets[i].id)
      } catch (err) {
        console.error(`[rag] reindex failed for ${targets[i].id}:`, err)
      }
    }
    emit('rag:indexProgress', { completed: targets.length, total: targets.length, done: true })
  } finally {
    reindexAllRunning = false
  }
}
