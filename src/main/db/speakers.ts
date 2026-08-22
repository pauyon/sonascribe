import { randomUUID } from 'node:crypto'
import type { Speaker } from '@shared/types'
import { speakerColor } from '../services/merge'
import { getDb } from './index'

/**
 * Speaker rows.
 *
 * Identity lives in its own table keyed by the diarizer's cluster index, so
 * renaming "Speaker 2" to "Dana" is a single-row update rather than a rewrite
 * of every utterance — and the rename survives re-running the merge.
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
    .prepare('SELECT * FROM speakers WHERE recording_id = ? ORDER BY cluster_id')
    .all(recordingId) as unknown as SpeakerRow[]
  return rows.map(toSpeaker)
}

/**
 * Returns the speaker for a cluster, creating it if this is the first time the
 * cluster has been seen.
 *
 * The UNIQUE (recording_id, cluster_id) constraint is what makes a re-merge
 * reuse the existing row — and therefore keep the user's chosen name.
 */
export function ensureSpeaker(recordingId: string, clusterId: number): Speaker {
  const existing = getDb()
    .prepare('SELECT * FROM speakers WHERE recording_id = ? AND cluster_id = ?')
    .get(recordingId, clusterId) as unknown as SpeakerRow | undefined

  if (existing) return toSpeaker(existing)

  // Named and coloured by arrival, not by cluster index.
  //
  // Cluster indices are an internal artefact: they start wherever the diarizer
  // happened to start, and tracks are offset past one another so they cannot
  // collide. Deriving the name from them shows the seams — a two-person
  // recording announcing "Speaker 2" and "Speaker 3" reads as though a third
  // person is missing. Counting the rows already created gives 1, 2, 3.
  const named = getDb()
    .prepare('SELECT COUNT(*) AS n FROM speakers WHERE recording_id = ? AND cluster_id >= 0')
    .get(recordingId) as unknown as { n: number }
  const position = named.n

  const speaker: Speaker = {
    id: randomUUID(),
    recordingId,
    clusterId,
    displayName: clusterId < 0 ? 'You' : `Speaker ${position + 1}`,
    color: speakerColor(clusterId < 0 ? 0 : position)
  }

  getDb()
    .prepare(
      `INSERT INTO speakers (id, recording_id, cluster_id, display_name, color)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      speaker.id,
      speaker.recordingId,
      speaker.clusterId,
      speaker.displayName,
      speaker.color
    )

  return speaker
}

export function renameSpeaker(id: string, displayName: string): Speaker {
  const result = getDb()
    .prepare('UPDATE speakers SET display_name = ? WHERE id = ?')
    .run(displayName, id)
  if (result.changes === 0) throw new Error('That speaker no longer exists')

  const row = getDb().prepare('SELECT * FROM speakers WHERE id = ?').get(id) as unknown as
    | SpeakerRow
    | undefined
  if (!row) throw new Error('That speaker no longer exists')
  return toSpeaker(row)
}

/**
 * Folds one speaker into another.
 *
 * Diarization commonly splits a single person across two clusters when their
 * voice changes — moving closer to the microphone is enough. Merging is the
 * correction for that, and it is why the editor needs it at all.
 */
export function mergeSpeakers(recordingId: string, fromId: string, intoId: string): void {
  if (fromId === intoId) throw new Error('Cannot merge a speaker into itself')

  const db = getDb()
  db.exec('BEGIN')
  try {
    const target = db
      .prepare('SELECT id FROM speakers WHERE id = ? AND recording_id = ?')
      .get(intoId, recordingId)
    if (!target) throw new Error('Target speaker not found')

    db.prepare(
      'UPDATE utterances SET speaker_id = ? WHERE speaker_id = ? AND recording_id = ?'
    ).run(intoId, fromId, recordingId)

    db.prepare('DELETE FROM speakers WHERE id = ? AND recording_id = ?').run(
      fromId,
      recordingId
    )

    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

/** Moves a single utterance to a different speaker. */
export function reassignUtterance(utteranceId: string, speakerId: string | null): void {
  const result = getDb()
    .prepare('UPDATE utterances SET speaker_id = ? WHERE id = ?')
    .run(speakerId, utteranceId)
  if (result.changes === 0) throw new Error('That line no longer exists')
}

/** Clears every speaker for a recording. Used before re-diarizing. */
export function deleteSpeakers(recordingId: string): void {
  getDb().prepare('DELETE FROM speakers WHERE recording_id = ?').run(recordingId)
}
