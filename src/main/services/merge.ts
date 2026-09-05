import type { TranscriptSegment, TranscriptWord } from './transcription'
import type { SpeakerSegment } from './diarize'

/**
 * Aligns a transcript against diarization output.
 *
 * Transcription and diarization run independently and disagree about where
 * boundaries fall, so they have to be reconciled. Alignment happens at the
 * *word* level: assigning whole whisper segments to a speaker puts the switch
 * wherever whisper happened to break a sentence, which visibly attributes the
 * first half of one person's reply to the previous speaker.
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
  /**
   * Which track this audio actually came from, or null when it no longer
   * corresponds to a single track.
   *
   * Every utterance starts out on exactly one track — `mergeTranscriptWithSpeakers`
   * runs once per track and stamps its result accordingly. `coalesceAdjacent`
   * is the one place two utterances are fused into one after that, and it
   * nulls this out when they disagree rather than keeping whichever side
   * happened to survive, since a stored (trackId, startMs, endMs) is trusted
   * downstream (voice-profile enrollment) to describe real audio in that one
   * file.
   */
  trackId: string | null
}

/**
 * Cluster id reserved for the local user.
 *
 * Negative so it can never collide with a diarizer cluster index, which always
 * counts up from zero.
 */
export const LOCAL_SPEAKER = -1

export interface MergeOptions {
  /**
   * Start a new utterance when one speaker pauses for longer than this, even
   * though the speaker has not changed. Without it a monologue becomes a single
   * unreadable block.
   */
  maxGapMs?: number
  /**
   * Attribute every word to this speaker instead of consulting the diarization
   * segments. Used for the microphone track, which is the local user by
   * definition — diarizing it could only introduce an error.
   */
  forceSpeaker?: number
}

/** Overlap in milliseconds between two intervals; 0 when they are disjoint. */
/** Exported for reuse by anchor-matching (services/profiles.ts), which is the same "how much do these two spans overlap" question. */
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
 * none at all — diarization only labels detected speech, so a word landing in
 * a "silent" stretch is normal, and attributing it to whoever was speaking
 * closest in time is far better than dropping it or inventing a speaker.
 *
 * `words` and `segments` are both already time-ordered (the caller sorts
 * `words`; diarization emits `segments` in order), so one cursor advanced
 * across the whole call finds every word's segment: nothing a later word
 * needs ever sits behind a segment an earlier word already passed. Rescanning
 * every word from segment 0 — the previous approach — made this an O(words ×
 * segments) pass, which visibly slowed the merge step on a long recording
 * with many diarization segments.
 */
function assignSpeakers(words: TranscriptWord[], segments: SpeakerSegment[]): Array<number | null> {
  let start = 0

  return words.map((word) => {
    // Segments fully before this word can't matter to it, or to any later
    // word — words only move forward from here.
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

    // No overlap: the nearest segment is whichever of the one just dropped
    // (closest ending before) or the one now at the cursor (closest starting
    // after) is nearer — anything further away in either direction only loses.
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
 * A gap this long between two words is a pause somebody could have stopped in.
 *
 * Below it the words run together and moving the boundary there would be no
 * better than where the diarizer put it.
 */
const MIN_SNAP_GAP_MS = 120

/**
 * Credit given to a candidate that follows the end of a sentence.
 *
 * People take their turn when the previous one finishes a thought, so a
 * boundary after "…that's really cool." is more likely right than one two words
 * later with a slightly longer pause in it. Worth about a fifth of a second of
 * silence — enough to win a close call, not enough to drag the boundary across
 * a genuinely long pause somewhere else.
 */
const SENTENCE_END_BONUS_MS = 220

/** True when this word closes a sentence, so a turn could plausibly start after it. */
function endsSentence(word: TranscriptWord): boolean {
  return /[.!?]["')\]]?$/.test(word.text.trim())
}


/**
 * Moves each speaker change to the nearest pause between words.
 *
 * Diarization decides when the voice changed, from the audio alone. The speech
 * engine decides where each word starts and ends. The two disagree by a couple
 * of hundred milliseconds as a matter of course, and the result is a switch
 * landing inside a phrase: "Um yeah. I" attributed to one person and "don't
 * know" to the next, splitting one sentence between two speakers.
 *
 * Words never overlap in time, so the silence between consecutive words is a
 * good proxy for where somebody actually stopped talking. Within a few words
 * either side of the boundary the longest such gap is almost always the real
 * turn, so the change is moved there and the words in between are handed to
 * whichever speaker now owns them.
 *
 * Only moved when there is a genuinely better gap to move to: with no pause
 * nearby, the diarizer's own placement stands.
 */
function snapBoundariesToPauses(assigned: Array<{ word: TranscriptWord; speaker: number | null }>): void {
  const gapBefore = (index: number): number =>
    assigned[index].word.startMs - assigned[index - 1].word.endMs

  // What a candidate boundary is worth: the silence in front of it, plus credit
  // for following the end of a sentence.
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
      // Never move the boundary past another speaker change; that would hand
      // away words belonging to a third run entirely.
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

    // The gap itself still has to be a real pause: the sentence bonus tips a
    // close decision, it does not create a boundary where nobody paused.
    if (bestAt !== at && gapBefore(bestAt) >= MIN_SNAP_GAP_MS) {
      if (bestAt < at) {
        // Boundary moves earlier: the tail of the left run was really the next
        // speaker starting to talk.
        for (let i = bestAt; i < at; i++) assigned[i].speaker = right
      } else {
        // Boundary moves later: the head of the right run was still the first
        // speaker finishing.
        for (let i = at; i < bestAt; i++) assigned[i].speaker = left
      }
      at = bestAt + 1
      continue
    }

    at++
  }
}

export function mergeTranscriptWithSpeakers(
  transcript: TranscriptSegment[],
  speakers: SpeakerSegment[],
  /** The track this transcript and these speaker segments were both produced from. */
  trackId: string,
  options: MergeOptions = {}
): MergedUtterance[] {
  const maxGapMs = options.maxGapMs ?? 2000

  // Flatten to a single time-ordered word stream. Whisper's own segmentation is
  // deliberately discarded here — speaker changes, not sentence breaks, decide
  // where an utterance ends.
  const words: TranscriptWord[] = transcript
    .flatMap((segment) =>
      segment.words.length > 0
        ? segment.words
        : // A segment with no token timings still carries text; treat the whole
          // segment as one word-like unit so nothing is silently lost.
          [
            {
              text: segment.text,
              startMs: segment.startMs,
              endMs: segment.endMs,
              probability: segment.confidence ?? 1
            }
          ]
    )
    .sort((a, b) => a.startMs - b.startMs)

  if (words.length === 0) return []

  const speakerOf =
    options.forceSpeaker !== undefined
      ? words.map(() => options.forceSpeaker as number)
      : assignSpeakers(words, speakers)
  const assigned = words.map((word, i) => ({ word, speaker: speakerOf[i] }))

  snapBoundariesToPauses(assigned)

  const utterances: MergedUtterance[] = []
  let current: MergedUtterance | null = null

  for (const { word, speaker } of assigned) {
    const speakerChanged = current !== null && current.speaker !== speaker
    const longPause = current !== null && word.startMs - current.endMs > maxGapMs

    if (current === null || speakerChanged || longPause) {
      current = {
        startMs: word.startMs,
        endMs: word.endMs,
        text: word.text,
        speaker,
        words: [word],
        confidence: null,
        trackId
      }
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
 * total. Clusters below this are the diarizer's tail: a cough, a door, one word
 * of crosstalk, or the same voice split off by a bad embedding. They are the
 * difference between "4 speakers" and "20 speakers" on the same audio.
 */
export const MIN_SPEAKER_SPEECH_MS = 1500

/**
 * The speech a speaker must have before they are believed, given the recording.
 *
 * The fixed threshold above protects a long recording from a tail of invented
 * speakers, where there is plenty of crosstalk and noise to mistake for people.
 * On a short take it does the opposite: in a seven-second recording, demanding a
 * second and a half of speech deletes anyone who says one word — which is how a
 * real second speaker, 0.39 s of them, disappeared from a transcript that had
 * correctly found two.
 *
 * Under a minute the bar is 0.3 s, easing back to the full threshold by five
 * minutes. There is no long tail of junk clusters to guard against in a minute
 * of audio, so the guard costs more than it saves.
 */
export function minSpeakerSpeechFor(durationMs?: number): number {
  const SHORT = 300
  if (durationMs == null || durationMs >= 300_000) return MIN_SPEAKER_SPEECH_MS
  if (durationMs <= 60_000) return SHORT
  const t = (durationMs - 60_000) / 240_000
  return SHORT + (MIN_SPEAKER_SPEECH_MS - SHORT) * t
}

/**
 * Folds negligible speakers into the one talking nearest to them in time.

 *
 * Clustering decides how many speakers exist from distances alone, and it has
 * no way to know that a cluster holding 400 ms of audio is not a person. This
 * runs afterwards, on the merged utterances, where total speech per speaker is
 * finally knowable.
 *
 * Reassignment is by nearest neighbour in time rather than by voice: the
 * embeddings are gone by this point, and in a conversation the speaker adjacent
 * to a fragment is overwhelmingly the one it belongs to. That is a heuristic,
 * which is why it is only applied to clusters small enough that leaving them
 * alone is certainly wrong.
 *
 * The local speaker is never absorbed and never absorbs: it was assigned from
 * the microphone track outright, not clustered, so it is not a guess to correct.
 */
export function absorbTinySpeakers(
  utterances: MergedUtterance[],
  minSpeechMs = MIN_SPEAKER_SPEECH_MS
): MergedUtterance[] {
  if (utterances.length === 0) return utterances

  const speechMs = new Map<number, number>()
  for (const u of utterances) {
    if (u.speaker == null || u.speaker === LOCAL_SPEAKER) continue
    speechMs.set(u.speaker, (speechMs.get(u.speaker) ?? 0) + (u.endMs - u.startMs))
  }

  const doomed = new Set(
    [...speechMs.entries()].filter(([, ms]) => ms < minSpeechMs).map(([speaker]) => speaker)
  )
  if (doomed.size === 0) return utterances

  // Absorbing every cluster would leave a conversation with no speakers at all,
  // which is worse than an over-split one. Keep the largest in that case.
  if (doomed.size === speechMs.size) {
    const largest = [...speechMs.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
    if (largest !== undefined) doomed.delete(largest)
    if (doomed.size === 0) return utterances
  }

  const survives = (speaker: number | null): boolean =>
    speaker != null && (speaker === LOCAL_SPEAKER || !doomed.has(speaker))

  const ordered = [...utterances].sort((a, b) => a.startMs - b.startMs)

  // Nearest surviving neighbour on each side, precomputed in two linear
  // passes rather than scanned for per doomed utterance: adjacent small
  // clusters — exactly what this function exists to clean up — used to make
  // that an O(n^2) scan, each doomed utterance walking past every other
  // doomed one before finding a survivor.
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

/** Fraction of the shorter utterance's duration the two must overlap before they're even compared as possible duplicates. */
const DUP_TIME_OVERLAP_FRACTION = 0.6
/** Fraction of the shorter text's words that must also appear in the other, once the time overlap test passes. */
const DUP_TEXT_SIMILARITY_FRACTION = 0.6

/** Lowercased, punctuation-stripped words — comparable across two ASR passes that spelled things differently. */
function wordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .split(/\s+/)
    .filter(Boolean)
}

/** Fraction of words the two texts share, as a multiset, relative to the shorter one. */
function textSimilarity(a: string, b: string): number {
  const wordsA = wordsOf(a)
  const wordsB = wordsOf(b)
  if (wordsA.length === 0 || wordsB.length === 0) return 0

  const remaining = new Map<string, number>()
  for (const word of wordsA) remaining.set(word, (remaining.get(word) ?? 0) + 1)

  let shared = 0
  for (const word of wordsB) {
    const count = remaining.get(word) ?? 0
    if (count > 0) {
      shared++
      remaining.set(word, count - 1)
    }
  }
  return shared / Math.min(wordsA.length, wordsB.length)
}

/**
 * Drops an utterance that is really the same speech as another track's,
 * caught twice because the same voice reached two different tracks — a mic
 * picking up the room's own system audio, or the reverse. Diarization has no
 * way to know two clusters *are* the same person when the only evidence is
 * that they never show up on the same track, so this catches it afterwards
 * by comparing what was actually said.
 *
 * Restricted to utterances from different tracks that overlap heavily in
 * time *and* say almost the same thing — genuine cross-talk between two
 * different people never satisfies both at once, so this can't mistake a
 * real conversation for a duplicate.
 */
export function dropCrossTrackDuplicates(utterances: MergedUtterance[]): MergedUtterance[] {
  const dropped = new Set<MergedUtterance>()

  for (let i = 0; i < utterances.length; i++) {
    const a = utterances[i]
    if (dropped.has(a) || a.trackId == null) continue

    for (let j = i + 1; j < utterances.length; j++) {
      const b = utterances[j]
      // Time-ordered, so nothing later can still overlap once b starts past a's end.
      if (b.startMs > a.endMs) break
      if (dropped.has(b) || b.trackId == null || b.trackId === a.trackId) continue

      const overlapMs = overlap(a.startMs, a.endMs, b.startMs, b.endMs)
      const shorterMs = Math.min(a.endMs - a.startMs, b.endMs - b.startMs)
      if (shorterMs <= 0 || overlapMs / shorterMs < DUP_TIME_OVERLAP_FRACTION) continue
      if (textSimilarity(a.text, b.text) < DUP_TEXT_SIMILARITY_FRACTION) continue

      // Keep whichever the engine was more confident in — the track carrying
      // someone else's audio bleeding through is generally the noisier one.
      const loser = (a.confidence ?? 0) >= (b.confidence ?? 0) ? b : a
      dropped.add(loser)
      // a itself lost — nothing left to compare it against.
      if (loser === a) break
    }
  }

  return dropped.size === 0 ? utterances : utterances.filter((u) => !dropped.has(u))
}

/**
 * Joins neighbouring utterances that now share a speaker.
 *
 * Absorption can leave two consecutive blocks attributed to the same person,
 * which reads as an interruption that never happened. Only genuinely adjacent
 * ones are joined — a long pause is still a paragraph break.
 */
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
      // The absorbed utterance came from its own track. Keeping either side's
      // trackId once the two disagree would claim the merged range is entirely
      // on one track when it isn't — null marks it as no longer trustworthy
      // for pulling a single-track audio sample from.
      if (last.trackId !== u.trackId) last.trackId = null
      continue
    }
    out.push({ ...u })
  }
  return out
}
