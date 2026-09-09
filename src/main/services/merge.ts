import type { TranscriptWord } from './transcription'
import type { SpeakerSegment } from './diarize'

/**
 * Aligns a transcript against diarization output.
 *
 * Transcription and diarization run independently and disagree about where
 * boundaries fall, so they have to be reconciled. Alignment happens at the
 * *word* level: assigning whole engine segments to a speaker puts the switch
 * wherever the engine happened to break a sentence, which visibly attributes
 * the first half of one person's reply to the previous speaker.
 */

/** A run of consecutive words attributed to one speaker. */
export interface MergedUtterance {
  startMs: number
  endMs: number
  text: string
  /** Diarizer cluster index, or null when no speaker could be determined. */
  speaker: number | null
  words: TranscriptWord[]
  confidence: number | null
}

export interface MergeOptions {
  /**
   * Start a new utterance when one speaker pauses for longer than this, even
   * though the speaker has not changed. Without it a monologue becomes a
   * single unreadable block.
   */
  maxGapMs?: number
}

/** Overlap in milliseconds between two intervals; 0 when they are disjoint. */
export function overlap(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart))
}

/** Absolute time distance between a word and a segment; 0 when they overlap. */
function distanceTo(word: TranscriptWord, segment: SpeakerSegment): number {
  if (word.startMs > segment.endMs) return word.startMs - segment.endMs
  if (segment.startMs > word.endMs) return segment.startMs - word.endMs
  return 0
}

/**
 * Assigns each word the speaker whose segment overlaps it the most, falling
 * back to the nearest segment (by time distance) for a word that overlaps
 * none at all — diarization only labels detected speech, so a word landing
 * in a "silent" stretch is normal, and attributing it to whoever was
 * speaking closest in time is far better than dropping it or inventing a
 * speaker.
 *
 * `words` and `segments` are both already time-ordered, so one cursor
 * advanced across the whole call finds every word's segment: nothing a
 * later word needs ever sits behind a segment an earlier word already
 * passed.
 */
function assignSpeakers(words: TranscriptWord[], segments: SpeakerSegment[]): Array<number | null> {
  let start = 0

  return words.map((word) => {
    while (start < segments.length && segments[start].endMs < word.startMs) start++

    let best: number | null = null
    let bestOverlap = 0
    for (let i = start; i < segments.length && segments[i].startMs <= word.endMs; i++) {
      const amount = overlap(word.startMs, word.endMs, segments[i].startMs, segments[i].endMs)
      if (amount > bestOverlap) {
        bestOverlap = amount
        best = segments[i].speaker
      }
    }
    if (best !== null) return best

    let nearest: number | null = null
    let nearestDistance = Number.POSITIVE_INFINITY
    for (const segment of [segments[start - 1], segments[start]]) {
      if (!segment) continue
      const distance = distanceTo(word, segment)
      if (distance < nearestDistance) {
        nearestDistance = distance
        nearest = segment.speaker
      }
    }
    return nearest
  })
}

/** How far either side of a speaker change to look for a better place to put it. */
const SNAP_WINDOW_WORDS = 4

/**
 * A gap this long between two words is a pause somebody could have stopped
 * in. Below it the words run together and moving the boundary there would
 * be no better than where the diarizer put it.
 */
const MIN_SNAP_GAP_MS = 120

/** Credit given to a candidate that follows the end of a sentence. */
const SENTENCE_END_BONUS_MS = 220

/** True when this word closes a sentence, so a turn could plausibly start after it. */
function endsSentence(word: TranscriptWord): boolean {
  return /[.!?]["')\]]?$/.test(word.text.trim())
}

/**
 * Moves each speaker change to the nearest pause between words.
 *
 * Diarization decides when the voice changed, from the audio alone. The
 * speech engine decides where each word starts and ends. The two disagree
 * by a couple of hundred milliseconds as a matter of course, and the result
 * is a switch landing inside a phrase. Words never overlap in time, so the
 * silence between consecutive words is a good proxy for where somebody
 * actually stopped talking — within a few words either side of the boundary
 * the longest such gap is almost always the real turn.
 *
 * Only moved when there is a genuinely better gap to move to: with no pause
 * nearby, the diarizer's own placement stands.
 */
function snapBoundariesToPauses(assigned: Array<{ word: TranscriptWord; speaker: number | null }>): void {
  const gapBefore = (index: number): number => assigned[index].word.startMs - assigned[index - 1].word.endMs

  const scoreOf = (index: number): number =>
    gapBefore(index) + (endsSentence(assigned[index - 1].word) ? SENTENCE_END_BONUS_MS : 0)

  let at = 1
  while (at < assigned.length) {
    if (assigned[at].speaker === assigned[at - 1].speaker) {
      at++
      continue
    }

    const left = assigned[at - 1].speaker
    const right = assigned[at].speaker

    let bestAt = at
    let bestScore = scoreOf(at)
    const from = Math.max(1, at - SNAP_WINDOW_WORDS)
    const to = Math.min(assigned.length - 1, at + SNAP_WINDOW_WORDS)
    for (let candidate = from; candidate <= to; candidate++) {
      const inSameRun =
        candidate <= at
          ? assigned.slice(candidate, at).every((a) => a.speaker === left)
          : assigned.slice(at, candidate).every((a) => a.speaker === right)
      if (!inSameRun) continue

      const score = scoreOf(candidate)
      if (score > bestScore) {
        bestScore = score
        bestAt = candidate
      }
    }

    if (bestAt !== at && gapBefore(bestAt) >= MIN_SNAP_GAP_MS) {
      if (bestAt < at) {
        for (let i = bestAt; i < at; i++) assigned[i].speaker = right
      } else {
        for (let i = at; i < bestAt; i++) assigned[i].speaker = left
      }
      at = bestAt + 1
      continue
    }

    at++
  }
}

/**
 * Aligns a flat, time-ordered word stream against diarization segments and
 * groups the result into speaker-turn utterances.
 */
export function mergeWordsWithSpeakers(
  words: TranscriptWord[],
  speakers: SpeakerSegment[],
  options: MergeOptions = {}
): MergedUtterance[] {
  const maxGapMs = options.maxGapMs ?? 2000
  if (words.length === 0) return []

  const speakerOf = assignSpeakers(words, speakers)
  const assigned = words.map((word, i) => ({ word, speaker: speakerOf[i] }))

  snapBoundariesToPauses(assigned)

  const utterances: MergedUtterance[] = []
  let current: MergedUtterance | null = null

  for (const { word, speaker } of assigned) {
    const speakerChanged = current !== null && current.speaker !== speaker
    const longPause = current !== null && word.startMs - current.endMs > maxGapMs

    if (current === null || speakerChanged || longPause) {
      current = { startMs: word.startMs, endMs: word.endMs, text: word.text, speaker, words: [word], confidence: null }
      utterances.push(current)
      continue
    }

    current.words.push(word)
    current.endMs = Math.max(current.endMs, word.endMs)
    current.text += ` ${word.text}`
  }

  for (const utterance of utterances) {
    utterance.text = utterance.text.replace(/\s+/g, ' ').trim()
    utterance.confidence =
      utterance.words.length > 0
        ? utterance.words.reduce((sum, w) => sum + w.probability, 0) / utterance.words.length
        : null
  }

  return utterances
}

/**
 * Minimum total speech before a cluster is believed to be a person.
 *
 * A real participant in a conversation says more than a second and a half in
 * total. Clusters below this are the diarizer's tail: a cough, a door, one
 * word of crosstalk, or the same voice split off by a bad embedding.
 */
export const MIN_SPEAKER_SPEECH_MS = 1500

/**
 * The speech a speaker must have before they are believed, given the
 * recording's length.
 *
 * The fixed threshold above protects a long recording from a tail of
 * invented speakers. On a short take it does the opposite: demanding a
 * second and a half of speech would delete anyone who says one word. Under
 * a minute the bar is 0.3 s, easing back to the full threshold by five
 * minutes.
 */
export function minSpeakerSpeechFor(durationMs?: number): number {
  const SHORT = 300
  if (durationMs == null || durationMs >= 300_000) return MIN_SPEAKER_SPEECH_MS
  if (durationMs <= 60_000) return SHORT
  const t = (durationMs - 60_000) / 240_000
  return SHORT + (MIN_SPEAKER_SPEECH_MS - SHORT) * t
}

/** Re-merges neighbouring utterances left with the same speaker after `absorbTinySpeakers` reassigns one. */
function coalesceAdjacent(utterances: MergedUtterance[], maxGapMs = 2000): MergedUtterance[] {
  const out: MergedUtterance[] = []
  for (const u of utterances) {
    const last = out[out.length - 1]
    if (last && last.speaker === u.speaker && u.startMs - last.endMs <= maxGapMs) {
      last.endMs = Math.max(last.endMs, u.endMs)
      last.text = `${last.text} ${u.text}`.replace(/\s+/g, ' ').trim()
      last.words = [...last.words, ...u.words]
      last.confidence =
        last.words.length > 0
          ? last.words.reduce((sum, w) => sum + w.probability, 0) / last.words.length
          : null
      continue
    }
    out.push({ ...u })
  }
  return out
}

/**
 * Folds negligible speakers into whoever is talking nearest to them in time.
 *
 * Clustering decides how many speakers exist from distances alone, with no
 * way to know a cluster holding 400ms of audio isn't a person. This runs
 * afterwards, on the merged utterances, where total speech per speaker is
 * finally knowable. Reassignment is by nearest neighbour in time rather than
 * by voice — the embeddings are gone by this point — which is a heuristic,
 * and why it's only applied to clusters small enough that leaving them alone
 * is certainly wrong.
 */
export function absorbTinySpeakers(
  utterances: MergedUtterance[],
  minSpeechMs = MIN_SPEAKER_SPEECH_MS
): MergedUtterance[] {
  if (utterances.length === 0) return utterances

  const speechMs = new Map<number, number>()
  for (const u of utterances) {
    if (u.speaker == null) continue
    speechMs.set(u.speaker, (speechMs.get(u.speaker) ?? 0) + (u.endMs - u.startMs))
  }

  const doomed = new Set([...speechMs.entries()].filter(([, ms]) => ms < minSpeechMs).map(([speaker]) => speaker))
  if (doomed.size === 0) return utterances

  // Absorbing every cluster would leave a conversation with no speakers at
  // all, which is worse than an over-split one. Keep the largest.
  if (doomed.size === speechMs.size) {
    const largest = [...speechMs.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
    if (largest !== undefined) doomed.delete(largest)
    if (doomed.size === 0) return utterances
  }

  const survives = (speaker: number | null): boolean => speaker != null && !doomed.has(speaker)

  const ordered = [...utterances].sort((a, b) => a.startMs - b.startMs)

  const before: Array<MergedUtterance | null> = new Array(ordered.length)
  let lastSurvivor: MergedUtterance | null = null
  for (let i = 0; i < ordered.length; i++) {
    before[i] = lastSurvivor
    if (survives(ordered[i].speaker)) lastSurvivor = ordered[i]
  }
  const after: Array<MergedUtterance | null> = new Array(ordered.length)
  let nextSurvivor: MergedUtterance | null = null
  for (let i = ordered.length - 1; i >= 0; i--) {
    after[i] = nextSurvivor
    if (survives(ordered[i].speaker)) nextSurvivor = ordered[i]
  }

  const result = ordered.map((u, at) => {
    if (u.speaker == null || survives(u.speaker)) return u

    const nearestBefore = before[at]
    const nearestAfter = after[at]
    if (!nearestBefore && !nearestAfter) return u
    const gapBefore = nearestBefore ? u.startMs - nearestBefore.endMs : Number.POSITIVE_INFINITY
    const gapAfter = nearestAfter ? nearestAfter.startMs - u.endMs : Number.POSITIVE_INFINITY
    const winner = gapBefore <= gapAfter ? nearestBefore : nearestAfter

    return { ...u, speaker: winner?.speaker ?? u.speaker }
  })

  return coalesceAdjacent(result)
}
