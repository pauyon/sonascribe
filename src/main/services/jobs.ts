import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import type { ActiveJob, JobProgress, JobStage, TrackKind } from '@shared/types'
import { getRecording } from '../db/recordings'
import { listTracks, setRecordingStatus } from '../db/tracks'
import { saveMergedTranscript } from '../db/transcript'
import { ensureSpeaker } from '../db/speakers'
import { listProfilesForMatching } from '../db/profiles'
import { runAutoEnrollment } from './profiles'
import {
  getDiarizationEnabled,
  getLanguage,
  getMicSoloSpeaker,
  getSelectedModelId,
  getSpeakerCount,
  getSpeakerSplitting
} from '../db/settings'
import { findModel, type AsrEngine } from '@shared/models'
import { emit } from '../ipc/events'
import { resolveModelPath } from './models'
import { transcribeWithWhisper } from './whisper'
import { transcribeWithParakeet } from './parakeet'
import { TranscriptionError, engineSidecar, type TranscriptSegment } from './transcription'
import { diarize, DiarizationError, minDurationOnFor, SPLITTING_PRESETS, type SpeakerSegment } from './diarize'
import { concatToWav } from './ffmpeg'
import {
  absorbTinySpeakers,
  LOCAL_SPEAKER,
  minSpeakerSpeechFor,
  mergeTranscriptWithSpeakers,
  type MergedUtterance
} from './merge'
import { hasBundledModel, hasSidecar } from './sidecars'
import { measurePeak, SILENCE_PEAK_THRESHOLD } from './peaks'
import { takeLiveWords } from './live-transcribe'
import { groupWordsIntoSegments } from './transcription'
import { recordingMediaPath } from '../paths'

/**
 * Serial job queue for the transcription pipeline.
 *
 * Jobs run one at a time. whisper.cpp already uses every core it is given, so
 * running two transcriptions at once makes both slower and finishes the pair no
 * sooner — and it would make progress reporting meaningless. Cancellation is a
 * kill of the child process, which is the main reason the ML engines are
 * sidecars rather than in-process addons.
 */

interface QueuedJob {
  recordingId: string
  controller: AbortController
  run: () => Promise<void>
}

const queue: QueuedJob[] = []
const controllers = new Map<string, AbortController>()

/**
 * Latest progress per in-flight recording.
 *
 * Progress is pushed to the renderer as it happens, but an event is only seen by
 * whoever is listening at that moment. A screen that opens midway through a job
 * — or reopens after the user navigated away — has missed every event so far and
 * would otherwise show an empty bar and a clock starting from zero for a job
 * twenty minutes old. Keeping the current value here makes it answerable.
 */
const activeJobs = new Map<string, ActiveJob>()

let running = false


export class JobError extends Error {}

/**
 * Transcribe the microphone first.
 *
 * It needs no diarization, so doing it first gets visible transcript rows in
 * front of the user sooner on a long recording.
 */
function trackOrder(kind: TrackKind): number {
  return kind === 'mic' ? 0 : kind === 'system' ? 1 : 2
}

/**
 * Picks out one track's slice of a joint diarization pass and rebases it to
 * track-local time.
 *
 * A segment that starts inside this track's window but runs past the end of
 * it has bled into the silence gap or the next track — the segmentation model
 * bridging across a boundary it should have stopped at. Real speech never
 * needs to do that, so the segment is dropped rather than clipped.
 */
function segmentsForPart(
  segments: SpeakerSegment[],
  windowStart: number,
  windowDurationMs: number
): SpeakerSegment[] {
  const windowEnd = windowStart + windowDurationMs
  const result: SpeakerSegment[] = []
  for (const segment of segments) {
    if (segment.startMs < windowStart || segment.startMs >= windowEnd) continue
    if (segment.endMs > windowEnd) continue
    result.push({ ...segment, startMs: segment.startMs - windowStart, endMs: segment.endMs - windowStart })
  }
  return result
}

/**
 * Routes a transcription to whichever engine the chosen model belongs to.
 *
 * Both runners return the same shape, so nothing downstream — merging,
 * diarization alignment, persistence — needs to know which one ran.
 */
function runAsr(
  engine: AsrEngine,
  options: Parameters<typeof transcribeWithWhisper>[0]
): ReturnType<typeof transcribeWithWhisper> {
  return engine === 'parakeet'
    ? transcribeWithParakeet(options)
    : transcribeWithWhisper(options)
}

function publishRecording(recordingId: string): void {
  const updated = getRecording(recordingId)
  if (updated) emit('recording:updated', updated)
}

function progress(recordingId: string, stage: JobStage, fraction: number | null): void {
  const payload: JobProgress = { recordingId, stage, fraction }
  const existing = activeJobs.get(recordingId)
  activeJobs.set(recordingId, {
    recordingId,
    startedAt: existing?.startedAt ?? Date.now(),
    progress: payload
  })
  emit('job:progress', payload)
}

/** True when a job for this recording is queued or in flight. */
export function isJobActive(recordingId: string): boolean {
  return controllers.has(recordingId)
}

export function listActiveJobs(): ActiveJob[] {
  return [...controllers.keys()].map(
    (recordingId) =>
      activeJobs.get(recordingId) ?? { recordingId, startedAt: Date.now(), progress: null }
  )
}


/**
 * Aborts every job in flight, for when the app is going away.
 *
 * The sidecars are separate processes and nothing kills them implicitly: quit
 * the app mid-transcription and parakeet-cli keeps running with the whole
 * window's audio in memory — 10 GB with no window left to show for it, until the
 * user finds it in Task Manager.
 *
 * Keys are snapshotted first because cancelJob mutates the map it iterates.
 */
export function cancelAllJobs(): number {
  const ids = [...controllers.keys()]
  for (const id of ids) cancelJob(id)
  if (ids.length > 0) console.log(`[jobs] cancelled ${ids.length} job(s) on shutdown`)
  return ids.length
}

export function cancelJob(recordingId: string): boolean {
  const controller = controllers.get(recordingId)
  if (!controller) return false
  controller.abort()

  // If it has not started yet, drop it from the queue so it never runs.
  const index = queue.findIndex((j) => j.recordingId === recordingId)
  if (index !== -1) {
    queue.splice(index, 1)
    controllers.delete(recordingId)
    activeJobs.delete(recordingId)
    setRecordingStatus(recordingId, 'queued')
    publishRecording(recordingId)
  }
  return true
}

async function drain(): Promise<void> {
  if (running) return
  running = true
  try {
    while (queue.length > 0) {
      const job = queue.shift()
      if (!job) break
      try {
        await job.run()
      } catch (err) {
        console.error(`[jobs] ${job.recordingId} failed:`, err)
      } finally {
        controllers.delete(job.recordingId)
        activeJobs.delete(job.recordingId)
      }
    }
  } finally {
    running = false
  }
}

/**
 * Queues transcription for a recording.
 *
 * Throws synchronously for conditions the user can fix immediately — no model
 * chosen, model not downloaded, nothing to transcribe — so the UI can say so
 * rather than showing a job that fails a moment later.
 */
export async function queueTranscription(recordingId: string): Promise<void> {
  if (controllers.has(recordingId)) {
    throw new JobError('This recording is already being transcribed')
  }

  // The recording is claimed here, synchronously, rather than after the checks
  // below. Those checks await, and the guard above used to sit on the far side
  // of that await: two starts arriving within the same tick — a double click, a
  // click racing a retry — both passed it and both queued. The recording was
  // then transcribed twice end to end, at twice the memory and twice the wait,
  // and because `controllers` is keyed by recording the second registration
  // simply overwrote the first, so nothing downstream could see it had happened.
  const controller = new AbortController()
  controllers.set(recordingId, controller)

  try {
    await prepareAndQueue(recordingId, controller)
  } catch (err) {
    // A start that never became a job must release its claim, or the recording
    // can never be transcribed again without a restart.
    controllers.delete(recordingId)
    activeJobs.delete(recordingId)
    throw err
  }
}

async function prepareAndQueue(
  recordingId: string,
  controller: AbortController
): Promise<void> {
  const recording = getRecording(recordingId)
  if (!recording) throw new JobError('Recording not found')

  const tracks = listTracks(recordingId)
  if (tracks.length === 0) {
    throw new JobError('This recording has no audio to transcribe')
  }

  const modelId = getSelectedModelId()
  if (!modelId) throw new JobError('No transcription model selected')

  const spec = findModel(modelId)
  if (!spec) throw new JobError(`Unknown model: ${modelId}`)

  const modelPath = await resolveModelPath(modelId)
  if (!modelPath) {
    throw new JobError(`${spec.label} is not downloaded yet`)
  }

  // Each engine has its own helper binary; say which one is missing rather than
  // letting the spawn fail deep inside the job.
  const sidecar = engineSidecar(spec.engine)
  if (!hasSidecar(sidecar)) {
    throw new JobError(`The ${sidecar} helper is missing. Run "npm run sidecars".`)
  }

  const language = getLanguage()

  // Diarization is skipped rather than failed when the helper or its models are
  // absent: a transcript without speaker labels is still worth having.
  const diarizationEnabled =
    getDiarizationEnabled() &&
    hasSidecar('sherpa-onnx-offline-speaker-diarization') &&
    hasBundledModel('segmentation.onnx') &&
    hasBundledModel('speaker-embedding.onnx')
  const numSpeakers = getSpeakerCount()
  const splitting = SPLITTING_PRESETS[getSpeakerSplitting()]
  // Only skip diarizing the microphone when the user has said it carries just
  // their own voice. Several people around one mic is at least as common.
  const micIsSolo = getMicSoloSpeaker()

  // Stamped now rather than at the first progress event, so the elapsed time a
  // screen shows counts from when the user pressed the button.
  activeJobs.set(recordingId, { recordingId, startedAt: Date.now(), progress: null })

  setRecordingStatus(recordingId, 'queued')
  publishRecording(recordingId)

  queue.push({
    recordingId,
    controller,
    run: async () => {
      if (controller.signal.aborted) return

      setRecordingStatus(recordingId, 'transcribing')
      publishRecording(recordingId)
      progress(recordingId, 'transcribing', 0)

      try {
        // A recorded session has separate 'mic' and 'system' tracks; an import
        // has one 'mixed' track. Transcribe each, then interleave by time.
        const ordered = [...tracks].sort((a, b) => trackOrder(a.kind) - trackOrder(b.kind))
        // How long the recording actually is, which decides how suspicious the
        // pipeline should be of a speaker who barely says anything.
        const longestTrackMs = Math.max(0, ...tracks.map((t) => t.durationMs ?? 0))
        const merged: Array<MergedUtterance & { trackId: string }> = []
        let resolvedLanguage: string | null = null
        const emptyTracks: TrackKind[] = []
        // Tracks that carry signal but came back with nothing — a fault, not silence.
        const failedTracks: TrackKind[] = []

        // Stage 1: transcribe every track first. Diarization runs afterwards,
        // once, over whichever tracks actually came back with speech — so a
        // track that turns out to be empty never claims a share of the
        // clustering budget below.
        const transcribed: Array<{ track: (typeof ordered)[number]; segments: TranscriptSegment[] }> =
          []

        for (const [index, track] of ordered.entries()) {
          const share = 1 / ordered.length

          setRecordingStatus(recordingId, 'transcribing')
          publishRecording(recordingId)

          // A recording transcribed as it was captured has nothing left to do
          // here. The words were produced by this same engine on windows cut at
          // silences, so they are not a preview to be redone — running the whole
          // file again would spend twenty minutes reproducing them.
          const live = takeLiveWords(recordingId, track.kind, track.durationMs ?? 0)
          const result = live
            ? { language: null, segments: groupWordsIntoSegments(live) }
            : await runAsr(spec.engine, {
                wavPath: track.wavPath,
                modelPath,
                language,
                onProgress: (fraction) =>
                  progress(
                    recordingId,
                    'transcribing',
                    // Parakeet reports no progress; keep the bar indeterminate
                    // rather than inventing a number.
                    fraction == null ? null : index * share + fraction * share
                  ),
                signal: controller.signal
              })
          if (controller.signal.aborted) return

          if (live) {
            console.log(
              `[jobs] using ${live.length} words transcribed live for the ${track.kind} track`
            )
            progress(recordingId, 'transcribing', (index + 1) / ordered.length)
          }

          resolvedLanguage ??= result.language ?? (language === 'auto' ? null : language)

          // A track with no speech is ordinary, not fatal: system audio with
          // nothing playing is silent, and failing the whole job would throw
          // away a perfectly good microphone transcript alongside it.
          //
          // But an empty result means one of two very different things, and the
          // engine reports both the same way. Either the audio really is silent,
          // or the engine produced nothing for audio that plainly is not — which
          // is a failure wearing the costume of an empty room. The peak settles
          // it, and it is already the test used to discard silent captures.
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

        // Stage 2: split off tracks that need no diarization — the mic when
        // it's declared to carry only the local user, or diarization is off
        // altogether — and merge those immediately.
        const toDiarize: typeof transcribed = []
        for (const { track, segments } of transcribed) {
          if (track.kind === 'mic' && micIsSolo) {
            // Declared to carry only the local user, so diarizing it could only
            // rediscover something already known — or get it wrong. Cluster -1
            // is reserved for "You".
            merged.push(
              ...mergeTranscriptWithSpeakers(segments, [], { forceSpeaker: LOCAL_SPEAKER }).map(
                (u) => ({ ...u, trackId: track.id })
              )
            )
            continue
          }
          if (!diarizationEnabled) {
            merged.push(
              ...mergeTranscriptWithSpeakers(segments, []).map((u) => ({ ...u, trackId: track.id }))
            )
            continue
          }
          toDiarize.push({ track, segments })
        }

        /**
         * A speaker count describes the recording, not each track in it. The
         * mic is the only track ever excluded from clustering (when declared
         * solo), so it's the only adjustment needed here. Computed even when
         * nothing ends up needing diarization, since the absorption pass below
         * also uses it to tell an asserted headcount from a guess.
         */
        const forcedCount =
          numSpeakers && numSpeakers > 0
            ? micIsSolo && transcribed.some((t) => t.track.kind === 'mic')
              ? Math.max(1, numSpeakers - 1)
              : numSpeakers
            : null

        // Known voices to try to recognise in this recording. Each one is
        // prepended as an anchor ahead of the real audio, and whichever
        // cluster ends up covering an anchor's window is that person — this
        // runs inside the same embedding space diarization already uses, with
        // no separate comparison step.
        const profiles = listProfilesForMatching()
        // Cluster index -> the profile whose anchor claimed it.
        const matchedProfiles = new Map<number, { id: string; displayName: string }>()

        // Stage 3: one diarization pass across every remaining track, so a
        // speaker heard on both mic and system is one cluster instead of two,
        // and a headcount describes the whole recording instead of being
        // divided between tracks that can't agree on how to split it.
        if (toDiarize.length > 0) {
          setRecordingStatus(recordingId, 'diarizing')
          publishRecording(recordingId)
          progress(recordingId, 'diarizing', 0)

          let byTrackId: Map<string, SpeakerSegment[]>

          if (toDiarize.length === 1 && profiles.length === 0) {
            const only = toDiarize[0].track
            const segments = await diarize({
              wavPath: only.wavPath,
              numSpeakers: forcedCount,
              threshold: splitting.threshold,
              // Tempered on short recordings, where the threshold that protects
              // a long meeting from fragmenting would instead delete a brief
              // reply.
              minDurationOn: minDurationOnFor(splitting.minDurationOn, only.durationMs ?? undefined),
              onProgress: (fraction) => progress(recordingId, 'diarizing', fraction),
              signal: controller.signal
            })
            byTrackId = new Map([[only.id, segments]])
          } else {
            // Anchors go first, then the real tracks. Real gaps between every
            // part in the concatenated audio, not just offsets: the
            // segmentation model needs actual silence to end a speech segment
            // at a boundary rather than bridging across it.
            const gapMs = 2000
            const analysisPath = join(recordingMediaPath(recordingId), 'diarize-analysis.wav')
            const trackDurations = toDiarize.map((t) => t.track.durationMs ?? 0)
            const parts = [
              ...profiles.map((p) => ({ inputPath: p.samplePath, durationMs: p.sampleMs })),
              ...toDiarize.map((t, i) => ({ inputPath: t.track.wavPath, durationMs: trackDurations[i] }))
            ]
            const { offsets } = await concatToWav({
              parts,
              gapMs,
              outputPath: analysisPath,
              signal: controller.signal
            })
            const totalDurationMs =
              parts.reduce((sum, p) => sum + p.durationMs, 0) + gapMs * (parts.length - 1)
            // An anchor consumes one of the requested clusters same as a real
            // participant, so the ceiling has to cover both — a profile whose
            // person didn't show up this time contributes no real segments
            // (see segmentsForPart below) and its slot goes unused rather than
            // stealing one from somebody who did.
            const clusterCeiling = forcedCount != null ? forcedCount + profiles.length : null

            try {
              const allSegments = await diarize({
                wavPath: analysisPath,
                numSpeakers: clusterCeiling,
                threshold: splitting.threshold,
                minDurationOn: minDurationOnFor(splitting.minDurationOn, totalDurationMs),
                onProgress: (fraction) => progress(recordingId, 'diarizing', fraction),
                signal: controller.signal
              })

              // Whichever cluster covers the most of an anchor's window is that
              // person. An anchor that ties with another for the same cluster,
              // or that overlaps nothing, is left unmatched rather than guessed.
              const claims = new Map<number, string[]>()
              const claimedBy = new Map<string, number>()
              for (const [i, profile] of profiles.entries()) {
                const windowStart = offsets[i]
                const windowEnd = windowStart + profile.sampleMs
                let best: number | null = null
                let bestOverlap = 0
                for (const segment of allSegments) {
                  const amount =
                    Math.min(segment.endMs, windowEnd) - Math.max(segment.startMs, windowStart)
                  if (amount > bestOverlap) {
                    bestOverlap = amount
                    best = segment.speaker
                  }
                }
                if (best == null) continue
                claims.set(best, [...(claims.get(best) ?? []), profile.id])
                claimedBy.set(profile.id, best)
              }
              for (const [profileId, cluster] of claimedBy) {
                if ((claims.get(cluster)?.length ?? 0) > 1) continue
                const profile = profiles.find((p) => p.id === profileId)
                if (profile) matchedProfiles.set(cluster, { id: profile.id, displayName: profile.displayName })
              }

              // Real tracks start after the anchor parts; segmentsForPart's own
              // windowing is what keeps an anchor's audio (and an absent
              // profile's dead cluster) out of the transcript.
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
          if (controller.signal.aborted) return

          for (const { track, segments } of toDiarize) {
            merged.push(
              ...mergeTranscriptWithSpeakers(segments, byTrackId.get(track.id) ?? []).map((u) => ({
                ...u,
                trackId: track.id
              }))
            )
          }
        }

        // Only when nothing anywhere produced speech is this a real failure —
        // and what to say about it depends on whether the audio was silent.
        if (merged.length === 0) {
          throw new JobError(
            failedTracks.length > 0
              ? 'This recording has audio in it, but transcription returned nothing. That usually means the engine ran out of memory. Try a shorter section, or a smaller model from the Models page.'
              : 'No speech was found in this recording. Check that the right input device was selected and that the audio is not silent.'
          )
        }

        // Half a conversation with no explanation is worse than a slow one.
        if (failedTracks.length > 0) {
          console.warn(
            `[jobs] transcript is incomplete: no text from ${failedTracks.join(' and ')} despite audible signal`
          )
        }

        setRecordingStatus(recordingId, 'merging')
        publishRecording(recordingId)
        progress(recordingId, 'merging', null)

        // Both tracks start at t=0, so ordering by start time interleaves the
        // local and remote halves of the conversation correctly.
        merged.sort((a, b) => a.startMs - b.startMs)

        // Fold away clusters too small to be a person. Done before speaker rows
        // exist so a cough never gets as far as being called "Speaker 7".
        //
        // Skipped when a count was honoured: the user asserted the headcount and
        // the clusterer was capped by it, so a thin cluster is one of the speakers
        // they told us about, not an artefact to tidy away.
        // absorbTinySpeakers only ever reassigns `speaker` (by spreading the
        // original utterance) or drops nothing, so `trackId` survives even
        // though its own signature is typed in terms of the untracked shape.
        const cleaned = (
          forcedCount == null
            ? absorbTinySpeakers(merged, minSpeakerSpeechFor(longestTrackMs))
            : merged
        ) as Array<MergedUtterance & { trackId: string }>
        if (cleaned.length !== merged.length) {
          console.log(
            `[jobs] absorbed negligible speakers: ${merged.length} utterances -> ${cleaned.length}`
          )
        }

        // Map cluster indices to speaker rows, creating any that are new. A
        // cluster an anchor claimed is created under that profile's name
        // instead of "Speaker N". Existing rows are reused, so renames (and a
        // profile link from a previous run) survive a re-run.
        const speakerIds = new Map<number, string>()
        for (const utterance of cleaned) {
          if (utterance.speaker == null || speakerIds.has(utterance.speaker)) continue
          speakerIds.set(
            utterance.speaker,
            ensureSpeaker(recordingId, utterance.speaker, matchedProfiles.get(utterance.speaker)).id
          )
        }

        saveMergedTranscript({
          recordingId,
          modelId,
          language: resolvedLanguage,
          utterances: cleaned.map((u) => ({
            startMs: u.startMs,
            endMs: u.endMs,
            text: u.text,
            confidence: u.confidence,
            speakerId: u.speaker == null ? null : (speakerIds.get(u.speaker) ?? null),
            trackId: u.trackId,
            words: u.words.map((w) => ({
              startMs: w.startMs,
              endMs: w.endMs,
              text: w.text
            }))
          }))
        })

        // Background bookkeeping, not part of the transcript itself — a
        // failure here must never turn a finished transcription into a failed
        // job, so it's isolated and only ever logged.
        try {
          await runAutoEnrollment(recordingId)
        } catch (err) {
          console.warn(`[jobs] voice-profile enrollment failed for ${recordingId}:`, err)
        }

        setRecordingStatus(recordingId, 'ready')
        publishRecording(recordingId)
      } catch (err) {
        if (controller.signal.aborted) {
          // A cancelled job returns to 'queued' so it can simply be retried.
          setRecordingStatus(recordingId, 'queued')
          publishRecording(recordingId)
          return
        }

        // Both sidecar errors carry the tail of the child's stderr, which is
        // where the actual cause is; the message alone is just an exit code.
        const message =
          err instanceof TranscriptionError || err instanceof DiarizationError
            ? `${err.message}\n${err.stderrTail}`
            : err instanceof Error
              ? err.message
              : String(err)

        setRecordingStatus(recordingId, 'failed', message)
        publishRecording(recordingId)
        throw err
      }
    }
  })

  void drain()
}
