import { randomUUID } from 'node:crypto'
import type { Speaker } from '@shared/types'
import { pickSpeakerColor } from '@shared/colors'
import { getDb } from './index'
import { getLocalSpeakerColor, setLocalSpeakerColor } from './settings'
import { setProfileColor } from './profiles'

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
  profile_id: string | null
}

function toSpeaker(row: SpeakerRow): Speaker {
  return {
    id: row.id,
    recordingId: row.recording_id,
    clusterId: row.cluster_id,
    displayName: row.display_name,
    color: row.color,
    profileId: row.profile_id
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
 *
 * `profile` is passed when a voice profile's anchor matched this cluster. An
 * existing row just gets the link — its name is left alone, since it may
 * already carry a rename the user made by hand. A new row is named after the
 * profile outright rather than "Speaker N", and coloured to match it too if
 * that color is free in this recording.
 */
export function ensureSpeaker(
  recordingId: string,
  clusterId: number,
  profile?: { id: string; displayName: string; color?: string | null } | null
): Speaker {
  const existing = getDb()
    .prepare('SELECT * FROM speakers WHERE recording_id = ? AND cluster_id = ?')
    .get(recordingId, clusterId) as unknown as SpeakerRow | undefined

  if (existing) {
    if (profile && existing.profile_id !== profile.id) {
      getDb().prepare('UPDATE speakers SET profile_id = ? WHERE id = ?').run(profile.id, existing.id)
      existing.profile_id = profile.id
    }
    return toSpeaker(existing)
  }

  // Named by arrival, not by cluster index.
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

  // Coloured against every speaker already in this recording — including
  // "You" — rather than by position, so two speakers can never start out
  // sharing a color no matter which order they were discovered in.
  const usedColors = (
    getDb().prepare('SELECT color FROM speakers WHERE recording_id = ?').all(recordingId) as unknown as Array<{
      color: string
    }>
  ).map((r) => r.color)

  // A recurring voice (or "You") keeps its remembered color when it's free
  // this time; otherwise it falls back to picking a fresh one exactly as if
  // it had never had a preference, rather than fighting over it.
  const preferredColor = profile ? profile.color : clusterId < 0 ? getLocalSpeakerColor() : null
  const color =
    preferredColor && !usedColors.includes(preferredColor) ? preferredColor : pickSpeakerColor(usedColors)

  const speaker: Speaker = {
    id: randomUUID(),
    recordingId,
    clusterId,
    displayName: profile ? profile.displayName : clusterId < 0 ? 'You' : `Speaker ${position + 1}`,
    color,
    profileId: profile?.id ?? null
  }

  getDb()
    .prepare(
      `INSERT INTO speakers (id, recording_id, cluster_id, display_name, color, profile_id)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      speaker.id,
      speaker.recordingId,
      speaker.clusterId,
      speaker.displayName,
      speaker.color,
      speaker.profileId
    )

  // Whatever color it ended up with — reused or freshly picked — becomes the
  // preference for next time. A collision-driven fallback today is a better
  // guess for tomorrow than a stale preference that lost to it once.
  rememberColorPreference(clusterId, profile?.id ?? null, speaker.color)

  return speaker
}

/**
 * Sets a speaker's color, swapping it with whoever in the recording currently
 * has it.
 *
 * Swapping rather than just overwriting is what keeps every color in a
 * recording unique without the picker needing to grey out anything — pick any
 * color you like and the one who had it takes the color you're giving up.
 *
 * Either side of the swap that's "You" or linked to a voice profile has this
 * remembered as its new preferred color too, the same as a fresh pick during
 * diarization would be — a manual choice is exactly the kind of signal that
 * preference exists to capture.
 */
export function setSpeakerColor(recordingId: string, id: string, color: string): void {
  const db = getDb()
  db.exec('BEGIN')
  try {
    const target = db
      .prepare('SELECT color, cluster_id, profile_id FROM speakers WHERE id = ? AND recording_id = ?')
      .get(id, recordingId) as unknown as
      | { color: string; cluster_id: number; profile_id: string | null }
      | undefined
    if (!target) throw new Error('That speaker no longer exists')

    const holder = db
      .prepare(
        'SELECT id, cluster_id, profile_id FROM speakers WHERE recording_id = ? AND color = ? AND id != ?'
      )
      .get(recordingId, color, id) as unknown as
      | { id: string; cluster_id: number; profile_id: string | null }
      | undefined

    if (holder) {
      db.prepare('UPDATE speakers SET color = ? WHERE id = ?').run(target.color, holder.id)
      rememberColorPreference(holder.cluster_id, holder.profile_id, target.color)
    }
    db.prepare('UPDATE speakers SET color = ? WHERE id = ?').run(color, id)
    rememberColorPreference(target.cluster_id, target.profile_id, color)

    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

function rememberColorPreference(clusterId: number, profileId: string | null, color: string): void {
  if (clusterId < 0) setLocalSpeakerColor(color)
  else if (profileId) setProfileColor(profileId, color)
}

/** Links a speaker to a voice profile, after automatic enrollment or a match. */
export function linkSpeakerToProfile(speakerId: string, profileId: string): void {
  const result = getDb()
    .prepare('UPDATE speakers SET profile_id = ? WHERE id = ?')
    .run(profileId, speakerId)
  if (result.changes === 0) throw new Error('That speaker no longer exists')
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
    if (result.changes === 0) throw new Error('That speaker no longer exists')
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}
