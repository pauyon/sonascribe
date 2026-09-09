import { app } from 'electron'
import { accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'

/**
 * Locates a bundled sidecar binary: ffmpeg for normalizing an imported file
 * to WAV, whisper-cli/parakeet-cli for transcription, and
 * sherpa-onnx-offline-speaker-diarization for speaker detection.
 *
 * Resolution order:
 *   1. packaged   <resources>/bin/<name>
 *   2. dev        <repo>/resources/bin/<os>/<name>
 *   3. PATH       so a developer with the tool already installed can skip the
 *                 fetch script, and so a broken bundle degrades to something
 *                 that works rather than to a hard failure — this is also
 *                 the only way whisper-cli/parakeet-cli resolve on macOS,
 *                 which has no prebuilt binary upstream (see
 *                 scripts/fetch-sidecars.mjs's mac guidance). Unlike
 *                 whisper.cpp, sherpa-onnx does publish a macOS build.
 */

export type SidecarName =
  | 'ffmpeg'
  | 'whisper-cli'
  | 'parakeet-cli'
  | 'sherpa-onnx-offline-speaker-diarization'

/** A small ONNX model bundled with the app rather than downloaded — see resolveBundledModel. */
export type BundledModel = 'segmentation.onnx' | 'speaker-embedding.onnx'

function exeName(name: SidecarName): string {
  return process.platform === 'win32' ? `${name}.exe` : name
}

function osDir(): string {
  if (process.platform === 'win32') return 'win'
  if (process.platform === 'darwin') return 'mac'
  return 'linux'
}

function isExecutable(path: string): boolean {
  try {
    // X_OK is not meaningful on Windows; existence is the real check there.
    accessSync(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

function fromPath(binary: string): string | null {
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  for (const dir of dirs) {
    const candidate = join(dir, binary)
    if (isExecutable(candidate)) return candidate
  }
  return null
}

const cache = new Map<SidecarName, string>()

export class SidecarMissingError extends Error {
  constructor(name: SidecarName) {
    super(
      `Required helper "${name}" was not found. Run "npm run sidecars" to download it.`
    )
    this.name = 'SidecarMissingError'
  }
}

export function resolveSidecar(name: SidecarName): string {
  const cached = cache.get(name)
  if (cached) return cached

  const binary = exeName(name)

  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'bin', binary)]
    : // __dirname is out/main in dev, so the repo root is two levels up.
      [join(__dirname, '..', '..', 'resources', 'bin', osDir(), binary)]

  for (const candidate of candidates) {
    if (isExecutable(candidate)) {
      cache.set(name, candidate)
      return candidate
    }
  }

  const onPath = fromPath(binary)
  if (onPath) {
    console.warn(`[sidecars] using ${name} from PATH: ${onPath}`)
    cache.set(name, onPath)
    return onPath
  }

  throw new SidecarMissingError(name)
}

/** Whether a sidecar can be found, without throwing. For UI preflight checks. */
export function hasSidecar(name: SidecarName): boolean {
  try {
    resolveSidecar(name)
    return true
  } catch {
    return false
  }
}

export class BundledModelMissingError extends Error {
  constructor(name: BundledModel) {
    super(`Required model "${name}" was not found. Run "npm run sidecars" to download it.`)
    this.name = 'BundledModelMissingError'
  }
}

function fileExists(path: string): boolean {
  try {
    accessSync(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Locates a small ONNX model shipped with the app itself (diarization's
 * segmentation + speaker-embedding networks, ~47 MB total) — unlike ASR
 * models, small enough to bundle rather than a runtime download, and with
 * no convenient runtime-download path from upstream anyway.
 */
export function resolveBundledModel(name: BundledModel): string {
  const candidate = app.isPackaged
    ? join(process.resourcesPath, 'models', name)
    : // __dirname is out/main in dev, so the repo root is two levels up.
      join(__dirname, '..', '..', 'resources', 'models', name)

  if (!fileExists(candidate)) throw new BundledModelMissingError(name)
  return candidate
}

export function hasBundledModel(name: BundledModel): boolean {
  try {
    resolveBundledModel(name)
    return true
  } catch {
    return false
  }
}
