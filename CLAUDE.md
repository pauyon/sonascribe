# SonaScribe — map for AI-assisted work

Local-first Electron transcription app (Windows/macOS). Record or import
audio, get a timestamped transcript with automatic speaker labels — entirely
on-device. **`README.md` is the primary architecture reference** ("Decisions
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
- ML engines (whisper.cpp, Parakeet, sherpa-onnx) and ffmpeg are **spawned CLI
  sidecars**, not native addons — see README for why. Fetched by
  `npm run sidecars` into `resources/bin/<platform>/` (git-ignored).
- **`electron-log`** — the only logging dependency. `src/main/log.ts` calls
  `Object.assign(console, log.functions)` once at startup, so every existing
  `console.*` call writes to `<userData>/logs/main.log` for free; nothing
  should ever call `log.*` directly instead of `console.*`.
- **`llama.cpp`** (`llama-server`, same `ggml-org` family as whisper.cpp) —
  the sidecar behind offline semantic search. Unlike every other sidecar it's
  a long-lived local HTTP server, not a run-to-completion CLI — see
  `services/embeddings.ts`. Real releases are the `b<number>` prerelease
  tags, not the semver-looking "latest" GitHub release (which ships no
  binaries at all) — `LLAMA_TAG` in `fetch-sidecars.mjs` must point at one.

## Directory map

```
src/
  main/
    index.ts, protocol.ts, paths.ts        entry point, sonascribe-media:// scheme, on-disk layout
    log.ts                                  electron-log init — console override, log file path, crash handlers
    display-media.ts                        desktopCapturer plumbing for system audio
    db/                                      ALL SQL lives here
      index.ts            getDb()/initDb(), WAL mode, migration runner
      migrations.ts        forward-only, numbered — NEVER edit a shipped one, append
      recordings.ts, tracks.ts, transcript.ts, speakers.ts, profiles.ts, chunks.ts, screenshots.ts, settings.ts
    services/                               everything that isn't SQL or IPC wiring
      jobs.ts                serial job queue: status transitions, persistence, error handling
      transcription-pipeline.ts   the actual ASR+diarization+anchor-matching pipeline (called by jobs.ts)
      diarize.ts, merge.ts        sherpa-onnx wrapper; word-level speaker alignment + absorption
      profiles.ts             voice-profile enrollment/refresh/matching (auto, no user action)
      chunking.ts             groups utterances into embedding-sized chunks
      embeddings.ts           llama-server lifecycle (start/health-check/stop) + embed calls
      search.ts               reindexRecording (post-transcription) + searchChunks (cosine similarity, no vector DB)
      whisper.ts, parakeet.ts, parakeet-parse.ts, transcription.ts   ASR engine runners (engine-neutral output)
      ffmpeg.ts, wav.ts, wav-writer.ts, peaks.ts    audio normalize/concat/extract/waveform
      recorder.ts, live-transcribe.ts, audio-chunks.ts   live capture + streamed transcription
      importer.ts, media-cleanup.ts, export.ts, screenshots.ts, screenshot-naming.ts, models.ts, sidecars.ts
    ipc/index.ts, ipc/events.ts             handler registry (must implement every ApiSchema channel) + event emitter
    windows/                                 BrowserWindow setup (main window, mini recorder)
  preload/            the only renderer↔main bridge; allowlists channels from shared/ipc.ts
  shared/                                    compiled into BOTH main and renderer — keep Electron-free
    ipc.ts       ApiSchema (request/response) + EventSchema (push) — the one IPC contract, see below
    types.ts     domain types mirroring the SQLite schema
    colors.ts    SPEAKER_COLORS palette + pickSpeakerColor() — used by main (assignment) and renderer (picker UI)
    models.ts, export.ts
  renderer/src/
    routes/       Library, Editor, Record, Models (settings), MiniRecorder
    components/    SpeakerBar, Transcript, Waveform, PlayerBar, ScreenshotGallery, JobProgress, LogViewer, SearchBox, ...
    lib/api.ts     useQuery/useEvent/api.invoke — the only way renderer talks to main
resources/bin/<platform>/    sidecar binaries, git-ignored, fetched by scripts/fetch-sidecars.mjs
scripts/          fetch-sidecars.mjs, smoke.mjs (CDP e2e), make-icon.mjs
```

## Core pipeline (what a recording goes through)

1. **Capture** (`recorder.ts` + renderer `lib/capture.ts`) — mic and system
   audio as **separate tracks** (`mic`/`system`/`mixed` for imports), raw PCM
   via AudioWorklet, never MediaRecorder. Stored at device rate; a 16 kHz mono
   copy is derived for the ML sidecars.
2. **Job queue** (`jobs.ts`) — one job at a time, cancellable, owns
   `recordings.status` transitions (`transcribing → diarizing → merging →
   ready`/`failed`) and the `job:progress` / `recording:updated` events.
3. **Pipeline** (`transcription-pipeline.ts`, called by jobs.ts) — per track:
   ASR (whisper or Parakeet, whichever's selected) → **one joint diarization
   pass across every track that needs it** (mic is skipped only when declared
   solo). Known voices (see below) are prepended as anchors in the same pass.
   Returns `MergedUtterance[]` + which cluster matched which profile; jobs.ts
   persists the rest.
4. **Speaker identity** (`db/speakers.ts`) — one row per cluster per
   recording, keyed so a re-run reuses it (renames survive). Colors are
   assigned so no two speakers in a recording share one
   (`shared/colors.ts::pickSpeakerColor`), and a recognized voice (or "You")
   keeps its remembered color across recordings.
5. **Voice profiles** (`db/profiles.ts` + `services/profiles.ts`) — fully
   automatic, no user action: after a job finishes, any speaker without
   enough audio history gets anchored; a later recording matching an existing
   anchor reuses it instead of inventing a new speaker. Capped (10) with
   least-recently-matched eviction. The only manual control is
   `profiles:clearAll` (Settings → "Clear remembered voices").
6. **Editor** (`Editor.tsx`, `Transcript.tsx`, `SpeakerBar.tsx`) — playback,
   inline edit, speaker rename/merge/delete/color, exact-text search
   (client-side filter), export (`services/export.ts`).
7. **Semantic search** (`services/search.ts`) — after every successful
   transcription, the transcript is chunked (`services/chunking.ts`),
   embedded (`services/embeddings.ts`), and stored in `chunk_embeddings`,
   replacing that recording's old rows wholesale. `SearchBox.tsx` queries it
   from the Editor (one recording) and Library (every recording) — distinct
   from the exact-text filter above, this finds a passage by meaning even if
   it shares no words with the query.

## Patterns to follow

- **The IPC contract is one file, both directions.** Add a channel to
  `ApiSchema` in `src/shared/ipc.ts` **and** to the `CHANNELS` array (runtime
  preload allowlist) **and** to `handlers` in `src/main/ipc/index.ts`. The
  mapped `Handlers` type makes a missing handler a compile error — trust the
  compiler, don't grep for it.
- **Migrations are append-only.** Never edit a `MIGRATIONS` entry once it
  might have run anywhere (including your own dev/test databases) — add a new
  numbered one. Current head: see `src/main/db/migrations.ts`.
- **`db/` does the SQL, `services/` does everything else.** A service that
  needs a row should call into `db/`, not `getDb()` directly.
- **All audio the ML sidecars touch is 16 kHz mono PCM WAV** — never assume
  otherwise when adding an ffmpeg step.
- **`shared/` must stay Electron-free** — it's compiled into the renderer too.
- **Two sidecar lifecycles exist — pick the right one.** whisper/parakeet/
  sherpa-onnx/ffmpeg are spawned per job and parsed from stdout to
  completion. `llama-server` is the one exception: started lazily, kept
  running, talked to over local HTTP, and stopped in `index.ts`'s
  `before-quit` handler. Don't spawn-per-call a model server — the model
  load alone is the dominant cost.

## Testing (no framework — do this instead)

1. `npm run typecheck` — catches most wiring mistakes given the compile-time
   guarantees above.
2. `npm run build && npm run smoke` — the closest thing to an e2e suite;
   extend `scripts/smoke.mjs` for new IPC-reachable behavior.
3. **Ad-hoc manual verification via CDP** (what this session used to verify
   diarization/voice-profile changes without a human at the keyboard):

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
   way, including importing a real audio file, starting a transcription, and
   polling `recordings:get` until `status` settles.

   **Always pass `--user-data-dir` pointed at a scratch directory.** Without
   it the app opens the developer's real `%APPDATA%/sonascribe` — real
   recordings, real downloaded models, a real database. Fake-media flags give
   silent/tone audio only, so they prove the pipeline doesn't crash on a
   live two-track recording but can't validate diarization accuracy; use a
   real audio fixture (e.g. the two-speaker WAV `smoke.mjs` already downloads)
   imported via `recordings:import` for anything accuracy-related.

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
