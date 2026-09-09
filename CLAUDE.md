# SonaScribe — map for AI-assisted work

Local-first Electron audio recorder (Windows/macOS). Record microphone and
system audio — mixed together into one file, in real time — or import an
existing file, and play it back. Optionally transcribe a recording on-device
with a locally-run Whisper or Parakeet model. Entirely on-device, nothing
leaves the machine. **`README.md` is the primary architecture reference**
("Decisions worth knowing") — read it first. This file adds what a human
README wouldn't: exact module boundaries, an AI-testing recipe, and a
maintenance instruction.

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
- **ffmpeg** normalizes an *imported* file to WAV and resamples a recording's
  own WAV down to 16 kHz for the ASR engines (`services/ffmpeg.ts`'s
  `resampleForAsr` — never the recording's own file). A live recording never
  touches it; mic and system audio are mixed by the browser's own Web Audio
  graph.
- **whisper.cpp** (`whisper-cli`) and **Parakeet TDT** (`parakeet-cli`, same
  whisper.cpp project) are the transcription sidecars — no Python anywhere.
  Both, plus ffmpeg, are fetched by `npm run sidecars` into
  `resources/bin/<platform>/` (git-ignored); whisper.cpp publishes no
  prebuilt macOS binary, so mac falls back to PATH (Homebrew or a source
  build — see `scripts/fetch-sidecars.mjs`'s mac guidance). ASR *models*
  (GGML, 78 MB–1.6 GB) are a separate, user-triggered runtime download to
  `<userData>/models/` — never bundled, see `shared/models.ts` for the
  catalogue and `services/models.ts` for the resumable downloader.
- **`electron-log`** — the only logging dependency. `src/main/log.ts` calls
  `Object.assign(console, log.functions)` once at startup, so every existing
  `console.*` call writes to `<userData>/logs/main.log` for free; nothing
  should ever call `log.*` directly instead of `console.*`.
- **Ollama**, for the opt-in Knowledge Base (transcript embedding + Q&A) —
  the one exception to "every model this app uses is bundled or downloaded
  by it directly." Ollama is a separate program the user installs and runs
  themselves; `services/ollama.ts` is only ever an HTTP client against it
  (`http://127.0.0.1:11434` by default, editable), never a spawned/managed
  process. "Not running" is treated as a normal state throughout, not an
  error — see the Knowledge Base step below.

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
                            `tracks`/`voice_profiles`/`screenshots` are historical
                            (diarization/RAG, since removed) and still unreferenced;
                            `utterances`/`words` are back in use for transcription — see
                            db/transcript.ts; `speakers` is active — see db/speakers.ts;
                            `chunk_embeddings` is active again too — see db/chunks.ts.
      recordings.ts         CRUD + status/duration/source-path/transcript-status setters
      transcript.ts          utterances/words CRUD — a recording's transcript
      chunks.ts               chunk_embeddings CRUD for the knowledge base — one recording's
                              chunks, or every recording's for a library-wide Ask
      repair-paths.ts       startup repair: repoint stale paths, resolve interrupted
                            recordings/transcriptions
      settings.ts            typed key/value accessors — recording settings + chosen
                            transcription engine/model/language + Ollama server URL/models
    services/                               everything that isn't SQL or IPC wiring
      recorder.ts             owns the in-progress WavWriter; start/chunk/pause/stop/cancel;
                               discards a recording whose peak level never cleared silence
      importer.ts              ffmpeg-normalize an imported file to WAV, serially queued
      ffmpeg.ts, wav.ts, wav-writer.ts, peaks.ts    audio normalize/extract/waveform/ASR-resample
      media-cleanup.ts        deletes a recording's media dir; sweeps orphaned ones at startup
      storage.ts               where recordings' media lives (default or user-chosen) and the
                                only place allowed to move it — see "Decisions worth knowing"
      sidecars.ts               resolves ffmpeg/whisper-cli/parakeet-cli (packaged / dev / PATH)
      transcription.ts          engine-neutral ASR types + word→segment grouping
      whisper.ts, parakeet.ts   one runner per engine, same TranscribeOptions/TranscriptionResult
                                shape; parakeet.ts alone needs audio-chunks.ts + parakeet-parse.ts
      audio-chunks.ts           silence-aware splitting for Parakeet's per-file memory ceiling —
                                also what gives long transcriptions real (not indeterminate) progress
      parakeet-parse.ts         parses parakeet-cli's `--print-segments` token table
      models.ts                 resumable ASR model download/inventory (`<userData>/models/`)
      jobs.ts                   serial transcription queue: one job at a time, AbortController
                                per recording, in-memory progress for a page opened mid-job
      ollama.ts                 HTTP client for a locally-installed Ollama server — never
                                bundled or spawned by this app, unlike every ASR sidecar;
                                "not running" is a normal, handled state, not an error
      chunking.ts                groups a transcript's utterances into ~800-char embedding
                                chunks, splitting long ones at sentence boundaries
      search.ts                   reindexes a recording's chunks via ollama.ts's embed call;
                                brute-force cosine similarity search, one recording's chunks
                                or every recording's — see "Knowledge Base" below
      answering.ts                retrieval-augmented answers: searchChunks's top excerpts
                                grounding an Ollama chat model's response
    ipc/index.ts, ipc/events.ts             handler registry (must implement every ApiSchema channel) + event emitter
    windows/                                 BrowserWindow setup (main window, mini recorder)
  preload/            the only renderer↔main bridge; allowlists channels from shared/ipc.ts
  shared/                                    compiled into BOTH main and renderer — keep Electron-free
    ipc.ts       ApiSchema (request/response) + EventSchema (push) — the one IPC contract, see below
    types.ts     domain types mirroring the SQLite schema — `Recording`, `Utterance` and friends
    models.ts    the ASR model catalogue (curated, not the full upstream zoo) + engine specs
    ollama.ts     recommended-model catalogue + types for the Ollama-backed knowledge base —
                 no download URLs here, unlike models.ts, since Ollama manages its own models
  renderer/src/
    routes/       Library, Record, Settings (recordings-folder location, transcription models,
                  Knowledge Base, logs), Editor (recording detail — playback, transcribe
                  action, transcript, Ask), Ask (library-wide question answering),
                  Trim (dedicated cut/marker editor), MiniRecorder
    components/    RecordingCard, PlayerBar, Waveform, StatusPill, Select, HelpTip, LogViewer,
                  ModelPicker (Settings' engine/model download UI), TranscriptPanel,
                  AskPanel (question/answer + citations, mounted scoped-to-one-recording on
                  Editor and library-wide on Ask), KnowledgeBaseSettings (Settings' Ollama
                  status/model picker/reindex card)
    lib/           api.ts (useQuery/useEvent/api.invoke), capture.ts (Web Audio capture + mixing),
                   useAudio.ts, useTranscript.ts, format.ts
resources/bin/<platform>/    ffmpeg/whisper-cli/parakeet-cli, git-ignored, fetched by
                              scripts/fetch-sidecars.mjs
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
5. **Transcription** (opt-in, `services/jobs.ts`) — a recording's `sourcePath`
   is resampled to 16 kHz mono (ASR engines' requirement, distinct from this
   app's own 48 kHz playback format), then handed to whichever engine is
   selected (`whisper.ts` or `parakeet.ts`, both behind the same
   `TranscribeOptions`/`TranscriptionResult` shape from `transcription.ts`).
   Parakeet's memory use scales with file length and it reports no progress
   of its own, so long files are split into silence-aware windows
   (`audio-chunks.ts`) and run through a small worker pool — real progress
   and a speedup on multi-core machines, in one mechanism. Whisper handles
   arbitrary length internally and reports its own progress, so it skips all
   of that. Either way the result becomes `utterances`/`words` rows
   (`db/transcript.ts`); `components/TranscriptPanel.tsx` groups a long
   utterance's words into paragraphs for display without touching the
   stored row.
6. **Knowledge Base** (opt-in, needs a locally-installed and running
   [Ollama](https://ollama.com) — never bundled the way the ASR sidecars
   are) — every text-changing write to a recording's transcript
   (`saveTranscript`, `saveSpeakerMergedTranscript`,
   `updateUtteranceText`, `splitUtterance`) fires a best-effort, fire-
   and-forget reindex (`services/search.ts`'s `triggerReindex`): chunk
   the transcript (`chunking.ts`), embed each chunk via Ollama
   (`ollama.ts`'s `embedChunks`), store the vectors (`db/chunks.ts`).
   Asking a question (`components/AskPanel.tsx`, mounted scoped to one
   recording on `Editor.tsx` or library-wide on `routes/Ask.tsx`) embeds
   the question, ranks every stored chunk by cosine similarity in plain
   JS (`search.ts`'s `searchChunks` — no vector database; personal-scale
   transcript data doesn't need one), and hands the top excerpts to an
   Ollama chat model as grounding context (`answering.ts`). A citation
   for a recording other than the one currently open navigates there and
   seeks once its audio metadata loads (`Editor.tsx`'s `location.state`
   effect) rather than a query-param deep link, since it's a one-shot
   jump, not a shareable URL.

## Patterns to follow

- **The IPC contract is one file, both directions.** Add a channel to
  `ApiSchema` in `src/shared/ipc.ts` **and** to the `CHANNELS` array (runtime
  preload allowlist) **and** to `handlers` in `src/main/ipc/index.ts`. The
  mapped `Handlers` type makes a missing handler a compile error — trust the
  compiler, don't grep for it.
- **Migrations are append-only.** Never edit a `MIGRATIONS` entry once it
  might have run anywhere (including your own dev/test databases) — add a new
  numbered one. Current head: see `src/main/db/migrations.ts`. `tracks`,
  `speakers`, `voice_profiles`, `chunk_embeddings`, `screenshots` remain from
  before this app was stripped down and are still unreferenced by anything in
  `src/`; `utterances`/`words` (also from that era) are back in active use —
  see `db/transcript.ts` — with `speaker_id`/`track_id` left `NULL` since
  there's no diarization or multi-track recording to point them at.
- **`db/` does the SQL, `services/` does everything else.** A service that
  needs a row should call into `db/`, not `getDb()` directly.
- **All audio the app touches is 16-bit PCM WAV** — never assume otherwise
  when adding an ffmpeg step. A live recording is written at the hardware's
  own sample rate; an imported file is normalized to 48 kHz mono; the copy
  handed to an ASR engine is a separate 16 kHz resample
  (`services/ffmpeg.ts`'s `resampleForAsr`) — never conflate this with
  `TARGET_SAMPLE_RATE`, which is this app's own 48 kHz format.
- **`shared/` must stay Electron-free** — it's compiled into the renderer too.
- **Spawn-per-call sidecars stay fine as long as they're run-to-completion.**
  ffmpeg, whisper-cli and parakeet-cli are all this: one process per
  normalize/resample/transcribe call, no shared state between calls. If a
  future feature needs a long-lived local server the way the old RAG
  feature's `llama-server` did, don't spawn it per call — start it lazily and
  keep it running (see git history / README for how that pattern looked
  before it was removed).

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
