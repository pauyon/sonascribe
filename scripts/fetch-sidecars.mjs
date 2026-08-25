/**
 * Downloads the ML/media sidecar binaries into resources/bin/<os>/.
 *
 * These are deliberately not committed: they are large, platform-specific and
 * separately licensed. Run this after cloning, and once per target platform you
 * intend to package for.
 *
 *   node scripts/fetch-sidecars.mjs                # current platform
 *   node scripts/fetch-sidecars.mjs --os mac       # cross-fetch for packaging
 *   node scripts/fetch-sidecars.mjs --force        # re-download
 *
 * Licensing note: the Windows and Linux ffmpeg builds are LGPL. No LGPL macOS
 * build is published by BtbN, so macOS uses the GPL build from ffmpeg-static.
 * ffmpeg is invoked as a separate process and is never linked into the app, but
 * if you ship the macOS build commercially, review that obligation.
 */

import { createWriteStream } from 'node:fs'
import { chmod, copyFile, mkdir, mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createGunzip } from 'node:zlib'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const exec = promisify(execFile)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// Pinned so a rebuild months from now produces the same binary.
const FFMPEG_BTBN_TAG = 'latest'
const FFMPEG_BTBN_SERIES = 'n8.1'
const FFMPEG_STATIC_TAG = 'b6.1.1'

// whisper.cpp publishes prebuilt CLIs for Windows and Linux only.
const WHISPER_TAG = 'b4938'

// sherpa-onnx does publish macOS binaries, unlike whisper.cpp.
const SHERPA_TAG = 'v1.13.6'
const SHERPA_SEG_TAG = 'speaker-segmentation-models'
const SHERPA_EMB_TAG = 'speaker-recongition-models' // upstream's spelling

/**
 * @typedef {object} Artifact
 * @property {string} name          Label used in logs, and the filename for single-member artifacts.
 * @property {string} url
 * @property {'raw'|'gz'|'zip'|'tarxz'} kind
 * @property {string} [member]      Single file to lift out of the archive.
 * @property {string[]} [members]   Several files to lift out; '*.dll' style suffix globs allowed.
 * @property {string} [sentinel]    File whose presence means this artifact is already installed.
 * @property {'bin'|'models'} [dest] Destination directory; defaults to 'bin'.
 */

/**
 * Diarization models, shipped with the app rather than downloaded at runtime.
 *
 * Together they are ~47 MB, which is small enough to bundle — and the
 * segmentation model is only published inside a .tar.bz2, so downloading it at
 * runtime would mean shipping an archive extractor purely for one file. Whisper
 * models stay a runtime download because they run to 1.6 GB.
 *
 * @returns {Artifact[]}
 */
function modelArtifacts() {
  return [
    {
      name: 'segmentation.onnx',
      url: `https://github.com/k2-fsa/sherpa-onnx/releases/download/${SHERPA_SEG_TAG}/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2`,
      kind: 'tarxz',
      member: 'model.onnx',
      dest: 'models'
    },
    {
      // English speaker embeddings. Titanet-small trades a little accuracy
      // against titanet-large for a 40 MB rather than 101 MB download.
      name: 'speaker-embedding.onnx',
      url: `https://github.com/k2-fsa/sherpa-onnx/releases/download/${SHERPA_EMB_TAG}/nemo_en_titanet_small.onnx`,
      kind: 'raw',
      dest: 'models'
    }
  ]
}

/** @returns {Artifact[]} */
function artifactsFor(os, arch) {
  const btbn = (slug) =>
    `https://github.com/BtbN/FFmpeg-Builds/releases/download/${FFMPEG_BTBN_TAG}/ffmpeg-${FFMPEG_BTBN_SERIES}-latest-${slug}.zip`
  const btbnTar = (slug) =>
    `https://github.com/BtbN/FFmpeg-Builds/releases/download/${FFMPEG_BTBN_TAG}/ffmpeg-${FFMPEG_BTBN_SERIES}-latest-${slug}.tar.xz`
  const staticBuild = (target) =>
    `https://github.com/eugeneware/ffmpeg-static/releases/download/${FFMPEG_STATIC_TAG}/ffmpeg-${target}.gz`
  const whisper = (asset) =>
    `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_TAG}/${asset}`
  const sherpa = (asset) =>
    `https://github.com/k2-fsa/sherpa-onnx/releases/download/${SHERPA_TAG}/${asset}`
  // The diarization CLI plus the shared libraries it loads from beside itself.
  const sherpaMembers = (exe) => [exe, '*.dll', '*.dylib', '*.so', '*.so.1']

  if (os === 'win') {
    const slug = arch === 'arm64' ? 'winarm64-lgpl-8.1' : 'win64-lgpl-8.1'
    return [
      { name: 'ffmpeg.exe', url: btbn(slug), kind: 'zip', member: 'ffmpeg.exe' },
      {
        // The BLAS build is roughly twice the download of the plain one and
        // markedly faster on CPU, which is the only backend most Windows
        // machines will have. The ggml-cpu-*.dll set is a runtime dispatch
        // table — ggml picks the one matching the host's instruction set, so
        // they all have to come along.
        name: 'whisper-cli.exe',
        url: whisper('whisper-blas-bin-x64.zip'),
        kind: 'zip',
        members: ['whisper-cli.exe', 'parakeet-cli.exe', '*.dll'],
        sentinel: 'whisper-cli.exe'
      },
      {
        // MT links the CRT statically, so the app does not require the user to
        // install a Visual C++ redistributable.
        name: 'sherpa-onnx-offline-speaker-diarization.exe',
        url: sherpa(`sherpa-onnx-${SHERPA_TAG}-win-x64-shared-MT-Release-no-tts.tar.bz2`),
        kind: 'tarxz',
        members: sherpaMembers('sherpa-onnx-offline-speaker-diarization.exe'),
        sentinel: 'sherpa-onnx-offline-speaker-diarization.exe'
      },
      ...modelArtifacts()
    ]
  }
  if (os === 'linux') {
    const slug = arch === 'arm64' ? 'linuxarm64-lgpl-8.1' : 'linux64-lgpl-8.1'
    const asset = arch === 'arm64' ? 'whisper-bin-ubuntu-arm64.tar.gz' : 'whisper-bin-ubuntu-x64.tar.gz'
    return [
      { name: 'ffmpeg', url: btbnTar(slug), kind: 'tarxz', member: 'ffmpeg' },
      {
        name: 'whisper-cli',
        url: whisper(asset),
        kind: 'tarxz',
        members: ['whisper-cli', 'parakeet-cli', '*.so', '*.so.1'],
        sentinel: 'whisper-cli'
      },
      {
        name: 'sherpa-onnx-offline-speaker-diarization',
        url: sherpa(`sherpa-onnx-${SHERPA_TAG}-linux-x64-shared.tar.bz2`),
        kind: 'tarxz',
        members: sherpaMembers('sherpa-onnx-offline-speaker-diarization'),
        sentinel: 'sherpa-onnx-offline-speaker-diarization'
      },
      ...modelArtifacts()
    ]
  }
  if (os === 'mac') {
    // whisper.cpp ships no macOS CLI — only an xcframework for embedding.
    // ffmpeg is fetched; whisper-cli has to come from Homebrew or a source
    // build, handled by noteMacWhisper() below.
    return [
      { name: 'ffmpeg', url: staticBuild(`darwin-${arch}`), kind: 'gz' },
      {
        name: 'sherpa-onnx-offline-speaker-diarization',
        url: sherpa(`sherpa-onnx-${SHERPA_TAG}-osx-${arch}-shared-no-tts.tar.bz2`),
        kind: 'tarxz',
        members: sherpaMembers('sherpa-onnx-offline-speaker-diarization'),
        sentinel: 'sherpa-onnx-offline-speaker-diarization'
      },
      ...modelArtifacts()
    ]
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

/** Recursively collect files matching an exact name or a '*.ext' suffix glob. */
async function findMatching(dir, patterns, found = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      await findMatching(full, patterns, found)
      continue
    }
    const hit = patterns.some((p) =>
      p.startsWith('*.') ? entry.name.endsWith(p.slice(1)) : entry.name === p
    )
    if (hit) found.push(full)
  }
  return found
}

async function extract(artifact, archivePath, workDir, destPath, destDir) {
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

  // Multi-file artifacts (whisper-cli plus its shared libraries) land flat in
  // the destination directory; the loader looks for them beside the executable.
  if (artifact.members) {
    const found = await findMatching(workDir, artifact.members)
    if (found.length === 0) {
      throw new Error(`no files matching ${artifact.members.join(', ')} inside ${artifact.url}`)
    }
    let copied = 0
    for (const file of found) {
      await moveFile(file, join(destDir, basename(file)))
      copied++
    }
    console.log(`    extracted ${copied} files`)
    return
  }

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
  // Models are platform-independent, so they live outside the per-os directory
  // and are shipped once rather than duplicated per target.
  const modelDir = join(ROOT, 'resources', 'models')
  await mkdir(binDir, { recursive: true })
  await mkdir(modelDir, { recursive: true })

  console.log(`Fetching sidecars for ${os}-${arch} -> resources/bin/${os}/`)

  for (const artifact of artifactsFor(os, arch)) {
    const destDir = artifact.dest === 'models' ? modelDir : binDir
    const destPath = join(destDir, artifact.sentinel ?? artifact.name)

    if (!force && (await exists(destPath))) {
      console.log(`  ${artifact.name} already present (use --force to re-download)`)
      continue
    }

    const workDir = await mkdtemp(join(tmpdir(), 'scribe-sidecar-'))
    try {
      console.log(`  downloading ${artifact.name}…`)
      const archivePath = join(workDir, 'download.bin')
      await download(artifact.url, archivePath)
      await extract(artifact, archivePath, workDir, destPath, destDir)
      // The zip/tar members and the raw macOS build are not reliably +x.
      if (os !== 'win' && artifact.dest !== 'models') await chmod(destPath, 0o755)
      const { size } = await stat(destPath)
      console.log(`  ${artifact.name} ready (${(size / 1e6).toFixed(1)} MB)`)
    } finally {
      await rm(workDir, { recursive: true, force: true })
    }
  }

  if (os === 'mac') noteMacWhisper()

  console.log('Done.')
}

/**
 * whisper.cpp has no prebuilt macOS CLI, so it cannot be fetched the way the
 * others are. Both routes below put `whisper-cli` somewhere the app will find
 * it — the sidecar resolver falls back to PATH.
 */
function noteMacWhisper() {
  console.log('')
  console.log('  whisper-cli: no prebuilt macOS binary is published upstream.')
  console.log('  Install it one of these ways:')
  console.log('')
  console.log('    brew install whisper-cpp')
  console.log('')
  console.log('  or build from source (gives Metal acceleration):')
  console.log('')
  console.log(`    git clone --depth 1 --branch ${WHISPER_TAG} https://github.com/ggml-org/whisper.cpp`)
  console.log('    cmake -B build -S whisper.cpp -DCMAKE_BUILD_TYPE=Release')
  console.log('    cmake --build build -j --config Release')
  console.log('    cp build/bin/whisper-cli resources/bin/mac/')
  console.log('')
}

await main()
