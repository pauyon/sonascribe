# SonaScribe — map for AI-assisted work

Local-first Electron audio recorder (Windows/macOS). Record microphone and
system audio — mixed together into one file, in real time — or import an
existing file, and play it back. Entirely on-device, nothing leaves the
machine. **`README.md` is the primary architecture reference** ("Decisions
worth knowing") — read it first. This file adds what a human README wouldn't:
exact module boundaries, an AI-testing recipe, and a maintenance instruction.

## Stack

- **Electron 42** + **electron-vite 4** (three builds: main/preload/renderer,
  see `electron.vite.config.ts`) + **electron-builder** for NSIS/DMG packaging.
- **React 19** + **react-router-dom 7**, no state library — data comes from
  `useQuery`/`useEvent` hooks (`src/renderer/src/lib/api.ts`) wrapping the IPC
  bridge, not from a store.
- **TypeScript 5**, strict, `noUnusedLocals`/`noUnusedParameters` on in both
  `tsconfig.node.json` (main+preload+shared) and `tsconfig.web.json`
  (renderer+shared) — an unused import is a compile error, not a lint warning.
- **`node:sqlite`** (Node's built-in, not better-sqlite3) — zero native
  deps, confined to `src/main/db/`.
- **No test framework** (no Jest/Vitest/Playwright). Verification is
  `npm run typecheck`, `npm run smoke` (`scripts/smoke.mjs`, a hand-rolled CDP
  driver — see Testing below), and manual runs.
- **ffmpeg** is the only spawned CLI sidecar — used solely to normalize an
  *imported* file to WAV. Fetched by `npm run sidecars` into
  `resources/bin/<platform>/` (git-ignored). A live recording never touches
  it; mic and system audio are mixed by the browser's own Web Audio graph.
- **`electron-log`** — the only logging dependency. `src/main/log.ts` calls
  `Object.assign(console, log.functions)` once at startup, so every existing
  `console.*` call writes to `<userData>/logs/main.log` for free; nothing
  should ever call `log.*` directly instead of `console.*`.

## Directory map

```
src/
  main/
    index.ts, protocol.ts, paths.ts        entry point, sonascribe-media:// scheme, on-disk layout
    log.ts                                  electron-log init — console override, log file path, crash handlers
    display-media.ts                        desktopCapturer plumbing for system audio
    db/                                      ALL SQL lives here
      index.ts            getDb()/initDb(), WAL mode, migration runner
      migrations.ts        forward-only, numbered — NEVER edit a shipped one, append.
                            Also the historical record of everything this app used to
                            do (transcription, diarization, RAG, screenshots) before
                            being stripped to a plain recorder — see below.
      recordings.ts         CRUD + status/duration/source-path setters
      repair-paths.ts       startup repair: repoint stale paths, resolve interrupted recordings
      settings.ts            typed key/value accessors for the recording-relevant settings
    services/                               everything that isn't SQL or IPC wiring
      recorder.ts             owns the in-progress WavWriter; start/chunk/pause/stop/cancel;
                               discards a recording whose peak level never cleared silence
      importer.ts              ffmpeg-normalize an imported file to WAV, serially queued
      ffmpeg.ts, wav.ts, wav-writer.ts, peaks.ts    audio normalize/extract/waveform
      media-cleanup.ts        deletes a recording's media dir; sweeps orphaned ones at startup
      storage.ts               where recordings' media lives (default or user-chosen) and the
                                only place allowed to move it — see "Decisions worth knowing"
      sidecars.ts               resolves the ffmpeg binary (packaged / dev / PATH)
    ipc/index.ts, ipc/events.ts             handler registry (must implement every ApiSchema channel) + event emitter
    windows/                                 BrowserWindow setup (main window, mini recorder)
  preload/            the only renderer↔main bridge; allowlists channels from shared/ipc.ts
  shared/                                    compiled into BOTH main and renderer — keep Electron-free
    ipc.ts       ApiSchema (request/response) + EventSchema (push) — the one IPC contract, see below
    types.ts     domain types mirroring the SQLite schema — just `Recording` and friends
  renderer/src/
    routes/       Library, Record, Settings (recordings-folder location, logs), Editor (recording
                  detail), MiniRecorder
    components/    RecordingCard, PlayerBar, Waveform, StatusPill, Select, HelpTip, LogViewer
    lib/           api.ts (useQuery/useEvent/api.invoke), capture.ts (Web Audio capture + mixing),
                   useAudio.ts, format.ts
resources/bin/<platform>/    ffmpeg binary, git-ignored, fetched by scripts/fetch-sidecars.mjs
scripts/          fetch-sidecars.mjs, smoke.mjs (CDP e2e), make-icon.mjs
```

## Core flow (what a recording goes through)

1. **Capture** (`lib/capture.ts`, driven by `routes/Record.tsx`) — mic and
   system audio opened as separate `MediaStream`s, then wired into **three**
   Web Audio nodes on one `AudioContext`: a combined `AudioWorkletNode` that
   both sources feed (this is what gets written to disk — connecting two
   sources to the same node input sums them, which is the entire mixing
   mechanism, no DSP code needed) plus one monitoring-only node per source,
   used only to drive the level meters and "test your mic" feature so a
   silent microphone can still be told apart from silent system audio even
   though the recorded file is already mixed. Runs at the hardware's own
   sample rate. `public/recorder-worklet.js` is source-count-agnostic — it
   just sums whatever reaches `inputs[0][0]`.
2. **Recording** (`services/recorder.ts`) — the renderer streams 16-bit PCM
   blocks from the combined node over `recording:chunk`; main owns the
   `WavWriter`. `stopRecording` reads back the file's peak level and discards
   (deletes the file, marks the row `failed`) anything that never cleared a
   silence threshold — system-audio loopback with nothing playing produces a
   full-length file of digital zeroes, which byte count alone wouldn't catch.
3. **Import** (`services/importer.ts`) — a picked or dropped file is
   normalized straight to WAV via ffmpeg (mono, 48 kHz, 16-bit PCM); the
   normalized file *is* `source_path`, there's no separate "original" kept
   alongside it. Queued serially — ffmpeg already saturates available cores
   on one transcode.
4. **Playback** (`routes/Editor.tsx`, `components/PlayerBar.tsx`,
   `Waveform.tsx`) — streamed over `sonascribe-media://source/<id>`; waveform
   peaks are computed in the main process (`services/peaks.ts`) and sent over
   IPC, since the renderer can't `fetch()` a custom scheme and wouldn't want
   to decode hundreds of megabytes of PCM anyway.

## Patterns to follow

- **The IPC contract is one file, both directions.** Add a channel to
  `ApiSchema` in `src/shared/ipc.ts` **and** to the `CHANNELS` array (runtime
  preload allowlist) **and** to `handlers` in `src/main/ipc/index.ts`. The
  mapped `Handlers` type makes a missing handler a compile error — trust the
  compiler, don't grep for it.
- **Migrations are append-only.** Never edit a `MIGRATIONS` entry once it
  might have run anywhere (including your own dev/test databases) — add a new
  numbered one. Current head: see `src/main/db/migrations.ts`. That file also
  still carries every table from before this app was stripped down to a plain
  recorder (`tracks`, `speakers`, `utterances`, `words`, `voice_profiles`,
  `chunk_embeddings`, `screenshots`) — deliberately not dropped, just
  unreferenced by any code in `src/`; an existing recording's `source_path`
  already pointed at a playable file, so nothing needed migrating.
- **`db/` does the SQL, `services/` does everything else.** A service that
  needs a row should call into `db/`, not `getDb()` directly.
- **All audio the app touches is 16-bit PCM WAV** — never assume otherwise
  when adding an ffmpeg step. A live recording is written at the hardware's
  own sample rate; an imported file is normalized to 48 kHz mono.
- **`shared/` must stay Electron-free** — it's compiled into the renderer too.
- **Don't reintroduce a spawn-per-call sidecar model.** ffmpeg is the only
  child process left, and it's genuinely run-to-completion per call — that's
  fine for a normalize step measured in seconds. If a future feature needs a
  long-lived local server the way the old RAG feature's `llama-server` did,
  don't spawn it per call — start it lazily and keep it running (see git
  history / README for how that pattern looked before it was removed).

## Testing (no framework — do this instead)

1. `npm run typecheck` — catches most wiring mistakes given the compile-time
   guarantees above.
2. `npm run build && npm run smoke` — the closest thing to an e2e suite;
   extend `scripts/smoke.mjs` for new IPC-reachable behavior.
3. **Ad-hoc manual verification via CDP** (what this session used to verify
   the mixed-recording rewrite without a human at the keyboard):

   ```bash
   npm run build
   npx electron . --remote-debugging-port=9222 \
     --use-fake-device-for-media-stream --use-fake-ui-for-media-stream \
     --user-data-dir="<some scratch dir>"
   ```

   Then drive it exactly like `scripts/smoke.mjs` does: `fetch
   http://127.0.0.1:9222/json/list` for the page's `webSocketDebuggerUrl`,
   open it with Node's built-in `WebSocket`, and call
   `Runtime.evaluate({ expression: "window.api.invoke(...)", awaitPromise:
   true, returnByValue: true })` — the full renderer API is reachable this
   way, including importing a real audio file, starting a recording via the
   real UI (click the same buttons a user would), and polling
   `recordings:get` until `status` settles.

   **Always pass `--user-data-dir` pointed at a scratch directory.** Without
   it the app opens the developer's real `%APPDATA%/sonascribe` — real
   recordings, a real database. Fake-media flags give silent/tone audio
   only, which is enough to prove the capture graph and mixing work (two
   fake oscillators summed into one node is a good direct test — see the
   smoke test's "two sources fed into one node" check) but not to judge
   real-world audio quality.

   `window.api.invoke('logs:read')` returns the current log file as a string
   — often faster than re-reading `<userData>/logs/main.log` from disk when
   verifying that something actually logged what you expected.

## Release

`v*.*.*` tag push → `.github/workflows/release.yml` builds Windows+macOS,
opens a **draft** GitHub Release (nothing goes public until published by
hand). Version lives only in `package.json`/`package-lock.json` — bump with
`npm version <x.y.z> --no-git-tag-version` (working tree isn't clean during a
feature commit, so let the normal `npm version` git integration stay off),
then commit, `git tag -a vX.Y.Z -m vX.Y.Z`, push the commit, push the tag.

## Keeping this file current

This file and README's "Decisions worth knowing" are the map — update both
when you change architecture (new module boundary, new external dependency,
a decision that reverses an existing "why" in README). Don't let either
drift into a changelog: describe what's true now, not what changed and when
— git history already has that.
