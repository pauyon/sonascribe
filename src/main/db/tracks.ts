import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import type { RecordingStatus, Track, TrackKind } from '@shared/types'
import { getDb } from './index'
import { recordingMixPath } from '../paths'

/** Track rows plus the recording-status mutations the pipeline performs. */

export function createTrack(input: {
  recordingId: string
  kind: TrackKind
  wavPath: string
  durationMs: number | null
}): Track {
  const track: Track = {
    id: randomUUID(),
    recordingId: input.recordingId,
    kind: input.kind,
    wavPath: input.wavPath,
    durationMs: input.durationMs
  }

  getDb()
    .prepare(
      `INSERT INTO tracks (id, recording_id, kind, wav_path, duration_ms)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(track.id, track.recordingId, track.kind, track.wavPath, track.durationMs)

  return track
}

export function listTracks(recordingId: string): Track[] {
  const rows = getDb()
    .prepare('SELECT * FROM tracks WHERE recording_id = ?')
    .all(recordingId) as unknown as Array<{
    id: string
    recording_id: string
    kind: string
    wav_path: string
    duration_ms: number | null
  }>

  return rows.map((r) => ({
    id: r.id,
    recordingId: r.recording_id,
    kind: r.kind as TrackKind,
    wavPath: r.wav_path,
    durationMs: r.duration_ms
  }))
}

/**
 * The WAV the editor draws its waveform from.
 *
 * The playback mixdown when a recording has one, so the envelope describes what
 * is actually audible — otherwise the waveform shows one half of a conversation
 * while both halves play. Everything else falls back to the first track, which
 * is what an import has and what a single-source recording has.
 *
 * Always a WAV this app wrote: the peak reader handles 16-bit PCM only, and an
 * imported original may be an mp3 or 24-bit.
 */
export function getWaveformPath(recordingId: string): string | null {
  const mix = recordingMixPath(recordingId)
  if (existsSync(mix)) return mix
  return listTracks(recordingId)[0]?.wavPath ?? null
}

/** Looks up a single track's WAV path. Used by the media protocol handler. */
export function getTrackPath(trackId: string): string | null {
  const row = getDb()
    .prepare('SELECT wav_path FROM tracks WHERE id = ?')
    .get(trackId) as unknown as { wav_path: string } | undefined
  return row?.wav_path ?? null
}

/**
 * Moves a recording to a new pipeline state.
 *
 * `error` is cleared on every non-failed transition so a successful retry does
 * not leave a stale message visible in the UI.
 */
export function setRecordingStatus(
  id: string,
  status: RecordingStatus,
  error: string | null = null
): void {
  getDb()
    .prepare('UPDATE recordings SET status = ?, error = ? WHERE id = ?')
    .run(status, status === 'failed' ? error : null, id)
}

export function setRecordingDuration(id: string, durationMs: number): void {
  getDb().prepare('UPDATE recordings SET duration_ms = ? WHERE id = ?').run(durationMs, id)
}

export function setRecordingSourcePath(id: string, sourcePath: string): void {
  getDb().prepare('UPDATE recordings SET source_path = ? WHERE id = ?').run(sourcePath, id)
}
