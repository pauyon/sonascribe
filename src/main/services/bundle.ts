import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Cut, Marker, Recording } from '@shared/types'
import { getRecording, insertRecordingFromBundle, listRecordings } from '../db/recordings'
import { listSpeakers } from '../db/speakers'
import {
  getUtterances,
  insertTranscriptFromBundle,
  type BundleSpeakerInput,
  type BundleUtteranceInput
} from '../db/transcript'
import { recordingMediaDir } from './storage'
import { safeFileName } from './transcript-export'
import { emit } from '../ipc/events'
import { showOpenDialog } from './dialogs'

/**
 * Export/import of a full recording — audio plus everything the app knows
 * about it (markers and their notes, cuts, the complete transcript down to
 * per-word timing, and speakers) — as a plain folder, for moving a
 * recording (or the whole library) to another machine.
 *
 * A folder rather than a zip: this app has a deliberate zero-new-dependency
 * stance (`node:sqlite` over better-sqlite3, sidecars over linked libraries,
 * see CLAUDE.md), and Node has no built-in ZIP writer — a folder gets the
 * same "one thing to copy/cloud-sync" result without pulling in a library
 * just for this. `exportAudio`/`exportTranscript` in transcript-export.ts
 * remain the "just the audio" / "just readable text" escape hatches; this is
 * the "everything, round-trippable" one.
 *
 * IDs (recording, speaker, utterance) are preserved on import rather than
 * regenerated — they're UUIDs, so a collision is effectively impossible, and
 * preserving them is what makes re-importing the same bundle idempotent
 * (recognized as already present) instead of silently duplicating rows.
 */

const MANIFEST_FILE = 'manifest.json'
const AUDIO_FILE = 'recording.wav'
const FORMAT_VERSION = 1

interface BundleManifest {
  formatVersion: typeof FORMAT_VERSION
  exportedAt: number
  recording: {
    id: string
    title: string
    createdAt: number
    durationMs: number | null
    source: Recording['source']
    cuts: Cut[]
    markers: Marker[]
    modelId: string | null
    language: string | null
    transcriptPreview: string | null
    // Never anything but 'ready' or 'none' — a mid-run/failed status is a
    // process state on the *source* machine, not portable data.
    transcriptStatus: 'ready' | 'none'
    speakerStatus: 'ready' | 'none'
  }
  speakers: BundleSpeakerInput[]
  utterances: BundleUtteranceInput[]
}

function buildManifest(recording: Recording): BundleManifest {
  const speakers = listSpeakers(recording.id)
  const utterances = getUtterances(recording.id)
  return {
    formatVersion: FORMAT_VERSION,
    exportedAt: Date.now(),
    recording: {
      id: recording.id,
      title: recording.title,
      createdAt: recording.createdAt,
      durationMs: recording.durationMs,
      source: recording.source,
      cuts: recording.cuts,
      markers: recording.markers,
      modelId: recording.modelId,
      language: recording.language,
      transcriptPreview: recording.transcriptPreview,
      transcriptStatus: recording.transcriptStatus === 'ready' ? 'ready' : 'none',
      speakerStatus: recording.speakerStatus === 'ready' ? 'ready' : 'none'
    },
    speakers: speakers.map((s) => ({
      id: s.id,
      clusterId: s.clusterId,
      displayName: s.displayName,
      color: s.color
    })),
    utterances: utterances.map((u) => ({
      id: u.id,
      startMs: u.startMs,
      endMs: u.endMs,
      text: u.text,
      confidence: u.confidence,
      speakerId: u.speaker?.id ?? null,
      words: u.words
    }))
  }
}

/** Writes one recording's bundle folder inside `destFolder`, returning the bundle folder's own path. */
async function writeBundle(recording: Recording, destFolder: string): Promise<string> {
  if (!recording.sourcePath) throw new Error(`"${recording.title}" has no audio to export yet`)
  const folder = join(destFolder, `${safeFileName(recording.title, 'recording')}-${recording.id}`)
  await mkdir(folder, { recursive: true })
  await copyFile(recording.sourcePath, join(folder, AUDIO_FILE))
  await writeFile(join(folder, MANIFEST_FILE), JSON.stringify(buildManifest(recording), null, 2), 'utf8')
  return folder
}

/** Prompts for a destination, then writes one recording's bundle there. Returns null if the dialog was cancelled. */
export async function exportRecordingBundle(recordingId: string): Promise<{ path: string } | null> {
  const recording = getRecording(recordingId)
  if (!recording) throw new Error('Recording not found')
  if (!recording.sourcePath) throw new Error('This recording has no audio yet')

  const result = await showOpenDialog({
    title: 'Choose a folder to export into',
    properties: ['openDirectory', 'createDirectory']
  })
  if (result.canceled || result.filePaths.length === 0) return null

  const path = await writeBundle(recording, result.filePaths[0])
  return { path }
}

/**
 * Prompts for a destination, then writes every recording that has audio as
 * its own bundle folder inside it, plus a purely informational summary file
 * import never reads — import auto-detects a library export by shape (a
 * folder of subfolders that each have their own manifest), not by this file.
 */
export async function exportLibraryBundle(): Promise<{ path: string; count: number } | null> {
  const result = await showOpenDialog({
    title: 'Choose a folder to export your library into',
    properties: ['openDirectory', 'createDirectory']
  })
  if (result.canceled || result.filePaths.length === 0) return null
  const destFolder = result.filePaths[0]

  const recordings = listRecordings().filter((r) => r.sourcePath)
  for (const recording of recordings) {
    await writeBundle(recording, destFolder)
  }
  await writeFile(
    join(destFolder, 'sonascribe-library-export.json'),
    JSON.stringify(
      { exportedAt: Date.now(), count: recordings.length, titles: recordings.map((r) => r.title) },
      null,
      2
    ),
    'utf8'
  )

  return { path: destFolder, count: recordings.length }
}

async function readManifest(folder: string): Promise<BundleManifest | null> {
  try {
    const raw = await readFile(join(folder, MANIFEST_FILE), 'utf8')
    const parsed = JSON.parse(raw) as BundleManifest
    if (parsed.formatVersion !== FORMAT_VERSION || !parsed.recording?.id) return null
    return parsed
  } catch {
    return null
  }
}

/** Copies the bundle's audio into place and recreates its DB rows. Assumes the id isn't already present — callers check that first. */
async function importOneBundle(folder: string, manifest: BundleManifest): Promise<void> {
  const audioDest = join(recordingMediaDir(manifest.recording.id), AUDIO_FILE)
  await copyFile(join(folder, AUDIO_FILE), audioDest)

  insertRecordingFromBundle({
    id: manifest.recording.id,
    title: manifest.recording.title,
    createdAt: manifest.recording.createdAt,
    durationMs: manifest.recording.durationMs,
    source: manifest.recording.source,
    sourcePath: audioDest,
    cuts: manifest.recording.cuts,
    markers: manifest.recording.markers,
    transcriptStatus: manifest.recording.transcriptStatus,
    modelId: manifest.recording.modelId,
    language: manifest.recording.language,
    transcriptPreview: manifest.recording.transcriptPreview,
    speakerStatus: manifest.recording.speakerStatus
  })

  if (manifest.speakers.length > 0 || manifest.utterances.length > 0) {
    insertTranscriptFromBundle(manifest.recording.id, manifest.speakers, manifest.utterances)
  }

  const updated = getRecording(manifest.recording.id)
  if (updated) emit('recording:updated', updated)
}

export interface ImportBundleResult {
  imported: number
  skipped: number
  errors: string[]
}

/**
 * Prompts for a folder, then imports whatever's there — a single bundle
 * (manifest.json directly inside) or a library export (a folder of
 * subfolders that each look like one), detected by shape rather than
 * requiring the caller to say which. A subfolder without a valid manifest is
 * silently ignored (an arbitrary folder can contain anything); one bundle
 * failing partway through is recorded in `errors` rather than aborting the
 * rest of a batch.
 */
export async function importBundle(): Promise<ImportBundleResult | null> {
  const result = await showOpenDialog({
    title: 'Choose a recording (or library export) folder',
    properties: ['openDirectory']
  })
  if (result.canceled || result.filePaths.length === 0) return null
  const sourceFolder = result.filePaths[0]

  const summary: ImportBundleResult = { imported: 0, skipped: 0, errors: [] }
  const direct = await readManifest(sourceFolder)
  const candidates: Array<{ folder: string; manifest: BundleManifest }> = []
  if (direct) {
    candidates.push({ folder: sourceFolder, manifest: direct })
  } else {
    const entries = await readdir(sourceFolder, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const folder = join(sourceFolder, entry.name)
      const manifest = await readManifest(folder)
      if (manifest) candidates.push({ folder, manifest })
    }
  }
  if (candidates.length === 0) {
    summary.errors.push('No recording bundle was found in that folder.')
    return summary
  }

  for (const { folder, manifest } of candidates) {
    if (getRecording(manifest.recording.id)) {
      summary.skipped++
      continue
    }
    try {
      await importOneBundle(folder, manifest)
      summary.imported++
    } catch (err) {
      summary.errors.push(`${manifest.recording.title || folder}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return summary
}
