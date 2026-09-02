import { spawn, type ChildProcess } from 'node:child_process'
import { cpus } from 'node:os'
import { dirname } from 'node:path'
import { DEFAULT_CHAT_MODEL_ID } from '@shared/models'
import { resolveSidecar } from './sidecars'
import { resolveModelPath } from './models'
import { searchChunks, type SearchResult } from './search'

/**
 * Offline RAG over a transcript: retrieve the chunks most relevant to a
 * question (reusing `searchChunks` — the same retrieval `services/search.ts`
 * already does), then have a small local chat model write an answer
 * grounded in them.
 *
 * A second, independent `llama-server` instance from the one
 * `services/embeddings.ts` runs — one process loads one model, and an
 * embedding model can't generate text — started in plain chat-completion
 * mode (no `--embedding`/`--pooling`) on its own port, so the GGUF's own
 * baked-in chat template is applied automatically via the OpenAI-compatible
 * `/v1/chat/completions` endpoint rather than a hand-rolled prompt format.
 */

const HOST = '127.0.0.1'
const PORT = 8757

/** How many retrieved excerpts to ground an answer in — same shape `searchChunks` already returns capped to. */
const MAX_EXCERPTS = 5

let serverProcess: ChildProcess | null = null
/** Dedupes concurrent start attempts — more than one question could be in flight at once. */
let startPromise: Promise<void> | null = null

/**
 * Stopped automatically after this long with no question asked.
 *
 * A 3B-parameter model resident with its KV cache is a couple of gigabytes
 * that would otherwise sit loaded for the rest of the app's life after one
 * question — Ask is occasional, not continuous, for most sessions.
 */
const IDLE_STOP_MS = 15 * 60 * 1000

let idleTimer: NodeJS.Timeout | null = null

/** Re-armed on every real use; fires stopAnswerServer once nothing has touched this server in IDLE_STOP_MS. */
function armIdleStop(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    idleTimer = null
    stopAnswerServer()
  }, IDLE_STOP_MS)
  // Must not be the reason the app fails to quit promptly.
  idleTimer.unref()
}

async function isHealthy(): Promise<boolean> {
  try {
    const res = await fetch(`http://${HOST}:${PORT}/health`)
    return res.ok
  } catch {
    return false
  }
}

async function waitUntilHealthy(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isHealthy()) return
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error('Answering server did not become ready in time')
}

export class AnsweringModelMissingError extends Error {
  constructor() {
    super('The answering model is not downloaded yet. Get it from Settings → Models.')
    this.name = 'AnsweringModelMissingError'
  }
}

async function startServer(): Promise<void> {
  const exe = resolveSidecar('llama-server')
  const modelPath = await resolveModelPath(DEFAULT_CHAT_MODEL_ID)
  if (!modelPath) throw new AnsweringModelMissingError()

  const child = spawn(
    exe,
    [
      '-m',
      modelPath,
      '-c',
      '4096',
      '--host',
      HOST,
      '--port',
      String(PORT),
      '--no-webui',
      // Leave a couple of cores for the rest of the machine, same reasoning
      // as every other sidecar.
      '-t',
      String(Math.max(1, Math.min(8, cpus().length - 2)))
    ],
    {
      windowsHide: true,
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

  await waitUntilHealthy(15_000)
}

/** Starts the server if it isn't already up and healthy. Safe to call from multiple places at once. */
export async function ensureAnswerServer(): Promise<void> {
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
export function stopAnswerServer(): void {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  serverProcess?.kill()
  serverProcess = null
}

interface ChatCompletionResponse {
  choices: Array<{ message: { role: string; content: string } }>
}

function buildSystemPrompt(excerpts: SearchResult[]): string {
  const numbered = excerpts
    .map((e, i) => `Excerpt ${i + 1}: "${e.text}"`)
    .join('\n\n')

  return (
    'You are answering a question about a recorded conversation, using only the excerpts below. ' +
    "If the excerpts don't contain the answer, say plainly that the recording doesn't cover it — " +
    'never invent an answer or use outside knowledge.\n\n' +
    numbered
  )
}

export interface AnswerResult {
  answer: string
  citations: Array<{ text: string; startMs: number; endMs: number }>
}

/** Answers a question about one recording, grounded in its transcript. */
export async function answerQuestion(question: string, recordingId: string): Promise<AnswerResult> {
  const trimmed = question.trim()
  if (!trimmed) return { answer: '', citations: [] }

  const excerpts = (await searchChunks(trimmed, recordingId)).slice(0, MAX_EXCERPTS)
  if (excerpts.length === 0) {
    return {
      answer: "This recording hasn't been indexed yet, or has no transcript to search.",
      citations: []
    }
  }

  await ensureAnswerServer()

  const res = await fetch(`http://${HOST}:${PORT}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: buildSystemPrompt(excerpts) },
        { role: 'user', content: trimmed }
      ],
      temperature: 0.2,
      max_tokens: 512
    })
  })
  if (!res.ok) {
    throw new Error(`Answering request failed: ${res.status} ${res.statusText}`)
  }

  const body = (await res.json()) as ChatCompletionResponse
  const answer = body.choices[0]?.message.content.trim() ?? ''

  return {
    answer,
    citations: excerpts.map((e) => ({ text: e.text, startMs: e.startMs, endMs: e.endMs }))
  }
}
