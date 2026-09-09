import type { AskCitation, AskResult } from '@shared/ollama'
import { getRagChatModel } from '../db/settings'
import { chat, type ChatMessage } from './ollama'
import { searchChunks, type SearchResult } from './search'

/**
 * Retrieval-augmented answers: pull the chunks most relevant to a question
 * (reusing `searchChunks` — the same retrieval semantic search already
 * does), then have a local Ollama chat model write an answer grounded in
 * them. Scoped to one recording when `recordingId` is given, or the whole
 * library when it's omitted — the library-wide case is what backs the
 * top-level Ask screen, citing which recording(s) the answer drew from.
 */

/** How many retrieved excerpts to ground an answer in — matches what `searchChunks` already caps to. */
const MAX_EXCERPTS = 5

export class AskConfigError extends Error {}

function buildSystemPrompt(excerpts: SearchResult[]): string {
  const numbered = excerpts
    .map((e, i) => `Excerpt ${i + 1} (from "${e.recordingTitle}"): "${e.text}"`)
    .join('\n\n')

  return (
    'You are answering a question about one or more recorded conversations, using only the excerpts below. ' +
    "If the excerpts don't contain the answer, say plainly that your recordings don't cover it — " +
    'never invent an answer or use outside knowledge. When an excerpt is relevant, you may mention which ' +
    'recording it came from.\n\n' +
    numbered
  )
}

/** Answers a question, grounded in one recording's transcript (`recordingId` given) or the whole library. */
export async function answerQuestion(question: string, recordingId?: string): Promise<AskResult> {
  const trimmed = question.trim()
  if (!trimmed) return { answer: '', citations: [] }

  const chatModel = getRagChatModel()
  if (!chatModel) {
    throw new AskConfigError('Pick a chat model in Settings → Knowledge Base before asking a question.')
  }

  const excerpts = (await searchChunks(trimmed, recordingId)).slice(0, MAX_EXCERPTS)
  if (excerpts.length === 0) {
    return {
      answer: recordingId
        ? "This recording hasn't been indexed yet, or has no transcript to search."
        : "Nothing in your library is indexed yet — transcribe a recording and set an embedding model in Settings first.",
      citations: []
    }
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(excerpts) },
    { role: 'user', content: trimmed }
  ]
  const answer = await chat(messages, chatModel)

  const citations: AskCitation[] = excerpts.map((e) => ({
    recordingId: e.recordingId,
    recordingTitle: e.recordingTitle,
    text: e.text,
    startMs: e.startMs,
    endMs: e.endMs
  }))

  return { answer, citations }
}
