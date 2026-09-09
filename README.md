# SonaScribe

Local-first audio recorder for Windows and macOS. Record microphone and
system audio — mixed together into one file — or import an existing file, and
play it back. Optionally transcribe a recording with a locally-run Whisper or
Parakeet model. Everything runs on device — nothing leaves the machine.

## Commands

```bash
npm run sidecars   # download ffmpeg + whisper-cli/parakeet-cli into resources/bin/ (run once after clone)
npm run dev        # dev server with HMR
npm run build      # typecheck + production build
npm run typecheck  # both tsconfig projects
npm run start      # run the production build
npm run smoke      # end-to-end test against a running app (see below)
npm run dist:win   # NSIS installer
npm run dist:mac   # DMG
```

### Smoke test

`scripts/smoke.mjs` drives the **live renderer** over the Chrome DevTools
Protocol and exercises the real preload → ipcMain → SQLite/ffmpeg path,
including the security boundaries. It needs the app running with a debugging
port:

```bash
npx electron . --remote-debugging-port=9222 --use-fake-device-for-media-stream --use-fake-ui-for-media-stream --user-data-dir="<scratch dir>"
npm run smoke
```

## Packaging

```bash
npm run icon        # regenerate build/icon.png
npm run sidecars    # fetch ffmpeg for the CURRENT platform
npm run dist:win    # NSIS installer  -> dist/SonaScribe-<version>-setup.exe
npm run dist:mac    # DMG (arm64+x64) -> dist/SonaScribe-<version>-<arch>.dmg
npm run dist:linux  # AppImage
```

Each platform must be built **on** that platform, and `npm run sidecars` must
be run there first — ffmpeg is native and is not cross-fetched by default
(`--os mac` can stage it, but signing still requires a Mac).

### CI release

`.github/workflows/release.yml` builds Windows and macOS on a pushed `v*.*.*`
tag (or manually, via workflow_dispatch against an existing tag) and attaches
the installers to a **draft** GitHub Release — nothing goes public until it's
reviewed and published by hand. No Authenticode or Apple notarization
credentials are wired in yet, so both builds are unsigned: Windows shows a
SmartScreen warning, and macOS Gatekeeper blocks the app outright, the same
tradeoff described in the macOS section below. Add `CSC_LINK` /
`CSC_KEY_PASSWORD` (Windows) or `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` /
`APPLE_TEAM_ID` (macOS) as repo secrets and wire them into the workflow's env
when signing is ready — `electron-builder.config.cjs` already switches on
their presence. Linux isn't in the workflow yet; `npm run dist:linux` would
slot in the same way if wanted.

### macOS — read before releasing

This has been configured but **never built or run** — development was on
Windows. Expect to debug it.

1. **Notarization is mandatory, not cosmetic.** The app requests microphone and
   audio-capture permission; without notarization Gatekeeper blocks it, and the
   failure is silent at the permission layer rather than a visible error. Set
   `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` — the build
   config enables notarization only when all three are present, and warns
   loudly when they are not.
2. **Verify the three usage-description keys survive into Info.plist**:
   `NSMicrophoneUsageDescription`, `NSAudioCaptureUsageDescription` and
   `NSScreenCaptureUsageDescription`. Missing the audio-capture key breaks
   system audio with no fallback.
3. ffmpeg has no LGPL macOS build published, so `fetch-sidecars.mjs` uses the
   GPL build from ffmpeg-static there. Review that obligation before shipping
   the macOS build commercially.

Auto-update is deliberately not configured: it needs a release server and an
update channel, which is a distribution decision rather than a build one.

## Architecture

```
src/
  main/       Node side: window, SQLite, IPC handlers, the recorder, importer, transcription
    db/       all SQL lives here — migrations + repositories
    services/ recorder.ts (WAV writer), importer.ts (ffmpeg normalize),
              peaks.ts, media-cleanup.ts, storage.ts (where recordings live, and relocating them),
              whisper.ts/parakeet.ts (transcription engines), models.ts (ASR model downloads),
              jobs.ts (transcription queue)
  preload/    the only renderer↔main bridge; allowlists channels
  shared/     types + the IPC contract both processes compile against
  renderer/   React UI — Library, Record, Settings (incl. transcription models), the
              recording detail view (playback + transcript), the dedicated trim editor
resources/bin/<platform>/   ffmpeg/whisper-cli/parakeet-cli binaries (git-ignored)
```

See `CLAUDE.md` for a fuller module map and the AI-assisted testing recipe.

### Decisions worth knowing

**Mic and system audio are mixed in real time by the Web Audio graph itself,
not by ffmpeg.** Connecting two `MediaStreamAudioSourceNode`s to the same
`AudioWorkletNode` input sums them automatically — standard Web Audio fan-in
— so the worklet that writes PCM to disk needs no idea how many sources feed
it. `lib/capture.ts` opens **three** nodes per recording: a combined one
(what actually gets written) plus one monitoring-only node per source, purely
so the level meters and "test your mic" feature can still tell a silent
microphone apart from silent system audio even though the file on disk is
already mixed.

**Recording writes raw PCM, never MediaRecorder.** An AudioWorklet
(`public/recorder-worklet.js`) reads the graph directly at the hardware's own
sample rate and streams 16-bit PCM blocks to the main process, which owns the
`WavWriter`. No WebM/Opus encode-and-decode round trip losing quality on the
way, and capturing at the hardware rate rather than downsampling means a good
microphone is never thrown away at the door. The worklet is served from
`public/` rather than a blob: URL because the renderer's CSP is
`script-src 'self'`, which applies to worklet modules too.

**SQLite is Node's built-in `node:sqlite`,** not better-sqlite3 — zero native
dependencies, no `electron-rebuild`. The driver surface used is deliberately
tiny and confined to `src/main/db/`.

**The IPC contract is one interface.** `src/shared/ipc.ts` defines every
channel; the preload allowlist, the main-process handler map and the
renderer's typing are all derived from it. Adding a channel on one side
without the other fails to compile.

**Audio reaches the renderer over a custom `sonascribe-media://` scheme, keyed
by recording id** — never a filesystem path. `sonascribe-media://source/<id>`
is the only route; the main process looks the id up in SQLite. Path traversal
is removed as a category rather than sanitised, and `webSecurity` stays on.
The handler implements HTTP range requests itself; `net.fetch` on a `file://`
URL ignores `Range` and always answers 200, which makes Chromium treat the
stream as non-seekable.

That scheme works from `<audio src>` but **not** from `fetch()` — Chromium
blocks cross-origin fetches to custom schemes outright. Waveform peaks
therefore get computed in the main process and sent over IPC, which is the
better design anyway: a two-hour recording is ~230 MB of PCM.

**Sidecar binaries are fetched, not committed.** `npm run sidecars` downloads
ffmpeg (normalizing an imported file to WAV; a live recording never touches
it — mixing happens in the browser's own audio graph, straight to disk) plus
whisper-cli/parakeet-cli (transcription) per platform. Windows and Linux use
BtbN's LGPL ffmpeg builds and whisper.cpp's own prebuilt CLI releases (which
bundle both whisper-cli and parakeet-cli together); no LGPL macOS ffmpeg
build is published, so macOS uses the GPL build from ffmpeg-static, and
whisper.cpp publishes no macOS CLI at all — `fetch-sidecars.mjs` prints
Homebrew/build-from-source instructions there instead, and the sidecar
resolver's PATH fallback is what actually picks either up. Every sidecar is
invoked as a separate process and never linked, but review the ffmpeg
licensing note before shipping macOS commercially.

**Automatic gain control is always on; echo cancellation and noise
suppression are off by default and each independently toggleable.** All three
route the microphone through Chromium's WebRTC audio processing module, and
it's echo cancellation specifically that gives a recording its "on a call"
character — worth enabling only for a laptop mic with sound coming from its
own speakers, where it stops the far end being recorded twice. AGC has no
such downside and no off switch: a quiet input device with nothing
compensating can lose a recording's audio outright, which costs far more
than the fidelity AGC trades away.

**Where recordings' media lives is user-configurable, but the database never
moves.** `db/settings.ts` stores just a pointer (a folder path, or null for
the default `<userData>/media`); `services/storage.ts` is the only module
that reads it and the only one allowed to change it, since changing it means
physically moving every recording's file and rewriting its `source_path` —
not just flipping a setting. Landing back on the default folder clears the
pointer to null rather than storing that path explicitly, so a future change
to what "default" means (e.g. a moved `userData` directory) keeps tracking
dynamically instead of freezing at whatever it resolved to on the day it was
set. Relocating rejects a folder nested inside (or a parent of) the current
one, and refuses outright while a recording is in progress — the recorder
holds an open file handle under the current root, and moving the directory
out from under it would corrupt or lose that recording.

**A recording that captured no sound is discarded automatically.**
`services/recorder.ts::stopRecording` reads back the peak level of the
written file before finalizing; system-audio loopback with nothing playing
produces a full-length file of digital zeroes, which byte count alone would
not catch.

**Transcription came back, scoped down.** This app used to transcribe,
diarize speakers, answer questions about a transcript (offline RAG via
llama.cpp), and capture screenshots during a recording, before all of that
was stripped down to a plain recorder. Plain transcription (no speakers, no
diarization, no RAG) was later added back on top of the stripped-down
recorder, reusing the schema that stripping left behind: `utterances`/`words`
are active again (`db/transcript.ts`), with `speaker_id`/`track_id` left
`NULL` since there's no diarization or multi-track recording pointing at
them. `tracks`, `speakers`, `voice_profiles`, `chunk_embeddings` and
`screenshots` remain unreferenced. See `db/migrations.ts` for the full
history.

**Transcription runs two possible engines, both native CLI sidecars —
whisper.cpp for Whisper models, `parakeet-cli` (same whisper.cpp project) for
NVIDIA's Parakeet TDT.** No Python anywhere, matching how ffmpeg is the only
other sidecar. Models are GGML files, 78 MB to 1.6 GB, downloaded on demand
(never bundled) to `<userData>/models/` with resumable HTTP downloads and a
magic-byte check against a truncated/corrupt file — `shared/models.ts` is a
short, curated catalogue rather than the full upstream model zoo, so picking
one doesn't require already knowing what a quantized GGML file is.
whisper.cpp handles arbitrarily long audio internally and reports real
progress; Parakeet's CLI does neither — its memory grows with input length
(a 2h25m file measured 20.8 GB resident) and it prints no progress at all —
so `services/audio-chunks.ts` splits long audio into silence-aware windows
and `parakeet.ts` runs a small worker pool over them, which is also what
turns "no progress" into a real, incrementally-climbing percentage. A
transcript is stored as `utterances`/`words`; `TranscriptPanel.tsx` groups a
long utterance's words into ~500-character paragraphs for display (split
only at sentence ends) without touching the stored row, so one five-minute
monologue doesn't render as an unbroken wall of text under a single
timestamp.

**Logging persists to a file, because a packaged build has no terminal.**
`src/main/log.ts` calls `electron-log`'s `Object.assign(console, log.functions)`
once at startup, so every existing `console.log`/`warn`/`error` call — no
rewriting needed — writes to `<userData>/logs/main.log` as well as the
terminal. An uncaught exception or unhandled rejection is logged the same way
and then exits the process, preserving the crash-on-fatal-error behavior Node
had by default rather than quietly limping on in an untested state. The
Record screen's "View logs" link (`LogViewer.tsx`) reads the file over IPC
(`logs:read`) into a read-only textarea with a copy-to-clipboard button, so a
user hitting a problem can hand over diagnostics without being asked to go
find a file path themselves.
