import { getTranscriptBundle } from '../db/recordings'
import { listChunksForSearch, replaceChunksForRecording } from '../db/chunks'
import { chunkUtterances } from './chunking'
import { embedChunks, embedQuery, EMBEDDING_MODEL_ID } from './embeddings'

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

/** How many results a search returns, ranked best first. */
const TOP_K = 10

/**
 * Rebuilds a recording's search index from its current transcript.
 *
 * Called after every successful transcription (see jobs.ts), best-effort by
 * the caller — `saveMergedTranscript` replaces every utterance with fresh
 * ids on each run, so there is nothing to patch incrementally; this always
 * starts from the transcript as it stands right now.
 */
export async function reindexRecording(recordingId: string): Promise<void> {
  const bundle = getTranscriptBundle(recordingId)
  if (!bundle) return

  const chunks = chunkUtterances(bundle.utterances)
  if (chunks.length === 0) {
    replaceChunksForRecording(recordingId, [])
    return
  }

  const vectors = await embedChunks(chunks.map((chunk) => chunk.text))
  replaceChunksForRecording(
    recordingId,
    chunks.map((chunk, i) => ({
      startMs: chunk.startMs,
      endMs: chunk.endMs,
      text: chunk.text,
      embedding: float32ToBytes(vectors[i]),
      modelId: EMBEDDING_MODEL_ID
    }))
  )
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

/** Searches one recording's chunks, or every recording's when `recordingId` is omitted. */
export async function searchChunks(query: string, recordingId?: string): Promise<SearchResult[]> {
  const trimmed = query.trim()
  if (!trimmed) return []

  const chunks = listChunksForSearch(recordingId)
  if (chunks.length === 0) return []

  const queryVector = await embedQuery(trimmed)

  return chunks
    .map((chunk) => ({
      recordingId: chunk.recordingId,
      recordingTitle: chunk.recordingTitle,
      text: chunk.text,
      startMs: chunk.startMs,
      endMs: chunk.endMs,
      score: cosineSimilarity(queryVector, bytesToFloat32(chunk.embedding))
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_K)
}
