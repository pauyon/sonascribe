/**
 * End-to-end smoke test.
 *
 * Drives the LIVE renderer over the Chrome DevTools Protocol, so every check
 * exercises the real preload -> ipcMain -> SQLite/ffmpeg path rather than a
 * mocked stand-in. Generates its own media fixtures with the bundled ffmpeg.
 *
 * The app must be started with Chromium's fake media device, or the live
 * capture checks have no audio to hear:
 *
 *   npx electron . --remote-debugging-port=9222 --use-fake-device-for-media-stream --use-fake-ui-for-media-stream
 *   npm run smoke
 */

import { execFile } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { readWavHeader } from './lib/wav-header.mjs'
// Imported from source on purpose: exercising the app's own renderer, not a
// reimplementation of it. Node 24 strips the types; the module has no runtime imports.
import { renderTranscript } from '../src/main/services/export.ts'
import { parseTokenTable } from '../src/main/services/parakeet-parse.ts'

const exec = promisify(execFile)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 9222
const FIXTURES = join(ROOT, '.smoke-fixtures')
// Downloaded once and reused: re-fetching on every run would make the suite
// depend on the network for something that never changes.
const CACHE = join(ROOT, '.smoke-cache')
/** Public-domain JFK clip shipped with whisper.cpp; real speech to transcribe. */
const SPEECH_URL =
  'https://raw.githubusercontent.com/ggml-org/whisper.cpp/master/samples/jfk.wav'
/** Two real voices — diarization cannot be exercised with synthetic audio. */
const TWO_SPEAKER_URL =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/1-two-speakers-en.wav'
/** Smallest model in the catalogue — keeps the download check tolerable. */
const TEST_MODEL = 'tiny.en'

/* ------------------------------------------------------------------ CDP --- */

async function waitForTarget(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const page = (await res.json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch {
      // Electron not listening yet.
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  throw new Error(
    `No debuggable page on port ${PORT}. Start the app with --remote-debugging-port=${PORT}.`
  )
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let nextId = 1
  const pending = new Map()

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    const entry = pending.get(msg.id)
    if (!entry) return
    pending.delete(msg.id)
    msg.error ? entry.reject(new Error(JSON.stringify(msg.error))) : entry.resolve(msg.result)
  })

  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', () => reject(new Error('CDP socket error')), { once: true })
  })

  return {
    ready,
    close: () => ws.close(),
    async send(method, params = {}) {
      await ready
      const id = nextId++
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        ws.send(JSON.stringify({ id, method, params }))
      })
    }
  }
}

async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  })
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails)
    )
  }
  return result.result.value
}

const json = (v) => JSON.stringify(v)

/* -------------------------------------------------------------- results --- */

const checks = []
function check(name, passed, detail = '') {
  checks.push({ name, passed })
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

function near(actual, expected, toleranceMs) {
  return typeof actual === 'number' && Math.abs(actual - expected) <= toleranceMs
}

/* ------------------------------------------------------------- fixtures --- */

function ffmpegPath() {
  const os = { win32: 'win', darwin: 'mac', linux: 'linux' }[process.platform]
  return join(ROOT, 'resources', 'bin', os, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
}

/**
 * Builds two fixtures: a plain stereo MP3, and an MP4 that really does carry a
 * video stream — the latter is the only way to prove the importer's -vn path
 * strips video instead of failing on it.
 */
async function buildFixtures() {
  await rm(FIXTURES, { recursive: true, force: true })
  await mkdir(FIXTURES, { recursive: true })
  const ff = ffmpegPath()

  const mp3 = join(FIXTURES, 'tone.mp3')
  await exec(ff, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', 'sine=frequency=440:sample_rate=44100:duration=5', '-ac', '2', '-y', mp3])

  const mp4 = join(FIXTURES, 'clip.mp4')
  await exec(ff, ['-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15:duration=3',
    '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=3',
    '-c:v', 'libopenh264', '-c:a', 'aac', '-ac', '2', '-shortest', '-y', mp4])

  return { mp3, mp4 }
}

/** Fetches the speech sample once and caches it for later runs. */
async function speechFixture() {
  await mkdir(CACHE, { recursive: true })
  const path = join(CACHE, 'speech.wav')
  try {
    if ((await stat(path)).size > 1000) return path
  } catch {
    // Not cached yet.
  }
  const res = await fetch(SPEECH_URL, { redirect: 'follow' })
  if (!res.ok) throw new Error(`speech fixture download failed: ${res.status}`)
  await writeFile(path, Buffer.from(await res.arrayBuffer()))
  return path
}

/**
 * Reads word rows straight from SQLite.
 *
 * Opened read-only so it cannot disturb the running app, which holds the same
 * database open in WAL mode.
 */
function readWords(dbPath, recordingId) {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    return db
      .prepare(
        `SELECT w.start_ms, w.end_ms, w.text
           FROM words w
           JOIN utterances u ON u.id = w.utterance_id
          WHERE u.recording_id = ?
          ORDER BY w.start_ms`
      )
      .all(recordingId)
  } finally {
    db.close()
  }
}

/**
 * Rebuilds a TranscriptBundle from SQLite and renders it in every format using
 * the app's own renderer (imported straight from source — Node 24 strips the
 * types, and the module has no runtime imports to resolve).
 */
function renderAllFormats(dbPath, recordingId) {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const rec = db.prepare('SELECT * FROM recordings WHERE id = ?').get(recordingId)
    const speakers = db
      .prepare('SELECT * FROM speakers WHERE recording_id = ? ORDER BY cluster_id')
      .all(recordingId)
      .map((s) => ({
        id: s.id,
        recordingId: s.recording_id,
        clusterId: s.cluster_id,
        displayName: s.display_name,
        color: s.color
      }))
    const utterances = db
      .prepare('SELECT * FROM utterances WHERE recording_id = ? ORDER BY start_ms')
      .all(recordingId)
      .map((u) => ({
        id: u.id,
        recordingId: u.recording_id,
        speakerId: u.speaker_id,
        startMs: u.start_ms,
        endMs: u.end_ms,
        text: u.text,
        edited: u.edited === 1,
        confidence: u.confidence
      }))

    const bundle = {
      recording: {
        id: rec.id,
        title: rec.title,
        createdAt: rec.created_at,
        durationMs: rec.duration_ms,
        source: rec.source,
        sourcePath: rec.source_path,
        status: rec.status,
        error: rec.error,
        modelId: rec.model_id,
        language: rec.language
      },
      tracks: [],
      speakers,
      utterances
    }

    return Object.fromEntries(
      ['txt', 'md', 'srt', 'vtt', 'json'].map((f) => [f, renderTranscript(bundle, f)])
    )
  } finally {
    db.close()
  }
}

/**
 * Two-speaker conversation fixture, cached like the single-speaker one.
 * Synthetic audio cannot exercise diarization — it needs two real voices.
 */
async function twoSpeakerFixture() {
  await mkdir(CACHE, { recursive: true })
  const path = join(CACHE, 'two-speakers.wav')
  try {
    if ((await stat(path)).size > 1000) return path
  } catch {
    // Not cached yet.
  }
  const res = await fetch(TWO_SPEAKER_URL, { redirect: 'follow' })
  if (!res.ok) throw new Error(`two-speaker fixture download failed: ${res.status}`)
  await writeFile(path, Buffer.from(await res.arrayBuffer()))
  return path
}

/** Polls until a recording reaches one of the given statuses. */
async function waitForStatus(client, id, statuses, timeoutMs = 600000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const rows = await evaluate(client, `window.api.invoke('recordings:list')`)
    const row = rows.find((r) => r.id === id)
    if (row && statuses.includes(row.status)) return row
    await new Promise((r) => setTimeout(r, 700))
  }
  throw new Error(`Timed out waiting for ${id} to reach ${statuses.join('/')}`)
}

/** Polls until every listed recording has left the in-flight states. */
async function waitForIngest(client, ids, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const rows = await evaluate(client, `window.api.invoke('recordings:list')`)
    const mine = rows.filter((r) => ids.includes(r.id))
    if (mine.length === ids.length && mine.every((r) => r.status !== 'normalizing')) return mine
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('Timed out waiting for ingest to finish')
}

/* ------------------------------------------------------------------ run --- */

const page = await waitForTarget()
const client = cdp(page.webSocketDebuggerUrl)
await client.ready
await client.send('Runtime.enable')

// The app may be sitting on any route from prior use. Drive it to a known
// starting point rather than asserting against wherever it happens to be.
await evaluate(client, `location.hash = '#/library'; true`)
// Wait for the route to actually commit rather than guessing at a delay: on a
// loaded machine a fixed sleep races React's render and fails for no reason.
for (let attempt = 0; attempt < 40; attempt++) {
  const heading = await evaluate(client, `document.querySelector('h1')?.textContent ?? null`)
  if (heading === 'Library') break
  await new Promise((r) => setTimeout(r, 150))
}

// ---- Phase 1: bridge, security boundaries, CRUD ----

const bridge = await evaluate(
  client,
  `({ invoke: typeof window.api?.invoke, on: typeof window.api?.on,
      getPath: typeof window.api?.getPathForFile,
      require: typeof window.require, process: typeof window.process })`
)
check('preload exposes invoke/on/getPathForFile',
  bridge.invoke === 'function' && bridge.on === 'function' && bridge.getPath === 'function',
  json(bridge))
check('renderer has no node require/process',
  bridge.require === 'undefined' && bridge.process === 'undefined')

const ui = await evaluate(
  client,
  `({ nav: [...document.querySelectorAll('.navlink')].map((a) => a.textContent),
      h1: document.querySelector('h1')?.textContent ?? null })`
)
// Assert the routes by name rather than by count, so adding one does not fail
// the check for the wrong reason.
check(
  'React mounted with all routes and the Library heading',
  ui.h1 === 'Library' &&
    ['Library', 'Record', 'Models'].every((label) => ui.nav.includes(label)),
  json(ui)
)

const info = await evaluate(client, `window.api.invoke('app:info')`)

// The app was renamed from "Scribe"; user data must have come with it rather
// than the app silently starting empty and stranding gigabytes of models.
check('user data lives under the current product name',
  basename(info.userDataPath).toLowerCase() === 'sonascribe', json(info.userDataPath))
check('no data is left behind under the old product name',
  !existsSync(join(dirname(info.userDataPath), 'scribe')),
  join(dirname(info.userDataPath), 'scribe'))
check('app:info round-trips', typeof info?.version === 'string', `platform=${info?.platform}`)
check('ffmpeg sidecar resolves', info?.ffmpegAvailable === true)

const created = await evaluate(
  client,
  `window.api.invoke('recordings:create', { title: 'SMOKE TEST', source: 'imported' })`
)
check('recordings:create returns a row', typeof created?.id === 'string')

const renamed = await evaluate(
  client,
  `window.api.invoke('recordings:rename', { id: ${json(created.id)}, title: 'SMOKE RENAMED' })`
)
check('recordings:rename persists', renamed?.title === 'SMOKE RENAMED')

const emptyTitle = await evaluate(
  client,
  `window.api.invoke('recordings:rename', { id: ${json(created.id)}, title: '   ' })
     .then(() => 'RESOLVED').catch((e) => 'REJECTED: ' + e.message)`
)
check('empty title rejected by main', String(emptyTitle).startsWith('REJECTED'))

const blocked = await evaluate(
  client,
  `window.api.invoke('fs:readFile').then(() => 'R').catch((e) => 'REJECTED: ' + e.message)`
)
check('unknown channel blocked by preload', String(blocked).includes('Blocked unknown IPC channel'))

const blockedEvent = await evaluate(
  client,
  `(() => { try { window.api.on('internal:secret', () => {}); return 'ALLOWED' }
            catch (e) { return 'BLOCKED: ' + e.message } })()`
)
check('unknown event blocked by preload', String(blockedEvent).startsWith('BLOCKED'))

await evaluate(client, `window.api.invoke('recordings:delete', { id: ${json(created.id)} })`)
const afterDelete = await evaluate(client, `window.api.invoke('recordings:list')`)
check('recordings:delete removes the row', !afterDelete.some((r) => r.id === created.id))

// ---- Phase 2: ingest ----

console.log('\nbuilding fixtures…')
const { mp3, mp4 } = await buildFixtures()

// Prove events actually arrive, rather than inferring it from the final state.
await evaluate(client, `
  window.__smokeEvents = { progress: 0, updated: [] };
  window.api.on('import:progress', () => { window.__smokeEvents.progress++ });
  window.api.on('recording:updated', (r) => { window.__smokeEvents.updated.push(r.id) });
  true
`)

const imported = await evaluate(
  client,
  `window.api.invoke('recordings:import', { paths: [${json(mp3)}, ${json(mp4)}] })`
)
check('recordings:import returns rows immediately', imported?.length === 2,
  `statuses=${imported?.map((r) => r.status).join(',')}`)
check('imported rows start in normalizing',
  imported.every((r) => r.status === 'normalizing'))
check('title derived from filename without extension',
  imported.some((r) => r.title === 'tone') && imported.some((r) => r.title === 'clip'),
  imported.map((r) => r.title).join(', '))

const done = await waitForIngest(client, imported.map((r) => r.id))

const tone = done.find((r) => r.title === 'tone')
const clip = done.find((r) => r.title === 'clip')

check('mp3 ingest succeeded', tone?.status === 'queued', `status=${tone?.status} err=${tone?.error ?? ''}`)
check('mp4 (with video stream) ingest succeeded', clip?.status === 'queued',
  `status=${clip?.status} err=${clip?.error ?? ''}`)

check('mp3 duration detected ~5000ms', near(tone?.durationMs, 5000, 150), `${tone?.durationMs}ms`)
check('mp4 duration detected ~3000ms', near(clip?.durationMs, 3000, 150), `${clip?.durationMs}ms`)

const events = await evaluate(client, `window.__smokeEvents`)
check('import:progress events were pushed to renderer', events.progress > 0, `${events.progress} events`)
check('recording:updated pushed for both imports',
  imported.every((r) => events.updated.includes(r.id)))

// Inspect the produced WAV on disk: this is what the ML sidecars will consume.
const toneBundle = await evaluate(client, `window.api.invoke('recordings:get', { id: ${json(tone.id)}})`)
check('a track row was created', toneBundle?.tracks?.length === 1,
  `kind=${toneBundle?.tracks?.[0]?.kind}`)
check("imported track kind is 'mixed'", toneBundle?.tracks?.[0]?.kind === 'mixed')

const wavPath = toneBundle.tracks[0].wavPath
const header = await readWavHeader(wavPath)
check('normalized WAV is 16 kHz', header.sampleRate === 16000, `${header.sampleRate} Hz`)
check('normalized WAV is mono', header.channels === 1, `${header.channels} ch`)
check('normalized WAV is 16-bit PCM', header.bitsPerSample === 16)
check('WAV header duration matches row', near(header.durationMs, tone.durationMs, 50),
  `${header.durationMs}ms vs ${tone.durationMs}ms`)

// The original is kept alongside the normalized copy for full-quality playback.
const originalOk = await stat(toneBundle.recording.sourcePath).then(() => true, () => false)
check('original file copied into app storage', originalOk && toneBundle.recording.sourcePath !== mp3)

/**
 * Exercises the media protocol through a real <audio> element.
 *
 * Deliberately not fetch(): Chromium blocks cross-origin fetches to custom
 * schemes, and the renderer's origin is file://. Media elements are exempt, and
 * playback is the behaviour that actually has to work.
 */
const audioProbe = (url) => `
  (async () => {
    const a = new Audio(${json(url)});
    // Muted playback is exempt from Chromium's autoplay gesture requirement,
    // which the test harness has no way to satisfy.
    a.muted = true;

    const once = (target, event, timeoutMs) => new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), timeoutMs);
      target.addEventListener(event, () => { clearTimeout(t); resolve(true) }, { once: true });
    });

    const loaded = await new Promise((resolve) => {
      const t = setTimeout(() => resolve({ ok: false, why: 'timeout' }), 10000);
      a.addEventListener('loadedmetadata', () => {
        clearTimeout(t); resolve({ ok: true, duration: a.duration });
      }, { once: true });
      a.addEventListener('error', () => {
        clearTimeout(t);
        resolve({ ok: false, why: 'code ' + (a.error && a.error.code) });
      }, { once: true });
      a.load();
    });
    if (!loaded.ok) return loaded;

    // Wait on real media events rather than wall-clock sleeps: a backgrounded
    // renderer has its timers throttled, which makes fixed delays flaky.
    let playErr = null;
    try { await a.play() } catch (e) { playErr = e.name + ': ' + e.message }
    const advanced = await once(a, 'timeupdate', 8000) && a.currentTime > 0;

    // A successful seek past the buffered head proves the handler honoured a
    // range request; without 206 support the element cannot seek at all.
    a.currentTime = 3;
    const seekFired = await once(a, 'seeked', 8000);
    const seeked = seekFired && a.currentTime >= 2.9;

    a.pause();
    return { ...loaded, advanced, seeked, playErr, at: a.currentTime };
  })()
`

const playback = await evaluate(
  client,
  audioProbe(`sonascribe-media://track/${toneBundle.tracks[0].id}`)
)
check('media protocol: <audio> loads track metadata', playback.ok === true,
  playback.ok ? `duration=${playback.duration}s` : `why=${playback.why}`)
check('media protocol: playback actually advances', playback.advanced === true,
  `at=${playback.at} playErr=${playback.playErr ?? 'none'}`)
check('media protocol: seeking works (range requests)', playback.seeked === true,
  `at=${playback.at}`)

const sourcePlayback = await evaluate(
  client,
  audioProbe(`sonascribe-media://source/${tone.id}`)
)
check('media protocol serves the original file too', sourcePlayback.ok === true,
  sourcePlayback.ok ? `duration=${sourcePlayback.duration}s` : `why=${sourcePlayback.why}`)

// An id that resolves to nothing must fail rather than serve something.
const badMedia = await evaluate(client, audioProbe('sonascribe-media://track/does-not-exist'))
check('media protocol refuses unknown ids', badMedia.ok === false, `why=${badMedia.why}`)

const traversal = await evaluate(
  client,
  audioProbe('sonascribe-media://track/..%2F..%2F..%2Fwindows%2Fwin.ini')
)
check('media protocol rejects path traversal', traversal.ok === false, `why=${traversal.why}`)

// ---- Phase 3: models + transcription ----

check('whisper-cli sidecar resolves', info?.whisperAvailable === true)

const catalogue = await evaluate(client, `window.api.invoke('models:list')`)
check('models:list returns the catalogue', Array.isArray(catalogue) && catalogue.length >= 5,
  `${catalogue?.length} models`)

const before = catalogue.find((m) => m.id === TEST_MODEL)
if (!before?.installed) {
  console.log(`\ndownloading ${TEST_MODEL} (first run only)…`)
  await evaluate(client, `
    window.__dl = { last: null };
    window.api.on('model:progress', (p) => { window.__dl.last = p });
    window.api.invoke('models:download', { id: ${json(TEST_MODEL)} })
  `)
  const deadline = Date.now() + 600000
  let settled = false
  while (Date.now() < deadline && !settled) {
    const list = await evaluate(client, `window.api.invoke('models:list')`)
    const err = await evaluate(client, `window.__dl?.last?.error ?? null`)
    settled = list.find((m) => m.id === TEST_MODEL)?.installed === true || err != null
    if (!settled) await new Promise((r) => setTimeout(r, 1000))
  }
  const dl = await evaluate(client, `window.__dl?.last ?? null`)
  check('model download reported progress', dl != null && dl.receivedBytes > 0,
    dl ? `${dl.receivedBytes} bytes` : 'no events')
  // Surface the failure reason here; otherwise the install check below just
  // reports "not installed" and hides why.
  check('model download completed without error', dl?.error == null, dl?.error ?? '')
}

const installed = await evaluate(client, `window.api.invoke('models:list')`)
const testStatus = installed.find((m) => m.id === TEST_MODEL)
check(`${TEST_MODEL} is installed and verified`, testStatus?.installed === true,
  `bytesOnDisk=${testStatus?.bytesOnDisk}`)

// Transcribing with no model selected must fail with a usable message, not a crash.
await evaluate(client, `window.api.invoke('settings:set', { modelId: '' })`)
const speechPath = await speechFixture()
const speechRows = await evaluate(
  client,
  `window.api.invoke('recordings:import', { paths: [${json(speechPath)}] })`
)
const speech = speechRows[0]
await waitForStatus(client, speech.id, ['queued', 'failed'])

const noModel = await evaluate(
  client,
  `window.api.invoke('transcribe:start', { id: ${json(speech.id)} })
     .then(() => 'RESOLVED').catch((e) => 'REJECTED: ' + e.message)`
)
check('transcribe without a model is rejected clearly',
  String(noModel).includes('No transcription model selected'), String(noModel).slice(0, 90))

const saved = await evaluate(
  client,
  `window.api.invoke('settings:set', { modelId: ${json(TEST_MODEL)}, language: 'en' })`
)
check('settings persist the chosen model', saved?.modelId === TEST_MODEL)

console.log('\ntranscribing…')
await evaluate(client, `
  window.__jobs = [];
  window.api.on('job:progress', (p) => { window.__jobs.push(p) });
  window.api.invoke('transcribe:start', { id: ${json(speech.id)} })
`)

const transcribed = await waitForStatus(client, speech.id, ['ready', 'failed'])
check('transcription completed', transcribed.status === 'ready',
  `status=${transcribed.status} err=${(transcribed.error ?? '').slice(0, 120)}`)
check('model id recorded on the recording', transcribed.modelId === TEST_MODEL)

const jobEvents = await evaluate(client, `window.__jobs`)
check('job:progress events were pushed', jobEvents.length > 0, `${jobEvents.length} events`)
check('job progress reached 100%', jobEvents.some((j) => j.fraction === 1))

const bundle = await evaluate(client, `window.api.invoke('recordings:get', { id: ${json(speech.id)} })`)
const utterances = bundle?.utterances ?? []
check('transcript has utterances', utterances.length > 0, `${utterances.length}`)

const fullText = utterances.map((u) => u.text).join(' ').toLowerCase()
// The clip is "...ask not what your country can do for you..."
check('transcript contains the expected speech', fullText.includes('fellow americans'),
  JSON.stringify(fullText.slice(0, 90)))

check('utterance timestamps are ordered and within duration',
  utterances.every((u, i) =>
    u.startMs <= u.endMs &&
    (i === 0 || u.startMs >= utterances[i - 1].startMs) &&
    u.endMs <= (transcribed.durationMs ?? 0) + 1000),
  `last end=${utterances.at(-1)?.endMs} duration=${transcribed.durationMs}`)

check('utterances carry a confidence score',
  utterances.every((u) => typeof u.confidence === 'number' && u.confidence > 0 && u.confidence <= 1),
  `first=${utterances[0]?.confidence}`)

// Word rows are what Phase 5 aligns speaker turns against. They are not part of
// the IPC bundle, so inspect the database directly rather than assume they were
// written.
const words = readWords(join(info.userDataPath, 'sonascribe.db'), speech.id)
check('word-level rows were persisted', words.length > 10, `${words.length} words`)
check('words have monotonic, non-negative timings',
  words.every((w, i) =>
    w.start_ms >= 0 && w.start_ms <= w.end_ms && (i === 0 || w.start_ms >= words[i - 1].start_ms)),
  `first=${words[0]?.start_ms}-${words[0]?.end_ms}ms`)
check('words reassemble into the transcript text',
  words.map((w) => w.text).join(' ').toLowerCase().includes('fellow americans'),
  json(words.slice(0, 6).map((w) => w.text).join(' ')))

// Re-transcribing must replace, not duplicate.
await evaluate(client, `window.api.invoke('transcribe:start', { id: ${json(speech.id)} })`)
const again = await waitForStatus(client, speech.id, ['ready', 'failed'])
const bundle2 = await evaluate(client, `window.api.invoke('recordings:get', { id: ${json(speech.id)} })`)
check('re-transcribing replaces rather than duplicates',
  again.status === 'ready' && bundle2.utterances.length === utterances.length,
  `${utterances.length} -> ${bundle2.utterances.length}`)

// ---- Phase 4: editor (peaks, editing, export) ----

const peaks = await evaluate(
  client,
  `window.api.invoke('peaks:get', { recordingId: ${json(speech.id)}, buckets: 400 })`
)
check('peaks:get returns the requested resolution', peaks?.values?.length === 400,
  `${peaks?.values?.length} buckets`)
check('peaks are normalized to 0..1',
  peaks.values.every((v) => typeof v === 'number' && v >= 0 && v <= 1))
check('peaks describe real audio, not silence',
  peaks.values.some((v) => v > 0.05) && peaks.values.some((v) => v < 0.02),
  `max=${Math.max(...peaks.values).toFixed(3)} min=${Math.min(...peaks.values).toFixed(3)}`)
check('peaks duration matches the track', near(peaks.durationMs, transcribed.durationMs, 50),
  `${peaks.durationMs}ms`)

// Second call must hit the on-disk cache rather than re-reading the PCM.
const t0 = Date.now()
const cached = await evaluate(
  client,
  `window.api.invoke('peaks:get', { recordingId: ${json(speech.id)}, buckets: 400 })`
)
const cachedMs = Date.now() - t0
check('cached peaks match the first computation',
  JSON.stringify(cached.values) === JSON.stringify(peaks.values), `${cachedMs}ms`)

// Editing an utterance.
// Uses the post-re-transcription rows on purpose: re-transcribing replaces every
// utterance with a new id, so an id captured before that point is stale.
const target = bundle2.utterances[0]
const EDITED = 'Edited by the smoke test.'
await evaluate(
  client,
  `window.api.invoke('utterances:update', { id: ${json(target.id)}, text: ${json(EDITED)} })`
)
const afterEdit = await evaluate(client, `window.api.invoke('recordings:get', { id: ${json(speech.id)} })`)
const editedRow = afterEdit.utterances.find((u) => u.id === target.id)
check('utterance text was updated', editedRow?.text === EDITED, json(editedRow?.text))
check('utterance is flagged as human-edited', editedRow?.edited === true)
check('editing preserved the timings',
  editedRow?.startMs === target.startMs && editedRow?.endMs === target.endMs)

// Export: exercise the real renderer against real rows. The IPC channel itself
// opens a native modal save dialog, which cannot be driven from here, so the
// production render function is imported directly instead of reimplemented —
// a test that reimplements the formatter would pass even when the app is wrong.
const rendered = renderAllFormats(join(info.userDataPath, 'sonascribe.db'), speech.id)
check('TXT export has a timestamped line', /^\[\d{2}:\d{2}\]/m.test(rendered.txt),
  json(rendered.txt.split('\n')[0]))
check('TXT export contains the edit', rendered.txt.includes(EDITED))
check('SRT export is correctly formed',
  /^1\r?\n\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}\r?\n/.test(rendered.srt),
  json(rendered.srt.slice(0, 44)))
check('VTT export starts with the WEBVTT header and uses dot separators',
  rendered.vtt.startsWith('WEBVTT') && /\d{2}:\d{2}:\d{2}\.\d{3} --> /.test(rendered.vtt))
check('Markdown export has a title heading', rendered.md.startsWith(`# speech`),
  json(rendered.md.split('\n')[0]))
const parsed = JSON.parse(rendered.json)
check('JSON export parses and carries utterances',
  Array.isArray(parsed.utterances) && parsed.utterances.length === utterances.length,
  `${parsed.utterances?.length} utterances`)
check('JSON export records the edited flag',
  parsed.utterances.some((u) => u.edited === true && u.text === EDITED))

// A stale id must fail loudly rather than silently dropping the user's edit.
const staleEdit = await evaluate(
  client,
  `window.api.invoke('utterances:update', { id: 'does-not-exist', text: 'x' })
     .then(() => 'RESOLVED').catch((e) => 'REJECTED: ' + e.message)`
)
check('editing a stale utterance id is rejected',
  String(staleEdit).includes('no longer exists'), String(staleEdit).slice(0, 80))

// ---- Phase 5: diarization ----

check('diarization helper and models resolve', info?.diarizationAvailable === true)

const twoSpeakerPath = await twoSpeakerFixture()
await evaluate(client, `window.api.invoke('settings:set', { diarize: true, speakerCount: 2 })`)
const diarSettings = await evaluate(client, `window.api.invoke('settings:get')`)
check('diarization settings persist',
  diarSettings?.diarize === true && diarSettings?.speakerCount === 2,
  json(diarSettings))

const convRows = await evaluate(
  client,
  `window.api.invoke('recordings:import', { paths: [${json(twoSpeakerPath)}] })`
)
const conv = convRows[0]
await waitForStatus(client, conv.id, ['queued', 'failed'])

console.log('\ntranscribing + diarizing…')
await evaluate(client, `
  window.__stages = [];
  window.api.on('job:progress', (p) => { window.__stages.push(p.stage) });
  window.api.invoke('transcribe:start', { id: ${json(conv.id)} })
`)
const diarized = await waitForStatus(client, conv.id, ['ready', 'failed'])
check('diarized run completed', diarized.status === 'ready',
  `status=${diarized.status} err=${(diarized.error ?? '').slice(0, 160)}`)

const stages = await evaluate(client, `[...new Set(window.__stages)]`)
check('pipeline reported a diarizing stage', stages.includes('diarizing'), json(stages))

const convBundle = await evaluate(client, `window.api.invoke('recordings:get', { id: ${json(conv.id)} })`)
const convSpeakers = convBundle?.speakers ?? []
const convUtterances = convBundle?.utterances ?? []

check('two speakers were detected', convSpeakers.length === 2,
  json(convSpeakers.map((s) => s.displayName)))
check('speakers have distinct colours',
  new Set(convSpeakers.map((s) => s.color)).size === convSpeakers.length)
check('every utterance is attributed to a speaker',
  convUtterances.length > 0 && convUtterances.every((u) => u.speakerId != null),
  `${convUtterances.length} utterances`)
check('both speakers actually appear in the transcript',
  new Set(convUtterances.map((u) => u.speakerId)).size === 2,
  json([...new Set(convUtterances.map((u) => convSpeakers.find((s) => s.id === u.speakerId)?.displayName))]))

// The whole point of word-level alignment: a speaker change must land on an
// utterance boundary, never mid-line.
check('utterances do not overlap in time',
  convUtterances.every((u, i) => i === 0 || u.startMs >= convUtterances[i - 1].endMs - 1),
  'boundaries are monotonic')

const convWords = readWords(join(info.userDataPath, 'sonascribe.db'), conv.id)
check('word rows survived the merge', convWords.length > 10, `${convWords.length} words`)

// Whisper emits control tokens ([_BEG_]) and timestamp tokens ([_TT_480]).
// Rebuilding text from words leaks them unless every shape is filtered.
const controlTokenRe = /[_[^]]*]/
const leakyUtterance = convUtterances.find((u) => controlTokenRe.test(u.text))
check('no whisper control tokens leak into utterance text', leakyUtterance == null,
  leakyUtterance ? json(leakyUtterance.text.slice(0, 70)) : 'clean')
const leakyWord = convWords.find((w) => controlTokenRe.test(w.text))
check('no whisper control tokens leak into word rows', leakyWord == null,
  leakyWord ? json(leakyWord.text) : 'clean')

// Renaming must survive a re-run, which is why speakers are keyed by cluster id.
const first = convSpeakers[0]
await evaluate(
  client,
  `window.api.invoke('speakers:rename', { id: ${json(first.id)}, displayName: 'Dana' })`
)
const renamedBundle = await evaluate(client, `window.api.invoke('recordings:get', { id: ${json(conv.id)} })`)
check('speaker rename persists',
  renamedBundle.speakers.find((s) => s.id === first.id)?.displayName === 'Dana')

await evaluate(client, `window.api.invoke('transcribe:start', { id: ${json(conv.id)} })`)
await waitForStatus(client, conv.id, ['ready', 'failed'])
const afterRerun = await evaluate(client, `window.api.invoke('recordings:get', { id: ${json(conv.id)} })`)
check('rename survives re-running the pipeline',
  afterRerun.speakers.some((s) => s.displayName === 'Dana'),
  json(afterRerun.speakers.map((s) => s.displayName)))
check('re-running does not duplicate speakers', afterRerun.speakers.length === 2,
  `${afterRerun.speakers.length} speakers`)

// Merging: the correction for one person split across two clusters.
const [a, b] = afterRerun.speakers
const beforeMerge = afterRerun.utterances.length
await evaluate(client, `
  window.api.invoke('speakers:merge', {
    recordingId: ${json(conv.id)}, fromId: ${json(b.id)}, intoId: ${json(a.id)}
  })
`)
const merged = await evaluate(client, `window.api.invoke('recordings:get', { id: ${json(conv.id)} })`)
check('merging removes the folded speaker', merged.speakers.length === 1,
  json(merged.speakers.map((s) => s.displayName)))
check('merging reassigns rather than deletes lines',
  merged.utterances.length === beforeMerge &&
    merged.utterances.every((u) => u.speakerId === a.id),
  `${merged.utterances.length} of ${beforeMerge} lines kept`)

const selfMerge = await evaluate(client, `
  window.api.invoke('speakers:merge', {
    recordingId: ${json(conv.id)}, fromId: ${json(a.id)}, intoId: ${json(a.id)}
  }).then(() => 'RESOLVED').catch((e) => 'REJECTED: ' + e.message)
`)
check('merging a speaker into itself is rejected',
  String(selfMerge).startsWith('REJECTED'), String(selfMerge).slice(0, 70))

// Exports must carry speaker names through.
const convRendered = renderAllFormats(join(info.userDataPath, 'sonascribe.db'), conv.id)
check('TXT export includes the speaker name', convRendered.txt.includes('Dana:'),
  json(convRendered.txt.split('\n')[0]))
check('VTT export includes a voice tag', convRendered.vtt.includes('<v Dana>'))
check('JSON export names the speaker',
  JSON.parse(convRendered.json).utterances.every((u) => u.speaker === 'Dana'))

// ---- Editor UI: driving the real controls ----

/**
 * Everything above calls transcribe:start over IPC. That misses whether the
 * button a user actually presses is even on screen — it was once replaced by a
 * Cancel button and a fake progress bar for a job that had never started,
 * because the resting 'queued' status was being read as "busy".
 */
const uiRows = await evaluate(
  client,
  `window.api.invoke('recordings:import', { paths: [${json(await speechFixture())}] })`
)
const uiRec = uiRows[0]
await waitForStatus(client, uiRec.id, ['queued', 'failed'])

await evaluate(client, `location.hash = '#/recordings/${uiRec.id}'`)
await new Promise((r) => setTimeout(r, 1200))

const idle = await evaluate(client, `
  ({
    buttons: [...document.querySelectorAll('.page__actions button')].map((b) => b.textContent),
    progress: document.querySelector('.job') != null,
    pill: document.querySelector('.pill')?.textContent ?? null
  })
`)
check('an imported recording offers a Transcribe button', idle.buttons.includes('Transcribe'),
  json(idle.buttons))
check('no progress bar before a job has started', idle.progress === false)
check('status reads as ready to transcribe, not as in progress',
  idle.pill === 'Ready to transcribe', json(idle.pill))

// Press it the way a user does.
await evaluate(client, `
  [...document.querySelectorAll('.page__actions button')]
    .find((b) => b.textContent === 'Transcribe').click()
`)
await new Promise((r) => setTimeout(r, 700))

const running = await evaluate(client, `
  ({
    buttons: [...document.querySelectorAll('.page__actions button')].map((b) => b.textContent),
    progress: document.querySelector('.job') != null,
    stage: document.querySelector('.job__stage')?.textContent ?? null,
    elapsed: document.querySelector('.job__elapsed')?.textContent ?? null
  })
`)
check('pressing Transcribe starts a job and swaps in Cancel',
  running.buttons.includes('Cancel'), json(running.buttons))
check('a progress bar appears once the job starts', running.progress === true)
check('progress names the stage rather than saying "Preparing"',
  running.stage != null && !running.stage.includes('Preparing'), json(running.stage))
check('progress shows an elapsed timer', /^\d+:\d{2}/.test(running.elapsed ?? ''),
  json(running.elapsed))

const uiDone = await waitForStatus(client, uiRec.id, ['ready', 'failed'])
check('the job started from the UI completes', uiDone.status === 'ready',
  `status=${uiDone.status}`)

await new Promise((r) => setTimeout(r, 800))
const finished = await evaluate(client, `
  ({
    progress: document.querySelector('.job') != null,
    buttons: [...document.querySelectorAll('.page__actions button')].map((b) => b.textContent),
    lines: document.querySelectorAll('.utterance').length
  })
`)
check('progress bar clears when the job finishes', finished.progress === false)
check('the button returns to offering another run',
  finished.buttons.some((b) => b?.includes('Transcribe')), json(finished.buttons))
check('the transcript is rendered in the editor', finished.lines > 0, `${finished.lines} lines`)

await evaluate(client, `window.api.invoke('recordings:delete', { id: ${json(uiRec.id)} })`)
await evaluate(client, `location.hash = '#/library'`)

// ---- Parakeet engine ----

check('parakeet-cli sidecar resolves', info?.parakeetAvailable === true)

/**
 * A real slice of `parakeet-cli --print-segments` output.
 *
 * The parser is imported from source and run against captured text rather than
 * by driving a 356 MB model, so the fragile part — the table regex — is covered
 * on every run. If upstream changes the format this fails immediately instead
 * of silently producing empty transcripts.
 */
const PARAKEET_TABLE = [
  '  [ 0] id= 8191 frame=  0 dur_idx= 0 dur_val= 0 p=1.0000 plog=-0.0000 t0=   0 t1=   0 word_start=false "<blk>"',
  '  [11] id=  279 frame= 41 dur_idx= 4 dur_val= 4 p=0.9988 plog=-19.2052 t0= 328 t1= 360 word_start=true "▁a"',
  '  [12] id=  583 frame= 45 dur_idx= 4 dur_val= 4 p=1.0000 plog=-20.2843 t0= 360 t1= 392 word_start=false "sk"',
  '  [13] id= 1491 frame= 53 dur_idx= 4 dur_val= 4 p=1.0000 plog=-22.9013 t0= 424 t1= 456 word_start=true "▁not"',
  '  [16] id=  867 frame= 75 dur_idx= 1 dur_val= 1 p=0.9926 plog=-12.6950 t0= 600 t1= 608 word_start=true "▁co"',
  '  [17] id=  331 frame= 76 dur_idx= 1 dur_val= 1 p=0.9999 plog=-9.6004 t0= 608 t1= 616 word_start=false "un"',
  '  [18] id=  958 frame= 77 dur_idx= 2 dur_val= 2 p=1.0000 plog=-10.4699 t0= 616 t1= 632 word_start=false "tr"',
  '  [19] id= 7893 frame= 79 dur_idx= 2 dur_val= 2 p=1.0000 plog=-17.4963 t0= 632 t1= 648 word_start=false "y"',
  '  [24] id= 7877 frame= 98 dur_idx= 4 dur_val= 4 p=0.8209 plog=-12.6989 t0= 776 t1= 776 word_start=false ","',
  'parakeet_print_timings:    total time =  1304.57 ms'
].join('\n')

const pkWords = parseTokenTable(PARAKEET_TABLE)
check('parakeet parser folds sub-word tokens into words',
  pkWords.map((w) => w.text).join(' ') === 'ask not country,',
  json(pkWords.map((w) => w.text)))
check('parakeet parser converts centiseconds to milliseconds',
  pkWords[0].startMs === 3280 && pkWords[0].endMs === 3920,
  `${pkWords[0].startMs}-${pkWords[0].endMs}ms`)
// The trailing comma is its own token and legitimately extends the word it
// attaches to, both in span and in worst-case confidence.
check('parakeet parser extends a word to its last token',
  pkWords[2].startMs === 6000 && pkWords[2].endMs === 7760,
  `country, ${pkWords[2].startMs}-${pkWords[2].endMs}ms`)
check('parakeet parser keeps the weakest token probability',
  Math.abs(pkWords[2].probability - 0.8209) < 1e-6, `${pkWords[2].probability}`)
check('parakeet parser drops non-token lines and control tokens',
  pkWords.length === 3 && !pkWords.some((w) => w.text.includes('<blk>')),
  `${pkWords.length} words`)

// End-to-end only when the model happens to be installed: it is a 356 MB
// download and the parser above already covers the risky part.
const pkStatus = (await evaluate(client, `window.api.invoke('models:list')`)).find(
  (m) => m.id === 'parakeet-tdt-0.6b-v3-q4_0'
)
if (pkStatus?.installed) {
  console.log('\ntranscribing with Parakeet…')
  await evaluate(client, `window.api.invoke('settings:set', { modelId: 'parakeet-tdt-0.6b-v3-q4_0' })`)
  const pkRows = await evaluate(
    client,
    `window.api.invoke('recordings:import', { paths: [${json(await speechFixture())}] })`
  )
  const pkRec = pkRows[0]
  await waitForStatus(client, pkRec.id, ['queued', 'failed'])
  await evaluate(client, `window.api.invoke('transcribe:start', { id: ${json(pkRec.id)} })`)
  const pkDone = await waitForStatus(client, pkRec.id, ['ready', 'failed'])
  check('Parakeet end-to-end transcription', pkDone.status === 'ready',
    `status=${pkDone.status} err=${(pkDone.error ?? '').slice(0, 160)}`)

  const pkBundle = await evaluate(client, `window.api.invoke('recordings:get', { id: ${json(pkRec.id)} })`)
  const pkText = pkBundle.utterances.map((u) => u.text).join(' ')
  check('Parakeet produced the expected speech',
    pkText.toLowerCase().includes('fellow americans'), json(pkText.slice(0, 80)))
  // Parakeet punctuates, which whisper's small models largely do not.
  check('Parakeet output is punctuated', /[,.]/.test(pkText), json(pkText.slice(0, 60)))
  check('Parakeet records its model id', pkDone.modelId === 'parakeet-tdt-0.6b-v3-q4_0')

  await evaluate(client, `window.api.invoke('recordings:delete', { id: ${json(pkRec.id)} })`)
  // Restore the whisper model so later phases test what they expect.
  await evaluate(client, `window.api.invoke('settings:set', { modelId: ${json(TEST_MODEL)} })`)
} else {
  console.log(`\nskipping Parakeet end-to-end: model not installed`)
}

// ---- Phase 6: recording ----

/**
 * Streams a WAV's PCM payload through the recording IPC as if it had come from
 * the capture worklet. This exercises the real writer, chunking and track
 * bookkeeping without needing a physical microphone.
 */
async function streamWavAsTrack(client, wavPath, kind) {
  const raw = await readFile(wavPath)
  const header = await readWavHeader(wavPath)
  if (header.sampleRate !== 16000 || header.channels !== 1) {
    throw new Error(`fixture ${wavPath} must be 16 kHz mono, got ${header.sampleRate}/${header.channels}`)
  }
  // Locate the payload the same way the app does, rather than assuming offset 44.
  const dataOffset = raw.indexOf('data', 12, 'ascii') + 8
  const pcm = raw.subarray(dataOffset, dataOffset + header.dataBytes)

  const CHUNK = 32768
  for (let at = 0; at < pcm.length; at += CHUNK) {
    const slice = pcm.subarray(at, Math.min(at + CHUNK, pcm.length))
    await evaluate(client, `
      (async () => {
        const bin = atob(${json(slice.toString('base64'))});
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        await window.api.invoke('recording:chunk', { kind: ${json(kind)}, samples: bytes });
      })()
    `)
  }
  return header.durationMs
}

const speechFixturePath = await speechFixture()

const started = await evaluate(
  client,
  `window.api.invoke('recording:start', {
     title: 'SMOKE RECORDING', kinds: ['mic', 'system'], sampleRate: 16000
   })`
)
check('recording:start creates a row', typeof started?.id === 'string',
  `status=${started?.status}`)

const micMs = await streamWavAsTrack(client, speechFixturePath, 'mic')
const systemMs = await streamWavAsTrack(client, twoSpeakerPath, 'system')

// Pausing must drop audio rather than buffer it, or the two tracks drift apart.
await evaluate(client, `window.api.invoke('recording:pause', { paused: true })`)
await streamWavAsTrack(client, speechFixturePath, 'mic')
await evaluate(client, `window.api.invoke('recording:pause', { paused: false })`)

const summary = await evaluate(client, `window.api.invoke('recording:stop')`)
check('recording:stop returns both tracks', summary?.tracks?.length === 2,
  json(summary?.tracks?.map((t) => t.kind)))
check('mic track duration matches what was written',
  near(summary.tracks.find((t) => t.kind === 'mic')?.durationMs, micMs, 60),
  `${summary.tracks.find((t) => t.kind === 'mic')?.durationMs}ms vs ${micMs}ms`)
check('audio sent while paused was discarded',
  near(summary.tracks.find((t) => t.kind === 'mic')?.durationMs, micMs, 60),
  'duration did not grow')
check('system track duration matches what was written',
  near(summary.tracks.find((t) => t.kind === 'system')?.durationMs, systemMs, 60),
  `${summary.tracks.find((t) => t.kind === 'system')?.durationMs}ms vs ${systemMs}ms`)

const recBundle = await evaluate(
  client,
  `window.api.invoke('recordings:get', { id: ${json(summary.recordingId)} })`
)
check('recording is queued and ready to transcribe',
  recBundle.recording.status === 'queued', recBundle.recording.status)
check('both track rows exist with the right kinds',
  new Set(recBundle.tracks.map((t) => t.kind)).size === 2 &&
    recBundle.tracks.every((t) => t.kind === 'mic' || t.kind === 'system'))

// The ML copy must be 16 kHz mono regardless of what was captured.
for (const track of recBundle.tracks) {
  const h = await readWavHeader(track.wavPath)
  check(`${track.kind} ML track is 16 kHz mono PCM`,
    h.sampleRate === 16000 && h.channels === 1 && h.bitsPerSample === 16 && h.dataBytes > 0,
    `${h.sampleRate}Hz ${h.channels}ch ${h.bitsPerSample}bit ${h.dataBytes}B`)
}

// The capture itself is kept separately, so a good microphone is not thrown
// away by the 16 kHz the ML pipeline happens to need.
check('the full-quality capture is retained for playback',
  typeof recBundle.recording.sourcePath === 'string' &&
    recBundle.recording.sourcePath.endsWith('.source.wav'),
  json(recBundle.recording.sourcePath))
const captureHeader = await readWavHeader(recBundle.recording.sourcePath)
check('the retained capture is a valid WAV',
  captureHeader.bitsPerSample === 16 && captureHeader.dataBytes > 0,
  `${captureHeader.sampleRate}Hz ${captureHeader.channels}ch`)

/**
 * Proves the capture rate is honoured rather than silently forced to 16 kHz.
 *
 * Recording straight to 16 kHz caps every recording at 8 kHz of bandwidth —
 * telephone quality — which no microphone can compensate for. The capture must
 * be kept as-is and the ML copy derived from it.
 */
await evaluate(
  client,
  `window.api.invoke('recording:start', { title: 'SMOKE HQ', kinds: ['mic'], sampleRate: 48000 })`
)
// One second of 48 kHz tone; the content is irrelevant, the format is not.
await evaluate(client, `
  (async () => {
    const samples = new Int16Array(48000);
    for (let i = 0; i < samples.length; i++) {
      samples[i] = Math.round(Math.sin((i / 48000) * 440 * 2 * Math.PI) * 12000);
    }
    const bytes = new Uint8Array(samples.buffer);
    await window.api.invoke('recording:chunk', { kind: 'mic', samples: bytes });
  })()
`)
const hqSummary = await evaluate(client, `window.api.invoke('recording:stop')`)
const hqBundle = await evaluate(
  client,
  `window.api.invoke('recordings:get', { id: ${json(hqSummary.recordingId)} })`
)
const hqCapture = await readWavHeader(hqBundle.recording.sourcePath)
const hqMl = await readWavHeader(hqBundle.tracks[0].wavPath)
check('a 48 kHz capture is stored at 48 kHz, not downgraded',
  hqCapture.sampleRate === 48000, `${hqCapture.sampleRate}Hz`)
check('the ML copy is derived at 16 kHz mono',
  hqMl.sampleRate === 16000 && hqMl.channels === 1,
  `${hqMl.sampleRate}Hz ${hqMl.channels}ch`)
check('capture and ML copy describe the same duration',
  near(hqCapture.durationMs, hqMl.durationMs, 60),
  `${hqCapture.durationMs}ms vs ${hqMl.durationMs}ms`)
await evaluate(client, `window.api.invoke('recordings:delete', { id: ${json(hqSummary.recordingId)} })`)

console.log('\ntranscribing a two-track recording…')
await evaluate(
  client,
  `window.api.invoke('settings:set', { diarize: true, speakerCount: 2, micSoloSpeaker: true })`
)
await evaluate(client, `window.api.invoke('transcribe:start', { id: ${json(summary.recordingId)} })`)
const recDone = await waitForStatus(client, summary.recordingId, ['ready', 'failed'])
check('two-track recording transcribed', recDone.status === 'ready',
  `status=${recDone.status} err=${(recDone.error ?? '').slice(0, 160)}`)

const twoTrack = await evaluate(
  client,
  `window.api.invoke('recordings:get', { id: ${json(summary.recordingId)} })`
)
const names = twoTrack.speakers.map((s) => s.displayName)
// The mic track is the local user by definition, so it must never be diarized
// into a numbered cluster — that is the whole point of recording two tracks.
check('with a solo mic declared, that track is attributed to "You"',
  names.includes('You'), json(names))
check('remote speakers were detected separately',
  twoTrack.speakers.some((s) => s.displayName !== 'You'), json(names))

const youSpeaker = twoTrack.speakers.find((s) => s.displayName === 'You')
const youLines = twoTrack.utterances.filter((u) => u.speakerId === youSpeaker?.id)
check('"You" has transcript lines from the mic track', youLines.length > 0,
  `${youLines.length} lines`)
check('the mic transcript is the speech that was fed to it',
  youLines.map((u) => u.text).join(' ').toLowerCase().includes('fellow americans'),
  json(youLines[0]?.text?.slice(0, 60)))

// Both tracks start at t=0, so the merged transcript must be one timeline.
check('utterances from both tracks are interleaved by time',
  twoTrack.utterances.every((u, i) => i === 0 || u.startMs >= twoTrack.utterances[i - 1].startMs),
  `${twoTrack.utterances.length} lines in order`)

/**
 * Several people around one microphone.
 *
 * The mic track used to be forced to a single "You" speaker unconditionally,
 * which collapsed an entire in-person conversation onto one person. Only a
 * declared solo microphone may skip diarization.
 */
await evaluate(
  client,
  `window.api.invoke('settings:set', { micSoloSpeaker: false, diarize: true, speakerCount: 2 })`
)
await evaluate(
  client,
  `window.api.invoke('recording:start', { title: 'SMOKE ONE MIC', kinds: ['mic'], sampleRate: 16000 })`
)
await streamWavAsTrack(client, twoSpeakerPath, 'mic')
const sharedMic = await evaluate(client, `window.api.invoke('recording:stop')`)
await evaluate(client, `window.api.invoke('transcribe:start', { id: ${json(sharedMic.recordingId)} })`)
const sharedDone = await waitForStatus(client, sharedMic.recordingId, ['ready', 'failed'])
check('a shared microphone transcribes', sharedDone.status === 'ready',
  `status=${sharedDone.status} err=${(sharedDone.error ?? '').slice(0, 140)}`)

const sharedBundle = await evaluate(
  client,
  `window.api.invoke('recordings:get', { id: ${json(sharedMic.recordingId)} })`
)
check('two people on one microphone are split into two speakers',
  sharedBundle.speakers.length === 2,
  json(sharedBundle.speakers.map((sp) => sp.displayName)))
check('a shared microphone is not labelled "You"',
  !sharedBundle.speakers.some((sp) => sp.displayName === 'You'),
  json(sharedBundle.speakers.map((sp) => sp.displayName)))
await evaluate(client, `window.api.invoke('recordings:delete', { id: ${json(sharedMic.recordingId)} })`)

/**
 * A silent track must not sink a recording that has good audio elsewhere.
 *
 * System-audio loopback with nothing playing produces a full-length file of
 * zeroes — silent, but far from empty. It used to be kept, then fail the whole
 * job when no engine could find speech in it, discarding a perfectly good
 * microphone transcript along with it.
 */
await evaluate(
  client,
  `window.api.invoke('recording:start', { title: 'SMOKE SILENT SYSTEM', kinds: ['mic', 'system'], sampleRate: 16000 })`
)
await streamWavAsTrack(client, twoSpeakerPath, 'mic')
await evaluate(client, `
  (async () => {
    // Half a second of digital silence, as loopback produces when idle.
    const bytes = new Uint8Array(16000);
    await window.api.invoke('recording:chunk', { kind: 'system', samples: bytes });
  })()
`)
const mixedSummary = await evaluate(client, `window.api.invoke('recording:stop')`)
check('a digitally silent track is discarded, not saved',
  mixedSummary.silentTracks.includes('system') &&
    mixedSummary.tracks.every((t) => t.kind !== 'system'),
  `kept=${json(mixedSummary.tracks.map((t) => t.kind))} dropped=${json(mixedSummary.silentTracks)}`)
check('the track that did carry audio is kept',
  mixedSummary.tracks.some((t) => t.kind === 'mic'))

await evaluate(client, `window.api.invoke('transcribe:start', { id: ${json(mixedSummary.recordingId)} })`)
const mixedDone = await waitForStatus(client, mixedSummary.recordingId, ['ready', 'failed'])
check('a recording with one silent source still transcribes',
  mixedDone.status === 'ready',
  `status=${mixedDone.status} err=${(mixedDone.error ?? '').slice(0, 140)}`)
await evaluate(client, `window.api.invoke('recordings:delete', { id: ${json(mixedSummary.recordingId)} })`)

// ---- Phase 6: live capture through the worklet ----

// Electron is launched with Chromium's fake media device, so getUserMedia and
// the AudioWorklet can be exercised for real rather than stubbed.
const live = await evaluate(client, `
  (async () => {
    let session = null;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ctx = new AudioContext({ sampleRate: 16000 });
      await ctx.audioWorklet.addModule('recorder-worklet.js');
      const src = ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ctx, 'recorder-processor', {
        numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1,
        channelCountMode: 'explicit', channelInterpretation: 'speakers'
      });
      let blocks = 0, samples = 0, peak = 0;
      node.port.onmessage = (e) => {
        blocks++; samples += e.data.samples.length;
        if (e.data.peak > peak) peak = e.data.peak;
      };
      src.connect(node);
      await new Promise((r) => setTimeout(r, 2500));
      src.disconnect(); node.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      await ctx.close();
      return { ok: true, blocks, samples, peak, rate: ctx.sampleRate };
    } catch (e) {
      if (session) await session.stop();
      return { ok: false, why: e.name + ': ' + e.message };
    }
  })()
`)
check('getUserMedia + AudioWorklet capture works', live.ok === true,
  live.ok ? `${live.blocks} blocks, ${live.samples} samples` : live.why)
if (live.ok) {
  check('capture graph runs at 16 kHz', live.rate === 16000, `${live.rate} Hz`)
  // Chromium's fake device emits a tone, so silence would mean the graph is
  // connected but not actually carrying audio.
  check('worklet received non-silent audio', live.peak > 0.01, `peak=${live.peak?.toFixed(3)}`)
  // ~2.5 s at 16 kHz is ~40000 samples; allow wide slack for scheduling.
  check('sample count is plausible for the elapsed time',
    live.samples > 16000 && live.samples < 80000, `${live.samples} samples`)
}

// Cancelling must leave nothing behind.
const rowsBeforeCancel = (await evaluate(client, `window.api.invoke('recordings:list')`)).length
await evaluate(client, `window.api.invoke('recording:start', { kinds: ['mic'], sampleRate: 48000 })`)
await evaluate(client, `window.api.invoke('recording:cancel')`)
const rowsAfterCancel = (await evaluate(client, `window.api.invoke('recordings:list')`)).length
check('cancelling a recording removes its row', rowsAfterCancel === rowsBeforeCancel,
  )

// ---- cleanup ----

await evaluate(client, `window.api.invoke('recordings:delete', { id: ${json(summary.recordingId)} })`)
await evaluate(client, `window.api.invoke('recordings:delete', { id: ${json(conv.id)} })`)
await evaluate(client, `window.api.invoke('settings:set', { speakerCount: null })`)
await evaluate(client, `window.api.invoke('recordings:delete', { id: ${json(speech.id)} })`)
for (const r of done) {
  await evaluate(client, `window.api.invoke('recordings:delete', { id: ${json(r.id)} })`)
}
const finalList = await evaluate(client, `window.api.invoke('recordings:list')`)
check('cleanup left the library empty of test rows',
  !finalList.some((r) => done.some((d) => d.id === r.id)))

await rm(FIXTURES, { recursive: true, force: true })
client.close()

const failed = checks.filter((c) => !c.passed)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length) console.log('failed:\n  ' + failed.map((f) => f.name).join('\n  '))
process.exit(failed.length === 0 ? 0 : 1)
