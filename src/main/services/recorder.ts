import { rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { DEFAULT_MARKER_COLOR, type Marker, type Recording } from '@shared/types'
import {
  createRecording,
  deleteRecording,
  setRecordingDuration,
  setRecordingMarkers,
  setRecordingSourcePath,
  setRecordingStatus
} from '../db/recordings'
import { recordingMediaDir } from './storage'
import { emit } from '../ipc/events'
import { focusMainWindow } from '../windows/main-window'
import { WavWriter } from './wav-writer'
import { measurePeak, SILENCE_PEAK_THRESHOLD } from './peaks'
import { triggerAutoTranscribe } from './jobs'

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
  /** Accumulated pause time, for the gap-detection math below — not derived from `paused` toggles alone since those only mark when a pause started. */
  pausedMs: number
  pauseStartedAt: number | null
  /**
   * When the first chunk actually arrived. Gap detection is measured from
   * here rather than `startedAt`, so ordinary IPC/startup latency between
   * `startRecording` returning and the renderer's first `recording:chunk`
   * call is never mistaken for a dropout.
   */
  firstChunkAt: number | null
  /** Wall-clock time of the most recently written chunk — what the stall watchdog below polls. */
  lastChunkAt: number
  /** Whether the watchdog has already warned about the current stall, so it warns once per stall rather than every tick. */
  stalled: boolean
  /** Marked live, in the moment — see `addMarker` — and persisted once the recording stops. */
  markers: Marker[]
}

let session: Session | null = null

/**
 * How far audio-time-written is allowed to lag wall-clock time before a chunk
 * write pads the gap with silence — covers ordinary block-buffering jitter
 * (a worklet flushes every ~85-250ms depending on sample rate) without
 * masking a real dropout, e.g. while the renderer is re-acquiring a lost
 * source. Without this, a dropout just shortens the file, silently shifting
 * every marker and transcript timestamp after it.
 */
const GAP_JITTER_MS = 500

function padGapIfNeeded(current: Session): void {
  const wallClockMs = Date.now() - current.firstChunkAt! - current.pausedMs
  const gapMs = wallClockMs - current.writer.durationMs
  if (gapMs <= GAP_JITTER_MS) return

  const bytesPerSample = 2 // 16-bit PCM, this app's only format
  const bytesPerMs = (current.writer.sampleRate * current.writer.channels * bytesPerSample) / 1000
  const rawBytes = Math.round(gapMs * bytesPerMs)
  const sampleAlign = current.writer.channels * bytesPerSample
  const padBytes = rawBytes - (rawBytes % sampleAlign)
  if (padBytes <= 0) return

  console.warn(`[recorder] capture gap detected (~${gapMs}ms) — padding with silence`)
  current.writer.write(Buffer.alloc(padBytes))
}

/**
 * Polls for chunks having stopped arriving entirely — distinct from the gap
 * padding above, which reacts to a chunk that eventually does arrive late.
 * Main has no other way to notice a stalled capture graph: `writeChunk` is
 * otherwise completely content- and time-blind.
 */
const STALL_WATCHDOG_MS = 1500
let watchdogTimer: ReturnType<typeof setInterval> | null = null

function startWatchdog(): void {
  stopWatchdog()
  watchdogTimer = setInterval(() => {
    if (!session || session.paused) return
    const idleMs = Date.now() - session.lastChunkAt
    if (idleMs > STALL_WATCHDOG_MS && !session.stalled) {
      session.stalled = true
      console.warn(`[recorder] no audio chunks received for ${idleMs}ms`)
      emit('recording:captureWarning', {
        kind: 'graph',
        state: 'lost',
        message: 'Audio capture has stalled.'
      })
    } else if (idleMs <= STALL_WATCHDOG_MS && session.stalled) {
      session.stalled = false
      emit('recording:captureWarning', {
        kind: 'graph',
        state: 'recovered',
        message: 'Audio capture resumed.'
      })
    }
  }, 500)
}

function stopWatchdog(): void {
  if (watchdogTimer) {
    clearInterval(watchdogTimer)
    watchdogTimer = null
  }
}

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

  const startedAt = Date.now()
  session = {
    recordingId: recording.id,
    writer,
    startedAt,
    paused: false,
    pausedMs: 0,
    pauseStartedAt: null,
    firstChunkAt: null,
    lastChunkAt: startedAt,
    stalled: false,
    markers: []
  }
  startWatchdog()
  setRecordingStatus(recording.id, 'normalizing')
  emit('recording:started', { recordingId: recording.id })

  return { ...recording, status: 'normalizing' }
}

/**
 * Appends captured audio.
 *
 * Blocks arriving while paused are dropped rather than buffered: pausing is
 * meant to leave the pause out of the recording. A gap since the last chunk —
 * the renderer re-acquiring a lost source, say — is padded with silence
 * first, so what follows stays at its correct position instead of sliding
 * earlier by however long the gap was.
 */
export function writeChunk(samples: Buffer): void {
  if (!session) throw new RecordingError('No recording in progress')
  if (session.paused) return
  session.lastChunkAt = Date.now()
  if (session.firstChunkAt === null) {
    session.firstChunkAt = session.lastChunkAt
  } else {
    padGapIfNeeded(session)
  }
  session.writer.write(samples)
}

export function setPaused(paused: boolean): void {
  if (!session) throw new RecordingError('No recording in progress')
  if (paused === session.paused) return
  if (paused) {
    session.pauseStartedAt = Date.now()
  } else if (session.pauseStartedAt !== null) {
    session.pausedMs += Date.now() - session.pauseStartedAt
    session.pauseStartedAt = null
    // Resuming shouldn't immediately read as a gap: the time spent paused is
    // now excluded above, so the next chunk lines back up with wall clock.
    session.lastChunkAt = Date.now()
  }
  session.paused = paused
  emit('recording:pauseChanged', { paused })
}

/**
 * Marks the current moment, for a user who wants to jump back to it later
 * without waiting for the recording to finish first. `elapsedMs` comes from
 * the caller (Record.tsx's own paused-time-excluding timer, or the mini
 * window's relayed copy of it) since this module doesn't track elapsed time
 * itself — only `recording:elapsed` calls relay it, for the broadcast mini
 * windows read from. Held in memory and persisted for real by `stopRecording`,
 * the same way the rest of a session's state lives only here until then.
 */
export function addMarker(elapsedMs: number, color?: string): Marker {
  if (!session) throw new RecordingError('No recording in progress')
  const marker: Marker = {
    id: randomUUID(),
    timeMs: Math.max(0, elapsedMs),
    label: '',
    color: color || DEFAULT_MARKER_COLOR,
    notes: ''
  }
  session.markers.push(marker)
  emit('recording:markerAdded', marker)
  return marker
}

/**
 * Updates a note on a marker already added this session — the live
 * counterpart to `recordings:setMarkers`' whole-list replace, which only
 * applies to a recording that's already stopped. No separate persistence
 * step: this mutates the same in-memory `session.markers` objects
 * `stopRecording` writes out via `setRecordingMarkers` once the take ends.
 */
export function updateMarker(id: string, notes: string): Marker {
  if (!session) throw new RecordingError('No recording in progress')
  const marker = session.markers.find((m) => m.id === id)
  if (!marker) throw new RecordingError(`Marker ${id} not found`)
  marker.notes = notes
  emit('recording:markerUpdated', marker)
  return marker
}

/** Current session, for a freshly opened mini controls window to bootstrap from — including markers already added before it existed to see their broadcasts. */
export function getRecordingStatus(): { recordingId: string; paused: boolean; markers: Marker[] } | null {
  return session ? { recordingId: session.recordingId, paused: session.paused, markers: session.markers } : null
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
  stopWatchdog()
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
  if (current.markers.length > 0) {
    setRecordingMarkers(current.recordingId, current.markers, durationMs)
  }
  // Best-effort, no-op if no model is downloaded yet — see triggerAutoTranscribe's doc comment.
  triggerAutoTranscribe(current.recordingId)

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
  stopWatchdog()
  // No lengthy work follows for a cancel, unlike stop — one event, right away.
  emit('recording:discarded', { recordingId: current.recordingId })
  focusMainWindow()

  await current.writer.close().catch(() => undefined)
  await rm(current.writer.path, { force: true })

  deleteRecording(current.recordingId)
  await rm(recordingMediaDir(current.recordingId), { recursive: true, force: true })
}
