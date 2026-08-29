import { randomUUID } from 'node:crypto'
import { getDb } from './index'

/**
 * Persists a whisper result as utterances and words.
 *
 * Re-running transcription replaces the previous transcript wholesale, inside a
 * transaction: a half-replaced transcript would be worse than either the old or
 * the new one.
 */

/**
 * Replaces a transcript with speaker-attributed utterances.
 *
 * Existing speaker rows are kept: they are keyed by cluster id, so a re-merge
 * reuses them and preserves any renaming the user has done. Only the utterances
 * and words are rewritten.
 */
export function saveMergedTranscript(input: {
  recordingId: string
  modelId: string
  language: string | null
  utterances: Array<{
    startMs: number
    endMs: number
    text: string
    confidence: number | null
    speakerId: string | null
    /** Which track this line's audio came from — the source enrollment reads from. */
    trackId: string | null
    words: Array<{ startMs: number; endMs: number; text: string }>
  }>
}): void {
  const db = getDb()

  db.exec('BEGIN')
  try {
    db.prepare('DELETE FROM utterances WHERE recording_id = ?').run(input.recordingId)

    const insertUtterance = db.prepare(
      `INSERT INTO utterances
         (id, recording_id, speaker_id, start_ms, end_ms, text, edited, confidence, track_id)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`
    )
    const insertWord = db.prepare(
      `INSERT INTO words (id, utterance_id, start_ms, end_ms, text)
       VALUES (?, ?, ?, ?, ?)`
    )

    for (const utterance of input.utterances) {
      const utteranceId = randomUUID()
      insertUtterance.run(
        utteranceId,
        input.recordingId,
        utterance.speakerId,
        utterance.startMs,
        utterance.endMs,
        utterance.text,
        utterance.confidence,
        utterance.trackId
      )
      for (const word of utterance.words) {
        insertWord.run(randomUUID(), utteranceId, word.startMs, word.endMs, word.text)
      }
    }

    db.prepare('UPDATE recordings SET model_id = ?, language = ? WHERE id = ?').run(
      input.modelId,
      input.language,
      input.recordingId
    )

    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

/**
 * Rewrites one utterance's text.
 *
 * Marks the row as edited so a later re-merge (Phase 5) can preserve human
 * corrections instead of overwriting them. The word rows are intentionally left
 * alone: they still carry correct timings, and re-deriving them from free text
 * would be guesswork.
 */
export function updateUtteranceText(id: string, text: string): void {
  const result = getDb()
    .prepare('UPDATE utterances SET text = ?, edited = 1 WHERE id = ?')
    .run(text, id)

  // A stale id — most likely an editor open across a re-transcription, which
  // replaces every row — would otherwise silently discard the user's edit.
  if (result.changes === 0) {
    throw new Error(
      'That line no longer exists. The transcript was replaced; reload and try again.'
    )
  }
}

/**
 * Removes one utterance and its words (cascade).
 *
 * For diarization false positives — a cough or background noise that got
 * transcribed as a line — rather than a misattribution, which `speakers:reassign`
 * already covers.
 */
export function deleteUtterance(id: string): void {
  const result = getDb().prepare('DELETE FROM utterances WHERE id = ?').run(id)
  if (result.changes === 0) {
    throw new Error(
      'That line no longer exists. The transcript was replaced; reload and try again.'
    )
  }
}

/**
 * A speaker's utterance audio ranges, for building a voice-profile sample.
 *
 * Ranges from before `track_id` existed (or an import re-saved without it)
 * come back empty — there is no track to know which file to cut the sample
 * from.
 */
export function listUtteranceRangesForSpeaker(
  speakerId: string
): Array<{ trackId: string; startMs: number; endMs: number }> {
  const rows = getDb()
    .prepare(
      `SELECT track_id, start_ms, end_ms FROM utterances
        WHERE speaker_id = ? AND track_id IS NOT NULL
        ORDER BY start_ms`
    )
    .all(speakerId) as unknown as Array<{ track_id: string; start_ms: number; end_ms: number }>
  return rows.map((r) => ({ trackId: r.track_id, startMs: r.start_ms, endMs: r.end_ms }))
}

export function countUtterances(recordingId: string): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS c FROM utterances WHERE recording_id = ?')
    .get(recordingId) as unknown as { c: number }
  return row.c
}
