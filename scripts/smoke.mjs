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
import { existsSync } from 'node:fs'
import { mkdir, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { readWavHeader } from './lib/wav-header.mjs'

const exec = promisify(execFile)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 9222
const FIXTURES = join(ROOT, '.smoke-fixtures')

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
check(
  'React mounted with the Library, Record and Settings routes',
  ui.h1 === 'Library' && ['Library', 'Record', 'Settings'].every((label) => ui.nav.includes(label)),
  json(ui)
)

const info = await evaluate(client, `window.api.invoke('app:info')`)

// The app was renamed from "Scribe"; user data must have come with it rather
// than the app silently starting empty and stranding gigabytes of data.
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

// ---- Phase 2: import + normalize ----

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

check('mp3 ingest succeeded', tone?.status === 'ready', `status=${tone?.status} err=${tone?.error ?? ''}`)
check('mp4 (with video stream) ingest succeeded', clip?.status === 'ready',
  `status=${clip?.status} err=${clip?.error ?? ''}`)

check('mp3 duration detected ~5000ms', near(tone?.durationMs, 5000, 150), `${tone?.durationMs}ms`)
check('mp4 duration detected ~3000ms', near(clip?.durationMs, 3000, 150), `${clip?.durationMs}ms`)

const events = await evaluate(client, `window.__smokeEvents`)
check('import:progress events were pushed to renderer', events.progress > 0, `${events.progress} events`)
check('recording:updated pushed for both imports',
  imported.every((r) => events.updated.includes(r.id)))

// Inspect the produced WAV on disk.
const toneRow = await evaluate(client, `window.api.invoke('recordings:get', { id: ${json(tone.id)}})`)
check('normalized recording has a source file', typeof toneRow?.sourcePath === 'string')

const header = await readWavHeader(toneRow.sourcePath)
check('normalized WAV is mono', header.channels === 1, `${header.channels} ch`)
check('normalized WAV is 16-bit PCM', header.bitsPerSample === 16)
check('WAV header duration matches row', near(header.durationMs, tone.durationMs, 50),
  `${header.durationMs}ms vs ${tone.durationMs}ms`)

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

const playback = await evaluate(client, audioProbe(`sonascribe-media://source/${tone.id}`))
check('media protocol: <audio> loads recording metadata', playback.ok === true,
  playback.ok ? `duration=${playback.duration}s` : `why=${playback.why}`)
check('media protocol: playback actually advances', playback.advanced === true,
  `at=${playback.at} playErr=${playback.playErr ?? 'none'}`)
check('media protocol: seeking works (range requests)', playback.seeked === true,
  `at=${playback.at}`)

// An id that resolves to nothing must fail rather than serve something.
const badMedia = await evaluate(client, audioProbe('sonascribe-media://source/does-not-exist'))
check('media protocol refuses unknown ids', badMedia.ok === false, `why=${badMedia.why}`)

const traversal = await evaluate(
  client,
  audioProbe('sonascribe-media://source/..%2F..%2F..%2Fwindows%2Fwin.ini')
)
check('media protocol rejects path traversal', traversal.ok === false, `why=${traversal.why}`)

// ---- Phase 3: peaks ----

const peaks = await evaluate(
  client,
  `window.api.invoke('peaks:get', { recordingId: ${json(tone.id)}, buckets: 200 })`
)
check('peaks:get returns the requested resolution',
  peaks?.min?.length === 200 && peaks?.max?.length === 200,
  `${peaks?.min?.length}/${peaks?.max?.length} buckets`)
check('peaks are a signed min <= 0 <= max envelope',
  peaks.min.every((v, i) => typeof v === 'number' && v <= 0 && v <= peaks.max[i]) &&
    peaks.max.every((v) => typeof v === 'number' && v >= 0))
check('peaks duration matches the recording', near(peaks.durationMs, tone.durationMs, 100),
  `${peaks.durationMs}ms`)

// ---- Phase 4: settings ----

const settingsBefore = await evaluate(client, `window.api.invoke('settings:get')`)
check('settings:get returns the trimmed recording settings',
  typeof settingsBefore?.captureSystemAudio === 'boolean' &&
    typeof settingsBefore?.noiseSuppression === 'boolean' &&
    typeof settingsBefore?.echoCancellation === 'boolean',
  json(settingsBefore))

const settingsAfter = await evaluate(
  client,
  `window.api.invoke('settings:set', { noiseSuppression: true, echoCancellation: true })`
)
check('settings:set persists changes',
  settingsAfter.noiseSuppression === true && settingsAfter.echoCancellation === true,
  json(settingsAfter))
await evaluate(client, `window.api.invoke('settings:set', { noiseSuppression: false, echoCancellation: false })`)

// ---- Phase 4b: storage relocation ----

const storageBefore = await evaluate(client, `window.api.invoke('storage:get')`)
check('storage:get reports the default location', storageBefore?.isDefault === true, json(storageBefore))
check('storage:get mediaRoot matches the default', storageBefore?.mediaRoot === storageBefore?.defaultMediaRoot)

const customMedia = join(FIXTURES, 'custom-media')
const relocated = await evaluate(
  client,
  `window.api.invoke('storage:relocate', { folder: ${json(customMedia)} })`
)
check('storage:relocate moves to the chosen folder',
  relocated?.mediaRoot === customMedia, json(relocated))

const storageAfterMove = await evaluate(client, `window.api.invoke('storage:get')`)
check('storage:get reflects the custom location', storageAfterMove?.isDefault === false, json(storageAfterMove))

const toneAfterMove = await evaluate(client, `window.api.invoke('recordings:get', { id: ${json(tone.id)} })`)
check('an existing recording\'s source_path was rewritten under the new root',
  toneAfterMove?.sourcePath?.startsWith(customMedia), toneAfterMove?.sourcePath)

const movedHeader = await readWavHeader(toneAfterMove.sourcePath)
check('the moved file is intact and still a valid WAV',
  movedHeader.dataBytes > 0 && near(movedHeader.durationMs, tone.durationMs, 100),
  `${movedHeader.durationMs}ms`)

const relocatedPlayback = await evaluate(client, audioProbe(`sonascribe-media://source/${tone.id}`))
check('the relocated recording still plays over the media protocol',
  relocatedPlayback.ok === true, relocatedPlayback.ok ? `duration=${relocatedPlayback.duration}s` : relocatedPlayback.why)

const nestedRejected = await evaluate(
  client,
  `window.api.invoke('storage:relocate', { folder: ${json(join(customMedia, 'nested'))} })
     .then(() => 'RESOLVED').catch((e) => 'REJECTED: ' + e.message)`
)
check('relocating into a nested subfolder is rejected', String(nestedRejected).startsWith('REJECTED'))

const movedBack = await evaluate(
  client,
  `window.api.invoke('storage:relocate', { folder: ${json(storageBefore.defaultMediaRoot)} })`
)
check('storage:relocate moves back to the default folder',
  movedBack?.mediaRoot === storageBefore.defaultMediaRoot, json(movedBack))

const storageAfterRestore = await evaluate(client, `window.api.invoke('storage:get')`)
check('isDefault is true again after moving back (no stale override)',
  storageAfterRestore?.isDefault === true, json(storageAfterRestore))

// toneRow.sourcePath is stale after the round trip; refresh it for later phases.
const toneAfterRestore = await evaluate(client, `window.api.invoke('recordings:get', { id: ${json(tone.id)} })`)
toneRow.sourcePath = toneAfterRestore.sourcePath

// ---- Phase 5: recording (mixed single-track capture) ----

/**
 * Streams a WAV's PCM payload through the recording IPC as if it had come
 * from the capture worklet's combined (already-mixed) node. This exercises
 * the real writer and duration bookkeeping without a physical microphone.
 */
async function streamWav(client, wavPath) {
  const { readFile } = await import('node:fs/promises')
  const raw = await readFile(wavPath)
  const header = await readWavHeader(wavPath)
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
        await window.api.invoke('recording:chunk', { samples: bytes });
      })()
    `)
  }
  return header.durationMs
}

const started = await evaluate(
  client,
  `window.api.invoke('recording:start', { title: 'SMOKE RECORDING', hasSystemAudio: true, sampleRate: ${header.sampleRate} })`
)
check('recording:start creates a row', typeof started?.id === 'string',
  `status=${started?.status}`)

const writtenMs = await streamWav(client, toneRow.sourcePath)

// Pausing must drop audio rather than buffer it.
await evaluate(client, `window.api.invoke('recording:pause', { paused: true })`)
await streamWav(client, toneRow.sourcePath)
await evaluate(client, `window.api.invoke('recording:pause', { paused: false })`)

const summary = await evaluate(client, `window.api.invoke('recording:stop')`)
check('recording:stop returns a duration', typeof summary?.durationMs === 'number')
check('recording is not flagged silent', summary?.silent === false, json(summary))
check('duration matches what was written (paused audio discarded)',
  near(summary.durationMs, writtenMs, 100),
  `${summary.durationMs}ms vs ${writtenMs}ms`)

const recRow = await evaluate(
  client,
  `window.api.invoke('recordings:get', { id: ${json(summary.recordingId)} })`
)
check('recording is ready with a source file',
  recRow.status === 'ready' && typeof recRow.sourcePath === 'string', recRow.status)

const recHeader = await readWavHeader(recRow.sourcePath)
check('recorded WAV matches the sample rate it was started with',
  recHeader.sampleRate === header.sampleRate, `${recHeader.sampleRate}Hz`)

await evaluate(client, `window.api.invoke('recordings:delete', { id: ${json(summary.recordingId)} })`)

// A silent capture must be discarded, not saved.
await evaluate(
  client,
  `window.api.invoke('recording:start', { title: 'SMOKE SILENT', hasSystemAudio: false, sampleRate: 48000 })`
)
await evaluate(client, `
  (async () => {
    const bytes = new Uint8Array(48000); // digital silence
    await window.api.invoke('recording:chunk', { samples: bytes });
  })()
`)
const silentSummary = await evaluate(client, `window.api.invoke('recording:stop')`)
check('a digitally silent recording is discarded, not saved', silentSummary.silent === true, json(silentSummary))

// Cancelling must leave nothing behind.
const rowsBeforeCancel = (await evaluate(client, `window.api.invoke('recordings:list')`)).length
await evaluate(client, `window.api.invoke('recording:start', { hasSystemAudio: false, sampleRate: 48000 })`)
await evaluate(client, `window.api.invoke('recording:cancel')`)
const rowsAfterCancel = (await evaluate(client, `window.api.invoke('recordings:list')`)).length
check('cancelling a recording removes its row', rowsAfterCancel === rowsBeforeCancel)

// ---- Phase 6: live capture through the worklet ----

// Electron is launched with Chromium's fake media device, so getUserMedia and
// the AudioWorklet can be exercised for real rather than stubbed.
const live = await evaluate(client, `
  (async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ctx = new AudioContext();
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
      return { ok: false, why: e.name + ': ' + e.message };
    }
  })()
`)
check('getUserMedia + AudioWorklet capture works', live.ok === true,
  live.ok ? `${live.blocks} blocks, ${live.samples} samples` : live.why)
if (live.ok) {
  // Chromium's fake device emits a tone, so silence would mean the graph is
  // connected but not actually carrying audio.
  check('worklet received non-silent audio', live.peak > 0.01, `peak=${live.peak?.toFixed(3)}`)
  check('sample count is plausible for the elapsed time', live.samples > 0, `${live.samples} samples`)
}

/** Two sources connected to the same node input must sum, not overwrite. */
const mixing = await evaluate(client, `
  (async () => {
    const ctx = new AudioContext();
    await ctx.audioWorklet.addModule('recorder-worklet.js');
    const node = new AudioWorkletNode(ctx, 'recorder-processor', {
      numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1,
      channelCountMode: 'explicit', channelInterpretation: 'speakers'
    });
    const oscA = new OscillatorNode(ctx, { frequency: 220 });
    const oscB = new OscillatorNode(ctx, { frequency: 330 });
    let peak = 0;
    node.port.onmessage = (e) => { if (e.data.peak > peak) peak = e.data.peak; };
    oscA.connect(node); oscB.connect(node);
    oscA.start(); oscB.start();
    await new Promise((r) => setTimeout(r, 300));
    oscA.stop(); oscB.stop();
    await ctx.close();
    return { peak };
  })()
`)
check('two sources fed into one node sum into an audible signal',
  mixing.peak > 0.01, `peak=${mixing.peak?.toFixed(3)}`)

// ---- Editor UI: driving the real controls ----

await evaluate(client, `location.hash = '#/recordings/${tone.id}'`)
await new Promise((r) => setTimeout(r, 800))

const editorUi = await evaluate(client, `
  ({
    title: document.querySelector('.page__title-editable')?.textContent ?? null,
    pill: document.querySelector('.pill')?.textContent ?? null,
    buttons: [...document.querySelectorAll('.page__actions button, .page__footer button')].map((b) => b.textContent)
  })
`)
check('the editor shows the recording title', editorUi.title === 'tone', json(editorUi))
check('status reads Ready', editorUi.pill === 'Ready', json(editorUi.pill))
check('reveal-in-folder and delete controls are present',
  editorUi.buttons.includes('Reveal in folder') && editorUi.buttons.includes('Delete recording'),
  json(editorUi.buttons))

await evaluate(client, `location.hash = '#/library'`)

// ---- cleanup ----

await evaluate(client, `window.api.invoke('recordings:delete', { id: ${json(tone.id)} })`)
await evaluate(client, `window.api.invoke('recordings:delete', { id: ${json(clip.id)} })`)
const finalList = await evaluate(client, `window.api.invoke('recordings:list')`)
check('cleanup left the library empty of test rows',
  !finalList.some((r) => done.some((d) => d.id === r.id)))

await rm(FIXTURES, { recursive: true, force: true })
client.close()

const failed = checks.filter((c) => !c.passed)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length) console.log('failed:\n  ' + failed.map((f) => f.name).join('\n  '))
process.exit(failed.length === 0 ? 0 : 1)
