/**
 * Types and catalogue for the Ollama-backed knowledge base.
 *
 * Unlike the ASR models in `shared/models.ts`, nothing here is bundled or
 * downloaded by this app directly — Ollama itself is a separate program the
 * user installs, and `main/services/ollama.ts` is just an HTTP client
 * against its local server (`127.0.0.1:11434` by default). The recommended
 * catalogue below exists only to give the Settings picker a curated
 * "install this" starting point instead of an empty text field.
 */

/** One model as Ollama's own `/api/tags` reports it. */
export interface OllamaModelInfo {
  name: string
  sizeBytes: number
  parameterSize: string
  quantization: string
}

export interface OllamaStatus {
  running: boolean
  version: string | null
  models: OllamaModelInfo[]
}

export interface RecommendedOllamaModel {
  /** The exact name Ollama expects for `/api/pull` and `/api/tags` matching, e.g. "nomic-embed-text:latest". */
  name: string
  role: 'embedding' | 'chat'
  label: string
  blurb: string
  /** Approximate on-disk size, shown before a real total is known from the pull's own progress stream. */
  sizeBytes: number
}

export const RECOMMENDED_OLLAMA_MODELS: RecommendedOllamaModel[] = [
  {
    name: 'nomic-embed-text:latest',
    role: 'embedding',
    label: 'nomic-embed-text',
    blurb: 'Text embeddings — required to index and search your library.',
    sizeBytes: 274_000_000
  },
  {
    name: 'llama3.2:3b',
    role: 'chat',
    label: 'Llama 3.2 3B',
    blurb: 'Small, fast — good for quick answers on modest hardware.',
    sizeBytes: 2_000_000_000
  },
  {
    name: 'qwen2.5:7b',
    role: 'chat',
    label: 'Qwen 2.5 7B',
    blurb: 'Larger, better reasoning and summaries if your GPU allows.',
    sizeBytes: 4_700_000_000
  }
]

/** Mirrors `shared/models.ts`'s `ModelDownloadProgress` shape so the renderer can reuse the same progress-bar rendering. */
export interface OllamaPullProgress {
  modelName: string
  receivedBytes: number
  totalBytes: number | null
  fraction: number | null
  done: boolean
  error: string | null
}

export interface RagSettings {
  embeddingModel: string | null
  chatModel: string | null
  serverUrl: string
}

export const DEFAULT_OLLAMA_SERVER_URL = 'http://127.0.0.1:11434'

export interface RagIndexStatus {
  chunkCount: number
  indexedRecordings: number
  totalRecordings: number
}

export interface AskCitation {
  recordingId: string
  recordingTitle: string
  text: string
  startMs: number
  endMs: number
}

export interface AskResult {
  answer: string
  citations: AskCitation[]
}
