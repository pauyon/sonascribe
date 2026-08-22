import { protocol } from 'electron'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname } from 'node:path'
import { Readable } from 'node:stream'
import { MEDIA_SCHEME } from '@shared/ipc'
import { getRecording } from './db/recordings'
import { getTrackPath } from './db/tracks'

/**
 * Serves recording audio to the renderer over `sonascribe-media://`.
 *
 * The renderer never receives a filesystem path, and this handler never accepts
 * one: a URL carries only a row id, which is looked up in the database to find
 * the real file. That removes path traversal as a category rather than trying to
 * sanitise it, and it means `webSecurity` stays on.
 *
 *   sonascribe-media://track/<trackId>       normalized 16 kHz mono WAV
 *   sonascribe-media://source/<recordingId>  original imported/recorded file
 *
 * Note: this scheme is reachable from <audio src> and <video src>, but NOT from
 * fetch()/XHR — Chromium refuses cross-origin fetches to any scheme outside
 * http/https/data/chrome*, and the renderer's origin is file:// (or
 * http://localhost in dev). No response header lifts that. Anything needing the
 * actual samples in the renderer, such as waveform peaks, must come over IPC,
 * which is the better design regardless: a two-hour recording is ~230 MB of PCM
 * that has no business being decoded in the UI process.
 */

export function registerMediaProtocolScheme(): void {
  // Must run before the app 'ready' event. `stream: true` is what enables range
  // requests, and without ranges an <audio> element cannot seek.
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
    }
  ])
}

const MIME_TYPES: Record<string, string> = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.aiff': 'audio/aiff',
  '.wma': 'audio/x-ms-wma',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.avi': 'video/x-msvideo'
}

function contentType(filePath: string): string {
  return MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
}

/** Maps a sonascribe-media URL to a real file, or null if it names nothing. */
function resolveMediaPath(url: URL): string | null {
  // For sonascribe-media://track/<id>: hostname is "track", pathname is "/<id>".
  const id = decodeURIComponent(url.pathname.replace(/^\//, ''))
  if (!id) return null

  switch (url.hostname) {
    case 'track':
      return getTrackPath(id)
    case 'source':
      return getRecording(id)?.sourcePath ?? null
    default:
      return null
  }
}

/**
 * Parses a single-range `Range: bytes=start-end` header.
 *
 * Only the single-range form is handled, which is all a media element sends.
 * Returns null for absent or unsatisfiable headers, and the caller then serves
 * the whole file.
 */
function parseRange(header: string | null, size: number): { start: number; end: number } | null {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return null

  const [, rawStart, rawEnd] = match

  // "bytes=-500" means the final 500 bytes.
  if (rawStart === '') {
    if (rawEnd === '') return null
    const length = Number(rawEnd)
    if (!Number.isFinite(length) || length <= 0) return null
    return { start: Math.max(0, size - length), end: size - 1 }
  }

  const start = Number(rawStart)
  if (!Number.isFinite(start) || start >= size) return null
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1)
  if (!Number.isFinite(end) || end < start) return null

  return { start, end }
}

export function registerMediaProtocolHandler(): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return new Response('Bad request', { status: 400 })
    }

    const filePath = resolveMediaPath(url)
    if (!filePath) return new Response('Not found', { status: 404 })

    let size: number
    try {
      const info = await stat(filePath)
      if (!info.isFile()) return new Response('Not found', { status: 404 })
      size = info.size
    } catch {
      // The row exists but the file is gone — deleted or on an unmounted drive.
      return new Response('Not found', { status: 404 })
    }

    const type = contentType(filePath)

    // Range support is implemented here rather than delegated to net.fetch:
    // net.fetch against a file:// URL ignores the Range header and always
    // answers 200, which makes Chromium treat the stream as non-seekable. The
    // editor's click-a-line-to-jump behaviour depends on seeking working.
    const range = parseRange(request.headers.get('Range'), size)

    if (!range) {
      const stream = createReadStream(filePath)
      return new Response(Readable.toWeb(stream) as ReadableStream, {
        status: 200,
        headers: {
          'Content-Type': type,
          'Content-Length': String(size),
          'Accept-Ranges': 'bytes'
        }
      })
    }

    const stream = createReadStream(filePath, { start: range.start, end: range.end })
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status: 206,
      headers: {
        'Content-Type': type,
        'Content-Length': String(range.end - range.start + 1),
        'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
        'Accept-Ranges': 'bytes'
      }
    })
  })
}
