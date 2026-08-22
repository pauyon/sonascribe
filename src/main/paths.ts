import { app } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Everything the app writes lives under Electron's per-user data directory, so
 * uninstalling is a single directory removal and nothing lands in the user's
 * Documents folder.
 *
 * Layout:
 *   <userData>/sonascribe.db  SQLite metadata (recordings, speakers, text)
 *   <userData>/media/         audio: originals and normalized 16k mono WAVs
 *   <userData>/models/        downloaded whisper + diarization models
 *
 * Audio and models are files on disk referenced by path, never SQLite BLOBs —
 * a multi-hour recording has no business travelling through the DB layer.
 */

function ensure(dir: string): string {
  mkdirSync(dir, { recursive: true })
  return dir
}

export function userDataPath(): string {
  return ensure(app.getPath('userData'))
}

export function dbPath(): string {
  return join(userDataPath(), 'sonascribe.db')
}

export function mediaPath(): string {
  return ensure(join(userDataPath(), 'media'))
}

export function modelsPath(): string {
  return ensure(join(userDataPath(), 'models'))
}

/** Per-recording media directory, holding the original plus derived WAV tracks. */
export function recordingMediaPath(recordingId: string): string {
  return ensure(join(mediaPath(), recordingId))
}

/**
 * The playback mixdown a multi-source recording gets, whether or not it exists.
 *
 * Named here rather than inside the recorder because the waveform resolver has
 * to test for the same file, and two modules agreeing on a filename by
 * coincidence is how a feature quietly stops working.
 *
 * Deliberately does not create the directory: callers probe this path to decide
 * whether a mix was made, and a probe must not have side effects.
 */
export function recordingMixPath(recordingId: string): string {
  return join(mediaPath(), recordingId, 'mix.source.wav')
}
