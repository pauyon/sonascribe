/**
 * Engine-neutral transcription types.
 *
 * Two ASR engines are supported — whisper.cpp and Parakeet — and everything
 * downstream (merging, diarization alignment, persistence) works on this shape
 * rather than on either engine's native output. Adding a third engine means
 * writing one runner, not touching the pipeline.
 */

import type { AsrEngine } from '@shared/models'

/** A word with timings, assembled from whichever sub-word units the engine emits. */
export interface TranscriptWord {
  text: string
  startMs: number
  endMs: number
  /** Model confidence 0..1 for this word. */
  probability: number
}

export interface TranscriptSegment {
  startMs: number
  endMs: number
  text: string
  words: TranscriptWord[]
  /** Mean word probability across the segment. */
  confidence: number | null
}

export interface TranscriptionResult {
  /** Detected language, or null when the engine does not report one. */
  language: string | null
  segments: TranscriptSegment[]
}

export interface TranscribeOptions {
  wavPath: string
  modelPath: string
  /** Language hint. Ignored by engines that always auto-detect. */
  language: string
  threads?: number
  /**
   * Fractional progress 0..1, or null when the engine reports none. Parakeet's
   * CLI prints no progress, so its jobs are indeterminate.
   */
  onProgress?: (fraction: number | null) => void
  signal?: AbortSignal
}

/** Thrown by any engine runner; carries the tail of the child's stderr. */
export class TranscriptionError extends Error {
  constructor(
    message: string,
    readonly stderrTail: string
  ) {
    super(message)
    this.name = 'TranscriptionError'
  }
}

/**
 * Groups engine words into segments on pauses.
 *
 * Parakeet emits one flat token stream with no segmentation of its own. Rather
 * than hand the pipeline a single enormous segment, split on silence — the
 * merge step will re-split by speaker afterwards regardless.
 */
export function groupWordsIntoSegments(
  words: TranscriptWord[],
  maxGapMs = 800
): TranscriptSegment[] {
  const segments: TranscriptSegment[] = []
  let current: TranscriptWord[] = []

  const flush = (): void => {
    if (current.length === 0) return
    const text = current
      .map((w) => w.text)
      .join(' ')
      // Punctuation arrives as its own token; pull it back onto the word before.
      .replace(/\s+([,.!?;:])/g, '$1')
      .trim()
    segments.push({
      startMs: current[0].startMs,
      endMs: current[current.length - 1].endMs,
      text,
      words: current,
      confidence: current.reduce((sum, w) => sum + w.probability, 0) / current.length
    })
    current = []
  }

  for (const word of words) {
    const previous = current[current.length - 1]
    if (previous && word.startMs - previous.endMs > maxGapMs) flush()
    current.push(word)
  }
  flush()

  return segments
}

/** Which sidecar binary an engine runs. */
export function engineSidecar(engine: AsrEngine): 'whisper-cli' | 'parakeet-cli' {
  return engine === 'parakeet' ? 'parakeet-cli' : 'whisper-cli'
}
