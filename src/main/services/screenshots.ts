import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { desktopCapturer } from 'electron'
import type { Screenshot } from '@shared/types'
import { recordingMediaPath } from '../paths'
import { insertScreenshot } from '../db/screenshots'
import { getScreenshotDisplayIds } from '../db/settings'
import { screenshotFileName } from './screenshot-naming'

/**
 * Screen capture for the "snap screenshot" action during a recording.
 *
 * `desktopCapturer.getSources` — already used in `display-media.ts` for the
 * system-audio-capture handshake — doubles as a still-image screenshot API:
 * requested with a generous `thumbnailSize`, each source's `thumbnail` is a
 * full capture of that screen at the moment of the call, capped to (never
 * upscaled past) its real resolution. No renderer involvement, and on macOS
 * no permission category beyond what recording system audio already needs.
 */

// Comfortably covers up to 4K; Electron never upscales past a source's own
// resolution; so this is a ceiling, not a target size.
const CAPTURE_SIZE = { width: 3840, height: 2160 }

export async function listDisplaySources(): Promise<Array<{ id: string; name: string }>> {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    // No image work needed just to list what's connected.
    thumbnailSize: { width: 0, height: 0 }
  })
  return sources.map((s) => ({ id: s.id, name: s.name }))
}

export async function captureScreenshots(
  recordingId: string,
  elapsedMs: number
): Promise<Screenshot[]> {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: CAPTURE_SIZE
  })
  if (sources.length === 0) {
    throw new Error('No display could be captured.')
  }

  // Chosen displays that have since been unplugged (or a docking station
  // that reshuffled ids) just won't match anything here — falling back to
  // every display is a saved preference degrading to the safe default, not
  // a silent no-op. Same fallback when nothing was ever chosen at all.
  const wantedIds = new Set(getScreenshotDisplayIds())
  const chosen = wantedIds.size > 0 ? sources.filter((s) => wantedIds.has(s.id)) : []
  const targets = chosen.length > 0 ? chosen : sources

  const dir = recordingMediaPath(recordingId)
  const results: Screenshot[] = []
  for (const source of targets) {
    const id = randomUUID()
    const fileName = screenshotFileName(id)
    await writeFile(join(dir, fileName), source.thumbnail.toPNG())
    results.push(
      insertScreenshot({
        id,
        recordingId,
        timestampMs: elapsedMs,
        displayLabel: source.name || 'Screen',
        fileName
      })
    )
  }
  return results
}
