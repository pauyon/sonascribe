import type { Utterance } from '@shared/types'

/**
 * Groups a transcript's utterances into chunks sized for embedding.
 *
 * Utterances are speaker turns, not fixed-size units (see merge.ts) — a
 * monologue with no 2s pause is one long paragraph, a rapid exchange is
 * several one-word rows. Neither is a good embedding chunk on its own: short
 * turns are merged together up to a target size, long ones are split at
 * sentence boundaries.
 */

export interface Chunk {
  startMs: number
  endMs: number
  text: string
}

/** Keep merging utterances into the current chunk until it reaches roughly this size. */
const TARGET_CHARS = 800
/** Above this within a single utterance, split at sentence boundaries rather than embedding one huge blob. */
const MAX_CHARS = 1500

/**
 * Splits one long utterance into sentence-aligned pieces, deriving each
 * piece's time range from the words it actually contains.
 *
 * The word-count alignment between a sentence group and the word stream is an
 * approximation (whitespace-splitting the rebuilt sentence text doesn't
 * always tokenize identically to the engine's own word boundaries), so a
 * piece's start/end can be off by a word or two — acceptable for "jump to
 * roughly the right moment," not claimed to be exact.
 */
function splitLongUtterance(u: Utterance): Chunk[] {
  const sentences = u.text.match(/[^.!?]+[.!?]*(\s+|$)/g) ?? [u.text]
  const groups: string[] = []
  let current = ''
  for (const sentence of sentences) {
    if (current && (current + sentence).length > TARGET_CHARS) {
      groups.push(current.trim())
      current = sentence
    } else {
      current += sentence
    }
  }
  if (current.trim()) groups.push(current.trim())

  // Nothing to split against — a human-edited line has no word timings, and a
  // "split" that produced only one group didn't actually split anything.
  if (groups.length <= 1 || u.words.length === 0) {
    return [{ startMs: u.startMs, endMs: u.endMs, text: u.text }]
  }

  const chunks: Chunk[] = []
  let wordIndex = 0
  for (const group of groups) {
    const wordCount = group.split(/\s+/).filter(Boolean).length
    const groupWords = u.words.slice(wordIndex, wordIndex + wordCount)
    wordIndex += wordCount
    if (groupWords.length === 0) continue
    chunks.push({
      startMs: groupWords[0].startMs,
      endMs: groupWords[groupWords.length - 1].endMs,
      text: group
    })
  }
  return chunks.length > 0 ? chunks : [{ startMs: u.startMs, endMs: u.endMs, text: u.text }]
}

export function chunkUtterances(utterances: Utterance[]): Chunk[] {
  const chunks: Chunk[] = []
  let current: Chunk | null = null

  const flush = (): void => {
    if (current) chunks.push(current)
    current = null
  }

  for (const u of utterances) {
    const text = u.text.trim()
    if (!text) continue

    if (text.length > MAX_CHARS) {
      flush()
      chunks.push(...splitLongUtterance(u))
      continue
    }

    if (!current) {
      current = { startMs: u.startMs, endMs: u.endMs, text }
      continue
    }

    if (current.text.length + text.length + 1 > TARGET_CHARS) {
      flush()
      current = { startMs: u.startMs, endMs: u.endMs, text }
      continue
    }

    current.text += ` ${text}`
    current.endMs = u.endMs
  }
  flush()

  return chunks
}
