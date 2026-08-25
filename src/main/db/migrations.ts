/**
 * Forward-only schema migrations.
 *
 * Each entry runs exactly once, in order, inside a transaction, and the applied
 * version is recorded in `schema_version`. Never edit a shipped migration —
 * append a new one, otherwise installs that already ran the old version will
 * silently diverge from fresh ones.
 */

export interface Migration {
  version: number
  name: string
  sql: string
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    sql: /* sql */ `
      CREATE TABLE recordings (
        id            TEXT PRIMARY KEY,
        title         TEXT    NOT NULL,
        created_at    INTEGER NOT NULL,
        duration_ms   INTEGER,
        source        TEXT    NOT NULL CHECK (source IN ('recorded', 'imported')),
        source_path   TEXT,
        status        TEXT    NOT NULL DEFAULT 'new',
        error         TEXT
      );

      CREATE INDEX idx_recordings_created_at ON recordings (created_at DESC);

      CREATE TABLE tracks (
        id           TEXT PRIMARY KEY,
        recording_id TEXT    NOT NULL REFERENCES recordings (id) ON DELETE CASCADE,
        kind         TEXT    NOT NULL CHECK (kind IN ('mic', 'system', 'mixed')),
        wav_path     TEXT    NOT NULL,
        duration_ms  INTEGER
      );

      CREATE INDEX idx_tracks_recording ON tracks (recording_id);

      -- cluster_id is the diarizer's output label, or -1 for the synthetic
      -- local-user speaker on the mic track. Unique per recording so a re-merge
      -- reuses the existing row and therefore preserves the user's rename.
      CREATE TABLE speakers (
        id           TEXT PRIMARY KEY,
        recording_id TEXT    NOT NULL REFERENCES recordings (id) ON DELETE CASCADE,
        cluster_id   INTEGER NOT NULL,
        display_name TEXT    NOT NULL,
        color        TEXT    NOT NULL,
        UNIQUE (recording_id, cluster_id)
      );

      CREATE TABLE utterances (
        id           TEXT PRIMARY KEY,
        recording_id TEXT    NOT NULL REFERENCES recordings (id) ON DELETE CASCADE,
        speaker_id   TEXT    REFERENCES speakers (id) ON DELETE SET NULL,
        start_ms     INTEGER NOT NULL,
        end_ms       INTEGER NOT NULL,
        text         TEXT    NOT NULL,
        edited       INTEGER NOT NULL DEFAULT 0
      );

      -- The editor always reads a recording's utterances in playback order.
      CREATE INDEX idx_utterances_playback ON utterances (recording_id, start_ms);

      CREATE TABLE words (
        id           TEXT PRIMARY KEY,
        utterance_id TEXT    NOT NULL REFERENCES utterances (id) ON DELETE CASCADE,
        start_ms     INTEGER NOT NULL,
        end_ms       INTEGER NOT NULL,
        text         TEXT    NOT NULL
      );

      CREATE INDEX idx_words_utterance ON words (utterance_id, start_ms);
    `
  },
  {
    version: 2,
    name: 'settings_and_transcription_meta',
    sql: /* sql */ `
      -- Simple key/value store. The app has a handful of preferences (chosen
      -- model, language) and a typed column per preference would mean a
      -- migration every time one is added.
      CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      -- Which model produced a transcript, so the UI can show it and a re-run
      -- with a better model is an informed choice rather than a guess.
      ALTER TABLE recordings ADD COLUMN model_id TEXT;
      ALTER TABLE recordings ADD COLUMN language TEXT;

      -- Average token probability for an utterance, surfaced as a confidence
      -- hint so low-quality passages can be flagged for review.
      ALTER TABLE utterances ADD COLUMN confidence REAL;
    `
  },
  {
    version: 3,
    name: 'screenshots',
    sql: /* sql */ `
      -- One row per image, not per snap: a snap on a two-monitor machine
      -- writes two rows sharing the same timestamp_ms.
      CREATE TABLE screenshots (
        id            TEXT    PRIMARY KEY,
        recording_id  TEXT    NOT NULL REFERENCES recordings (id) ON DELETE CASCADE,
        timestamp_ms  INTEGER NOT NULL,
        display_label TEXT    NOT NULL,
        file_name     TEXT    NOT NULL,
        created_at    INTEGER NOT NULL
      );

      CREATE INDEX idx_screenshots_recording ON screenshots (recording_id, timestamp_ms);
    `
  }
]
