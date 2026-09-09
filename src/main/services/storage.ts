import { existsSync, mkdirSync } from 'node:fs'
import { cp, rename, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { defaultMediaPath, within } from '../paths'
import { getMediaRoot as getConfiguredMediaRoot, setMediaRoot as setConfiguredMediaRoot } from '../db/settings'
import { listRecordings, setRecordingSourcePath } from '../db/recordings'

/**
 * Where recordings' audio files live on disk, and how that location is
 * changed.
 *
 * Defaults to `<userData>/media`, but a user can point this at any folder —
 * a bigger drive, a synced folder, wherever. The database itself always
 * stays under `<userData>`; only the audio moves. `db/settings.ts` holds just
 * the pointer (or null for the default); this module is what actually reads
 * it, and the only place allowed to move files and change it together.
 */

function ensure(dir: string): string {
  mkdirSync(dir, { recursive: true })
  return dir
}

export function getMediaRoot(): string {
  return ensure(getConfiguredMediaRoot() ?? defaultMediaPath())
}

export function isDefaultMediaRoot(): boolean {
  return getConfiguredMediaRoot() == null
}

/** Per-recording media directory, holding its one audio file. */
export function recordingMediaDir(recordingId: string): string {
  return ensure(within(getMediaRoot(), recordingId))
}

export class RelocateError extends Error {}

function isNested(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent + sep)
}

/**
 * Moves every recording's media directory into `newRoot`, repoints each
 * moved recording's `source_path` there, then makes `newRoot` the configured
 * root.
 *
 * A recording with no file yet (still importing, or already lost) is skipped
 * rather than failing the whole move — nothing to move for it either way.
 * Each directory is moved with `rename` where possible (instant, same
 * volume) and falls back to copy-then-delete across volumes, the same
 * fallback `fetch-sidecars.mjs` uses for the same reason.
 */
export async function relocateMediaRoot(newRoot: string): Promise<string> {
  const resolvedNew = resolve(newRoot)
  const currentRoot = resolve(getMediaRoot())
  if (resolvedNew === currentRoot) return currentRoot

  if (isNested(currentRoot, resolvedNew) || isNested(resolvedNew, currentRoot)) {
    throw new RelocateError(
      'Choose a folder that is not inside — or a parent of — the current recordings folder.'
    )
  }

  ensure(resolvedNew)

  for (const recording of listRecordings()) {
    if (!recording.sourcePath) continue
    const recordingId = basename(dirname(recording.sourcePath))
    const fileName = basename(recording.sourcePath)
    const oldDir = join(currentRoot, recordingId)
    const newDir = join(resolvedNew, recordingId)

    // Already moved (a previous attempt got partway through), or the file
    // lives somewhere repair-paths.ts hasn't reconciled yet — either way,
    // nothing here to move.
    if (!existsSync(oldDir)) continue

    await moveDir(oldDir, newDir)
    setRecordingSourcePath(recording.id, join(newDir, fileName))
  }

  // Landing back on the default folder clears the override (stores null)
  // rather than pinning that same path explicitly — so isDefaultMediaRoot()
  // reads true again, and a future change to what "default" means (e.g. a
  // moved userData directory) is still tracked dynamically instead of frozen
  // at whatever it resolved to on this call.
  setConfiguredMediaRoot(resolvedNew === resolve(defaultMediaPath()) ? null : resolvedNew)
  return resolvedNew
}

async function moveDir(from: string, to: string): Promise<void> {
  try {
    await rename(from, to)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
    await cp(from, to, { recursive: true })
    await rm(from, { recursive: true, force: true })
  }
}
