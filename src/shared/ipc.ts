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
  ActiveJob,
  CreateRecordingInput,
  LiveTranscriptChunk,
  ImportProgress,
  JobProgress,
  Platform,
  Recording,
  RecordingSummary,
  Screenshot,
  SpeakerSplitting,
  TrackKind,
  TranscriptBundle
} from './types'
import type { ModelDownloadProgress, ModelStatus } from './models'
import type { ExportFormat } from './export'

export interface ApiSchema {
  'recordings:list': {
    request: void
    response: RecordingSummary[]
  }
  'recordings:get': {
    request: { id: string }
    response: TranscriptBundle | null
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
      modelsPath: string
      /** False when the ffmpeg sidecar is missing, so the UI can explain why. */
      ffmpegAvailable: boolean
      /** False when whisper-cli is missing — the common case on macOS. */
      whisperAvailable: boolean
      /** False when parakeet-cli is missing. Ships in the same archive as whisper-cli. */
      parakeetAvailable: boolean
      /** False when the diarization helper or its models are missing. */
      diarizationAvailable: boolean
    }
  }

  /** Installed/downloading state for every model in the catalogue. */
  'models:list': {
    request: void
    response: ModelStatus[]
  }
  /** Starts a resumable download. Progress arrives via `model:progress`. */
  'models:download': {
    request: { id: string }
    response: void
  }
  'models:cancel': {
    request: { id: string }
    response: void
  }
  'models:delete': {
    request: { id: string }
    response: void
  }

  'settings:get': {
    request: void
    response: TranscriptionSettings
  }
  'settings:set': {
    request: Partial<TranscriptionSettings>
    response: TranscriptionSettings
  }

  /**
   * Queues transcription. Returns once queued, not once finished — progress
   * arrives via `job:progress` and completion via `recording:updated`.
   */
  'transcribe:start': {
    request: { id: string }
    response: void
  }
  'transcribe:cancel': {
    request: { id: string }
    response: void
  }
  /** Recording ids with a queued or in-flight job, for restoring UI state. */
  /**
   * Jobs currently queued or running, with their latest progress.
   *
   * Returned in full rather than as bare ids so a screen opening mid-job can
   * show the real stage, percentage and elapsed time immediately, instead of an
   * empty bar until the next progress event happens to arrive.
   */
  'transcribe:active': {
    request: void
    response: ActiveJob[]
  }

  /**
   * Waveform envelope for a recording, computed in the main process.
   *
   * Keyed by recording rather than by track: which file the waveform should
   * describe is the playback mixdown when there is one, and the renderer has no
   * way to know whether one was written. Main resolves it so the waveform and
   * the audio can never disagree.
   *
   * The renderer cannot fetch the audio itself (Chromium blocks fetch to custom
   * schemes), and would not want to: this returns ~2 kB instead of hundreds of
   * megabytes of PCM.
   */
  'peaks:get': {
    request: { recordingId: string; buckets?: number }
    response: { values: number[]; durationMs: number }
  }

  /** Rewrites one utterance's text and flags it as human-edited. */
  'utterances:update': {
    request: { id: string; text: string }
    response: void
  }
  /**
   * Removes one line permanently — for a diarization false-positive (a cough or
   * background noise mistaken for speech) rather than something worth keeping
   * and just misattributed. The renderer defers this call behind an undo
   * window, so by the time it arrives it is final.
   */
  'utterances:delete': {
    request: { id: string }
    response: void
  }

  /**
   * Renders the transcript and asks the user where to save it.
   * Returns the written path, or null if the save dialog was cancelled.
   *
   * `includeScreenshots` copies the recording's screenshots into a folder
   * alongside the exported file and links them from it — ignored for `srt`
   * and `vtt`, neither of which has a sensible way to carry an inline image.
   */
  'transcript:export': {
    request: { id: string; format: ExportFormat; includeScreenshots: boolean }
    response: string | null
  }

  'speakers:rename': {
    request: { id: string; displayName: string }
    response: void
  }
  /**
   * Folds one speaker into another.
   *
   * Diarization routinely splits a single person across two clusters when their
   * voice changes, so merging is the primary correction the editor needs.
   */
  'speakers:merge': {
    request: { recordingId: string; fromId: string; intoId: string }
    response: void
  }
  /** Moves one line to a different speaker. */
  'speakers:reassign': {
    request: { utteranceId: string; speakerId: string | null }
    response: void
  }
  /**
   * Removes a speaker and every line attributed to them.
   *
   * For a cluster that turns out to be entirely background noise or a
   * diarization artifact, rather than a real person worth keeping and just
   * misattributed — reassigning covers that case instead.
   */
  'speakers:delete': {
    request: { id: string }
    response: void
  }

  /**
   * Opens WAV writers and returns the new recording row.
   *
   * The renderer has already acquired its streams by this point, so `kinds`
   * reflects what it actually managed to open — system audio may have been
   * declined without that failing the whole recording.
   */
  'recording:start': {
    request: { title?: string; kinds: TrackKind[]; sampleRate: number }
    response: Recording
  }
  /** Appends one block of 16-bit PCM to a track. */
  'recording:chunk': {
    request: { kind: TrackKind; samples: Uint8Array }
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
      tracks: Array<{ kind: TrackKind; durationMs: number }>
      /**
       * Tracks discarded for carrying no signal — system-audio loopback with
       * nothing playing, most often. Reported so the UI can say what happened
       * instead of a source quietly vanishing.
       */
      silentTracks: TrackKind[]
    }
  }
  /** Discards an in-progress recording and everything captured so far. */
  'recording:cancel': {
    request: void
    response: void
  }

  /**
   * Opens the mini controls window for the in-progress recording, or focuses
   * it if it is already open. A small always-on-top window with pause/resume
   * and the live transcript, so those stay reachable with the main window
   * minimized.
   */
  'recording:openMiniControls': {
    request: void
    response: void
  }
  /**
   * Current recording session, for the mini window to show the right state
   * the moment it opens rather than waiting for the next broadcast — the
   * same reason `transcribe:active` exists for Editor.tsx.
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
  /** Resizes the mini window between its collapsed and expanded presets. */
  'recording:resizeMiniControls': {
    request: { expanded: boolean }
    response: void
  }

  /**
   * Snaps a screenshot of every connected display (or just the one chosen in
   * Settings, if any) and attaches it to the recording at the given elapsed
   * time. One row per display — a two-monitor snap returns two.
   */
  'screenshots:capture': {
    request: { recordingId: string; elapsedMs: number }
    response: Screenshot[]
  }
  /** Removes one screenshot — the row and its file. */
  'screenshots:delete': {
    request: { id: string }
    response: void
  }
  /** Currently connected displays, for the "which screen" Settings dropdown. */
  'screenshots:listDisplays': {
    request: void
    response: Array<{ id: string; name: string }>
  }

  /** Reveals a file in the OS file manager, selected — for jumping to an export. */
  'shell:showItemInFolder': {
    request: { path: string }
    response: void
  }
}

export interface TranscriptionSettings {
  modelId: string | null
  language: string
  /** Run speaker diarization after transcription. */
  diarize: boolean
  /** Upper bound on the speaker count, or null to cluster automatically. */
  speakerCount: number | null
  /**
   * How eagerly to split voices apart when the count is unknown.
   *
   * Ignored when speakerCount is set: a fixed cluster count makes the distance
   * threshold irrelevant.
   */
  speakerSplitting: SpeakerSplitting
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
   * Route the microphone through WebRTC echo cancellation and automatic gain.
   *
   * This is the pair that makes a recording sound like a phone call. Worth
   * enabling only when recording a laptop mic with sound playing from its own
   * speakers, where echo cancellation stops the far end being captured twice.
   */
  echoCancellation: boolean
  /**
   * The microphone carries only the local user's voice.
   *
   * True skips diarizing the mic track and labels it "You" — correct for a
   * call. False (the default) diarizes it like any other source, which is what
   * several people sharing one microphone requires.
   */
  micSoloSpeaker: boolean
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
  /**
   * Which display a screenshot snap captures, by `desktopCapturer` source id.
   * Null (the default) means every connected display. A stale id — a
   * monitor that's since been unplugged — falls back to every display
   * rather than capturing nothing.
   */
  screenshotDisplayId: string | null
}

/** Payloads pushed from main to renderer. */
export interface EventSchema {
  /** A recording row changed: status, duration or title. */
  'recording:updated': Recording
  /** Fine-grained progress for an in-flight ingest job. */
  'import:progress': ImportProgress
  /** Progress for a transcription/diarization job. */
  'job:progress': JobProgress
  /** Progress for a model download. */
  'model:progress': ModelDownloadProgress
  /**
   * A window of text transcribed while the recording is still running.
   *
   * One event per completed window, carrying only that window's text rather than
   * the transcript so far: a two-hour recording accumulates tens of thousands of
   * words, and resending all of them every forty-five seconds would put the
   * whole transcript through the bridge over and over. The renderer appends.
   */
  'live:transcript': LiveTranscriptChunk
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
   * A stop has begun and the session is gone in main, ahead of the (possibly
   * several-second) normalize/mixdown work `recording:stopped` waits for.
   * Every window still forwarding audio blocks needs to stop immediately —
   * writing to a session that's already gone otherwise fails silently, over
   * and over, for however long that work takes.
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
    tracks: Array<{ kind: TrackKind; durationMs: number }>
    silentTracks: TrackKind[]
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
  'dialog:pickMediaFiles',
  'recordings:import',
  'app:info',
  'models:list',
  'models:download',
  'models:cancel',
  'models:delete',
  'settings:get',
  'settings:set',
  'transcribe:start',
  'transcribe:cancel',
  'transcribe:active',
  'peaks:get',
  'utterances:update',
  'utterances:delete',
  'transcript:export',
  'speakers:rename',
  'speakers:merge',
  'speakers:reassign',
  'speakers:delete',
  'recording:start',
  'recording:chunk',
  'recording:pause',
  'recording:stop',
  'recording:cancel',
  'recording:openMiniControls',
  'recording:status',
  'recording:elapsed',
  'recording:resizeMiniControls',
  'screenshots:capture',
  'screenshots:delete',
  'screenshots:listDisplays',
  'shell:showItemInFolder'
] as const satisfies readonly Channel[]

export const EVENTS = [
  'recording:updated',
  'import:progress',
  'job:progress',
  'model:progress',
  'live:transcript',
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

/** URL for a normalized track's WAV. */
export function trackMediaUrl(trackId: string): string {
  return `${MEDIA_SCHEME}://track/${trackId}`
}

/** URL for a recording's original, un-normalized file. */
export function sourceMediaUrl(recordingId: string): string {
  return `${MEDIA_SCHEME}://source/${recordingId}`
}

/** URL for one screenshot's PNG. */
export function screenshotMediaUrl(screenshotId: string): string {
  return `${MEDIA_SCHEME}://screenshot/${screenshotId}`
}
