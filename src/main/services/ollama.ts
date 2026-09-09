import type { OllamaModelInfo, OllamaStatus } from '@shared/ollama'
import { getRagServerUrl } from '../db/settings'
import { emit } from '../ipc/events'

/**
 * Thin HTTP client for a locally-installed Ollama server.
 *
 * Unlike every ASR sidecar this app spawns and manages itself, Ollama is a
 * separate program the user installs and runs on their own — this file only
 * ever talks to it over HTTP (default `http://127.0.0.1:11434`, editable in
 * Settings for a Docker/LAN install). "Not running" is an expected, common
 * state, not an error: every function here treats a connection failure as
 * "not available" rather than throwing, so the rest of the app can degrade
 * to an empty/disabled state instead of surfacing a stack trace.
 */

export class OllamaError extends Error {}

interface OllamaTagsResponse {
  models: Array<{
    name: string
    size: number
    details?: { parameter_size?: string; quantization_level?: string }
  }>
}

interface OllamaVersionResponse {
  version: string
}

interface OllamaEmbedResponse {
  embeddings: number[][]
}

interface OllamaChatResponse {
  message: { role: string; content: string }
}

async function isReachable(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/version`)
    return res.ok
  } catch {
    return false
  }
}

/**
 * Ollama's own error responses are `{"error": "..."}` with a specific,
 * actionable message (e.g. which model doesn't support the requested
 * operation) — far more useful than the generic HTTP status text, so every
 * failing request tries to surface it instead.
 */
async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string }
    if (body.error) return body.error
  } catch {
    // Not JSON, or no `error` field — fall through to the generic message.
  }
  return `${fallback}: ${res.status} ${res.statusText}`
}

/** Ollama's own status plus its installed model list, for the Settings "Knowledge Base" card. */
export async function getStatus(): Promise<OllamaStatus> {
  const baseUrl = getRagServerUrl()
  if (!(await isReachable(baseUrl))) {
    return { running: false, version: null, models: [] }
  }

  try {
    const [versionRes, tagsRes] = await Promise.all([
      fetch(`${baseUrl}/api/version`),
      fetch(`${baseUrl}/api/tags`)
    ])
    const version = versionRes.ok ? ((await versionRes.json()) as OllamaVersionResponse).version : null
    const tags = tagsRes.ok ? ((await tagsRes.json()) as OllamaTagsResponse) : { models: [] }

    const models: OllamaModelInfo[] = tags.models.map((m) => ({
      name: m.name,
      sizeBytes: m.size,
      parameterSize: m.details?.parameter_size ?? '',
      quantization: m.details?.quantization_level ?? ''
    }))

    return { running: true, version, models }
  } catch {
    return { running: false, version: null, models: [] }
  }
}

/** Splits a `/api/pull` streaming body into its newline-delimited JSON objects, one status update at a time. */
async function* ndjsonLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newlineIndex: number
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex).trim()
        buffer = buffer.slice(newlineIndex + 1)
        if (line) yield line
      }
    }
    if (buffer.trim()) yield buffer.trim()
  } finally {
    reader.releaseLock()
  }
}

interface OllamaPullStreamChunk {
  status: string
  digest?: string
  total?: number
  completed?: number
  error?: string
}

const activePulls = new Map<string, AbortController>()

/** True while a pull for this model is in flight — same "already downloading" guard `services/models.ts` uses. */
export function isPulling(modelName: string): boolean {
  return activePulls.has(modelName)
}

/**
 * Downloads a model via `/api/pull`, emitting `ollama:pullProgress` from its
 * streamed status lines — same event-per-chunk shape `services/models.ts`
 * uses for ASR model downloads, so the renderer can reuse that progress-bar
 * rendering. Concurrent calls for the same model share the first pull.
 */
export async function pullModel(modelName: string): Promise<void> {
  if (activePulls.has(modelName)) return

  const baseUrl = getRagServerUrl()
  const controller = new AbortController()
  activePulls.set(modelName, controller)

  try {
    const res = await fetch(`${baseUrl}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelName, stream: true }),
      signal: controller.signal
    })
    if (!res.ok || !res.body) {
      throw new OllamaError(`Pull request failed: ${res.status} ${res.statusText}`)
    }

    let succeeded = false
    for await (const line of ndjsonLines(res.body)) {
      const chunk = JSON.parse(line) as OllamaPullStreamChunk
      if (chunk.error) throw new OllamaError(chunk.error)
      if (chunk.status === 'success') succeeded = true

      emit('ollama:pullProgress', {
        modelName,
        receivedBytes: chunk.completed ?? 0,
        totalBytes: chunk.total ?? null,
        fraction: chunk.total && chunk.total > 0 ? (chunk.completed ?? 0) / chunk.total : null,
        done: chunk.status === 'success',
        error: null
      })
    }

    if (!succeeded) throw new OllamaError('Pull ended without confirming success')
  } catch (err) {
    const message = controller.signal.aborted
      ? 'Pull cancelled'
      : err instanceof Error
        ? err.message
        : String(err)
    emit('ollama:pullProgress', {
      modelName,
      receivedBytes: 0,
      totalBytes: null,
      fraction: null,
      done: true,
      error: message
    })
    if (!controller.signal.aborted) throw err
  } finally {
    activePulls.delete(modelName)
  }
}

export function cancelPull(modelName: string): void {
  activePulls.get(modelName)?.abort()
}

export async function deleteModel(modelName: string): Promise<void> {
  const baseUrl = getRagServerUrl()
  const res = await fetch(`${baseUrl}/api/delete`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: modelName })
  })
  if (!res.ok) {
    throw new OllamaError(await errorMessage(res, 'Delete request failed'))
  }
}

/**
 * Embeds a batch of texts in one request.
 *
 * nomic-embed-text (the recommended embedding model) is trained with task
 * prefixes and expects one on every input — "search_document: " for what
 * gets indexed, "search_query: " for what searches it — for the asymmetric
 * retrieval case this app always uses (a short question finding a longer
 * passage). Omitting them still produces valid vectors, just not ones that
 * reflect the model's own training setup.
 */
async function embed(texts: string[], model: string, prefix: string): Promise<Float32Array[]> {
  if (texts.length === 0) return []

  const baseUrl = getRagServerUrl()
  const res = await fetch(`${baseUrl}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: texts.map((text) => prefix + text) })
  })
  if (!res.ok) {
    throw new OllamaError(await errorMessage(res, 'Embedding request failed'))
  }

  const body = (await res.json()) as OllamaEmbedResponse
  if (body.embeddings.length !== texts.length) {
    throw new OllamaError('Embedding response did not match the number of inputs')
  }
  return body.embeddings.map((vector) => new Float32Array(vector))
}

export function embedChunks(texts: string[], model: string): Promise<Float32Array[]> {
  return embed(texts, model, 'search_document: ')
}

export async function embedQuery(text: string, model: string): Promise<Float32Array> {
  const [vector] = await embed([text], model, 'search_query: ')
  return vector
}

export interface ChatMessage {
  role: 'system' | 'user'
  content: string
}

/** One-shot (non-streaming) chat completion — see the plan's Verification note on why token streaming is deferred. */
export async function chat(messages: ChatMessage[], model: string): Promise<string> {
  const baseUrl = getRagServerUrl()
  const res = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: false })
  })
  if (!res.ok) {
    throw new OllamaError(await errorMessage(res, 'Chat request failed'))
  }

  const body = (await res.json()) as OllamaChatResponse
  return body.message.content.trim()
}
