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
