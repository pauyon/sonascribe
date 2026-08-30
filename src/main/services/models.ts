import { createWriteStream } from 'node:fs'
import { open, rename, rm, stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { join } from 'node:path'
import {
  MODELS,
  findModel,
  modelDownloadUrl,
  modelFileName,
  type ModelSpec,
  type ModelStatus
} from '@shared/models'
import { modelsPath } from '../paths'
import { emit } from '../ipc/events'

/**
 * Download and inventory management for whisper models.
 *
 * Models are large (78 MB to 1.6 GB) and are therefore not bundled — the
 * installer stays small and the user picks what suits their machine. Downloads
 * are resumable, because a 1.6 GB transfer that has to restart from zero after
 * a dropped connection is not something a user will tolerate twice.
 */

interface ActiveDownload {
  controller: AbortController
  receivedBytes: number
  totalBytes: number | null
}

const active = new Map<string, ActiveDownload>()

function specFor(id: string): ModelSpec {
  const spec = findModel(id)
  if (!spec) throw new ModelDownloadError(`Unknown model: ${id}`)
  return spec
}

function finalPath(id: string): string {
  return join(modelsPath(), modelFileName(specFor(id)))
}

/** Partial downloads live beside the target and are renamed into place on success. */
function partPath(id: string): string {
  return `${finalPath(id)}.part`
}

async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

/**
 * ggml's magic, written as a little-endian uint32.
 *
 * On disk the bytes therefore read "lmgg", not "ggml" — comparing the leading
 * four bytes as ASCII rejects every valid model.
 */
const GGML_MAGIC = 0x67676d6c

/** GGUF's magic is the literal ASCII bytes "GGUF" at offset 0 — no byte-order flip, unlike ggml's. */
const GGUF_MAGIC = Buffer.from('GGUF', 'ascii')

/**
 * Verifies a file is really a model in the given format.
 *
 * A truncated download or an HTML error page saved under the model's
 * filename would otherwise only surface as a confusing engine crash much
 * later.
 */
async function hasValidMagic(path: string, format: ModelSpec['format']): Promise<boolean> {
  try {
    const handle = await open(path, 'r')
    try {
      const buf = Buffer.alloc(4)
      const { bytesRead } = await handle.read(buf, 0, 4, 0)
      if (bytesRead !== 4) return false
      return format === 'gguf' ? buf.equals(GGUF_MAGIC) : buf.readUInt32LE(0) === GGML_MAGIC
    } finally {
      await handle.close()
    }
  } catch {
    return false
  }
}

export async function isModelInstalled(id: string): Promise<boolean> {
  const spec = specFor(id)
  const path = finalPath(id)
  return (await sizeOf(path)) > 0 && (await hasValidMagic(path, spec.format))
}

/** Absolute path to an installed model, or null if it is not present. */
export async function resolveModelPath(id: string): Promise<string | null> {
  return (await isModelInstalled(id)) ? finalPath(id) : null
}

export async function listModelStatuses(): Promise<ModelStatus[]> {
  return Promise.all(
    MODELS.map(async (spec) => {
      const download = active.get(spec.id)
      const installed = await isModelInstalled(spec.id)
      const bytesOnDisk = installed
        ? await sizeOf(finalPath(spec.id))
        : await sizeOf(partPath(spec.id))

      return {
        id: spec.id,
        installed,
        bytesOnDisk,
        downloading: download != null,
        fraction: download?.totalBytes
          ? download.receivedBytes / download.totalBytes
          : null,
        error: null
      }
    })
  )
}

/** Emits the current byte counts for an in-flight download. */
function publishProgress(modelId: string): void {
  const download = active.get(modelId)
  if (!download) return

  const { receivedBytes, totalBytes } = download
  emit('model:progress', {
    modelId,
    receivedBytes,
    totalBytes,
    fraction: totalBytes && totalBytes > 0 ? receivedBytes / totalBytes : null,
    done: false,
    error: null
  })
}

export class ModelDownloadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ModelDownloadError'
  }
}

/**
 * Downloads a model, resuming a previous partial transfer when possible.
 *
 * Returns the final path. Concurrent calls for the same model share the first
 * download rather than racing each other onto the same file.
 */
export async function downloadModel(id: string): Promise<string> {
  const spec = findModel(id)
  if (!spec) throw new ModelDownloadError(`Unknown model: ${id}`)

  if (await isModelInstalled(id)) return finalPath(id)
  if (active.has(id)) throw new ModelDownloadError(`${spec.label} is already downloading`)

  const target = finalPath(id)
  const part = partPath(id)
  const controller = new AbortController()
  const state: ActiveDownload = { controller, receivedBytes: 0, totalBytes: null }
  active.set(id, state)

  try {
    const alreadyHave = await sizeOf(part)
    const headers: Record<string, string> = {}
    if (alreadyHave > 0) headers.Range = `bytes=${alreadyHave}-`

    const response = await fetch(modelDownloadUrl(spec), {
      headers,
      redirect: 'follow',
      signal: controller.signal
    })

    if (!response.ok) {
      throw new ModelDownloadError(
        `Download failed: ${response.status} ${response.statusText}`
      )
    }
    if (!response.body) throw new ModelDownloadError('Download returned an empty body')

    // 206 means the server honoured the resume; 200 means it ignored the Range
    // header and is sending the whole file, so any partial data must be dropped.
    const resuming = response.status === 206 && alreadyHave > 0
    state.receivedBytes = resuming ? alreadyHave : 0

    const contentLength = Number(response.headers.get('Content-Length') ?? '')
    state.totalBytes = Number.isFinite(contentLength)
      ? state.receivedBytes + contentLength
      : spec.sizeBytes

    let sinceLastEmit = 0
    const counter = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctrl) {
        state.receivedBytes += chunk.byteLength
        sinceLastEmit += chunk.byteLength
        // Emitting per chunk would flood the renderer; roughly every 2 MB is
        // enough to animate a progress bar smoothly.
        if (sinceLastEmit >= 2_000_000) {
          sinceLastEmit = 0
          publishProgress(id)
        }
        ctrl.enqueue(chunk)
      }
    })

    await pipeline(
      Readable.fromWeb(response.body.pipeThrough(counter) as never),
      createWriteStream(part, { flags: resuming ? 'a' : 'w' })
    )

    if (!(await hasValidMagic(part, spec.format))) {
      await rm(part, { force: true })
      throw new ModelDownloadError(
        'Downloaded file is not a valid model. It may have been truncated — try again.'
      )
    }

    await rename(part, target)
    active.delete(id)
    emit('model:progress', {
      modelId: id,
      receivedBytes: state.receivedBytes,
      totalBytes: state.totalBytes,
      fraction: 1,
      done: true,
      error: null
    })
    return target
  } catch (err) {
    active.delete(id)

    const aborted = controller.signal.aborted
    const message = aborted
      ? 'Download cancelled'
      : err instanceof Error
        ? err.message
        : String(err)

    // A cancelled or network-interrupted download keeps its .part file so the
    // next attempt can resume; only a corrupt payload is discarded (above).
    emit('model:progress', {
      modelId: id,
      receivedBytes: state.receivedBytes,
      totalBytes: state.totalBytes,
      fraction: null,
      done: false,
      error: message
    })
    throw err instanceof Error ? err : new Error(message)
  }
}

export function cancelModelDownload(id: string): void {
  active.get(id)?.controller.abort()
}

/** Removes an installed model and any partial download for it. */
export async function deleteModel(id: string): Promise<void> {
  cancelModelDownload(id)
  await rm(finalPath(id), { force: true })
  await rm(partPath(id), { force: true })
}
