/**
 * Downloads the ffmpeg binary into resources/bin/<os>/ — the only sidecar
 * this app needs, for normalizing an imported file to WAV.
 *
 * Deliberately not committed: it's large, platform-specific and separately
 * licensed. Run this after cloning, and once per target platform you intend
 * to package for.
 *
 *   node scripts/fetch-sidecars.mjs                # current platform
 *   node scripts/fetch-sidecars.mjs --os mac       # cross-fetch for packaging
 *   node scripts/fetch-sidecars.mjs --force        # re-download
 *
 * Licensing note: the Windows and Linux builds are LGPL. No LGPL macOS build
 * is published by BtbN, so macOS uses the GPL build from ffmpeg-static.
 * ffmpeg is invoked as a separate process and is never linked into the app,
 * but if you ship the macOS build commercially, review that obligation.
 */

import { createWriteStream } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, rename, rm, stat, copyFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createGunzip } from 'node:zlib'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const exec = promisify(execFile)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// Pinned so a rebuild months from now produces the same binary.
const FFMPEG_BTBN_TAG = 'latest'
const FFMPEG_BTBN_SERIES = 'n8.1'
const FFMPEG_STATIC_TAG = 'b6.1.1'

/**
 * @typedef {object} Artifact
 * @property {string} name    Label used in logs, and the filename.
 * @property {string} url
 * @property {'raw'|'gz'|'zip'|'tarxz'} kind
 * @property {string} [member] Single file to lift out of an archive.
 */

/** @returns {Artifact} */
function artifactFor(os, arch) {
  const btbn = (slug) =>
    `https://github.com/BtbN/FFmpeg-Builds/releases/download/${FFMPEG_BTBN_TAG}/ffmpeg-${FFMPEG_BTBN_SERIES}-latest-${slug}.zip`
  const btbnTar = (slug) =>
    `https://github.com/BtbN/FFmpeg-Builds/releases/download/${FFMPEG_BTBN_TAG}/ffmpeg-${FFMPEG_BTBN_SERIES}-latest-${slug}.tar.xz`
  const staticBuild = (target) =>
    `https://github.com/eugeneware/ffmpeg-static/releases/download/${FFMPEG_STATIC_TAG}/ffmpeg-${target}.gz`

  if (os === 'win') {
    const slug = arch === 'arm64' ? 'winarm64-lgpl-8.1' : 'win64-lgpl-8.1'
    return { name: 'ffmpeg.exe', url: btbn(slug), kind: 'zip', member: 'ffmpeg.exe' }
  }
  if (os === 'linux') {
    const slug = arch === 'arm64' ? 'linuxarm64-lgpl-8.1' : 'linux64-lgpl-8.1'
    return { name: 'ffmpeg', url: btbnTar(slug), kind: 'tarxz', member: 'ffmpeg' }
  }
  if (os === 'mac') {
    return { name: 'ffmpeg', url: staticBuild(`darwin-${arch}`), kind: 'gz' }
  }
  throw new Error(`Unsupported os: ${os}`)
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`)
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest))
}

/** Recursively locate a file by exact name. Archive layouts vary between builds. */
async function findFile(dir, name) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      const hit = await findFile(full, name)
      if (hit) return hit
    } else if (entry.name === name) {
      return full
    }
  }
  return null
}

async function extract(artifact, archivePath, workDir, destPath) {
  if (artifact.kind === 'raw') {
    await moveFile(archivePath, destPath)
    return
  }
  if (artifact.kind === 'gz') {
    await pipeline(
      (await import('node:fs')).createReadStream(archivePath),
      createGunzip(),
      createWriteStream(destPath)
    )
    return
  }
  // bsdtar ships with Windows 10+, macOS and most Linux distros, and reads both
  // zip and tar.xz — which avoids pulling in an archive library.
  //
  // On Windows the system bsdtar must be addressed by absolute path: if a POSIX
  // shell like Git Bash is on PATH its GNU tar wins, and GNU tar reads the "C:"
  // in a Windows path as a remote host and tries to connect to it.
  const tarBin =
    process.platform === 'win32'
      ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
      : 'tar'
  await exec(tarBin, ['-xf', archivePath, '-C', workDir])

  const found = await findFile(workDir, artifact.member ?? artifact.name)
  if (!found) throw new Error(`${artifact.member ?? artifact.name} not found inside ${artifact.url}`)
  await moveFile(found, destPath)
}

/**
 * Moves a file, falling back to copy+delete when the source and destination
 * are on different filesystems.
 *
 * `rename` is atomic but POSIX (and Windows) refuse it across devices — EXDEV
 * — and the OS temp directory is not guaranteed to share a drive with the
 * repo. It usually does on a dev machine, which is why this only surfaces on
 * CI runners that put TEMP and the checkout on separate drives.
 */
async function moveFile(src, dest) {
  try {
    await rename(src, dest)
  } catch (err) {
    if (err.code !== 'EXDEV') throw err
    await copyFile(src, dest)
    await rm(src)
  }
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function main() {
  const argv = process.argv.slice(2)
  const flag = (name, fallback) => {
    const i = argv.indexOf(`--${name}`)
    return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback
  }
  const force = argv.includes('--force')

  const defaultOs = { win32: 'win', darwin: 'mac', linux: 'linux' }[process.platform]
  const os = flag('os', defaultOs)
  const arch = flag('arch', process.arch === 'arm64' ? 'arm64' : 'x64')

  const binDir = join(ROOT, 'resources', 'bin', os)
  await mkdir(binDir, { recursive: true })

  console.log(`Fetching ffmpeg for ${os}-${arch} -> resources/bin/${os}/`)

  const artifact = artifactFor(os, arch)
  const destPath = join(binDir, artifact.name)

  if (!force && (await exists(destPath))) {
    console.log(`  ${artifact.name} already present (use --force to re-download)`)
    return
  }

  const workDir = await mkdtemp(join(tmpdir(), 'scribe-sidecar-'))
  try {
    console.log(`  downloading ${artifact.name}…`)
    const archivePath = join(workDir, 'download.bin')
    await download(artifact.url, archivePath)
    await extract(artifact, archivePath, workDir, destPath)
    // The zip/tar members and the raw macOS build are not reliably +x.
    if (os !== 'win') await chmod(destPath, 0o755)
    const { size } = await stat(destPath)
    console.log(`  ${artifact.name} ready (${(size / 1e6).toFixed(1)} MB)`)
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }

  console.log('Done.')
}

await main()
