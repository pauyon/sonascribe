import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Recording, TrackKind } from '@shared/types'
import { createRecording, deleteRecording } from '../db/recordings'
import {
  createTrack,
  setRecordingDuration,
  setRecordingSourcePath,
  setRecordingStatus
} from '../db/tracks'
import { recordingMediaPath, recordingMixPath } from '../paths'
import { emit } from '../ipc/events'
import { WavWriter } from './wav-writer'
import { mixToWav, normalizeToWav } from './ffmpeg'
import { measurePeak, SILENCE_PEAK_THRESHOLD } from './peaks'
import {
  discardLiveTranscription,
  finishLiveTranscription,
  hasLiveWords,
  startLiveTranscription
} from './live-transcribe'
import { queueTranscription } from './jobs'

/**
 * Holds the open WAV writers for an in-progress recording.
 *
 * Audio is captured in the renderer (only it can reach getUserMedia and
 * getDisplayMedia) and streamed here as 16-bit PCM blocks. The main process owns
 * the files so a renderer crash cannot lose a recording that is already on disk.
 *
 * Mic and system audio are written as two separate tracks rather than one mix.
 * That is what lets the pipeline attribute the mic track to the local user
 * outright and only diarize the remote participants — the largest accuracy win
 * available, and the reason `tracks` is a table rather than a column.
 *
 * A mixdown of those tracks is written on stop purely so that playing a
 * recording back gives both ends of the conversation. It is never an input to
 * transcription or diarization; the separation above is what those depend on.
 *
 * Audio is captured at the hardware's own rate and kept that way; the 16 kHz
 * mono copy the ML sidecars require is derived on stop, exactly as an imported
 * file is. Recording directly at 16 kHz would permanently cap every recording
 * at telephone bandwidth, which no microphone can compensate for.
 */

interface Session {
  recordingId: string
  writers: Map<TrackKind, WavWriter>
  startedAt: number
  paused: boolean
}

let session: Session | null = null

export class RecordingError extends Error {}

export function isRecording(): boolean {
  return session !== null
}

export interface StartRecordingInput {
  title?: string
  /** Which tracks the renderer managed to open. */
  kinds: TrackKind[]
  /** Hardware capture rate, so the WAV header describes the real audio. */
  sampleRate: number
}

export function startRecording(input: StartRecordingInput): Recording {
  if (session) throw new RecordingError('A recording is already in progress')
  if (input.kinds.length === 0) throw new RecordingError('No audio sources to record')

  const now = new Date()
  const recording = createRecording({
    title:
      input.title?.trim() ||
      `Recording ${now.toLocaleDateString()} ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
    source: 'recorded',
    sourcePath: null
  })

  if (!Number.isFinite(input.sampleRate) || input.sampleRate < 8000) {
    throw new RecordingError(`Implausible capture rate: ${input.sampleRate}`)
  }

  const dir = recordingMediaPath(recording.id)
  const writers = new Map<TrackKind, WavWriter>()
  for (const kind of input.kinds) {
    // ".source" marks the full-quality capture; the ML copy takes the plain name.
    writers.set(kind, new WavWriter(join(dir, `${kind}.source.wav`), input.sampleRate))
  }

  session = { recordingId: recording.id, writers, startedAt: Date.now(), paused: false }
  setRecordingStatus(recording.id, 'normalizing')

  // Transcribe as it records, so the transcript is finished about when the
  // speaker stops. Fire-and-forget: it declines when no model is available, and
  // a recording must never fail to start because transcription could not.
  void startLiveTranscription({
    recordingId: recording.id,
    sampleRate: input.sampleRate,
    tracks: [...writers].map(([kind, writer]) => ({ kind, path: writer.path })),
    // Each finished window goes straight to the Record screen, so the user can
    // watch the transcript build instead of waiting to find out afterwards
    // whether anything was picked up at all.
    onWindow: (kind, window) => {
      emit('live:transcript', { recordingId: recording.id, kind, ...window })
    }
  }).catch((err) => console.warn('[live] could not start:', err))


  return { ...recording, status: 'normalizing' }
}

/**
 * Appends captured audio.
 *
 * Blocks arriving while paused are dropped rather than buffered: pausing is
 * meant to leave the pause out of the recording, and both tracks pause together
 * so they stay aligned on a shared timeline.
 */
export function writeChunk(kind: TrackKind, samples: Buffer): void {
  if (!session) throw new RecordingError('No recording in progress')
  if (session.paused) return
  session.writers.get(kind)?.write(samples)
}

export function setPaused(paused: boolean): void {
  if (!session) throw new RecordingError('No recording in progress')
  session.paused = paused
}

export interface RecordingSummary {
  recordingId: string
  durationMs: number
  tracks: Array<{ kind: TrackKind; durationMs: number }>
  /** Tracks discarded for carrying no signal, so the UI can say why. */
  silentTracks: TrackKind[]
}

/** Closes the files, registers the tracks, and leaves the recording ready to transcribe. */
export async function stopRecording(): Promise<RecordingSummary> {
  if (!session) throw new RecordingError('No recording in progress')
  const current = session
  session = null

  const tracks: RecordingSummary['tracks'] = []
  const silentTracks: TrackKind[] = []
  let longestMs = 0
  let playbackSource: string | null = null
  // Kept captures, mic first, for the playback mixdown below.
  const kept: string[] = []

  const dir = recordingMediaPath(current.recordingId)
  setRecordingStatus(current.recordingId, 'normalizing')

  // Close every writer before the live pass finishes, so its last window sees
  // complete files rather than racing the final blocks onto disk.
  const closed = new Map<TrackKind, { durationMs: number; bytes: number }>()
  for (const [kind, writer] of current.writers) {
    closed.set(kind, await writer.close())
  }
  await finishLiveTranscription(current.recordingId)

  for (const [kind, writer] of current.writers) {
    const { durationMs, bytes } = closed.get(kind) ?? { durationMs: 0, bytes: 0 }

    // A track that captured nothing must not be kept. Byte count is not the
    // test: system-audio loopback with nothing playing produces a full-length
    // file of zeroes, which is silent but far from empty. Keeping it means a
    // recording with perfectly good microphone audio still has a track that no
    // engine can find speech in.
    const peak = bytes === 0 ? 0 : await measurePeak(writer.path)
    if (peak < SILENCE_PEAK_THRESHOLD) {
      console.log(`[recorder] discarding silent ${kind} track (peak ${peak.toFixed(5)})`)
      await rm(writer.path, { force: true })
      silentTracks.push(kind)
      continue
    }

    // Derive the 16 kHz mono copy the sidecars consume, keeping the capture
    // itself untouched for playback and for any later re-processing.
    const wavPath = join(dir, `${kind}.wav`)
    await normalizeToWav({ inputPath: writer.path, outputPath: wavPath, normalizeLoudness: true })

    createTrack({ recordingId: current.recordingId, kind, wavPath, durationMs })
    tracks.push({ kind, durationMs })
    longestMs = Math.max(longestMs, durationMs)

    // Fallback playback source, used when there is only one track or the
    // mixdown below fails: prefer the microphone capture, since it is the local
    // user's own voice and the track they are most likely to want to hear.
    if (playbackSource == null || kind === 'mic') playbackSource = writer.path
    if (kind === 'mic') kept.unshift(writer.path)
    else kept.push(writer.path)
  }

  if (tracks.length === 0) {
    setRecordingStatus(current.recordingId, 'failed', 'No audio was captured')
    return { recordingId: current.recordingId, durationMs: 0, tracks: [], silentTracks }
  }

  // One file that holds the whole conversation, for listening and for sharing.
  //
  // The per-source tracks above stay exactly as they were and remain what the
  // ML pipeline reads: the mic track is the local user by definition, and that
  // shortcut dies the moment it is mixed with anything. This mix is only ever
  // the playback source.
  //
  // A failed mix must not fail the recording — the audio is already safely on
  // disk. Falling back to the single-track behaviour costs the remote half of
  // playback, which is worth far less than the take itself.
  if (kept.length > 1) {
    const mixPath = recordingMixPath(current.recordingId)
    try {
      await mixToWav({ inputPaths: kept, outputPath: mixPath })
      playbackSource = mixPath
    } catch (err) {
      console.error('[recorder] could not mix tracks; playing back a single track:', err)
      await rm(mixPath, { force: true })
    }
  }

  setRecordingDuration(current.recordingId, longestMs)
  if (playbackSource) setRecordingSourcePath(current.recordingId, playbackSource)
  setRecordingStatus(current.recordingId, 'queued')

  // Nothing left to decide when the transcript already exists. Asking the user
  // to press Transcribe on work that is finished makes live transcription look
  // like it never happened — the only step still outstanding is identifying the
  // speakers, which is seconds rather than the length of the recording.
  if (hasLiveWords(current.recordingId)) {
    void queueTranscription(current.recordingId).catch((err) =>
      console.warn('[recorder] could not start the finishing pass:', err)
    )
  }


  return { recordingId: current.recordingId, durationMs: longestMs, tracks, silentTracks }
}

/** Aborts and deletes everything captured so far, including the row. */
export async function cancelRecording(): Promise<void> {
  if (!session) return
  const current = session
  session = null

  await discardLiveTranscription(current.recordingId)

  for (const writer of current.writers.values()) {
    await writer.close().catch(() => undefined)
    await rm(writer.path, { force: true })
  }

  // No track rows exist yet, so nothing cascades; remove the recording itself
  // and its media directory so a cancelled take leaves nothing behind.
  deleteRecording(current.recordingId)
  await rm(recordingMediaPath(current.recordingId), { recursive: true, force: true })
}
