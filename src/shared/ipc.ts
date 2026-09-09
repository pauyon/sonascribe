/**
 * The IPC contract.
 *
 * `ApiSchema` (renderer -> main, request/response) and `EventSchema`
 * (main -> renderer, push) are the single source of truth for what may cross
 * the process boundary. The preload bridge, the main-process handler registry
 * and the renderer's `window.api` typing are all derived from them, so a channel
 * cannot be added on one side without the other side failing to compile. That is
 * the whole point of routing everything through here.
 */

import type {
  CreateRecordingInput,
  Cut,
  ImportProgress,
  Marker,
  Platform,
  Recording,
  Speaker,
  Utterance
} from './types'
import type { AsrEngine, ModelDownloadProgress, ModelStatus } from './models'
import type { ExportFormat } from './export'

export interface ApiSchema {
  'recordings:list': {
    request: void
    response: Recording[]
  }
  'recordings:get': {
    request: { id: string }
    response: Recording | null
  }
  'recordings:create': {
    request: CreateRecordingInput
    response: Recording
  }
  'recordings:rename': {
    request: { id: string; title: string }
    response: Recording
  }
  'recordings:delete': {
    request: { id: string }
    response: void
  }
  /**
   * Replaces a recording's whole cut list — non-destructive trim regions in
   * the original file's own time. The renderer always sends the full desired
   * list (add, remove-one, and clear-all are all just "here's the new
   * list"); the response comes back normalized (clamped, sorted, merged) so
   * the caller's local state matches exactly what was persisted.
   */
  'recordings:setCuts': {
    request: { id: string; cuts: Cut[] }
    response: Recording
  }
  /**
   * Replaces a recording's whole marker list — labeled, colored jump-to
   * points in the original file's own time. Same whole-list-replace shape as
   * `recordings:setCuts`: add/rename/recolor/remove are all "here's the new
   * list."
   */
  'recordings:setMarkers': {
    request: { id: string; markers: Marker[] }
    response: Recording
  }
  /**
   * Opens the native file picker. Returns absolute paths, or an empty array if
   * the user cancelled.
   */
  'dialog:pickMediaFiles': {
    request: void
    response: string[]
  }
  /**
   * Queues one ingest job per path and returns immediately with the created
   * rows in `normalizing` state. Completion arrives via the `recording:updated`
   * event — importing a long video takes far too long to block an IPC call on.
   */
  'recordings:import': {
    request: { paths: string[] }
    response: Recording[]
  }
  'app:info': {
    request: void
    response: {
      version: string
      platform: Platform
      userDataPath: string
      mediaPath: string
      /** Current log file, so a "reveal logs" affordance can point at it. */
      logPath: string
      /** False when the ffmpeg sidecar is missing, so the UI can explain why importing is disabled. */
      ffmpegAvailable: boolean
      /** Engines whose sidecar binary actually resolves on this machine/platform — see `services/sidecars.ts`. */
      availableEngines: AsrEngine[]
    }
  }

  'settings:get': {
    request: void
    response: RecordingSettings
  }
  'settings:set': {
    request: Partial<RecordingSettings>
    response: RecordingSettings
  }

  /** Where recordings' audio files currently live, and what the default would be. */
  'storage:get': {
    request: void
    response: { mediaRoot: string; isDefault: boolean; defaultMediaRoot: string }
  }
  /** Opens the native folder picker. Returns the chosen path, or null if cancelled. */
  'storage:pickFolder': {
    request: void
    response: string | null
  }
  /**
   * Moves every recording's audio into `folder` and makes it the new home for
   * future ones. Rejects while a recording is in progress. Can take a while
   * for a large library — the call does not resolve until the move (and every
   * recording's updated path) is complete.
   */
  'storage:relocate': {
    request: { folder: string }
    response: { mediaRoot: string }
  }

  /**
   * Waveform envelope for a recording, computed in the main process.
   *
   * The renderer cannot fetch the audio itself (Chromium blocks fetch to custom
   * schemes), and would not want to: this returns ~2 kB instead of hundreds of
   * megabytes of PCM.
   */
  'peaks:get': {
    request: { recordingId: string; buckets?: number }
    /** The real (signed) waveform envelope per bucket — `min` <= 0 <= `max`. */
    response: { min: number[]; max: number[]; durationMs: number }
  }

  /**
   * Opens WAV writers and returns the new recording row.
   *
   * The renderer has already acquired its streams by this point, so `kinds`
   * reflects what it actually managed to open — system audio may have been
   * declined without that failing the whole recording.
   */
  'recording:start': {
    request: { title?: string; hasSystemAudio: boolean; sampleRate: number }
    response: Recording
  }
  /** Appends one block of 16-bit PCM — mic and system audio already mixed together (see lib/capture.ts). */
  'recording:chunk': {
    request: { samples: Uint8Array }
    response: void
  }
  'recording:pause': {
    request: { paused: boolean }
    response: void
  }
  'recording:stop': {
    request: void
    response: {
      recordingId: string
      durationMs: number
      /** True if nothing was captured — mic and system audio both silent — so the UI can say what happened. */
      silent: boolean
    }
  }
  /** Discards an in-progress recording and everything captured so far. */
  'recording:cancel': {
    request: void
    response: void
  }

  /**
   * Opens the mini controls window for the in-progress recording, or focuses
   * it if it is already open. A small always-on-top window with pause/resume,
   * so those stay reachable with the main window minimized.
   */
  'recording:openMiniControls': {
    request: void
    response: void
  }
  /**
   * Current recording session, for the mini window to show the right state
   * the moment it opens rather than waiting for the next broadcast.
   */
  'recording:status': {
    request: void
    response: { recordingId: string; paused: boolean } | null
  }
  /**
   * Relays the elapsed time Record.tsx already tracks (it alone accounts for
   * paused spans) out to every window via `recording:elapsedTick`, so the
   * mini window doesn't need its own copy of that bookkeeping.
   */
  'recording:elapsed': {
    request: { elapsedMs: number }
    response: void
  }

  /** Reveals a file in the OS file manager, selected. */
  'shell:showItemInFolder': {
    request: { path: string }
    response: void
  }

  /**
   * The current log file's contents, for the in-app viewer — so a user who
   * hits a problem can copy diagnostics without hunting down the file path
   * themselves. Empty string if nothing has been logged yet.
   */
  'logs:read': {
    request: void
    response: string
  }

  /** Every catalogued model's on-disk/download state, for the Settings picker. */
  'models:list': {
    request: void
    response: ModelStatus[]
  }
  /**
   * Starts (or, if already downloading, no-ops on) a resumable download.
   * Progress arrives via `model:progress`; this resolves once the file is on
   * disk and verified.
   */
  'models:download': {
    request: { modelId: string }
    response: void
  }
  'models:cancelDownload': {
    request: { modelId: string }
    response: void
  }
  'models:delete': {
    request: { modelId: string }
    response: void
  }

  'transcription:getSettings': {
    request: void
    response: TranscriptionSettings
  }
  'transcription:setSettings': {
    request: {
      engine?: AsrEngine
      /** Only the engine(s) actually changing need to be included. */
      modelId?: Partial<Record<AsrEngine, string>>
      language?: string
    }
    response: TranscriptionSettings
  }

  /**
   * Queues transcription for a recording using the currently selected engine
   * and model. Throws synchronously for anything the user can fix immediately
   * (no model chosen, model not installed, already running) rather than
   * queuing a job that fails a moment later.
   */
  'transcript:start': {
    request: { recordingId: string }
    response: void
  }
  'transcript:cancel': {
    request: { recordingId: string }
    response: void
  }
  /** A recording's utterances (each with its words), in playback order. Empty until a transcript exists. */
  'transcript:get': {
    request: { recordingId: string }
    response: Utterance[]
  }
  /** Corrects one utterance's text by hand — replaces the ASR result outright, so its per-word timings/highlighting are gone from that line afterward. */
  'transcript:editUtterance': {
    request: { utteranceId: string; text: string }
    response: void
  }
  /** Splits one utterance into two at a word boundary — for two people's sentences the diarizer ran together into one line. Both halves keep their real per-word timing; the second half starts credited to the same speaker as the original. */
  'transcript:splitUtterance': {
    request: { utteranceId: string; wordIndex: number }
    response: void
  }
  /**
   * Every recording currently queued or transcribing, with its latest known
   * progress — the source a freshly (re)mounted page reads from, so a
   * percentage already in flight survives navigating away and back rather
   * than resetting to unknown.
   */
  'transcript:listActive': {
    request: void
    response: Array<{ recordingId: string; fraction: number | null }>
  }
  /** Writes a transcript to a user-chosen file. Returns the chosen path, or null if the user cancelled. */
  'transcript:export': {
    request: { recordingId: string; format: ExportFormat }
    response: string | null
  }
  /** Copies a recording's original audio file to a user-chosen location. Returns the chosen path, or null if the user cancelled. */
  'audio:export': {
    request: { recordingId: string }
    response: string | null
  }

  /**
   * Queues speaker detection for a recording — only meaningful once it has
   * a transcript, and re-runnable afterward. Same synchronous-claim-then-
   * validate shape as `transcript:start`.
   */
  'speakers:detect': {
    request: { recordingId: string }
    response: void
  }
  'speakers:cancel': {
    request: { recordingId: string }
    response: void
  }
  /** Every speaker detected in a recording, in cluster order. Empty until detection has run. */
  'speakers:list': {
    request: { recordingId: string }
    response: Speaker[]
  }
  /** Adds a new, empty speaker — for correcting an undercount (diarization missed someone entirely) rather than a misattribution, which `reassignUtterance` covers. Named/colored the same way detection names/colors one, and lines are reassigned to it by hand afterward. */
  'speakers:create': {
    request: { recordingId: string }
    response: Speaker
  }
  'speakers:rename': {
    request: { id: string; displayName: string }
    response: Speaker
  }
  /** Sets a speaker's color, swapping it with whoever in the recording currently has it — see db/speakers.ts. */
  'speakers:recolor': {
    request: { recordingId: string; id: string; color: string }
    response: void
  }
  /** Folds `fromId`'s lines into `intoId` and removes `fromId` — for a voice diarization split across two clusters. */
  'speakers:merge': {
    request: { recordingId: string; fromId: string; intoId: string }
    response: void
  }
  /** Moves one utterance to a different speaker, for a single misattributed line. */
  'speakers:reassignUtterance': {
    request: { utteranceId: string; speakerId: string | null }
    response: void
  }
  /** Removes a speaker and every line attributed to them — for a cluster that was never a real person. */
  'speakers:delete': {
    request: { id: string }
    response: void
  }
  /** Removes a speaker but leaves their lines in place, unassigned — for a speaker who shouldn't have been split out, as opposed to a diarization artifact whose lines were never real content. */
  'speakers:deleteKeepingLines': {
    request: { id: string }
    response: void
  }
  /** Same shape as `transcript:listActive`, for speaker detection jobs. */
  'speakers:listActive': {
    request: void
    response: Array<{ recordingId: string; fraction: number | null }>
  }
}

export interface RecordingSettings {
  /**
   * Apply WebRTC noise suppression to the microphone.
   *
   * Gates out steady background noise (fans, hum, keyboard) without echo
   * cancellation or gain riding along, so — unlike `echoCancellation` below —
   * it does not carry the "on a call" character. Off by default because on a
   * decent microphone it still trades a little fidelity for the noise floor.
   */
  noiseSuppression: boolean
  /**
   * Route the microphone through WebRTC echo cancellation.
   *
   * This is what makes a recording sound like a phone call. Worth enabling
   * only when recording a laptop mic with sound playing from its own
   * speakers, where echo cancellation stops the far end being captured twice.
   *
   * Automatic gain control has no matching setting: the Record screen turns
   * it on unconditionally, since — unlike this — it carries no "on a call"
   * character and there's no real case for wanting it off.
   */
  echoCancellation: boolean
  /** Last-used microphone, by device id, or null for the system default. */
  micDeviceId: string | null
  /** Last-used choice for whether to also capture system audio. */
  captureSystemAudio: boolean
  /**
   * Open the mini controls window automatically when the main window is
   * minimized during a recording, rather than requiring "Pop out controls"
   * to be clicked first.
   */
  autoPopOutOnMinimize: boolean
}

export interface TranscriptionSettings {
  engine: AsrEngine
  /**
   * Model id per engine, so switching engines remembers each one's own
   * choice — the last one explicitly picked, or a sensible suggested
   * default (not necessarily installed yet) if none has been.
   */
  modelId: Record<AsrEngine, string>
  /** Language hint for Whisper. Ignored by Parakeet, which always auto-detects. */
  language: string
}

/** Payloads pushed from main to renderer. */
export interface EventSchema {
  /** A recording row changed: status, duration or title. */
  'recording:updated': Recording
  /** Fine-grained progress for an in-flight ingest job. */
  'import:progress': ImportProgress
  /**
   * Pause state changed, from whichever window (main or mini controls)
   * toggled it. Both treat `paused` as derived from this rather than
   * setting it locally, so either window's button stays correct no matter
   * which one was clicked.
   */
  'recording:pauseChanged': { paused: boolean }
  /** Relayed elapsed time, from Record.tsx's `recording:elapsed` calls. */
  'recording:elapsedTick': { elapsedMs: number }
  /**
   * A stop has begun and the session is gone in main, ahead of the (brief)
   * finalize work `recording:stopped` waits for. Every window still
   * forwarding audio blocks needs to stop immediately — writing to a session
   * that's already gone otherwise fails silently, over and over.
   */
  'recording:sessionEnded': { recordingId: string }
  /**
   * A recording finished successfully (or failed for lack of any audio) and
   * is fully processed — the same result `recording:stop` resolves with,
   * broadcast so whichever window didn't initiate the stop can react too.
   */
  'recording:stopped': {
    recordingId: string
    durationMs: number
    silent: boolean
  }
  /** A recording was discarded — mirrors `recording:stopped` for the cancel path. */
  'recording:discarded': { recordingId: string }

  /** Byte-level progress for an in-flight model download. */
  'model:progress': ModelDownloadProgress
  /** Fractional progress for an in-flight transcription, or null when the engine can't report one. */
  'transcript:progress': { recordingId: string; fraction: number | null }
  /** Fractional progress for an in-flight speaker detection, or null when not yet known. */
  'speaker:progress': { recordingId: string; fraction: number | null }
}

export type Channel = keyof ApiSchema
export type Request<C extends Channel> = ApiSchema[C]['request']
export type Response<C extends Channel> = ApiSchema[C]['response']

export type EventName = keyof EventSchema
export type EventPayload<E extends EventName> = EventSchema[E]

/**
 * Every channel the preload bridge is allowed to expose. Derived from the schema
 * rather than written by hand so it can never drift out of sync.
 */
export const CHANNELS = [
  'recordings:list',
  'recordings:get',
  'recordings:create',
  'recordings:rename',
  'recordings:delete',
  'recordings:setCuts',
  'recordings:setMarkers',
  'dialog:pickMediaFiles',
  'recordings:import',
  'app:info',
  'settings:get',
  'settings:set',
  'storage:get',
  'storage:pickFolder',
  'storage:relocate',
  'peaks:get',
  'recording:start',
  'recording:chunk',
  'recording:pause',
  'recording:stop',
  'recording:cancel',
  'recording:openMiniControls',
  'recording:status',
  'recording:elapsed',
  'shell:showItemInFolder',
  'logs:read',
  'models:list',
  'models:download',
  'models:cancelDownload',
  'models:delete',
  'transcription:getSettings',
  'transcription:setSettings',
  'transcript:start',
  'transcript:cancel',
  'transcript:get',
  'transcript:editUtterance',
  'transcript:splitUtterance',
  'transcript:listActive',
  'transcript:export',
  'audio:export',
  'speakers:detect',
  'speakers:cancel',
  'speakers:list',
  'speakers:create',
  'speakers:rename',
  'speakers:recolor',
  'speakers:merge',
  'speakers:reassignUtterance',
  'speakers:delete',
  'speakers:deleteKeepingLines',
  'speakers:listActive'
] as const satisfies readonly Channel[]

export const EVENTS = [
  'recording:updated',
  'import:progress',
  'recording:pauseChanged',
  'recording:elapsedTick',
  'recording:sessionEnded',
  'recording:stopped',
  'recording:discarded',
  'model:progress',
  'transcript:progress',
  'speaker:progress'
] as const satisfies readonly EventName[]

/**
 * Shape of the `window.api` object the preload script installs.
 *
 * Channels whose request type is `void` take no argument; all others require
 * exactly one. The conditional keeps `api.invoke('recordings:list')` legal while
 * still forcing a payload on `recordings:get`.
 */
export type RendererApi = {
  invoke<C extends Channel>(
    ...args: Request<C> extends void ? [channel: C] : [channel: C, payload: Request<C>]
  ): Promise<Response<C>>
  /** Subscribes to a push event. Returns an unsubscribe function. */
  on<E extends EventName>(event: E, listener: (payload: EventPayload<E>) => void): () => void
  /**
   * Absolute path of a dropped File.
   *
   * Electron 32 removed the non-standard `File.path` property, so a drop target
   * has no way to learn the real path without asking the preload layer.
   */
  getPathForFile(file: File): string
}

/** Media served to the renderer goes through this scheme, never file://. */
export const MEDIA_SCHEME = 'sonascribe-media'

/** URL for a recording's one audio file. */
export function sourceMediaUrl(recordingId: string): string {
  return `${MEDIA_SCHEME}://source/${recordingId}`
}
