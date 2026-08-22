import { app } from 'electron'
import { accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'

/**
 * Locates the bundled sidecar executables (ffmpeg now; whisper.cpp and
 * sherpa-onnx in later phases).
 *
 * Resolution order:
 *   1. packaged   <resources>/bin/<name>
 *   2. dev        <repo>/resources/bin/<os>/<name>
 *   3. PATH       so a developer with ffmpeg already installed can skip the
 *                 fetch script, and so a broken bundle degrades to something
 *                 that works rather than to a hard failure
 */

export type SidecarName =
  | 'ffmpeg'
  | 'whisper-cli'
  // Ships inside the same whisper.cpp release archive as whisper-cli.
  | 'parakeet-cli'
  | 'sherpa-onnx-offline-speaker-diarization'

/**
 * Models shipped with the app rather than downloaded.
 *
 * Only the diarization pair qualifies: together they are ~47 MB, and the
 * segmentation model is published only inside a .tar.bz2, so fetching it at
 * runtime would mean shipping an archive extractor for a single file. Whisper
 * models are a runtime download because they reach 1.6 GB.
 */
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

/** Plain existence — model files are data and carry no execute bit. */
function fileExists(path: string): boolean {
  try {
    accessSync(path, constants.F_OK)
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
    super(`Bundled model "${name}" was not found. Run "npm run sidecars" to download it.`)
    this.name = 'BundledModelMissingError'
  }
}

/**
 * Path to a model shipped inside the app bundle.
 *
 * Unlike the binaries these are platform-independent, so they live in one
 * `resources/models` directory rather than one per OS.
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
