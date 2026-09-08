import { app } from 'electron'
import { mkdirSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

/**
 * Everything the app writes lives under Electron's per-user data directory, so
 * uninstalling is a single directory removal and nothing lands in the user's
 * Documents folder.
 *
 * Layout:
 *   <userData>/sonascribe.db  SQLite metadata (recordings)
 *   <userData>/media/         one WAV per recording
 *
 * Audio is a file on disk referenced by path, never a SQLite BLOB — a
 * multi-hour recording has no business travelling through the DB layer.
 */

function ensure(dir: string): string {
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Joins `segment` onto `root` and rejects the result if it would land outside
 * `root` — a `recordingId` that reaches these path helpers is meant to always
 * be one this process generated with `randomUUID()`, but nothing between an
 * IPC payload and here re-checks that. Without this, an id like
 * `"../../../../Users/me/Documents"` resolves through `join` exactly like any
 * other path segment, and `recordings:delete` hands the result straight to a
 * recursive `rm` — the most consequential filesystem operation in the app.
 *
 * Exported so `services/storage.ts` can apply the same guard to whichever
 * folder the user has configured as the media root, not just this one.
 */
export function within(root: string, segment: string): string {
  const candidate = resolve(root, segment)
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    throw new Error(`Refusing to use a path outside ${root}: ${segment}`)
  }
  return candidate
}

export function userDataPath(): string {
  return ensure(app.getPath('userData'))
}

export function dbPath(): string {
  return join(userDataPath(), 'sonascribe.db')
}

/**
 * Where recordings' media lives when the user hasn't chosen a custom folder.
 *
 * `services/storage.ts` is the module that actually decides where media
 * lives at any given moment — it falls back to this when no custom root is
 * configured. Nothing else should assume media lives here.
 */
export function defaultMediaPath(): string {
  return ensure(join(userDataPath(), 'media'))
}
