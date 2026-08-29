import type { VoiceProfile } from '@shared/types'
import { getDb } from './index'

/**
 * Voice profile rows.
 *
 * A profile's audio sample lives on disk (see `paths.voiceProfilePath`); this
 * table just tracks its metadata. Every profile is enrolled and matched
 * automatically — `last_matched_at` exists so the least useful one (the one
 * longest since it was actually recognised) is the one evicted when the cap
 * in services/profiles.ts is reached.
 */

interface VoiceProfileRow {
  id: string
  display_name: string
  sample_path: string
  sample_ms: number
  created_at: number
  last_matched_at: number
}

function toProfile(row: VoiceProfileRow): VoiceProfile {
  return {
    id: row.id,
    displayName: row.display_name,
    sampleMs: row.sample_ms,
    createdAt: row.created_at
  }
}

export function getProfile(id: string): VoiceProfile | null {
  const row = getDb().prepare('SELECT * FROM voice_profiles WHERE id = ?').get(id) as unknown as
    | VoiceProfileRow
    | undefined
  return row ? toProfile(row) : null
}

export function listProfiles(): VoiceProfile[] {
  const rows = getDb()
    .prepare('SELECT * FROM voice_profiles ORDER BY created_at')
    .all() as unknown as VoiceProfileRow[]
  return rows.map(toProfile)
}

/** Every profile, anchored into every diarization pass, with what jobs.ts needs beyond the public shape. */
export function listProfilesForMatching(): Array<VoiceProfile & { samplePath: string }> {
  const rows = getDb()
    .prepare('SELECT * FROM voice_profiles ORDER BY created_at')
    .all() as unknown as VoiceProfileRow[]
  return rows.map((r) => ({ ...toProfile(r), samplePath: r.sample_path }))
}

/**
 * The profile least recently recognised, or null when there's room to spare.
 * Ties (including every profile at `last_matched_at = 0`, never matched since
 * creation) fall back to the oldest by creation time.
 */
export function leastRecentlyMatchedProfileId(): string | null {
  const row = getDb()
    .prepare('SELECT id FROM voice_profiles ORDER BY last_matched_at ASC, created_at ASC LIMIT 1')
    .get() as unknown as { id: string } | undefined
  return row?.id ?? null
}

export function countProfiles(): number {
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM voice_profiles').get() as unknown as {
    n: number
  }
  return row.n
}

/** Inserts a profile row. `id` and `samplePath` are decided by the caller, which
 *  writes the sample file itself before this is called. */
export function insertProfile(input: {
  id: string
  displayName: string
  samplePath: string
  sampleMs: number
}): VoiceProfile {
  const now = Date.now()
  const profile: VoiceProfile = {
    id: input.id,
    displayName: input.displayName,
    sampleMs: input.sampleMs,
    createdAt: now
  }

  getDb()
    .prepare(
      `INSERT INTO voice_profiles (id, display_name, sample_path, sample_ms, created_at, last_matched_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(profile.id, profile.displayName, input.samplePath, input.sampleMs, now, now)

  return profile
}

/** Replaces a profile's sample in place, when a later recording offers a better one. */
export function updateProfileSample(id: string, input: { samplePath: string; sampleMs: number }): void {
  const result = getDb()
    .prepare('UPDATE voice_profiles SET sample_path = ?, sample_ms = ? WHERE id = ?')
    .run(input.samplePath, input.sampleMs, id)
  if (result.changes === 0) throw new Error('That voice profile no longer exists')
}

/** Marks a profile as recognised just now, keeping it safe from the next eviction. */
export function touchProfileMatched(id: string): void {
  getDb().prepare('UPDATE voice_profiles SET last_matched_at = ? WHERE id = ?').run(Date.now(), id)
}

/** The sample's file path, so the caller can delete it alongside the row. */
export function getProfileSamplePath(id: string): string | null {
  const row = getDb().prepare('SELECT sample_path FROM voice_profiles WHERE id = ?').get(id) as
    | { sample_path: string }
    | undefined
  return row?.sample_path ?? null
}

export function deleteProfile(id: string): void {
  const result = getDb().prepare('DELETE FROM voice_profiles WHERE id = ?').run(id)
  if (result.changes === 0) throw new Error('That voice profile no longer exists')
}

/** Every sample path, for the caller to delete before wiping the table. */
export function allProfileSamplePaths(): string[] {
  const rows = getDb().prepare('SELECT sample_path FROM voice_profiles').all() as unknown as Array<{
    sample_path: string
  }>
  return rows.map((r) => r.sample_path)
}

export function deleteAllProfiles(): void {
  getDb().prepare('DELETE FROM voice_profiles').run()
}
