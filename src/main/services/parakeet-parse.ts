import type { TranscriptWord } from './transcription'

/**
 * Parser for Parakeet's `--print-segments` token table.
 *
 * Kept free of any Electron or filesystem import so it can be exercised
 * directly: this regex is the fragile part of the Parakeet integration — an
 * upstream change to the table format would silently produce empty transcripts
 * — and a parser that can only be tested by running a 356 MB model would not be
 * tested at all.
 */

/**
 * One row of the table:
 *
 *   [13] id= 1491 frame= 53 ... p=1.0000 ... t0= 424 t1= 456 word_start=true "▁not"
 *
 * t0/t1 are in units of 10 ms: the encoder runs at 12.5 frames per second
 * (16 kHz / 160-sample hop / 8× subsampling), so one frame is 80 ms and the
 * printed values are frame × 8.
 */
const TOKEN_RE =
  /^\s*\[\s*\d+\]\s+id=\s*\d+\s+frame=\s*\d+.*?\bp=([\d.]+).*?\bt0=\s*(\d+)\s+t1=\s*(\d+)\s+word_start=(true|false)\s+"(.*)"\s*$/

/** Parakeet timestamps are centiseconds. */
const TIME_UNIT_MS = 10

/** SentencePiece marks a word start with U+2581 LOWER ONE EIGHTH BLOCK. */
const WORD_MARK = '▁'

/**
 * Folds sub-word tokens into words.
 *
 * `word_start` is authoritative, so unlike the whisper path there is no need to
 * infer boundaries from leading whitespace. Punctuation arrives as its own
 * token with word_start=false and a zero-length span, and is appended to the
 * word before it.
 */
export function parseTokenTable(output: string): TranscriptWord[] {
  const words: TranscriptWord[] = []

  for (const line of output.split('\n')) {
    const match = TOKEN_RE.exec(line)
    if (!match) continue

    const [, rawProbability, rawT0, rawT1, rawWordStart, rawText] = match

    // Vocabulary control tokens (<blk>, <unk>) are angle-bracketed and carry no
    // transcript text. Current builds do not print them, but a blank token
    // reaching the fallback below would otherwise be emitted as a real word.
    if (/^<.*>$/.test(rawText)) continue

    const text = rawText.replaceAll(WORD_MARK, '')
    if (text === '') continue

    const startMs = Number(rawT0) * TIME_UNIT_MS
    const endMs = Number(rawT1) * TIME_UNIT_MS
    const probability = Number(rawProbability)

    if (rawWordStart === 'true' || words.length === 0) {
      words.push({ text, startMs, endMs, probability })
      continue
    }

    const current = words[words.length - 1]
    current.text += text
    current.endMs = Math.max(current.endMs, endMs)
    // A word is only as trustworthy as its least certain piece.
    current.probability = Math.min(current.probability, probability)
  }

  return words
}
