import { randomUUID } from 'node:crypto'
import type { TranscriptSegment } from '../services/transcription'
import type { MergedUtterance } from '../services/merge'
import type { TranscriptWord, Utterance } from '@shared/types'
import { getDb } from './index'

/**
 * Repository for `utterances`/`words` — a recording's transcript.
 *
 * `track_id` on `utterances` is left NULL: this app has no separate mic/
 * system tracks, a recording is always one mixed file. `speaker_id` is set
 * once speaker detection has run (see `saveSpeakerMergedTranscript`) — NULL
 * until then, same as before detection existed.
 */

interface UtteranceRow {
  id: string
  recording_id: string
  start_ms: number
  end_ms: number
  text: string
  confidence: number | null
  speaker_id: string | null
  speaker_name: string | null
  speaker_color: string | null
}

interface WordRow {
  utterance_id: string
  start_ms: number
  end_ms: number
  text: string
  probability: number | null
}

const UTTERANCE_SELECT = `
  SELECT u.id, u.recording_id, u.start_ms, u.end_ms, u.text, u.confidence,
         u.speaker_id, s.display_name AS speaker_name, s.color AS speaker_color
  FROM utterances u
  LEFT JOIN speakers s ON s.id = u.speaker_id
  WHERE u.recording_id = ?
  ORDER BY u.start_ms
`

export function getUtterances(recordingId: string): Utterance[] {
  const db = getDb()
  const utteranceRows = db.prepare(UTTERANCE_SELECT).all(recordingId) as unknown as UtteranceRow[]
  if (utteranceRows.length === 0) return []

  const wordRows = db
    .prepare(
      `SELECT w.utterance_id, w.start_ms, w.end_ms, w.text, w.probability
       FROM words w
       JOIN utterances u ON u.id = w.utterance_id
       WHERE u.recording_id = ?
       ORDER BY w.start_ms`
    )
    .all(recordingId) as unknown as WordRow[]

  const wordsByUtterance = new Map<string, TranscriptWord[]>()
  for (const row of wordRows) {
    const list = wordsByUtterance.get(row.utterance_id) ?? []
    list.push({ text: row.text, startMs: row.start_ms, endMs: row.end_ms, probability: row.probability ?? 1 })
    wordsByUtterance.set(row.utterance_id, list)
  }

  return utteranceRows.map((row) => ({
    id: row.id,
    recordingId: row.recording_id,
    startMs: row.start_ms,
    endMs: row.end_ms,
    text: row.text,
    confidence: row.confidence,
    words: wordsByUtterance.get(row.id) ?? [],
    speaker: row.speaker_id
      ? { id: row.speaker_id, name: row.speaker_name ?? '', color: row.speaker_color ?? '#667085' }
      : null
  }))
}

/**
 * Every word in a recording's transcript, flat and time-ordered — what
 * speaker detection re-segments from. Utterances themselves are already
 * ordered by `start_ms` and each utterance's own words are chronological, so
 * a plain join in word order is enough; no separate sort is needed.
 */
export function getAllWords(recordingId: string): TranscriptWord[] {
  const rows = getDb()
    .prepare(
      `SELECT w.start_ms, w.end_ms, w.text, w.probability
       FROM words w
       JOIN utterances u ON u.id = w.utterance_id
       WHERE u.recording_id = ?
       ORDER BY w.start_ms`
    )
    .all(recordingId) as unknown as Array<{ start_ms: number; end_ms: number; text: string; probability: number | null }>
  return rows.map((row) => ({
    startMs: row.start_ms,
    endMs: row.end_ms,
    text: row.text,
    probability: row.probability ?? 1
  }))
}

/**
 * Hand-corrects one utterance's text. Its words are cleared rather than left
 * in place: they're per-word ASR timings for the *old* wording, so keeping
 * them would highlight the wrong word as playback passes through the line —
 * `getUtterances`'s existing words.length fallback then renders the edited
 * text as a plain paragraph, same as a line that never had word data. Marked
 * `edited` so a later pass can tell this line's text came from a person, not
 * the ASR — part of the schema from before this app was stripped down,
 * unused until now.
 */
export function updateUtteranceText(utteranceId: string, text: string): void {
  const db = getDb()
  db.exec('BEGIN')
  try {
    db.prepare('DELETE FROM words WHERE utterance_id = ?').run(utteranceId)
    db.prepare('UPDATE utterances SET text = ?, edited = 1 WHERE id = ?').run(text, utteranceId)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

/**
 * Splits one utterance into two at a word boundary — for the diarizer
 * running two people's sentences together into one line rather than a
 * misattribution (which reassigning the whole line already covers). Unlike
 * `updateUtteranceText`, both halves keep their real per-word ASR timing:
 * the boundary is a word index, not a hand-typed guess, so there's nothing
 * to invalidate. The first half keeps the original row (and id — nothing
 * else needs to know it split); the second half is a new row starting at
 * `wordIndex`, initially crediting the same speaker as the original since a
 * clash is usually exactly two different speakers — reassigning it is a
 * separate, already-existing action once the split lands.
 */
export function splitUtterance(utteranceId: string, wordIndex: number): void {
  const db = getDb()
  db.exec('BEGIN')
  try {
    const utterance = db
      .prepare('SELECT recording_id, speaker_id, confidence FROM utterances WHERE id = ?')
      .get(utteranceId) as unknown as { recording_id: string; speaker_id: string | null; confidence: number | null } | undefined
    if (!utterance) throw new Error('That line no longer exists')

    const words = db
      .prepare('SELECT id, start_ms, end_ms, text FROM words WHERE utterance_id = ? ORDER BY start_ms')
      .all(utteranceId) as unknown as Array<{ id: string; start_ms: number; end_ms: number; text: string }>
    if (wordIndex <= 0 || wordIndex >= words.length) throw new Error('Nothing to split at that point')

    const firstWords = words.slice(0, wordIndex)
    const secondWords = words.slice(wordIndex)

    db.prepare('UPDATE utterances SET end_ms = ?, text = ? WHERE id = ?').run(
      firstWords[firstWords.length - 1].end_ms,
      firstWords.map((w) => w.text).join(' '),
      utteranceId
    )

    const secondId = randomUUID()
    db.prepare(
      `INSERT INTO utterances (id, recording_id, speaker_id, start_ms, end_ms, text, confidence)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      secondId,
      utterance.recording_id,
      utterance.speaker_id,
      secondWords[0].start_ms,
      secondWords[secondWords.length - 1].end_ms,
      secondWords.map((w) => w.text).join(' '),
      utterance.confidence
    )

    const reassignWord = db.prepare('UPDATE words SET utterance_id = ? WHERE id = ?')
    for (const word of secondWords) reassignWord.run(secondId, word.id)

    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

/**
 * Replaces a recording's whole transcript. Utterance ids aren't stable
 * across a re-transcription (there is nothing meaningful to preserve them
 * for yet — no edits, no per-utterance metadata), so this always clears and
 * re-inserts rather than diffing. Also clears any existing speaker
 * attribution: a fresh transcription means entirely new utterance rows, so
 * whatever speaker detection previously assigned no longer has anything
 * meaningful to point at — the caller (`services/jobs.ts`) resets
 * `speaker_status` to `'none'` alongside this.
 */
export function saveTranscript(recordingId: string, segments: TranscriptSegment[]): void {
  const db = getDb()
  const deleteUtterances = db.prepare('DELETE FROM utterances WHERE recording_id = ?')
  const deleteSpeakers = db.prepare('DELETE FROM speakers WHERE recording_id = ?')
  const insertUtterance = db.prepare(
    `INSERT INTO utterances (id, recording_id, start_ms, end_ms, text, confidence)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
  const insertWord = db.prepare(
    `INSERT INTO words (id, utterance_id, start_ms, end_ms, text, probability)
     VALUES (?, ?, ?, ?, ?, ?)`
  )

  // One transaction so a re-transcription is never observed half-swapped —
  // the old rows gone but the new ones not fully written yet.
  db.exec('BEGIN')
  try {
    deleteUtterances.run(recordingId)
    deleteSpeakers.run(recordingId)
    for (const seg of segments) {
      const utteranceId = randomUUID()
      insertUtterance.run(utteranceId, recordingId, seg.startMs, seg.endMs, seg.text, seg.confidence)
      for (const word of seg.words) {
        insertWord.run(randomUUID(), utteranceId, word.startMs, word.endMs, word.text, word.probability)
      }
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

/**
 * Replaces a recording's utterances with speaker-attributed ones — the
 * result of speaker detection. Utterance boundaries change (a speaker
 * change now starts a new utterance, not just a pause), so this replaces
 * the rows the same way `saveTranscript` does, rather than merely setting
 * `speaker_id` on the ones already there.
 */
export function saveSpeakerMergedTranscript(
  recordingId: string,
  utterances: MergedUtterance[],
  speakerIdByCluster: Map<number, string>
): void {
  const db = getDb()
  const deleteUtterances = db.prepare('DELETE FROM utterances WHERE recording_id = ?')
  const insertUtterance = db.prepare(
    `INSERT INTO utterances (id, recording_id, start_ms, end_ms, text, confidence, speaker_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
  const insertWord = db.prepare(
    `INSERT INTO words (id, utterance_id, start_ms, end_ms, text, probability)
     VALUES (?, ?, ?, ?, ?, ?)`
  )

  db.exec('BEGIN')
  try {
    deleteUtterances.run(recordingId)
    for (const u of utterances) {
      const utteranceId = randomUUID()
      const speakerId = u.speaker == null ? null : (speakerIdByCluster.get(u.speaker) ?? null)
      insertUtterance.run(utteranceId, recordingId, u.startMs, u.endMs, u.text, u.confidence, speakerId)
      for (const word of u.words) {
        insertWord.run(randomUUID(), utteranceId, word.startMs, word.endMs, word.text, word.probability)
      }
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}
