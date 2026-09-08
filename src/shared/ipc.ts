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
  Platform,
  Recording
} from './types'

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
    response: { values: number[]; durationMs: number }
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
  'logs:read'
] as const satisfies readonly Channel[]

export const EVENTS = [
  'recording:updated',
  'import:progress',
  'recording:pauseChanged',
  'recording:elapsedTick',
  'recording:sessionEnded',
  'recording:stopped',
  'recording:discarded'
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
