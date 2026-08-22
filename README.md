# SonaScribe

Local-first audio transcription for Windows and macOS. Record or import audio,
get a timestamped transcript with automatic speaker labels. Everything runs on
device — no API keys, no per-minute cost, no audio leaving the machine.

## Status

**All 7 phases complete.** Windows is built and verified end to end; macOS is configured but untested (see Packaging). See
`~/.claude/plans/linked-mapping-avalanche.md` for the full build plan.

| Phase | Scope | State |
|---|---|---|
| 1 | Skeleton: Electron + React + typed IPC + SQLite | ✅ done |
| 2 | Ingest: file import, ffmpeg normalize to 16 kHz mono | ✅ done |
| 3 | Transcription: whisper.cpp sidecar, model downloader, job queue | ✅ done |
| 4 | Editor: waveform, synced playback, editing, export | ✅ done |
| 5 | Diarization: sherpa-onnx, speaker merge + rename | ✅ done |
| 6 | Recording: mic + system audio as separate tracks | ✅ done |
| 7 | Packaging: NSIS, DMG, macOS notarization | ✅ Windows verified · macOS untested |

## Commands

```bash
npm run sidecars   # download ffmpeg into resources/bin/ (run once after clone)
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
Protocol and exercises the real preload → ipcMain → SQLite path, including the
security boundaries. It needs the app running with a debugging port:

```bash
npx electron . --remote-debugging-port=9222   # terminal 1
npm run smoke                                  # terminal 2
```

## Packaging

```bash
npm run icon        # regenerate build/icon.png
npm run sidecars    # fetch binaries + models for the CURRENT platform
npm run dist:win    # NSIS installer  -> dist/SonaScribe-<version>-setup.exe
npm run dist:mac    # DMG (arm64+x64) -> dist/SonaScribe-<version>-<arch>.dmg
npm run dist:linux  # AppImage
```

Each platform must be built **on** that platform, and `npm run sidecars` must
be run there first — the binaries are native and are not cross-fetched by
default (`--os mac` can stage them, but signing still requires a Mac).

Where the ~195 MB Windows installer goes:

| Part | Size |
|---|---|
| Electron runtime | ~145 MB |
| ffmpeg | 114 MB |
| whisper.cpp + BLAS | ~59 MB |
| sherpa-onnx diarization | ~20 MB |
| Diarization models | 45 MB |
| App code (asar) | 4.7 MB |

Whisper models are **not** included; they are downloaded on first use, which is
what keeps 1.6 GB out of the installer.

### macOS — read before releasing

This has been configured but **never built or run** — development was on
Windows. Expect to debug it.

1. **whisper-cli must be installed manually.** Upstream publishes no macOS CLI.
   `npm run sidecars` prints instructions (`brew install whisper-cpp`, or a
   source build for Metal acceleration). sherpa-onnx and ffmpeg are fetched
   normally.
2. **Notarization is mandatory, not cosmetic.** The app requests microphone and
   audio-capture permission; without notarization Gatekeeper blocks it, and the
   failure is silent at the permission layer rather than a visible error. Set
   `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` — the build
   config enables notarization only when all three are present, and warns
   loudly when they are not.
3. **Verify the three usage-description keys survive into Info.plist**:
   `NSMicrophoneUsageDescription`, `NSAudioCaptureUsageDescription` and
   `NSScreenCaptureUsageDescription`. Missing the audio-capture key breaks
   system audio with no fallback.
4. `disable-library-validation` is entitled so the separately-signed ML
   sidecars can load.

Auto-update is deliberately not configured: it needs a release server and an
update channel, which is a distribution decision rather than a build one.

## Architecture

```
src/
  main/       Node side: window, SQLite, IPC handlers, ML sidecar orchestration
    db/       all SQL lives here — migrations + repositories
  preload/    the only renderer↔main bridge; allowlists channels
  shared/     types + the IPC contract both processes compile against
  renderer/   React UI
resources/bin/<platform>/   ML sidecar binaries (git-ignored)
```

### Decisions worth knowing

**ML engines run as spawned CLI sidecars, not native node addons.** whisper.cpp
and sherpa-onnx both ship prebuilt executables. Driving them via
`child_process.spawn` keeps the project free of node-ABI coupling (no
`electron-rebuild`), isolates crashes to a single job, makes jobs cancellable by
killing the process, and gives parseable progress on stdout.

**SQLite is Node's built-in `node:sqlite`,** not better-sqlite3 — same reasoning:
zero native dependencies. The driver surface used is deliberately tiny and
confined to `src/main/db/`, so swapping it is a contained change if the
built-in module's still-experimental API shifts.

**The IPC contract is one interface.** `src/shared/ipc.ts` defines every channel;
the preload allowlist, the main-process handler map and the renderer's typing are
all derived from it. Adding a channel on one side without the other fails to
compile.

**Recording captures mic and system audio as separate tracks** (Phase 6). The mic
track is by definition the local user, so it needs no speaker detection at all —
only the system track (remote participants) gets diarized. This is the single
biggest accuracy win available and it's why the schema has a `tracks` table
rather than one audio file per recording.

**Audio reaches the renderer over a custom `sonascribe-media://` scheme, keyed by
row id** — never a filesystem path. A URL names a track or recording id, which
the main process looks up in SQLite. Path traversal is removed as a category
rather than sanitised, and `webSecurity` stays on. The handler implements HTTP
range requests itself; `net.fetch` on a `file://` URL ignores `Range` and always
answers 200, which makes Chromium treat the stream as non-seekable.

That scheme works from `<audio src>` but **not** from `fetch()` — Chromium
blocks cross-origin fetches to custom schemes outright. Waveform peaks
(Phase 4) therefore get computed in the main process and sent over IPC, which
is the better design anyway: a two-hour recording is ~230 MB of PCM.

**ffmpeg is fetched, not committed.** `npm run sidecars` downloads it per
platform. Windows and Linux use BtbN's LGPL builds; no LGPL macOS build is
published, so macOS uses the GPL build from ffmpeg-static. ffmpeg is invoked as
a separate process and never linked, but review that before shipping macOS
commercially.

**Two ASR engines: Whisper and Parakeet.** Both run through the same pipeline —
each runner returns engine-neutral `TranscriptWord`/`TranscriptSegment`, so
merging, diarization alignment and persistence never learn which one ran.
Adding a third means writing one runner.

- **Whisper** (whisper.cpp) — widest language coverage, and the only engine that
  accepts a language hint. Emits JSON with per-token offsets and reports
  progress.
- **Parakeet** (NVIDIA TDT 0.6B) — faster at comparable size and punctuates
  markedly better. Its CLI has no JSON output, so the `--print-segments` token
  table is parsed instead; that table marks word boundaries *explicitly*
  (`word_start=true`) rather than leaving them to be inferred from whitespace,
  which makes its word timings — and therefore speaker alignment — more
  accurate. It reports no progress and always auto-detects language.

The Parakeet table regex is the fragile part of that integration, so
`parakeet-parse.ts` is kept free of Electron imports and the smoke test runs it
against captured real output on every run. A format change upstream fails
immediately instead of silently producing empty transcripts.

`parakeet-cli` ships inside the same whisper.cpp release archive as
`whisper-cli`, so it costs no extra download and has the same macOS gap.

**Models are downloaded, never bundled.** The installer stays ~150 MB while the
catalogue runs from 78 MB (tiny) to 1.6 GB (large-v3-turbo). Downloads resume
from a `.part` file, and each is verified by its ggml magic — which is stored
as a little-endian uint32, so the first four bytes on disk read `lmgg`, not
`ggml`. Comparing them as ASCII silently rejects every valid model *after*
downloading it in full.

**whisper.cpp publishes no macOS CLI** — only an xcframework for embedding.
Windows and Linux get prebuilt binaries from the pinned release; on macOS
`npm run sidecars` prints instructions for `brew install whisper-cpp` or a
source build (which also gets you Metal acceleration). The sidecar resolver
falls back to PATH, so a Homebrew install just works. **This path is untested —
it was developed on Windows.**

**Recordings are kept at the hardware's own rate; the 16 kHz copy is derived.**
Capturing straight to 16 kHz caps a recording at 8 kHz of audible bandwidth —
telephone quality — which no microphone can compensate for. The capture is
stored as `<kind>.source.wav` at the device rate and ffmpeg derives the 16 kHz
mono `<kind>.wav` the ML sidecars need, exactly as an imported file is handled.
Playback uses the full-quality capture.

**Microphone processing is off by default.** `echoCancellation`,
`noiseSuppression` and `autoGainControl` route the stream through Chromium's
WebRTC audio processing module — the conferencing pipeline — and that is what
gives a recording its "on a call" character. It is worth enabling only for a
laptop mic with sound coming from speakers, where echo cancellation stops the
far end being recorded twice. There is a toggle on the Record screen saying so.

**Recording writes raw PCM, never MediaRecorder.** An AudioWorklet reads the
graph directly and the AudioContext is created at 16 kHz, so the browser
resamples and what reaches disk is already exactly what whisper wants — no
WebM/Opus encode-and-decode round trip losing quality on the way. The worklet is
served from `public/` rather than a blob: URL because the renderer's CSP is
`script-src 'self'`, which applies to worklet modules too.

**The two-track payoff is realised here.** The mic track is passed through the
merge with `forceSpeaker: -1` — the local user is known, so diarizing that
track could only spend time to rediscover it and risk getting it wrong. Only the
system track is clustered. Both start at t=0, so sorting the combined utterances
by start time interleaves the conversation correctly. Verified end to end: mic
audio lands under "You", remote voices under Speaker 1/2, one ordered timeline.

**Losing system audio degrades rather than fails.** If the loopback request is
declined the microphone half is still recorded, with a warning — half a
recording beats none.

**Speakers are aligned at the word level, not the segment level.** Transcription
and diarization run independently and disagree about boundaries. Each word is
assigned to the diarization segment it overlaps most, then consecutive
same-speaker words are regrouped into utterances. Assigning whole whisper
segments instead puts the speaker change wherever whisper happened to break a
sentence — visibly attributing the first half of a reply to the wrong person.

**Speaker identity is a separate table keyed by cluster id.** Renaming
"Speaker 2" to "Dana" is one row, and because `ensureSpeaker` reuses the row
for a cluster, the name survives re-running the whole pipeline. Merging exists
because diarization routinely splits one person across two clusters when their
voice changes — leaning toward the microphone is enough to do it.

**Diarization models ship with the app; whisper models do not.** The pair is
~47 MB, and the segmentation model is published only inside a `.tar.bz2`, so
downloading it at runtime would mean shipping an archive extractor for one file.
Whisper models stay a runtime download because they reach 1.6 GB. If the
diarization helper is missing the pipeline skips it rather than failing — a
transcript without speaker labels is still worth having.

**The waveform is drawn from peaks, not by a waveform library.** wavesurfer.js
loads the media itself, and it cannot — the audio is served over a scheme the
renderer may not fetch. The main process streams the PCM, reduces it to ~2000
amplitudes and caches them beside the audio; the renderer draws that on a
canvas. ~2 kB crosses IPC instead of hundreds of megabytes, and there is no
dependency that has to be talked out of fetching the file.

**Jobs run one at a time and are cancellable.** whisper saturates every core it
is given, so concurrency would make each job slower without finishing the batch
sooner. Cancellation kills the child process — the main reason the ML engines
are sidecars rather than in-process addons. Threads are capped at cores-2 so the
machine stays usable during a long transcription.

**macOS system audio needs no virtual audio driver.** Electron 39+ inherits
Chromium's CoreAudio Tap API. It does require `NSAudioCaptureUsageDescription`
in Info.plist (already in `electron-builder.yml`) — there is no fallback if it's
missing, and the failure is silent.
