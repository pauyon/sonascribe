import { existsSync } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { getMediaRoot } from '../services/storage'
import { readWavInfo } from '../services/wav'
import { getDb } from './index'

/**
 * Repoints stored media paths at the current media directory.
 *
 * Recording rows hold absolute paths. That breaks whenever the user-data
 * directory moves — a product rename, a migrated Windows profile, a restored
 * backup — leaving rows that point at directories which no longer exist. The
 * audio is still there under the new root, so the path is rewritten rather
 * than the recording being treated as lost.
 *
 * Only rows whose file is genuinely missing are touched, and only when the
 * matching file can be found under the current root, so this is a no-op in the
 * normal case.
 */
export function repairMediaPaths(): number {
  const db = getDb()
  const root = getMediaRoot()
  let repaired = 0

  /**
   * Media lives at <mediaRoot>/<recordingId>/<file>, so the last two segments
   * of a stale path are enough to relocate it.
   */
  const relocate = (stored: string | null): string | null => {
    if (!stored || existsSync(stored)) return null
    const candidate = join(root, basename(dirname(stored)), basename(stored))
    return candidate !== stored && existsSync(candidate) ? candidate : null
  }

  const recordings = db
    .prepare('SELECT id, source_path FROM recordings WHERE source_path IS NOT NULL')
    .all() as unknown as Array<{ id: string; source_path: string }>
  const updateRecording = db.prepare('UPDATE recordings SET source_path = ? WHERE id = ?')
  for (const recording of recordings) {
    const fixed = relocate(recording.source_path)
    if (fixed) {
      updateRecording.run(fixed, recording.id)
      repaired++
    }
  }

  if (repaired > 0) console.log(`[repair] repointed ${repaired} media path(s)`)
  return repaired
}

/**
 * Patches a WAV file's two size fields (the RIFF chunk and the `data` chunk)
 * to match what's actually on disk, and returns the resulting duration.
 *
 * `WavWriter`'s constructor writes its header with placeholder sizes (see
 * wav-writer.ts) and only patches them for real in `close()` — a session
 * that never reached a clean `close()` (a crash mid-recording, not just
 * mid-finalize) leaves the file sitting there with real audio in it but a
 * header that still claims zero bytes of data. The `fmt` chunk itself (and
 * therefore sample rate/channels/bit depth) is written up front and is
 * always intact, so `readWavInfo` is trustworthy for everything except the
 * size fields this function is here to fix.
 */
async function repairWavHeader(path: string): Promise<number> {
  const info = await readWavInfo(path)
  const { size: fileSize } = await stat(path)
  const realDataBytes = Math.max(0, fileSize - info.dataOffset)
  const byteRate = info.sampleRate * info.channels * (info.bitsPerSample / 8)
  const durationMs = byteRate > 0 ? Math.round((realDataBytes / byteRate) * 1000) : 0

  const handle = await open(path, 'r+')
  try {
    const sizes = Buffer.alloc(4)
    sizes.writeUInt32LE(fileSize - 8, 0)
    await handle.write(sizes, 0, 4, 4)
    sizes.writeUInt32LE(realDataBytes, 0)
    await handle.write(sizes, 0, 4, info.dataOffset - 4)
  } finally {
    await handle.close()
  }

  return durationMs
}

/**
 * Returns recordings stranded mid-finalize to a state the user can act on.
 *
 * A recording interrupted while `normalizing` — the window closed, the
 * machine slept, a crash — comes back claiming to be normalizing forever,
 * with no process left actually finishing that work.
 *
 * `source_path` is only ever set by `stopRecording`'s own clean-exit path
 * (see recorder.ts), so it's still null for the far more common case: the
 * app went away while actively recording, not during the brief finalize
 * window. The audio itself is written continuously the whole time straight
 * to `<mediaRoot>/<id>/recording.wav` — a deterministic path this
 * reconstructs and checks directly, rather than giving up just because the
 * DB row was never linked up to it. 'ready' (with its header repaired) once
 * real audio is confirmed present, 'failed' otherwise — there's nothing left
 * to retry automatically the way a transcription job used to be re-queued.
 */
export async function resetInterruptedRecordings(): Promise<number> {
  const db = getDb()
  const stranded = db
    .prepare(`SELECT id, source_path FROM recordings WHERE status = 'normalizing'`)
    .all() as unknown as Array<{ id: string; source_path: string | null }>
  if (stranded.length === 0) return 0

  const toReady = db.prepare(`UPDATE recordings SET status = 'ready', error = NULL WHERE id = ?`)
  const toReadyWithPath = db.prepare(
    `UPDATE recordings SET status = 'ready', error = NULL, source_path = ?, duration_ms = ? WHERE id = ?`
  )
  const toFailed = db.prepare(`UPDATE recordings SET status = 'failed', error = ? WHERE id = ?`)

  let recovered = 0
  for (const { id, source_path: sourcePath } of stranded) {
    if (sourcePath && existsSync(sourcePath)) {
      toReady.run(id)
      continue
    }

    const expectedPath = join(getMediaRoot(), id, 'recording.wav')
    if (existsSync(expectedPath)) {
      try {
        const durationMs = await repairWavHeader(expectedPath)
        // A crash within the first block or two, before any real audio
        // landed, is the one case genuinely indistinguishable from "nothing
        // was ever recorded" — treated the same way rather than leaving a
        // 0:00 entry with nothing to play.
        if (durationMs > 0) {
          toReadyWithPath.run(expectedPath, durationMs, id)
          recovered++
          continue
        }
      } catch (err) {
        console.warn(`[repair] found ${expectedPath} but could not repair its header:`, err)
      }
    }

    toFailed.run('Interrupted before any audio was saved', id)
  }

  console.log(
    `[db] resolved ${stranded.length} recording(s) interrupted mid-finalize` +
      (recovered > 0 ? ` (${recovered} recovered from a crash mid-recording)` : '')
  )
  return stranded.length
}

/**
 * Returns a recording stranded mid-transcription to a state the user can act
 * on. A recording interrupted while `transcribing` — the app closed, the
 * machine slept, a crash — comes back claiming to be transcribing forever,
 * with no job left actually finishing that work. Unlike
 * `resetInterruptedRecordings` above there's no ambiguity about the outcome:
 * the transcript is either fully saved or it isn't, so this always reports
 * failure rather than checking for a file on disk.
 */
export function resetInterruptedTranscriptions(): number {
  const db = getDb()
  const result = db
    .prepare(
      `UPDATE recordings SET transcript_status = 'failed', transcript_error = ?
       WHERE transcript_status = 'transcribing'`
    )
    .run('Interrupted — try again')

  const changes = Number(result.changes)
  if (changes > 0) {
    console.log(`[db] resolved ${changes} transcription(s) interrupted mid-run`)
  }
  return changes
}

/** Same repair as `resetInterruptedTranscriptions`, for speaker detection's own status column. */
export function resetInterruptedSpeakerDetections(): number {
  const db = getDb()
  const result = db
    .prepare(
      `UPDATE recordings SET speaker_status = 'failed', speaker_error = ?
       WHERE speaker_status = 'detecting'`
    )
    .run('Interrupted — try again')

  const changes = Number(result.changes)
  if (changes > 0) {
    console.log(`[db] resolved ${changes} speaker detection(s) interrupted mid-run`)
  }
  return changes
}
