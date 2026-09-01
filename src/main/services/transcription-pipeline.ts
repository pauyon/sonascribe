import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import type { Track, TrackKind } from '@shared/types'
import type { AsrEngine } from '@shared/models'
import { listProfilesForMatching } from '../db/profiles'
import { recordingMediaPath } from '../paths'
import { transcribeWithWhisper } from './whisper'
import { transcribeWithParakeet } from './parakeet'
import { groupWordsIntoSegments, type TranscriptSegment } from './transcription'
import { diarize, minDurationOnFor, type SpeakerSegment } from './diarize'
import { concatToWav } from './ffmpeg'
import { LOCAL_SPEAKER, mergeTranscriptWithSpeakers, type MergedUtterance } from './merge'
import { measurePeak, SILENCE_PEAK_THRESHOLD } from './peaks'
import { takeLiveWords } from './live-transcribe'
import { matchProfilesToClusters, type ProfileMatch } from './profiles'

/**
 * Turns a recording's tracks into speaker-attributed utterances.
 *
 * This is the ASR + diarization + anchor-matching pipeline, pulled out of
 * jobs.ts on purpose: jobs.ts owns the queue, status transitions and
 * persistence, and none of that needs to know how a transcript is actually
 * produced. Everything below is pure with respect to the job system — it
 * reports progress through the callbacks it's given rather than touching the
 * recording row itself.
 */

/** Transcribe the microphone first — it needs no diarization, so visible rows land sooner on a long recording. */
function trackOrder(kind: TrackKind): number {
  return kind === 'mic' ? 0 : kind === 'system' ? 1 : 2
}

/**
 * Picks out one track's slice of a joint diarization pass and rebases it to
 * track-local time.
 *
 * A segment overlapping this window at all is clamped to it rather than
 * dropped whenever it runs past either edge — including the very common case
 * of the last real segment in the whole file, which the segmentation model
 * routinely rounds a few tens of milliseconds past the file's true end (its
 * own frame quantization, not the model bridging into content that doesn't
 * exist). Dropping the whole segment for that used to throw away everything
 * from the boundary crossing on, taking a real speaker's entire tail — in one
 * observed case, all 36 seconds of a person's only remaining segment,
 * because it ended 20ms past the window. The 2-second silence gap between
 * parts (see concatToWav below) is what actually protects against a segment
 * genuinely bleeding into a neighbour's content; clamping a boundary overrun
 * of a few tens of milliseconds can't reach across that.
 */
function segmentsForPart(
  segments: SpeakerSegment[],
  windowStart: number,
  windowDurationMs: number
): SpeakerSegment[] {
  const windowEnd = windowStart + windowDurationMs
  const result: SpeakerSegment[] = []
  for (const segment of segments) {
    const startMs = Math.max(segment.startMs, windowStart)
    const endMs = Math.min(segment.endMs, windowEnd)
    if (endMs <= startMs) continue
    result.push({ ...segment, startMs: startMs - windowStart, endMs: endMs - windowStart })
  }
  return result
}

/** Routes a transcription to whichever engine the chosen model belongs to. Both return the same shape. */
function runAsr(
  engine: AsrEngine,
  options: Parameters<typeof transcribeWithWhisper>[0]
): ReturnType<typeof transcribeWithWhisper> {
  return engine === 'parakeet' ? transcribeWithParakeet(options) : transcribeWithWhisper(options)
}

export interface TranscriptionPipelineOptions {
  recordingId: string
  tracks: Track[]
  engine: AsrEngine
  modelPath: string
  language: string
  diarizationEnabled: boolean
  micIsSolo: boolean
  /** Upper bound on speaker count, or null to cluster automatically. Describes the whole recording, not one track. */
  numSpeakers: number | null
  splitting: { threshold: number; minDurationOn: number }
  signal: AbortSignal
  /** Same semantics as jobs.ts's own status-transition helper — called only for stages this pipeline owns. */
  setStage: (stage: 'transcribing' | 'diarizing') => void
  /** Same semantics as jobs.ts's own progress helper. */
  progress: (stage: 'transcribing' | 'diarizing', fraction: number | null) => void
}

export interface TranscriptionPipelineResult {
  utterances: MergedUtterance[]
  resolvedLanguage: string | null
  /** Tracks that were silent — ordinary, not an error. */
  emptyTracks: TrackKind[]
  /** Tracks that carried signal but the engine returned nothing for — a fault, not silence. */
  failedTracks: TrackKind[]
  /** Cluster index -> the voice profile whose anchor claimed it. */
  matchedProfiles: Map<number, ProfileMatch>
  /**
   * The headcount actually applied to clustering, adjusted for a solo mic —
   * or null if none was asserted. Returned so the caller can tell an asserted
   * count from a guess when deciding whether to run the absorption pass.
   */
  forcedCount: number | null
}

export async function runTranscriptionPipeline(
  options: TranscriptionPipelineOptions
): Promise<TranscriptionPipelineResult> {
  const {
    recordingId,
    tracks,
    engine,
    modelPath,
    language,
    diarizationEnabled,
    micIsSolo,
    numSpeakers,
    splitting,
    signal,
    setStage,
    progress
  } = options

  // A recorded session has separate 'mic' and 'system' tracks; an import has
  // one 'mixed' track. Transcribe each, then interleave by time.
  const ordered = [...tracks].sort((a, b) => trackOrder(a.kind) - trackOrder(b.kind))
  const merged: MergedUtterance[] = []
  let resolvedLanguage: string | null = null
  const emptyTracks: TrackKind[] = []
  const failedTracks: TrackKind[] = []

  // Stage 1: transcribe every track first. Diarization runs afterwards, once,
  // over whichever tracks actually came back with speech — so a track that
  // turns out to be empty never claims a share of the clustering budget below.
  const transcribed: Array<{ track: (typeof ordered)[number]; segments: TranscriptSegment[] }> = []

  const share = 1 / ordered.length
  setStage('transcribing')

  // Tracks are independent files, so there's no reason for the system track's
  // ASR to wait on the mic's (or vice versa) — that used to make a two-track
  // call take roughly twice as long as the audio needed. `ordered` still puts
  // the mic first so it keeps the first slice of the progress bar and wins the
  // language-resolution tie below, but the actual work now runs concurrently.
  const results = await Promise.all(
    ordered.map(async (track, index) => {
      // A recording transcribed as it was captured has nothing left to do here.
      // The words were produced by this same engine on windows cut at silences,
      // so they are not a preview to be redone — running the whole file again
      // would spend twenty minutes reproducing them.
      const live = takeLiveWords(recordingId, track.kind, track.durationMs ?? 0)
      const result = live
        ? { language: null, segments: groupWordsIntoSegments(live) }
        : await runAsr(engine, {
            wavPath: track.wavPath,
            modelPath,
            language,
            onProgress: (fraction) =>
              progress(
                'transcribing',
                // Parakeet reports no progress; keep the bar indeterminate rather
                // than inventing a number.
                fraction == null ? null : index * share + fraction * share
              ),
            signal
          })

      if (live) {
        console.log(`[jobs] using ${live.length} words transcribed live for the ${track.kind} track`)
        progress('transcribing', (index + 1) / ordered.length)
      }

      return { track, result }
    })
  )
  if (signal.aborted) return emptyResult()

  for (const { track, result } of results) {
    resolvedLanguage ??= result.language ?? (language === 'auto' ? null : language)

    // A track with no speech is ordinary, not fatal: system audio with
    // nothing playing is silent, and failing the whole job would throw away a
    // perfectly good microphone transcript alongside it.
    //
    // But an empty result means one of two very different things, and the
    // engine reports both the same way. Either the audio really is silent, or
    // the engine produced nothing for audio that plainly is not — which is a
    // failure wearing the costume of an empty room. The peak settles it, and
    // it is already the test used to discard silent captures.
    if (result.segments.length === 0) {
      const peak = await measurePeak(track.wavPath)
      if (peak >= SILENCE_PEAK_THRESHOLD) {
        console.warn(
          `[jobs] ${track.kind} track carries signal (peak ${peak.toFixed(3)}) but the engine returned no text`
        )
        failedTracks.push(track.kind)
      } else {
        console.log(`[jobs] no speech on ${track.kind} track; skipping it`)
        emptyTracks.push(track.kind)
      }
      continue
    }

    transcribed.push({ track, segments: result.segments })
  }

  // Stage 2: split off tracks that need no diarization — the mic when it's
  // declared to carry only the local user, or diarization is off altogether —
  // and merge those immediately.
  const toDiarize: typeof transcribed = []
  for (const { track, segments } of transcribed) {
    if (track.kind === 'mic' && micIsSolo) {
      // Declared to carry only the local user, so diarizing it could only
      // rediscover something already known — or get it wrong. Cluster -1 is
      // reserved for "You".
      merged.push(...mergeTranscriptWithSpeakers(segments, [], track.id, { forceSpeaker: LOCAL_SPEAKER }))
      continue
    }
    if (!diarizationEnabled) {
      merged.push(...mergeTranscriptWithSpeakers(segments, [], track.id))
      continue
    }
    toDiarize.push({ track, segments })
  }

  /**
   * A speaker count describes the recording, not each track in it. The mic is
   * the only track ever excluded from clustering (when declared solo), so
   * it's the only adjustment needed here. Computed even when nothing ends up
   * needing diarization, since the caller's absorption pass also uses it to
   * tell an asserted headcount from a guess.
   */
  const forcedCount =
    numSpeakers && numSpeakers > 0
      ? micIsSolo && transcribed.some((t) => t.track.kind === 'mic')
        ? Math.max(1, numSpeakers - 1)
        : numSpeakers
      : null

  // Known voices to try to recognise in this recording. Each one is prepended
  // as an anchor ahead of the real audio, and whichever cluster ends up
  // covering an anchor's window is that person — this runs inside the same
  // embedding space diarization already uses, with no separate comparison step.
  const profiles = listProfilesForMatching()
  let matchedProfiles: Map<number, ProfileMatch> = new Map()

  // Stage 3: one diarization pass across every remaining track, so a speaker
  // heard on both mic and system is one cluster instead of two, and a
  // headcount describes the whole recording instead of being divided between
  // tracks that can't agree on how to split it.
  if (toDiarize.length > 0) {
    setStage('diarizing')
    progress('diarizing', 0)

    let byTrackId: Map<string, SpeakerSegment[]>

    if (toDiarize.length === 1 && profiles.length === 0) {
      const only = toDiarize[0].track
      const segments = await diarize({
        wavPath: only.wavPath,
        numSpeakers: forcedCount,
        threshold: splitting.threshold,
        // Tempered on short recordings, where the threshold that protects a
        // long meeting from fragmenting would instead delete a brief reply.
        minDurationOn: minDurationOnFor(splitting.minDurationOn, only.durationMs ?? undefined),
        onProgress: (fraction) => progress('diarizing', fraction),
        signal
      })
      byTrackId = new Map([[only.id, segments]])
    } else {
      // Anchors go first, then the real tracks. Real gaps between every part
      // in the concatenated audio, not just offsets: the segmentation model
      // needs actual silence to end a speech segment at a boundary rather
      // than bridging across it.
      const gapMs = 2000
      const analysisPath = join(recordingMediaPath(recordingId), 'diarize-analysis.wav')
      const trackDurations = toDiarize.map((t) => t.track.durationMs ?? 0)
      const parts = [
        ...profiles.map((p) => ({ inputPath: p.samplePath, durationMs: p.sampleMs })),
        ...toDiarize.map((t, i) => ({ inputPath: t.track.wavPath, durationMs: trackDurations[i] }))
      ]

      // The path is claimed above the try, but nothing can write to it until
      // concatToWav runs — that call has to be inside the guard too, or a
      // failure or cancellation partway through concatenation leaves the file
      // behind with nothing left to clean it up.
      try {
        const { offsets } = await concatToWav({
          parts,
          gapMs,
          outputPath: analysisPath,
          signal
        })
        const totalDurationMs = parts.reduce((sum, p) => sum + p.durationMs, 0) + gapMs * (parts.length - 1)
        // An anchor consumes one of the requested clusters same as a real
        // participant, so the ceiling has to cover both — a profile whose
        // person didn't show up this time contributes no real segments (see
        // segmentsForPart below) and its slot goes unused rather than
        // stealing one from somebody who did.
        const clusterCeiling = forcedCount != null ? forcedCount + profiles.length : null

        const allSegments = await diarize({
          wavPath: analysisPath,
          numSpeakers: clusterCeiling,
          threshold: splitting.threshold,
          minDurationOn: minDurationOnFor(splitting.minDurationOn, totalDurationMs),
          onProgress: (fraction) => progress('diarizing', fraction),
          signal
        })

        matchedProfiles = matchProfilesToClusters(profiles, offsets, allSegments)

        // Real tracks start after the anchor parts; segmentsForPart's own
        // windowing is what keeps an anchor's audio (and an absent profile's
        // dead cluster) out of the transcript.
        byTrackId = new Map(
          toDiarize.map(({ track }, i) => [
            track.id,
            segmentsForPart(allSegments, offsets[profiles.length + i], trackDurations[i])
          ])
        )
      } finally {
        await rm(analysisPath, { force: true })
      }
    }
    if (signal.aborted) return emptyResult()

    for (const { track, segments } of toDiarize) {
      merged.push(...mergeTranscriptWithSpeakers(segments, byTrackId.get(track.id) ?? [], track.id))
    }
  }

  return { utterances: merged, resolvedLanguage, emptyTracks, failedTracks, matchedProfiles, forcedCount }
}

/** What an aborted pipeline resolves with — the caller checks `signal.aborted` itself and returns before using this. */
function emptyResult(): TranscriptionPipelineResult {
  return {
    utterances: [],
    resolvedLanguage: null,
    emptyTracks: [],
    failedTracks: [],
    matchedProfiles: new Map(),
    forcedCount: null
  }
}
