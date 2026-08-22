import { DatabaseSync } from 'node:sqlite'
import { dbPath } from '../paths'
import { MIGRATIONS } from './migrations'

/**
 * SQLite access for the main process.
 *
 * Uses Node's built-in `node:sqlite` (Electron 42 ships Node 24) rather than a
 * native addon such as better-sqlite3. That keeps the project free of any
 * node-ABI-coupled dependency, so an Electron upgrade can never require an
 * electron-rebuild step. The API surface used here is deliberately tiny —
 * exec/prepare/run/all/get — so swapping the driver later is contained to this
 * file if the built-in module's API changes.
 */

let db: DatabaseSync | null = null

export function getDb(): DatabaseSync {
  if (!db) throw new Error('Database accessed before initDb() was called')
  return db
}

export function initDb(): DatabaseSync {
  if (db) return db

  const database = new DatabaseSync(dbPath())

  // WAL lets a future reader (e.g. an export job) run without blocking writes.
  database.exec('PRAGMA journal_mode = WAL')
  // Off by default in SQLite; the schema leans on ON DELETE CASCADE.
  database.exec('PRAGMA foreign_keys = ON')

  migrate(database)

  db = database
  return db
}

export function closeDb(): void {
  db?.close()
  db = null
}

function migrate(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version    INTEGER PRIMARY KEY,
      name       TEXT    NOT NULL,
      applied_at INTEGER NOT NULL
    )
  `)

  const row = database
    .prepare('SELECT MAX(version) AS version FROM schema_version')
    .get() as { version: number | null } | undefined
  const current = row?.version ?? 0

  const pending = MIGRATIONS.filter((m) => m.version > current).sort(
    (a, b) => a.version - b.version
  )
  if (pending.length === 0) return

  for (const migration of pending) {
    // One transaction per migration: a failure leaves the DB at the last good
    // version rather than half-applied.
    database.exec('BEGIN')
    try {
      database.exec(migration.sql)
      database
        .prepare(
          'INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)'
        )
        .run(migration.version, migration.name, Date.now())
      database.exec('COMMIT')
      console.log(`[db] applied migration ${migration.version}: ${migration.name}`)
    } catch (err) {
      database.exec('ROLLBACK')
      throw new Error(
        `Migration ${migration.version} (${migration.name}) failed: ${String(err)}`
      )
    }
  }
}
