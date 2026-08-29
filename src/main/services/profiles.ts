import { randomUUID } from 'node:crypto'
import { rename, rm } from 'node:fs/promises'
import {
  allProfileSamplePaths,
  countProfiles,
  deleteAllProfiles as deleteAllProfileRows,
  deleteProfile as deleteProfileRow,
  getProfile,
  getProfileSamplePath,
  insertProfile,
  leastRecentlyMatchedProfileId,
  touchProfileMatched,
  updateProfileSample
} from '../db/profiles'
import { linkSpeakerToProfile, listSpeakers } from '../db/speakers'
import { listUtteranceRangesForSpeaker } from '../db/transcript'
import { listTracks } from '../db/tracks'
import { voiceProfilePath } from '../paths'
import type { SpeakerSegment } from './diarize'
import { extractSegmentsToWav } from './ffmpeg'
import { overlap } from './merge'

/**
 * Enrollment and refresh happen automatically at the end of every
 * transcription job (see `runAutoEnrollment`, called from jobs.ts) — there is
 * no user-facing "save this voice" action. The goal is purely to stop a
 * recurring voice fragmenting into a new invented speaker each time; who they
 * are is not the point, so failures here are always swallowed by the caller
 * rather than surfaced.
 */

/** Below this, a sample is too thin to anchor reliably — worse than no profile at all. */
const MIN_SAMPLE_MS = 5_000
/**
 * Above this there are diminishing returns. Kept short on purpose: every
 * profile's sample is prepended to every future diarization pass, so its
 * length is a cost paid on every recording forever, not just this one.
 */
const TARGET_SAMPLE_MS = 10_000
/**
 * A later recording only replaces an existing anchor when it offers
 * meaningfully more audio — otherwise a profile would get rewritten by
 * essentially the same sample on every matching recording, for no benefit.
 */
const REFRESH_MARGIN = 1.3

/**
 * Hard ceiling on how many voices are remembered at once.
 *
 * Each one costs its sample length on every future diarization pass (see
 * TARGET_SAMPLE_MS above), so an unbounded set would make every recording
 * slower forever as one-off callers and rare guests pile up alongside the
 * people actually worth recognising. Past the cap, the least recently
 * recognised profile is evicted to make room — a regular contact keeps
 * getting matched and stays; a stranger heard once ages out on their own.
 */
const MAX_PROFILES = 10

interface SampleCandidate {
  trackWavPath: string
  ranges: Array<{ startMs: number; endMs: number }>
  totalMs: number
}

/**
 * Picks the best available audio for a speaker's anchor, or null if there
 * isn't enough yet.
 *
 * All of it comes from a single track: mixing mic and system-audio samples of
 * the same person would blur the anchor with two different capture
 * characteristics (gain, room tone) that a real recording of them won't share
 * consistently.
 */
function buildSampleCandidate(recordingId: string, speakerId: string): SampleCandidate | null {
  const ranges = listUtteranceRangesForSpeaker(speakerId)
  if (ranges.length === 0) return null

  const byTrack = new Map<string, { totalMs: number; ranges: typeof ranges }>()
  for (const range of ranges) {
    const entry = byTrack.get(range.trackId) ?? { totalMs: 0, ranges: [] }
    entry.totalMs += range.endMs - range.startMs
    entry.ranges.push(range)
    byTrack.set(range.trackId, entry)
  }
  const [trackId, { ranges: trackRanges }] = [...byTrack.entries()].sort(
    (a, b) => b[1].totalMs - a[1].totalMs
  )[0]

  const track = listTracks(recordingId).find((t) => t.id === trackId)
  if (!track) return null

  // Longest lines first — a few clean, complete lines make a better anchor
  // than many short fragments stitched together.
  const longestFirst = [...trackRanges].sort((a, b) => b.endMs - b.startMs - (a.endMs - a.startMs))
  const picked: typeof longestFirst = []
  let totalMs = 0
  for (const range of longestFirst) {
    if (totalMs >= TARGET_SAMPLE_MS) break
    picked.push(range)
    totalMs += range.endMs - range.startMs
  }
  if (totalMs < MIN_SAMPLE_MS) return null

  // Chronological order for the extracted sample; pick order above was by length.
  picked.sort((a, b) => a.startMs - b.startMs)
  return { trackWavPath: track.wavPath, ranges: picked, totalMs }
}

/** Creates a new profile from a speaker who isn't linked to one yet, evicting to stay under the cap. */
async function enrollSpeaker(
  recordingId: string,
  speakerId: string,
  displayName: string,
  color: string
): Promise<void> {
  const candidate = buildSampleCandidate(recordingId, speakerId)
  if (!candidate) return

  if (countProfiles() >= MAX_PROFILES) {
    const evictId = leastRecentlyMatchedProfileId()
    if (evictId) await deleteProfile(evictId)
  }

  const id = randomUUID()
  const samplePath = voiceProfilePath(id)
  await extractSegmentsToWav({
    inputPath: candidate.trackWavPath,
    segments: candidate.ranges,
    outputPath: samplePath
  })

  const profile = insertProfile({ id, displayName, samplePath, sampleMs: candidate.totalMs, color })
  linkSpeakerToProfile(speakerId, profile.id)
}

/**
 * Marks a matched profile as recognised, and replaces its sample when this
 * recording offers a meaningfully better one — the anchor improves over time
 * instead of being stuck with whatever audio happened to exist the first time.
 */
async function refreshProfileIfBetter(
  recordingId: string,
  speakerId: string,
  profileId: string
): Promise<void> {
  touchProfileMatched(profileId)

  const profile = getProfile(profileId)
  const candidate = buildSampleCandidate(recordingId, speakerId)
  if (!profile || !candidate || candidate.totalMs <= profile.sampleMs * REFRESH_MARGIN) return

  // Extracted beside the live sample and swapped in by rename rather than
  // written over it directly — ffmpeg can't read and write the same file
  // anyway, and this is also what protects the existing, working anchor if
  // the app dies or the disk fills up mid-extraction: a failure here leaves
  // the temp file orphaned instead of leaving every future recording's
  // diarization pass reading a truncated one.
  const samplePath = voiceProfilePath(profileId)
  const tempPath = `${samplePath}.tmp.wav`
  try {
    await extractSegmentsToWav({
      inputPath: candidate.trackWavPath,
      segments: candidate.ranges,
      outputPath: tempPath
    })
  } catch (err) {
    await rm(tempPath, { force: true })
    throw err
  }
  await rename(tempPath, samplePath)
  updateProfileSample(profileId, { samplePath, sampleMs: candidate.totalMs })
}

/** Who a profile's anchor turned out to belong to, once diarized. */
export interface ProfileMatch {
  id: string
  displayName: string
  color: string | null
}

/**
 * Matches diarized clusters against the anchored voice-profile windows that
 * were prepended ahead of the real audio.
 *
 * Whichever cluster covers the most of an anchor's window is that person. An
 * anchor that ties with another for the same cluster, or overlaps nothing, is
 * left unmatched rather than guessed — a wrong identity is worse than none.
 */
export function matchProfilesToClusters(
  profiles: Array<{ id: string; displayName: string; sampleMs: number; color: string | null }>,
  /** Each profile's anchor start time in the diarized audio, same order as `profiles`. */
  offsets: number[],
  segments: SpeakerSegment[]
): Map<number, ProfileMatch> {
  const claims = new Map<number, string[]>()
  const claimedBy = new Map<string, number>()

  for (const [i, profile] of profiles.entries()) {
    const windowStart = offsets[i]
    const windowEnd = windowStart + profile.sampleMs
    let best: number | null = null
    let bestOverlap = 0
    for (const segment of segments) {
      const amount = overlap(segment.startMs, segment.endMs, windowStart, windowEnd)
      if (amount > bestOverlap) {
        bestOverlap = amount
        best = segment.speaker
      }
    }
    if (best == null) continue
    claims.set(best, [...(claims.get(best) ?? []), profile.id])
    claimedBy.set(profile.id, best)
  }

  const matched = new Map<number, ProfileMatch>()
  for (const [profileId, cluster] of claimedBy) {
    if ((claims.get(cluster)?.length ?? 0) > 1) continue
    const profile = profiles.find((p) => p.id === profileId)
    if (profile) matched.set(cluster, { id: profile.id, displayName: profile.displayName, color: profile.color })
  }
  return matched
}

/**
 * Runs after a recording finishes transcribing: enrolls any new voice that
 * had enough clean audio, and refreshes anchors that were matched this time.
 *
 * Best-effort throughout — a speaker with too little audio, or an extraction
 * that fails, is simply skipped rather than failing the job. This is
 * background bookkeeping the user never asked for directly.
 */
export async function runAutoEnrollment(recordingId: string): Promise<void> {
  for (const speaker of listSpeakers(recordingId)) {
    // Cluster -1 is the local user, assigned outright rather than diarized —
    // there is nothing here worth anchoring.
    if (speaker.clusterId < 0) continue

    try {
      if (speaker.profileId) {
        await refreshProfileIfBetter(recordingId, speaker.id, speaker.profileId)
      } else {
        await enrollSpeaker(recordingId, speaker.id, speaker.displayName, speaker.color)
      }
    } catch (err) {
      console.warn(`[profiles] enrollment skipped for speaker ${speaker.id}:`, err)
    }
  }
}

async function deleteProfile(id: string): Promise<void> {
  const samplePath = getProfileSamplePath(id)
  deleteProfileRow(id)
  if (samplePath) await rm(samplePath, { force: true })
}

/** Forgets every remembered voice — the one manual control this feature has. */
export async function clearAllProfiles(): Promise<void> {
  const paths = allProfileSamplePaths()
  deleteAllProfileRows()
  await Promise.all(paths.map((p) => rm(p, { force: true })))
}
