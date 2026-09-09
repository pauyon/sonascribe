import { randomUUID } from 'node:crypto'
import type { Speaker } from '@shared/types'
import { pickSpeakerColor } from '@shared/colors'
import { getDb } from './index'

/**
 * Speaker rows.
 *
 * Identity lives in its own table keyed by the diarizer's cluster index, so
 * renaming "Speaker 2" to "Dana" is a single-row update rather than a rewrite
 * of every utterance — and the rename survives re-running detection.
 */

interface SpeakerRow {
  id: string
  recording_id: string
  cluster_id: number
  display_name: string
  color: string
}

function toSpeaker(row: SpeakerRow): Speaker {
  return {
    id: row.id,
    recordingId: row.recording_id,
    clusterId: row.cluster_id,
    displayName: row.display_name,
    color: row.color
  }
}

export function listSpeakers(recordingId: string): Speaker[] {
  const rows = getDb()
    .prepare('SELECT id, recording_id, cluster_id, display_name, color FROM speakers WHERE recording_id = ? ORDER BY cluster_id')
    .all(recordingId) as unknown as SpeakerRow[]
  return rows.map(toSpeaker)
}

/**
 * Returns the speaker for a cluster, creating it if this is the first time the
 * cluster has been seen this run.
 *
 * The UNIQUE (recording_id, cluster_id) constraint is what makes a re-run of
 * detection reuse the existing row — and therefore keep the user's chosen
 * name — as long as the diarizer keeps assigning the same cluster indices,
 * which it does for the same audio and settings.
 */
export function ensureSpeaker(recordingId: string, clusterId: number): Speaker {
  const db = getDb()
  const existing = db
    .prepare(
      'SELECT id, recording_id, cluster_id, display_name, color FROM speakers WHERE recording_id = ? AND cluster_id = ?'
    )
    .get(recordingId, clusterId) as unknown as SpeakerRow | undefined
  if (existing) return toSpeaker(existing)

  // Named by arrival, not by cluster index. Cluster indices are an internal
  // artefact — deriving the name from them shows the seams (e.g. jumping
  // straight to "Speaker 3"). Counting the rows already created gives 1, 2, 3.
  const named = db
    .prepare('SELECT COUNT(*) AS n FROM speakers WHERE recording_id = ?')
    .get(recordingId) as unknown as { n: number }

  const usedColors = (
    db.prepare('SELECT color FROM speakers WHERE recording_id = ?').all(recordingId) as unknown as Array<{
      color: string
    }>
  ).map((r) => r.color)

  const speaker: Speaker = {
    id: randomUUID(),
    recordingId,
    clusterId,
    displayName: `Speaker ${named.n + 1}`,
    color: pickSpeakerColor(usedColors)
  }

  db.prepare(
    `INSERT INTO speakers (id, recording_id, cluster_id, display_name, color)
     VALUES (?, ?, ?, ?, ?)`
  ).run(speaker.id, speaker.recordingId, speaker.clusterId, speaker.displayName, speaker.color)

  return speaker
}

/**
 * Sets a speaker's color, swapping it with whoever in the recording currently
 * has it.
 *
 * Swapping rather than just overwriting is what keeps every color in a
 * recording unique without the picker needing to grey out anything — pick any
 * color you like and the one who had it takes the color you're giving up.
 */
export function setSpeakerColor(recordingId: string, id: string, color: string): void {
  const db = getDb()
  db.exec('BEGIN')
  try {
    const target = db
      .prepare('SELECT color FROM speakers WHERE id = ? AND recording_id = ?')
      .get(id, recordingId) as unknown as { color: string } | undefined
    if (!target) throw new Error('That speaker no longer exists')

    const holder = db
      .prepare('SELECT id FROM speakers WHERE recording_id = ? AND color = ? AND id != ?')
      .get(recordingId, color, id) as unknown as { id: string } | undefined

    if (holder) {
      db.prepare('UPDATE speakers SET color = ? WHERE id = ?').run(target.color, holder.id)
    }
    db.prepare('UPDATE speakers SET color = ? WHERE id = ?').run(color, id)

    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

export function renameSpeaker(id: string, displayName: string): Speaker {
  const result = getDb().prepare('UPDATE speakers SET display_name = ? WHERE id = ?').run(displayName, id)
  if (Number(result.changes) === 0) throw new Error('That speaker no longer exists')

  const row = getDb()
    .prepare('SELECT id, recording_id, cluster_id, display_name, color FROM speakers WHERE id = ?')
    .get(id) as unknown as SpeakerRow | undefined
  if (!row) throw new Error('That speaker no longer exists')
  return toSpeaker(row)
}

/**
 * Folds one speaker into another.
 *
 * Diarization commonly splits a single person across two clusters when their
 * voice changes — moving closer to the microphone is enough. Merging is the
 * correction for that.
 */
export function mergeSpeakers(recordingId: string, fromId: string, intoId: string): void {
  if (fromId === intoId) throw new Error('Cannot merge a speaker into itself')

  const db = getDb()
  db.exec('BEGIN')
  try {
    const target = db.prepare('SELECT id FROM speakers WHERE id = ? AND recording_id = ?').get(intoId, recordingId)
    if (!target) throw new Error('Target speaker not found')

    db.prepare('UPDATE utterances SET speaker_id = ? WHERE speaker_id = ? AND recording_id = ?').run(
      intoId,
      fromId,
      recordingId
    )
    db.prepare('DELETE FROM speakers WHERE id = ? AND recording_id = ?').run(fromId, recordingId)

    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

/** Moves a single utterance to a different speaker. */
export function reassignUtterance(utteranceId: string, speakerId: string | null): void {
  const result = getDb().prepare('UPDATE utterances SET speaker_id = ? WHERE id = ?').run(speakerId, utteranceId)
  if (Number(result.changes) === 0) throw new Error('That line no longer exists')
}

/**
 * Removes one speaker and every line attributed to them.
 *
 * For a cluster that turns out to be entirely background noise or a
 * diarization artifact rather than a real person — reassigning individual
 * lines covers a misattribution, this covers "this was never a speaker".
 */
export function deleteSpeaker(id: string): void {
  const db = getDb()
  db.exec('BEGIN')
  try {
    db.prepare('DELETE FROM utterances WHERE speaker_id = ?').run(id)
    const result = db.prepare('DELETE FROM speakers WHERE id = ?').run(id)
    if (Number(result.changes) === 0) throw new Error('That speaker no longer exists')
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}
