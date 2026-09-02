import { spawn, type ChildProcess } from 'node:child_process'
import { cpus } from 'node:os'
import { dirname } from 'node:path'
import { resolveBundledModel, resolveSidecar } from './sidecars'

/**
 * A long-lived local HTTP server for text embeddings (`llama-server` in
 * `--embedding` mode) — unlike every other sidecar in this app, which is
 * spawned once per job and read from stdout to completion. Embedding many
 * chunks that way would be dominated by per-process model-load overhead;
 * a persistent server answers each request in milliseconds once it's up
 * (~300ms cold start, measured).
 *
 * Started lazily on first search or first post-transcription indexing pass,
 * not at app launch — a user who never searches pays no memory/CPU cost for
 * it. Stopped in index.ts's existing before-quit cleanup, alongside
 * `cancelAllJobs()` — and, since every transcription reindexes itself, also
 * stopped after a period of no use (see IDLE_STOP_MS below) so it doesn't sit
 * loaded for the rest of the session after the one recording that started it.
 */

const HOST = '127.0.0.1'
const PORT = 8756

/** Identifies which model produced a stored embedding, so a future model change is detectable. */
export const EMBEDDING_MODEL_ID = 'nomic-embed-text-v1.5-q4_k_m'

let serverProcess: ChildProcess | null = null
/** Dedupes concurrent start attempts — indexing and a search can both trigger one at once. */
let startPromise: Promise<void> | null = null

/**
 * Stopped automatically after this long with no request through it.
 *
 * Every transcription reindexes itself (see search.ts), so this server starts
 * the moment a session's first recording finishes — whether or not anyone
 * ever searches or asks a question. Without an idle stop it then sits loaded
 * for the rest of the app's life, next to the Q&A model doing the same, for
 * a user who spends the following three hours just browsing the Library.
 */
const IDLE_STOP_MS = 15 * 60 * 1000

let idleTimer: NodeJS.Timeout | null = null

/** Re-armed on every real use; fires stopEmbeddingServer once nothing has touched this server in IDLE_STOP_MS. */
function armIdleStop(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    idleTimer = null
    stopEmbeddingServer()
  }, IDLE_STOP_MS)
  // Must not be the reason the app fails to quit promptly.
  idleTimer.unref()
}

async function isHealthy(): Promise<boolean> {
  try {
    const res = await fetch(`http://${HOST}:${PORT}/health`)
    return res.ok
  } catch {
    // Connection refused — nothing listening yet, not a real error.
    return false
  }
}

async function waitUntilHealthy(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isHealthy()) return
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error('Embedding server did not become ready in time')
}

async function startServer(): Promise<void> {
  const exe = resolveSidecar('llama-server')
  const modelPath = resolveBundledModel('embedding-model.gguf')

  const child = spawn(
    exe,
    [
      '-m',
      modelPath,
      '--embedding',
      '--pooling',
      'mean',
      '--host',
      HOST,
      '--port',
      String(PORT),
      '--no-webui',
      // Leave a couple of cores for the rest of the machine, same reasoning
      // as the diarization/ASR sidecars.
      '-t',
      String(Math.max(1, Math.min(8, cpus().length - 2)))
    ],
    {
      windowsHide: true,
      // Same reason as every other sidecar: the executable loads its shared
      // libraries from its own directory.
      cwd: dirname(exe)
    }
  )
  serverProcess = child

  child.on('exit', () => {
    if (serverProcess === child) serverProcess = null
  })
  child.on('error', () => {
    if (serverProcess === child) serverProcess = null
  })

  await waitUntilHealthy(10_000)
}

/** Starts the server if it isn't already up and healthy. Safe to call from multiple places at once. */
export async function ensureEmbeddingServer(): Promise<void> {
  armIdleStop()
  if (serverProcess && (await isHealthy())) return
  if (startPromise) return startPromise

  startPromise = startServer()
  try {
    await startPromise
  } finally {
    startPromise = null
  }
}

/** For index.ts's quit handler (and the idle timeout above). A no-op if the server was never started. */
export function stopEmbeddingServer(): void {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  serverProcess?.kill()
  serverProcess = null
}

interface EmbeddingResponseItem {
  index: number
  // Doubly nested in llama-server's own response shape: one row per input
  // sequence (always one here), each holding the pooled vector.
  embedding: number[][]
}

async function embed(texts: string[], prefix: string): Promise<Float32Array[]> {
  if (texts.length === 0) return []

  await ensureEmbeddingServer()

  const res = await fetch(`http://${HOST}:${PORT}/embedding`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: texts.map((text) => prefix + text) })
  })
  if (!res.ok) {
    throw new Error(`Embedding request failed: ${res.status} ${res.statusText}`)
  }

  const items = (await res.json()) as EmbeddingResponseItem[]
  const byIndex = new Map(items.map((item) => [item.index, item.embedding[0]]))

  return texts.map((_, i) => {
    const vector = byIndex.get(i)
    if (!vector) throw new Error(`Embedding server returned nothing for input ${i}`)
    return new Float32Array(vector)
  })
}

/**
 * nomic-embed-text-v1.5 is trained with task prefixes and expects one on
 * every input — "search_document: " for what gets indexed, "search_query: "
 * for what searches it — for the asymmetric case this app always uses
 * (a short query finding a longer passage). Omitting them still produces
 * valid vectors, but ones that don't reflect the model's actual training
 * setup for retrieval.
 */
/** Embeds a batch of chunk texts in one request — the whole point of a persistent server over a per-call CLI. */
export function embedChunks(texts: string[]): Promise<Float32Array[]> {
  return embed(texts, 'search_document: ')
}

export async function embedQuery(text: string): Promise<Float32Array> {
  const [vector] = await embed([text], 'search_query: ')
  return vector
}
