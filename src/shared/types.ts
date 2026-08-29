/**
 * Domain types shared by the main and renderer processes.
 *
 * These mirror the SQLite schema in src/main/db/migrations.ts. All times are
 * integer milliseconds so they survive IPC structured-clone without float drift
 * and can be compared directly against HTMLMediaElement.currentTime * 1000.
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
 * Lifecycle of a recording as it moves through the pipeline.
 *
 * The pipeline is: ingest -> (diarize || transcribe) -> merge -> ready.
 * `failed` is terminal until the user retries; `error` on the row explains why.
 */
export type RecordingStatus =
  | 'new'
  | 'normalizing'
  | 'queued'
  | 'transcribing'
  | 'diarizing'
  | 'merging'
  | 'ready'
  | 'failed'

/**
 * Which physical source a track was captured from.
 *
 * This distinction is what lets us skip diarization on `mic`: that track is by
 * definition the local user, so it gets a single known speaker rather than a
 * clustering pass. Only `system` (remote participants) needs diarizing.
 * `mixed` is used for imported files, where the two are already inseparable.
 */
export type TrackKind = 'mic' | 'system' | 'mixed'

export interface Recording {
  id: string
  title: string
  createdAt: number
  durationMs: number | null
  source: RecordingSource
  /** Original file as supplied/recorded. Played back in the editor for quality. */
  sourcePath: string | null
  status: RecordingStatus
  error: string | null
  /** Model that produced the current transcript, if any. */
  modelId: string | null
  /** Detected or configured spoken language of the transcript. */
  language: string | null
}

export interface Track {
  id: string
  recordingId: string
  kind: TrackKind
  /** 16 kHz mono PCM WAV — the only form the ML sidecars ever consume. */
  wavPath: string
  durationMs: number | null
}

export interface Speaker {
  id: string
  recordingId: string
  /**
   * Cluster index as emitted by the diarizer, or -1 for the synthetic local-user
   * speaker attached to the mic track. Stable across re-merges, which is what
   * lets a rename survive re-running the merge step.
   */
  clusterId: number
  displayName: string
  color: string
  /** Voice profile this speaker was recognised as, or linked to by hand. */
  profileId: string | null
}

/**
 * A saved sample of one person's voice, enrolled and matched automatically —
 * there is no per-profile control, only a global "forget everything."
 *
 * Matching works by anchoring the sample ahead of the real audio in a
 * diarization pass, not by comparing embedding vectors — the bundled
 * diarization CLI never exposes those. `sampleMs` is the anchor's own length,
 * needed to know how much of the analysis audio belongs to it rather than to
 * the recording being diarized. The name carries no meaning beyond whatever
 * generic label the speaker had when the profile was created — identifying
 * who's who is never the point, only telling one recurring voice apart from a
 * new one.
 */
export interface VoiceProfile {
  id: string
  displayName: string
  sampleMs: number
  createdAt: number
}

export interface Utterance {
  id: string
  recordingId: string
  speakerId: string | null
  startMs: number
  endMs: number
  text: string
  /** True once a human has edited the text, so re-merge won't clobber it. */
  edited: boolean
  /** Mean model confidence 0..1, or null if unknown. */
  confidence: number | null
  /**
   * Word timings for following along and for seeking by word.
   *
   * Empty when a human has edited the line: the words it was built from no
   * longer match the text, and highlighting the wrong ones is worse than
   * highlighting none.
   */
  words: TranscriptWordSpan[]
}

export interface Word {
  id: string
  utteranceId: string
  startMs: number
  endMs: number
  text: string
}

export interface Screenshot {
  id: string
  recordingId: string
  /** Elapsed time in the recording this was taken at. */
  timestampMs: number
  /** The source display's own name, e.g. "Screen 1" — shown when a snap covered more than one. */
  displayLabel: string
}

/** A recording plus everything needed to render its editor view. */
export interface TranscriptBundle {
  recording: Recording
  tracks: Track[]
  speakers: Speaker[]
  utterances: Utterance[]
  screenshots: Screenshot[]
}

/**
 * Sample rate every audio path converges on.
 *
 * Whisper requires 16 kHz mono; the recorder creates its AudioContext at this
 * rate so the browser resamples and the worklet emits ready-to-use PCM.
 */
export const TARGET_SAMPLE_RATE = 16_000

/** Which step of the ingest pipeline a progress update refers to. */
export type ImportStage = 'copying' | 'normalizing'

/** Which step of the ML pipeline a job progress update refers to. */
export type JobStage = 'transcribing' | 'diarizing' | 'merging'

export interface JobProgress {
  recordingId: string
  stage: JobStage
  /** 0..1, or null when the total is not yet known. */
  fraction: number | null
}

/**
 * A job in flight, as the main process remembers it.
 *
 * Progress used to exist only as an event, so it lived wherever the last event
 * happened to land — React state that a route unmount discarded. Leaving a
 * screen and coming back showed an empty bar and a restarted clock for a job
 * that had been running for twenty minutes. Main holds the current value so a
 * screen can ask for it on mount rather than waiting for the next tick.
 */
export interface ActiveJob {
  recordingId: string
  /** When the job was queued, so elapsed time survives navigation. */
  startedAt: number
  /**
   * Latest progress, or null while the job is still queued behind another.
   *
   * Null rather than a placeholder stage: a job waiting its turn is not
   * transcribing, and saying so would put a stage name and a percentage on
   * something that has not begun.
   */
  progress: JobProgress | null
}

export interface ImportProgress {
  recordingId: string
  stage: ImportStage
  /** 0..1, or null when the total length is not yet known. */
  fraction: number | null
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

/**
 * How eagerly diarization splits voices apart.
 *
 * Clustering has no notion of "right" without knowing the headcount, so this is
 * the one dial that matters when the count is unknown. Measured against
 * sherpa-onnx's own reference clips: 'balanced' is the only setting that gets
 * both their 2-speaker and 4-speaker recordings right, which is why it is the
 * default. 'split' is closer to the library's own defaults and finds a spurious
 * speaker or two; 'merge' errs the other way and can fuse two similar voices.
 */
export type SpeakerSplitting = 'merge' | 'balanced' | 'split'

export const SPEAKER_SPLITTING_VALUES: readonly SpeakerSplitting[] = [
  'merge',
  'balanced',
  'split'
] as const

/**
 * One window of text from a recording that is still being captured.
 *
 * Carries its own start time because windows are transcribed as they complete
 * and the display orders them itself — two tracks are being windowed at once and
 * neither finishes in step with the other.
 */
export interface LiveTranscriptChunk {
  recordingId: string
  kind: TrackKind
  startMs: number
  endMs: number
  text: string
}

/**
 * A recording as the library shows it: the row plus the start of its transcript.
 *
 * Separate from Recording so the preview travels only where it is wanted — the
 * editor already has every utterance and has no use for a truncated copy.
 */
export interface RecordingSummary extends Recording {
  /** First few hundred characters of the transcript, or null before there is one. */
  preview: string | null
}

/**
 * One word with its own timing, as the engine reported it.
 *
 * Named a span rather than a word because it is sometimes a fragment: engines
 * emit sub-word pieces, and the merge joins them into whole words before they
 * are stored, but the timing is still a span of audio rather than a token.
 */
export interface TranscriptWordSpan {
  startMs: number
  endMs: number
  text: string
}
