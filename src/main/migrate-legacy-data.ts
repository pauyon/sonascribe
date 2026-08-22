import { app } from 'electron'
import { existsSync, renameSync, rmSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Moves user data left behind by a previous product name.
 *
 * Electron derives the user-data directory from `productName`, so renaming the
 * app silently strands everything the user already has — recordings, and up to
 * gigabytes of downloaded models — in a folder the app no longer looks at. It
 * would simply appear to be a fresh install.
 *
 * Both directories live under the same parent, so each move is a rename on one
 * volume: instant, and atomic per item regardless of how large the models are.
 */

/** Product names this app has shipped under, oldest first. */
const LEGACY_PRODUCT_NAMES = ['scribe', 'Scribe']

/** Files and directories owned by the app, and their names after the rename. */
const OWNED_ITEMS: Array<{ from: string; to: string }> = [
  { from: 'scribe.db', to: 'sonascribe.db' },
  // SQLite's write-ahead log and shared-memory files must travel with the
  // database; leaving them behind can strand committed transactions.
  { from: 'scribe.db-wal', to: 'sonascribe.db-wal' },
  { from: 'scribe.db-shm', to: 'sonascribe.db-shm' },
  { from: 'media', to: 'media' },
  { from: 'models', to: 'models' }
]

export function migrateLegacyUserData(): void {
  const currentDir = app.getPath('userData')
  const parent = dirname(currentDir)

  for (const legacyName of LEGACY_PRODUCT_NAMES) {
    const legacyDir = join(parent, legacyName)

    // On a case-insensitive filesystem the "old" and "new" names can resolve to
    // the same directory; migrating it onto itself would delete live data.
    if (!existsSync(legacyDir)) continue
    if (legacyDir.toLowerCase() === currentDir.toLowerCase()) continue

    let moved = 0
    let failed = 0

    for (const item of OWNED_ITEMS) {
      const source = join(legacyDir, item.from)
      const target = join(currentDir, item.to)
      if (!existsSync(source)) continue

      // Never overwrite: data already in the new location is authoritative.
      if (existsSync(target)) {
        console.warn(`[migrate] ${item.to} already exists; leaving legacy copy alone`)
        failed++
        continue
      }

      try {
        renameSync(source, target)
        moved++
      } catch (err) {
        console.error(`[migrate] could not move ${item.from}:`, err)
        failed++
      }
    }

    if (moved > 0) console.log(`[migrate] moved ${moved} item(s) from "${legacyName}"`)

    // Only discard the old directory once everything owned has been rescued.
    // What remains is Chromium's own cache, which is disposable.
    if (failed === 0) {
      try {
        rmSync(legacyDir, { recursive: true, force: true })
        console.log(`[migrate] removed legacy directory "${legacyName}"`)
      } catch (err) {
        console.error(`[migrate] could not remove "${legacyName}":`, err)
      }
    } else {
      const remaining = readdirSync(legacyDir).length
      console.warn(
        `[migrate] keeping "${legacyName}" (${remaining} entries): ${failed} item(s) were not migrated`
      )
    }
  }
}
