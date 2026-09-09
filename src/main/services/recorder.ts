import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Recording } from '@shared/types'
import { createRecording, deleteRecording, setRecordingDuration, setRecordingSourcePath, setRecordingStatus } from '../db/recordings'
import { recordingMediaDir } from './storage'
import { emit } from '../ipc/events'
import { focusMainWindow } from '../windows/main-window'
import { WavWriter } from './wav-writer'
import { measurePeak, SILENCE_PEAK_THRESHOLD } from './peaks'

/**
 * Holds the open WAV writer for an in-progress recording.
 *
 * Audio is captured in the renderer (only it can reach getUserMedia and
 * getDisplayMedia) and streamed here as 16-bit PCM blocks. The main process
 * owns the file so a renderer crash cannot lose a recording that is already
 * on disk.
 *
 * Mic and system audio are mixed into one stream before they ever reach this
 * module — see lib/capture.ts, which connects both sources to a shared
 * AudioWorkletNode so the summing happens in the audio graph itself. There is
 * exactly one writer per recording, not one per source: a plain recorder has
 * no reason to keep them separate the way a transcription pipeline needing to
 * attribute speakers to a specific mic does.
 *
 * Audio is captured at the hardware's own rate and kept that way — recording
 * straight to a lower rate would permanently cap every recording at whatever
 * that rate allows, which no microphone can compensate for.
 */

interface Session {
  recordingId: string
  writer: WavWriter
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
  /** Whether the renderer managed to open a system-audio stream to mix in. */
  hasSystemAudio: boolean
  /** Hardware capture rate, so the WAV header describes the real audio. */
  sampleRate: number
}

export function startRecording(input: StartRecordingInput): Recording {
  if (session) throw new RecordingError('A recording is already in progress')

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

  const dir = recordingMediaDir(recording.id)
  const writer = new WavWriter(join(dir, 'recording.wav'), input.sampleRate)

  session = { recordingId: recording.id, writer, startedAt: Date.now(), paused: false }
  setRecordingStatus(recording.id, 'normalizing')

  return { ...recording, status: 'normalizing' }
}

/**
 * Appends captured audio.
 *
 * Blocks arriving while paused are dropped rather than buffered: pausing is
 * meant to leave the pause out of the recording.
 */
export function writeChunk(samples: Buffer): void {
  if (!session) throw new RecordingError('No recording in progress')
  if (session.paused) return
  session.writer.write(samples)
}

export function setPaused(paused: boolean): void {
  if (!session) throw new RecordingError('No recording in progress')
  session.paused = paused
  emit('recording:pauseChanged', { paused })
}

/** Current session, for a freshly opened mini controls window to bootstrap from. */
export function getRecordingStatus(): { recordingId: string; paused: boolean } | null {
  return session ? { recordingId: session.recordingId, paused: session.paused } : null
}

export interface RecordingSummary {
  recordingId: string
  durationMs: number
  /** True if nothing was captured — the one track was entirely silent. */
  silent: boolean
}

/** Closes the file and leaves the recording ready to play. */
export async function stopRecording(): Promise<RecordingSummary> {
  if (!session) throw new RecordingError('No recording in progress')
  const current = session
  session = null
  // Every window still forwarding audio blocks (the renderer that owns the
  // capture graph, wherever Stop was actually clicked from) needs to stop
  // immediately — writing to a session that's already gone otherwise fails
  // silently, over and over, for however long the work below takes.
  emit('recording:sessionEnded', { recordingId: current.recordingId })

  setRecordingStatus(current.recordingId, 'normalizing')

  const { durationMs } = await current.writer.close()

  // A take that captured nothing must not be kept. Byte count is not the
  // test: system-audio loopback with nothing playing produces a full-length
  // file of zeroes, which is silent but far from empty.
  //
  // measurePeak reading the file at all is not guaranteed, rare as that
  // should be — treated the same as genuinely silent rather than failing the
  // whole stop over it.
  const peak = await measurePeak(current.writer.path).catch((err: unknown) => {
    console.warn('[recorder] could not read back the recording; treating it as silent:', err)
    return 0
  })
  const silent = peak < SILENCE_PEAK_THRESHOLD

  if (silent) {
    console.log(`[recorder] discarding silent recording (peak ${peak.toFixed(5)})`)
    await rm(current.writer.path, { force: true })
    setRecordingStatus(current.recordingId, 'failed', 'No audio was captured')
    const summary = { recordingId: current.recordingId, durationMs: 0, silent: true }
    emit('recording:stopped', summary)
    focusMainWindow()
    return summary
  }

  setRecordingDuration(current.recordingId, durationMs)
  setRecordingSourcePath(current.recordingId, current.writer.path)
  setRecordingStatus(current.recordingId, 'ready')

  const summary = { recordingId: current.recordingId, durationMs, silent: false }
  emit('recording:stopped', summary)
  focusMainWindow()
  return summary
}

/** Aborts and deletes everything captured so far, including the row. */
export async function cancelRecording(): Promise<void> {
  if (!session) return
  const current = session
  session = null
  // No lengthy work follows for a cancel, unlike stop — one event, right away.
  emit('recording:discarded', { recordingId: current.recordingId })
  focusMainWindow()

  await current.writer.close().catch(() => undefined)
  await rm(current.writer.path, { force: true })

  deleteRecording(current.recordingId)
  await rm(recordingMediaDir(current.recordingId), { recursive: true, force: true })
}
