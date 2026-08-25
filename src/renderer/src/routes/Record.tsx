import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { LiveTranscriptChunk, TrackKind } from '@shared/types'
import { api, useEvent, useQuery } from '../lib/api'
import {
  CaptureError,
  CLEAN_MIC,
  requestMicStream,
  requestSystemStream,
  startCapture,
  type CaptureSession
} from '../lib/capture'
import { formatDuration } from '../lib/format'
import Select from '../components/Select'
import LiveTranscriptPanel from '../components/LiveTranscriptPanel'

/** Peak level meter for one track. */
function Meter({
  label,
  level,
  color,
  hint
}: {
  label: string
  level: number
  color: string
  hint?: string
}): React.JSX.Element {
  return (
    <div className="meter">
      <span className="meter__label">{label}</span>
      <div className="meter__track">
        <div
          className="meter__fill"
          // Peak amplitude is linear, but hearing is not: a square root curve
          // makes normal speech occupy a useful part of the bar instead of
          // hugging the left edge.
          style={{ width: `${Math.min(100, Math.sqrt(level) * 100)}%`, background: color }}
        />
      </div>
      {hint && <span className="meter__hint">{hint}</span>}
    </div>
  )
}

/** Above this a source is considered to be hearing something. */
const SIGNAL_FLOOR = 0.01

export default function Record(): React.JSX.Element {
  const navigate = useNavigate()
  // Text transcribed while this recording runs, one entry per finished window.
  const [live, setLive] = useState<LiveTranscriptChunk[]>([])
  const { data: info } = useQuery('app:info')
  const { data: settings, refetch: refetchSettings } = useQuery('settings:get')
  const { data: displays } = useQuery('screenshots:listDisplays')

  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [deviceId, setDeviceId] = useState<string>('')
  const [wantSystem, setWantSystem] = useState(true)
  // Applied once, the first time settings arrive — later refetches (e.g. from
  // toggling mic processing) must not stomp on a choice made mid-session.
  const appliedStoredChoice = useRef(false)

  const [recording, setRecording] = useState(false)
  const [paused, setPaused] = useState(false)
  const [elapsedMs, setElapsedMs] = useState(0)
  const [levels, setLevels] = useState<Record<string, number>>({ mic: 0, system: 0 })
  const [error, setError] = useState<string | null>(null)
  const [warning, setWarning] = useState<string | null>(null)
  /** Brief "Screenshot saved" confirmation, not tied to anything cross-window. */
  const [screenshotNotice, setScreenshotNotice] = useState<string | null>(null)
  const [sampleRate, setSampleRate] = useState<number | null>(null)

  /** Which sources the open capture graph actually has, monitoring or recording. */
  const [openKinds, setOpenKinds] = useState<TrackKind[]>([])
  /** Why system audio is not being monitored, when it was asked for. */
  const [systemNote, setSystemNote] = useState<string | null>(null)
  /** Highest level seen since monitoring began, to tell silent from untested. */
  const [everHeard, setEverHeard] = useState<Record<string, boolean>>({})

  // Blocks arriving before the main process has opened its writers would be
  // dropped by it anyway; this gates them at the source instead of logging an
  // error per block. Both tracks share one clock, so they stay aligned.
  const acceptingRef = useRef(false)

  /**
   * The capture graph, open from the moment this screen is.
   *
   * One graph serves both jobs. Monitoring and recording differ only in whether
   * the blocks are forwarded to the main process, so pressing record does not
   * reopen the microphone: no gap, no second permission prompt, and the level
   * you were watching is the level being written.
   */
  const sessionRef = useRef<CaptureSession | null>(null)
  const startedAtRef = useRef(0)
  const pausedMsRef = useRef(0)
  const pauseStartRef = useRef(0)
  /** Guards against two monitor starts overlapping when settings change quickly. */
  const openingRef = useRef(false)
  /** Set once `recording:start` resolves — a screenshot snap needs it, nothing else does. */
  const recordingIdRef = useRef<string | null>(null)

  // Device labels are only populated once microphone permission has been
  // granted, so the list is refreshed after the stream opens too.
  const loadDevices = useCallback(async () => {
    try {
      const all = await navigator.mediaDevices.enumerateDevices()
      setDevices(all.filter((d) => d.kind === 'audioinput'))
    } catch {
      // Enumeration can fail before any permission has been granted.
    }
  }, [])

  // Windows of text arrive while the recording runs. Appended rather than
  // replaced: each event carries only the window that just finished.
  useEvent('live:transcript', (chunk) => {
    setLive((prev) => [...prev, chunk])
  })

  // Pause is decided in main, not set optimistically here, so a toggle from
  // the mini controls window updates this screen too (and vice versa).
  useEvent('recording:pauseChanged', (payload) => {
    setPaused(payload.paused)
  })

  // Stops sending audio blocks the instant the session is gone in main. This
  // matters when Stop is clicked from the mini controls window rather than
  // here: without it, this window keeps writing to a session that's already
  // closed until the (possibly several-second) recording:stopped event below
  // arrives with the final result.
  useEvent('recording:sessionEnded', () => {
    acceptingRef.current = false
  })

  // The single place that decides what happens once a recording is done —
  // reached the same way whether Stop was clicked here or in the mini
  // controls window, so the outcome (the warning banner, where it navigates)
  // can't depend on which one it was.
  useEvent('recording:stopped', (summary) => {
    acceptingRef.current = false
    setRecording(false)
    setPaused(false)
    if (summary.tracks.length === 0) {
      setError(
        'No audio was captured, so nothing was saved. Check the input device and that its level meter moved.'
      )
      return
    }
    if (summary.silentTracks.length > 0) {
      const names = summary.silentTracks
        .map((k) => (k === 'system' ? 'System audio' : 'Microphone'))
        .join(' and ')
      setWarning(`${names} captured no sound and was not saved.`)
    }
    navigate(`/recordings/${summary.recordingId}`)
  })

  // Mirrors recording:stopped for the cancel path — same reasoning, no result
  // to report either way.
  useEvent('recording:discarded', () => {
    acceptingRef.current = false
    setRecording(false)
    setPaused(false)
    setElapsedMs(0)
    setLive([])
  })

  const closeSession = useCallback(async () => {
    const session = sessionRef.current
    sessionRef.current = null
    acceptingRef.current = false
    setOpenKinds([])
    if (session) await session.stop()
  }, [])

  /**
   * Opens the microphone (and system audio, if wanted) and starts metering.
   *
   * Runs on arrival and whenever the choice of source changes, so the meters
   * answer "is this thing working" before anything is committed to disk —
   * previously the only way to find out was to record something and look at it
   * afterwards.
   */
  const openMonitor = useCallback(async () => {
    if (recording || openingRef.current) return
    openingRef.current = true
    setSystemNote(null)

    try {
      await closeSession()

      // Independent on purpose: noise suppression alone does not carry the
      // "on a call" character that echo cancellation (paired with the gain
      // control it needs) does, so a user after less-noisy audio need not
      // accept the phone-call sound to get it.
      const processing = {
        ...CLEAN_MIC,
        noiseSuppression: settings?.noiseSuppression ?? false,
        echoCancellation: settings?.echoCancellation ?? false,
        autoGainControl: settings?.echoCancellation ?? false
      }

      const streams: Array<{ kind: TrackKind; stream: MediaStream }> = []
      try {
        streams.push({
          kind: 'mic',
          stream: await requestMicStream(deviceId || undefined, processing)
        })
      } catch (err) {
        setError(err instanceof CaptureError ? err.message : String(err))
        return
      }
      setError(null)

      if (wantSystem) {
        try {
          streams.push({ kind: 'system', stream: await requestSystemStream() })
        } catch (err) {
          // Only a note: the microphone is open and usable, and this is still
          // setup — nothing has been lost yet.
          setSystemNote(err instanceof CaptureError ? err.message : String(err))
        }
      }

      const session = await startCapture(streams, (kind, samples, peak) => {
        setLevels((prev) => ({ ...prev, [kind]: Math.max(prev[kind] ?? 0, peak) }))
        if (peak > SIGNAL_FLOOR) setEverHeard((prev) => (prev[kind] ? prev : { ...prev, [kind]: true }))
        if (!acceptingRef.current) return
        // A Uint8Array view keeps the structured clone to the exact bytes rather
        // than the whole backing buffer.
        void api.invoke('recording:chunk', {
          kind,
          samples: new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength)
        })
      })

      sessionRef.current = session
      setOpenKinds(streams.map((s) => s.kind))
      setSampleRate(Math.round(session.context.sampleRate))
      setEverHeard({})
      void loadDevices()
    } finally {
      openingRef.current = false
    }
  }, [
    closeSession,
    deviceId,
    loadDevices,
    recording,
    settings?.noiseSuppression,
    settings?.echoCancellation,
    wantSystem
  ])

  useEffect(() => {
    void loadDevices()
    navigator.mediaDevices.addEventListener('devicechange', loadDevices)
    return () => navigator.mediaDevices.removeEventListener('devicechange', loadDevices)
  }, [loadDevices])

  // Recall last session's microphone and system-audio choice. A device that
  // has since been unplugged just will not be in `devices`, and the <Select>
  // falls back to "System default" on its own — no validation needed here.
  useEffect(() => {
    if (appliedStoredChoice.current || !settings) return
    appliedStoredChoice.current = true
    if (settings.micDeviceId) setDeviceId(settings.micDeviceId)
    setWantSystem(settings.captureSystemAudio)
  }, [settings])

  // Reopen whenever the source selection changes, but never mid-recording: the
  // dropdown is not shown then, and swapping the graph would break the take.
  useEffect(() => {
    if (recording) return
    void openMonitor()
  }, [openMonitor, recording])

  // Everything open is closed on the way out, recording or not. A monitor left
  // running would hold the microphone for the rest of the session.
  useEffect(() => {
    return () => {
      if (acceptingRef.current) void api.invoke('recording:cancel')
      const session = sessionRef.current
      sessionRef.current = null
      acceptingRef.current = false
      if (session) void session.stop()
    }
  }, [])

  // Elapsed timer, excluding paused time. Also relayed to main (throttled to
  // whole seconds, not every 200ms tick) so a mini controls window — which
  // has no way to reach getUserMedia and so can't derive this itself — has
  // something to display.
  const lastRelayedSecRef = useRef(-1)
  useEffect(() => {
    if (!recording || paused) return
    const timer = setInterval(() => {
      const next = Date.now() - startedAtRef.current - pausedMsRef.current
      setElapsedMs(next)
      const sec = Math.floor(next / 1000)
      if (sec !== lastRelayedSecRef.current) {
        lastRelayedSecRef.current = sec
        void api.invoke('recording:elapsed', { elapsedMs: next })
      }
    }, 200)
    return () => clearInterval(timer)
  }, [recording, paused])

  // Levels decay when a source goes quiet, otherwise the meter sticks at its
  // last peak and reads as if audio is still arriving. Runs while monitoring as
  // well as while recording, so the bars fall back when the room goes silent.
  useEffect(() => {
    const timer = setInterval(() => {
      setLevels((prev) => ({ mic: (prev.mic ?? 0) * 0.7, system: (prev.system ?? 0) * 0.7 }))
    }, 120)
    return () => clearInterval(timer)
  }, [])

  async function start(): Promise<void> {
    setWarning(null)
    // Last take's text must not linger behind this one's.
    setLive([])

    // The graph is already open and metering; if something closed it, open it
    // again rather than refusing.
    if (!sessionRef.current) await openMonitor()
    const session = sessionRef.current
    if (!session) return

    const rate = Math.round(session.context.sampleRate)
    setSampleRate(rate)

    try {
      const created = await api.invoke('recording:start', {
        kinds: session.tracks.map((t) => t.kind),
        sampleRate: rate
      })
      recordingIdRef.current = created.id
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return
    }

    // From here the same blocks that were feeding the meters are written to disk.
    acceptingRef.current = true
    startedAtRef.current = Date.now()
    pausedMsRef.current = 0
    setElapsedMs(0)
    setRecording(true)
    setPaused(false)
  }

  function togglePause(): void {
    const next = !paused
    if (next) {
      pauseStartRef.current = Date.now()
    } else {
      pausedMsRef.current += Date.now() - pauseStartRef.current
    }
    // `paused` itself updates from the recording:pauseChanged broadcast this
    // triggers, not set here directly — see that listener above.
    void api.invoke('recording:pause', { paused: next })
  }

  async function stop(): Promise<void> {
    // Optimistic, for instant feedback on this window's own click — the
    // recording:sessionEnded/recording:stopped handlers above do the same
    // (and are what actually run when Stop is clicked from the mini window
    // instead), so this is belt-and-braces rather than load-bearing here.
    acceptingRef.current = false
    setRecording(false)
    setPaused(false)

    try {
      await api.invoke('recording:stop')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function discard(): Promise<void> {
    acceptingRef.current = false
    setRecording(false)
    setPaused(false)
    setElapsedMs(0)
    setLive([])

    try {
      await api.invoke('recording:cancel')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function snapScreenshot(): Promise<void> {
    const recordingId = recordingIdRef.current
    if (!recordingId) return
    try {
      const shots = await api.invoke('screenshots:capture', { recordingId, elapsedMs })
      setScreenshotNotice(
        shots.length > 1 ? `Screenshot saved (${shots.length} displays)` : 'Screenshot saved'
      )
      setTimeout(() => setScreenshotNotice(null), 2500)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const monitoringSystem = openKinds.includes('system')
  // Derived from state, not from the ref: a ref changing does not re-render, so
  // a button disabled on one would stay disabled until something else moved.
  const captureOpen = openKinds.length > 0
  const micLive = (levels.mic ?? 0) > SIGNAL_FLOOR

  // Ordered by when each window's audio was spoken, not by when the engine
  // finished it: two tracks are transcribed at once and they do not complete in
  // step, so a system-audio window can land after a later microphone one.
  const orderedLive = [...live].sort((a, b) => a.startMs - b.startMs)

  const meters = (
    <div className="recorder__meters">
      <Meter
        label="Microphone"
        level={levels.mic ?? 0}
        color="var(--accent-strong)"
        hint={
          recording
            ? undefined
            : everHeard.mic
              ? 'Hearing you'
              : captureOpen
                ? 'Say something to check the level'
                : undefined
        }
      />
      {monitoringSystem && (
        <Meter
          label="System audio"
          level={levels.system ?? 0}
          color="var(--ok-strong)"
          hint={
            recording
              ? undefined
              : everHeard.system
                ? 'Hearing playback'
                : 'Play something to check the level'
          }
        />
      )}
    </div>
  )

  return (
    <div className="page">
      <header className="page__header">
        <div>
          <h1>Record</h1>
          <p className="page__subtitle">
            Microphone and system audio, captured as separate tracks
          </p>
        </div>
      </header>

      {error && <div className="banner banner--error">{error}</div>}
      {warning && <div className="banner banner--warn">{warning}</div>}
      {settings && !settings.modelId && (
        <div className="banner banner--warn">
          No transcription model selected. This recording will still save, but the
          live transcript and automatic transcription won't run until you pick one
          on the <Link to="/settings">Settings</Link> page.
        </div>
      )}

      {/*
        One frame for both states. Setup and recording share the same slots —
        clock, meters, controls, detail — so starting a recording changes what is
        in them rather than rebuilding the screen. The timer used to appear from
        nowhere and shove the meters down the page, which is what read as a jump.
      */}
      <div className={`recorder ${recording ? 'recorder--live' : 'recorder--setup'}`}>
        <div className="recorder__stage">
          <div className="recorder__time">{formatDuration(recording ? elapsedMs : 0)}</div>
          <p className="recorder__status">
            {recording
              ? paused
                ? 'Paused — no audio is being written'
                : 'Recording'
              : !captureOpen
                ? 'Opening the microphone…'
                : micLive
                  ? `Ready — capturing at ${((sampleRate ?? 48000) / 1000).toFixed(1)} kHz`
                  : `Listening on ${
                      devices.find((d) => d.deviceId === deviceId)?.label || 'the default microphone'
                    }`}
          </p>
        </div>

        {/* Never remounted: the levels being watched keep moving straight through
            the transition, which is most of what makes it read as one screen. */}
        {meters}

        <div className="recorder__controls">
          {recording ? (
            <>
              <button className="btn" onClick={togglePause}>
                {paused ? 'Resume' : 'Pause'}
              </button>
              <button className="btn btn--primary" onClick={stop}>
                Stop and save
              </button>
              <button className="btn btn--ghost" onClick={discard}>
                Discard
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => void snapScreenshot()}
                title="Snap a screenshot, tagged with the current time in the recording"
              >
                📷 Snap screenshot
              </button>
              {screenshotNotice && <span className="recorder__toast">{screenshotNotice}</span>}
            </>
          ) : (
            <button className="btn btn--record" onClick={start} disabled={!captureOpen}>
              Start recording
            </button>
          )}
        </div>

        {/* The only part that swaps. Keyed so React replaces it outright rather
            than reconciling two unrelated trees, which is what lets it fade. */}
        <div className="recorder__detail" key={recording ? 'live' : 'setup'}>
          {recording ? (
            <LiveTranscriptPanel
              chunks={orderedLive}
              monitoringSystem={monitoringSystem}
              micLabel={settings?.micSoloSpeaker ? 'You' : 'Mic'}
            />
          ) : (
            <div className="recorder__setup">
              <div className="recorder__field">
                <span id="mic-label">Microphone</span>
                <Select
                  value={deviceId}
                  ariaLabel="Microphone"
                  options={[
                    { value: '', label: 'System default' },
                    ...devices.map((d, i) => ({
                      value: d.deviceId,
                      label: d.label || `Microphone ${i + 1}`
                    }))
                  ]}
                  onChange={(id) => {
                    setDeviceId(id)
                    void api.invoke('settings:set', { micDeviceId: id || null })
                  }}
                />
              </div>

              {/* Nothing to choose between on a single-display machine — "all
                  displays" and "this one display" capture the same thing, so
                  the picker only earns its place once there's an actual
                  choice to make. */}
              {displays && displays.length > 1 && (
                <div className="recorder__field">
                  <span id="screenshot-display-label">Screenshot capture</span>
                  <Select
                    value={settings?.screenshotDisplayId ?? ''}
                    ariaLabel="Which display a screenshot snap captures"
                    options={[
                      { value: '', label: 'All displays' },
                      ...displays.map((d) => ({ value: d.id, label: d.name }))
                    ]}
                    onChange={async (id) => {
                      await api.invoke('settings:set', { screenshotDisplayId: id || null })
                      refetchSettings()
                    }}
                  />
                </div>
              )}

              <label className="toolbar__toggle">
                <input
                  type="checkbox"
                  checked={wantSystem}
                  onChange={(e) => {
                    const next = e.target.checked
                    setWantSystem(next)
                    void api.invoke('settings:set', { captureSystemAudio: next })
                  }}
                />
                Also capture system audio (for meetings and calls)
              </label>
              {systemNote && <p className="recorder__fine recorder__fine--warn">{systemNote}</p>}

              <label className="toolbar__toggle">
                <input
                  type="checkbox"
                  checked={settings?.noiseSuppression ?? false}
                  onChange={async (e) => {
                    await api.invoke('settings:set', { noiseSuppression: e.target.checked })
                    refetchSettings()
                  }}
                />
                Reduce background noise
              </label>
              <p className="recorder__fine">
                Gates out steady noise — fans, hum, keyboard clatter — on its own,
                without the echo cancellation or gain riding along below. The meter
                above updates as soon as you change it.
              </p>

              <label className="toolbar__toggle">
                <input
                  type="checkbox"
                  checked={settings?.echoCancellation ?? false}
                  onChange={async (e) => {
                    await api.invoke('settings:set', { echoCancellation: e.target.checked })
                    refetchSettings()
                  }}
                />
                Cancel speaker echo
              </label>
              <p className="recorder__fine">
                Leave this off for an external or USB microphone — this is what makes
                a recording sound like a phone call. Turn it on only for a laptop mic
                with sound coming from its own speakers, where it stops the far end
                being recorded twice.
              </p>

              <label className="toolbar__toggle">
                <input
                  type="checkbox"
                  checked={settings?.micSoloSpeaker ?? false}
                  onChange={async (e) => {
                    await api.invoke('settings:set', { micSoloSpeaker: e.target.checked })
                    refetchSettings()
                  }}
                />
                Only my voice is on this microphone
              </label>
              <p className="recorder__fine">
                Tick this for a call, where you are on the mic and everyone else comes
                through system audio — your side gets labelled “You” without guessing.
                Leave it unticked when several people share one microphone, or everyone
                in the room is merged into a single speaker.
              </p>

              <label className="toolbar__toggle">
                <input
                  type="checkbox"
                  checked={settings?.autoPopOutOnMinimize ?? false}
                  onChange={async (e) => {
                    await api.invoke('settings:set', { autoPopOutOnMinimize: e.target.checked })
                    refetchSettings()
                  }}
                />
                Pop out controls automatically when minimized
              </label>
              <p className="recorder__fine">
                While recording, minimizing this window opens a small always-on-top
                controls window — pause/resume, stop &amp; save, discard, and a
                collapsible live transcript — so those stay reachable without this
                window in view. This is the only way to reach it; leave it unticked
                and minimizing behaves normally. Closing that window brings this one
                back.
              </p>
            </div>
          )}
        </div>
      </div>

      <div className="recorder__note">
        <p>
          The microphone and system audio are saved as two separate tracks. Your own
          voice is therefore labelled without any guessing, and speaker detection only
          has to work out the people on the other end — which is why it is accurate.
        </p>
        <p>
          Transcription runs while you record, so a finished recording is usually ready
          within seconds of stopping rather than taking as long again to process.
        </p>
        {info?.platform === 'darwin' && (
          <p>
            macOS will ask for Microphone and Screen &amp; System Audio Recording
            permission the first time.
          </p>
        )}
      </div>
    </div>
  )
}
