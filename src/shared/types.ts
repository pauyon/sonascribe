/**
 * Domain types shared by the main and renderer processes.
 *
 * These mirror the `recordings` table in src/main/db/migrations.ts. All times
 * are integer milliseconds so they survive IPC structured-clone without float
 * drift and can be compared directly against HTMLMediaElement.currentTime * 1000.
 */

/**
 * Host platform, narrowed to the ones this app targets.
 *
 * Declared here rather than reusing `NodeJS.Platform` so the shared types stay
 * compilable in the renderer, which has no Node type definitions.
 */
export type Platform = 'darwin' | 'win32' | 'linux'

/** Where a recording's audio originally came from. */
export type RecordingSource = 'recorded' | 'imported'

/**
 * A recording's lifecycle: captured/imported, briefly finalized to a clean
 * WAV, then playable — or failed if no usable audio ever existed.
 */
export type RecordingStatus = 'new' | 'normalizing' | 'ready' | 'failed'

/**
 * A recording's transcript, independent of `RecordingStatus` — a recording
 * can be `ready` to play with no transcript at all, one queued or in
 * progress, or one that failed and can be retried.
 */
export type TranscriptStatus = 'none' | 'queued' | 'transcribing' | 'ready' | 'failed'

/**
 * Speaker detection's own lifecycle, independent of `TranscriptStatus` — it
 * only ever runs against an existing transcript, on demand, and is
 * re-runnable.
 */
export type SpeakerStatus = 'none' | 'queued' | 'detecting' | 'ready' | 'failed'

/** A non-destructive trim region, in the original file's own time. */
export interface Cut {
  startMs: number
  endMs: number
}

/** A labeled, colored jump-to point, in the original file's own time. */
export interface Marker {
  id: string
  timeMs: number
  label: string
  color: string
}

/**
 * A warm amber rather than the app's own accent blue: a new marker's default
 * color used to match the waveform's "played" bar fill exactly (both drew
 * from `--accent-strong`), which read fine against the light theme's near-
 * white waveform panel but all but vanished against the dark theme's navy
 * one. Picked from `SPEAKER_COLORS` for the same colourblind-safe reasoning
 * that palette was built for. Shared rather than renderer-only so a marker
 * added live during a recording (main process) gets the identical default a
 * marker added during playback (renderer) does.
 */
export const DEFAULT_MARKER_COLOR = '#e5a43b'

export interface Recording {
  id: string
  title: string
  createdAt: number
  durationMs: number | null
  source: RecordingSource
  /** The recording's one audio file — mic+system mixed in real time for a live take, or the normalized copy of an imported file. */
  sourcePath: string | null
  status: RecordingStatus
  error: string | null
  /**
   * Trimmed-out regions, original-file time, sorted and non-overlapping.
   * The file itself is never touched — see `renderer/src/lib/cuts.ts` for how
   * these become a compressed waveform and playback position.
   */
  cuts: Cut[]
  /** Jump-to points, original-file time, sorted by `timeMs`. */
  markers: Marker[]
  transcriptStatus: TranscriptStatus
  transcriptError: string | null
  /** Id of the model that produced the current transcript, or null if there isn't one. */
  modelId: string | null
  /** Language the current transcript was produced in (a Whisper hint, or an engine's own detection). Null until a transcript exists. */
  language: string | null
  /** A short snippet of the transcript, for the library card. Null until a transcript exists. */
  transcriptPreview: string | null
  speakerStatus: SpeakerStatus
  speakerError: string | null
}

/** A word with timings, part of an `Utterance`. */
export interface TranscriptWord {
  text: string
  startMs: number
  endMs: number
  /** Model confidence 0..1. 1 for a word persisted before this was tracked. */
  probability: number
}

/** A named, colored voice detected in one recording — never shared across recordings. */
export interface Speaker {
  id: string
  recordingId: string
  /** The diarizer's cluster index — internal, never shown; identity for a re-run to reattach to the same row. */
  clusterId: number
  displayName: string
  color: string
}

/** One contiguous span of speech in a recording's transcript. */
export interface Utterance {
  id: string
  recordingId: string
  startMs: number
  endMs: number
  text: string
  words: TranscriptWord[]
  /** Mean word confidence 0..1, or null when the engine didn't report one. */
  confidence: number | null
  /** Who said this, once speaker detection has run. Null beforehand, or if this line couldn't be attributed to anyone. */
  speaker: { id: string; name: string; color: string } | null
}

/**
 * Container extensions the importer accepts. ffmpeg reads far more than this;
 * the list exists to populate the file picker and to reject obvious mistakes
 * early rather than to limit what can be decoded.
 */
export const SUPPORTED_MEDIA_EXTENSIONS = [
  'mp3',
  'm4a',
  'aac',
  'wav',
  'flac',
  'ogg',
  'opus',
  'wma',
  'aiff',
  'mp4',
  'mov',
  'mkv',
  'webm',
  'avi',
  'm4v'
] as const

export interface CreateRecordingInput {
  title: string
  source: RecordingSource
  sourcePath?: string | null
}

export interface ImportProgress {
  recordingId: string
  /** 0..1, or null when the total length is not yet known. */
  fraction: number | null
}
