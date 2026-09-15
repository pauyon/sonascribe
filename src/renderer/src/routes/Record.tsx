import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { DEFAULT_MARKER_COLOR, type Marker } from '@shared/types'
import { api, useEvent, useQuery } from '../lib/api'
import {
  CaptureError,
  CLEAN_MIC,
  requestMicStream,
  requestSystemStream,
  startCapture,
  type CaptureSession,
  type CaptureSourceKind
} from '../lib/capture'
import { formatDuration } from '../lib/format'
import Select from '../components/Select'
import HelpTip from '../components/HelpTip'
import Icon from '../components/Icon'
import LiveWaveform, { type LiveWaveformHandle } from '../components/LiveWaveform'
import MarkerNoteField from '../components/MarkerNoteField'

/** Peak level meter for one source. */
function Meter({
  label,
  level,
  color,
  hint,
  warn
}: {
  label: string
  level: number
  color: string
  hint?: string
  /** Escalates the hint's styling — a source that's stayed silent too long, not just untested yet. */
  warn?: boolean
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
      {hint && (
        <span className={warn ? 'meter__hint meter__hint--warn' : 'meter__hint'}>{hint}</span>
      )}
    </div>
  )
}

/** Above this a source is considered to be hearing something. */
const SIGNAL_FLOOR = 0.01

/**
 * Watches one source's live audio track for the two signals that mean it has
 * gone dead under us — the device disappearing (`ended`) or another
 * application taking it over (`mute`) — and reports it through `onLost`
 * rather than reacting itself, so the same wiring serves the initial open, a
 * single-source recovery, and a full graph rebuild alike.
 *
 * Guarded by identity: a track this function is no longer watching (because
 * its source was deliberately replaced) can still fire a queued `ended` event
 * from `track.stop()`'s own cleanup — the `activeTrack` map is checked at
 * fire time, not closed over, so a stale event for an already-replaced track
 * is silently ignored instead of triggering a redundant recovery.
 */
function wireTrackWatchers(
  kind: CaptureSourceKind,
  stream: MediaStream,
  activeTrack: Record<CaptureSourceKind, MediaStreamTrack | null>,
  onLost: (kind: CaptureSourceKind, reason: string) => void
): void {
  const track = stream.getAudioTracks()[0] ?? null
  activeTrack[kind] = track
  if (!track) return
  track.addEventListener('ended', () => {
    if (activeTrack[kind] === track) onLost(kind, `${kind} track ended`)
  })
  track.addEventListener('mute', () => {
    if (activeTrack[kind] === track) onLost(kind, `${kind} track muted`)
  })
}

export default function Record(): React.JSX.Element {
  const navigate = useNavigate()
  const { data: info } = useQuery('app:info')
  const { data: settings, refetch: refetchSettings } = useQuery('settings:get')

  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [deviceId, setDeviceId] = useState<string>('')
  const [wantSystem, setWantSystem] = useState(true)
  // Applied once, the first time settings arrive — later refetches (e.g. from
  // toggling mic processing) must not stomp on a choice made mid-session.
  const appliedStoredChoice = useRef(false)

  const [recording, setRecording] = useState(false)
  const [paused, setPaused] = useState(false)
  const [elapsedMs, setElapsedMs] = useState(0)
  /** This session's markers, oldest first — the mini window can add one too, so this stays in sync via broadcasts rather than only this window's own clicks. */
  const [markers, setMarkers] = useState<Marker[]>([])
  /**
   * The one marker whose note field is allowed to be open right now — set to
   * the marker just added (so it auto-expands and focuses without waiting on
   * the broadcast), and enforced on every `MarkerNoteField` via its
   * `active` prop so placing a new marker saves and collapses whichever
   * one was open before, rather than leaving both open at once.
   */
  const [expandedMarkerId, setExpandedMarkerId] = useState<string | null>(null)
  const markersListRef = useRef<HTMLDivElement>(null)
  /**
   * Always points at the current render's `mark` (defined further down, but
   * hoisted since it's a function declaration) — the "m" shortcut effect
   * below only re-runs when `recording` changes, so calling `mark` directly
   * from inside it would keep using whatever `elapsedMs`/`markerColor` were
   * current at that moment forever, not the latest ones. Reassigned on every
   * render (a plain statement, not inside an effect) so it's never stale.
   */
  const markRef = useRef<(() => void) | null>(null)
  /** Sticky color the next marker stamps with — same "remembers your last pick" pattern as the offline editor's PlayerBar swatch. */
  const [markerColor, setMarkerColor] = useState(DEFAULT_MARKER_COLOR)
  const [levels, setLevels] = useState<Record<string, number>>({ mic: 0, system: 0 })
  const [error, setError] = useState<string | null>(null)
  const [warning, setWarning] = useState<string | null>(null)
  /**
   * True from the moment a stop begins (here or in the mini controls window)
   * until it actually finishes. `session` in main is gone as soon as the stop
   * starts, so starting a new recording in that window would begin capturing
   * while the previous one is still being finalized.
   */
  const [finishing, setFinishing] = useState(false)
  const [sampleRate, setSampleRate] = useState<number | null>(null)

  /** Which sources the open capture graph actually has, monitoring or recording. */
  const [openKinds, setOpenKinds] = useState<CaptureSourceKind[]>([])
  /** Why system audio is not being monitored, when it was asked for. */
  const [systemNote, setSystemNote] = useState<string | null>(null)
  /** Which rung of the mic fallback ladder is active, when it isn't the plain requested one. */
  const [micNote, setMicNote] = useState<string | null>(null)
  /**
   * A transient report from the capture supervisor (see the recovery effects
   * below) — a source going quiet or a device coming back. `tone: 'warn'`
   * persists until the next notice; `'ok'` clears itself.
   */
  const [captureNotice, setCaptureNotice] = useState<{ tone: 'warn' | 'ok'; message: string } | null>(
    null
  )
  const captureNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Highest level seen since monitoring began, to tell silent from untested. */
  const [everHeard, setEverHeard] = useState<Record<string, boolean>>({})
  /** A source that's stayed silent long enough to be worth flagging — see the effect below. */
  const [silentTooLong, setSilentTooLong] = useState({ mic: false, system: false })
  /**
   * When each source started listening, for the silence timer above — tracked
   * per source rather than once for the whole graph, so recovering just the
   * mic (say) gives the mic a fresh grace period without resetting system
   * audio's, and vice versa.
   */
  const sourceOpenedAtRef = useRef<Record<CaptureSourceKind, number>>({ mic: 0, system: 0 })
  /** The live track backing each source right now — see `wireTrackWatchers`. */
  const activeTrackRef = useRef<Record<CaptureSourceKind, MediaStreamTrack | null>>({
    mic: null,
    system: null
  })
  /** Guards a source against a second recovery attempt piling on top of one already in flight. */
  const recoveringRef = useRef<Record<CaptureSourceKind, boolean>>({ mic: false, system: false })
  /** Rate-limits recovery attempts for a source that keeps immediately failing again. */
  const lastRecoveryAttemptAtRef = useRef<Record<CaptureSourceKind, number>>({ mic: 0, system: 0 })
  /** Runs once per silent stretch rather than once per second the warning stays up. */
  const silentRecoveryAttemptedRef = useRef({ mic: false, system: false })
  /** Timestamp of the most recent combined (post-mix) block — the capture graph's heartbeat. */
  const lastBlockAtRef = useRef(0)
  const rebuildingGraphRef = useRef(false)
  const lastRebuildAttemptAtRef = useRef(0)

  /**
   * "Test your mic": records a few seconds from the already-open monitoring
   * stream and plays it straight back, so a quiet or misconfigured input is
   * heard rather than inferred from a meter. No second permission prompt and
   * no temp file — it taps the same PCM blocks already feeding the meters.
   */
  const [micTest, setMicTest] = useState<'idle' | 'recording' | 'ready' | 'playing'>('idle')
  const [micTestSecondsLeft, setMicTestSecondsLeft] = useState(0)
  const micTestChunksRef = useRef<Int16Array[]>([])
  const micTestActiveRef = useRef(false)
  const micTestTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const micTestSourceRef = useRef<AudioBufferSourceNode | null>(null)

  // Blocks arriving before the main process has opened its writer would be
  // dropped by it anyway; this gates them at the source instead of logging an
  // error per block.
  const acceptingRef = useRef(false)

  /**
   * The capture graph, open from the moment this screen is.
   *
   * One graph serves both jobs. Monitoring and recording differ only in whether
   * the combined blocks are forwarded to the main process, so pressing record
   * does not reopen the microphone: no gap, no second permission prompt, and
   * the level you were watching is the level being written.
   */
  const sessionRef = useRef<CaptureSession | null>(null)
  const startedAtRef = useRef(0)
  const pausedMsRef = useRef(0)
  const pauseStartRef = useRef(0)
  /** Guards against two monitor starts overlapping when settings change quickly. */
  const openingRef = useRef(false)
  /**
   * Mirrors `paused` for the combined-block callback, which is created once
   * inside `openMonitor`'s useCallback and does not reopen on every pause
   * toggle — reading the `paused` state value there would see whatever it
   * was when the graph opened, not the current value.
   */
  const pausedRef = useRef(false)
  const liveWaveformRef = useRef<LiveWaveformHandle>(null)

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

  // Pause is decided in main, not set optimistically here, so a toggle from
  // the mini controls window updates this screen too (and vice versa).
  useEvent('recording:pauseChanged', (payload) => {
    setPaused(payload.paused)
    pausedRef.current = payload.paused
  })

  // Tracks every marker added this session, regardless of which window (this
  // one or the mini controls popout) actually called recording:addMarker —
  // deduped by id since this window's own click also appends directly (for
  // zero-latency auto-focus) from recording:addMarker's synchronous
  // response, and would otherwise double up when this same broadcast arrives
  // right behind it.
  useEvent('recording:markerAdded', (marker) => {
    setMarkers((prev) => (prev.some((m) => m.id === marker.id) ? prev : [...prev, marker]))
  })

  // A note typed into any marker from either window lands here.
  useEvent('recording:markerUpdated', (marker) => {
    setMarkers((prev) => prev.map((m) => (m.id === marker.id ? marker : m)))
  })

  // Stops sending audio blocks the instant the session is gone in main. This
  // matters when Stop is clicked from the mini controls window rather than
  // here: without it, this window keeps writing to a session that's already
  // closed until the (possibly several-second) recording:stopped event below
  // arrives with the final result.
  useEvent('recording:sessionEnded', () => {
    acceptingRef.current = false
    setFinishing(true)
  })

  // The single place that decides what happens once a recording is done —
  // reached the same way whether Stop was clicked here or in the mini
  // controls window, so the outcome (the warning banner, where it navigates)
  // can't depend on which one it was.
  useEvent('recording:stopped', (summary) => {
    acceptingRef.current = false
    setRecording(false)
    setPaused(false)
    pausedRef.current = false
    setFinishing(false)
    setCaptureNotice(null)
    if (summary.silent) {
      setError(
        'No audio was captured, so nothing was saved. Check the input device and that its level meter moved.'
      )
      setMarkers([])
      setExpandedMarkerId(null)
      return
    }
    navigate(`/recordings/${summary.recordingId}`)
  })

  // Mirrors recording:stopped for the cancel path — same reasoning, no result
  // to report either way.
  useEvent('recording:discarded', () => {
    acceptingRef.current = false
    setRecording(false)
    setPaused(false)
    pausedRef.current = false
    setFinishing(false)
    setElapsedMs(0)
    setMarkers([])
    setExpandedMarkerId(null)
    setCaptureNotice(null)
  })

  /** Cancels an in-progress or finished mic test — a device change invalidates whatever it captured. */
  const resetMicTest = useCallback(() => {
    if (micTestTimerRef.current) {
      clearInterval(micTestTimerRef.current)
      micTestTimerRef.current = null
    }
    micTestSourceRef.current?.stop()
    micTestSourceRef.current = null
    micTestActiveRef.current = false
    micTestChunksRef.current = []
    setMicTest('idle')
  }, [])

  const closeSession = useCallback(async () => {
    resetMicTest()
    const session = sessionRef.current
    sessionRef.current = null
    acceptingRef.current = false
    activeTrackRef.current = { mic: null, system: null }
    setOpenKinds([])
    setCaptureNotice(null)
    if (session) await session.stop()
  }, [resetMicTest])

  const showCaptureNotice = useCallback(
    (tone: 'warn' | 'ok', message: string, autoDismissMs?: number) => {
      if (captureNoticeTimerRef.current) {
        clearTimeout(captureNoticeTimerRef.current)
        captureNoticeTimerRef.current = null
      }
      setCaptureNotice({ tone, message })
      if (autoDismissMs) {
        captureNoticeTimerRef.current = setTimeout(() => setCaptureNotice(null), autoDismissMs)
      }
    },
    []
  )

  /**
   * Opens the microphone, falling back through `requestMicStream`'s ladder as
   * needed, and records which rung won as a fine-print note — the user should
   * be able to tell that a call app forced unprocessed audio settings, not
   * just that the mic quietly started working differently.
   */
  const acquireMic = useCallback(async (): Promise<MediaStream> => {
    // Independent on purpose: noise suppression alone does not carry the
    // "on a call" character that echo cancellation does, so a user after
    // less-noisy audio need not accept the phone-call sound to get it.
    const processing = {
      ...CLEAN_MIC,
      noiseSuppression: settings?.noiseSuppression ?? false,
      echoCancellation: settings?.echoCancellation ?? false
    }
    const acquisition = await requestMicStream(deviceId || undefined, processing)
    setMicNote(
      acquisition.attempt === 'requested'
        ? null
        : acquisition.attempt === 'requested-raw'
          ? 'Your microphone needed unprocessed audio settings to stay usable — noise suppression, echo cancellation and automatic gain are off for this recording, likely because another app has the device.'
          : 'Your saved microphone was unavailable, so the system default device is being used instead, with unprocessed audio settings.'
    )
    return acquisition.stream
  }, [deviceId, settings?.noiseSuppression, settings?.echoCancellation])

  const handleLevel = useCallback(
    (kind: CaptureSourceKind, samples: Int16Array, peak: number) => {
      setLevels((prev) => ({ ...prev, [kind]: Math.max(prev[kind] ?? 0, peak) }))
      if (peak > SIGNAL_FLOOR) {
        setEverHeard((prev) => (prev[kind] ? prev : { ...prev, [kind]: true }))
      }
      // Copied rather than kept as a view: the worklet reuses its buffers
      // block to block, so holding the view itself would see later blocks'
      // data overwrite what was meant to be a snapshot of this one.
      if (kind === 'mic' && micTestActiveRef.current) micTestChunksRef.current.push(samples.slice())
    },
    []
  )

  const handleBlock = useCallback((samples: Int16Array, peak: number) => {
    // The combined node keeps processing as long as any source is attached to
    // it, even one producing nothing, so this fires on a steady cadence
    // whenever the capture graph's audio thread is actually alive — the
    // heartbeat the stall watchdog below is built on.
    lastBlockAtRef.current = Date.now()
    if (!acceptingRef.current) return
    // Gated the same way the chunk itself is, plus paused: the strip
    // should stop advancing exactly when "no audio is being written"
    // is true, not keep tracing the monitored signal underneath it.
    if (!pausedRef.current) liveWaveformRef.current?.push(peak)
    // A Uint8Array view keeps the structured clone to the exact bytes
    // rather than the whole backing buffer.
    void api.invoke('recording:chunk', {
      samples: new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength)
    })
  }, [])

  /**
   * Re-acquires one source in place — a mic gone quiet because another app
   * grabbed the device, an interface reappearing after being unplugged, or a
   * source whose track just reported `ended`/`muted`. Swaps into the same
   * combined node via `replaceSource`, so this never touches the recording
   * that's already in progress beyond the gap while the new stream opens.
   */
  const recoverSource = useCallback(
    async (kind: CaptureSourceKind, reason: string): Promise<boolean> => {
      const session = sessionRef.current
      if (!session || recoveringRef.current[kind]) return false
      if (Date.now() - lastRecoveryAttemptAtRef.current[kind] < 3000) return false
      lastRecoveryAttemptAtRef.current[kind] = Date.now()
      recoveringRef.current[kind] = true
      const what = kind === 'mic' ? 'Microphone' : 'System audio'
      console.info(`[record] recovering ${kind}: ${reason}`)
      showCaptureNotice('warn', `${what} was lost — reconnecting…`)
      // Relayed to main so a popped-out mini controls window — which can't
      // reach getUserMedia itself — sees the same state. Best-effort: no mini
      // window being open just means nothing is listening on the other end.
      const relay = (state: 'lost' | 'recovered', message: string): void => {
        void api.invoke('recording:reportCaptureState', { kind, state, message }).catch(() => undefined)
      }
      relay('lost', `${what} was lost — reconnecting…`)

      try {
        const stream = kind === 'mic' ? await acquireMic() : await requestSystemStream()
        wireTrackWatchers(kind, stream, activeTrackRef.current, (k, r) => recoverSourceRef.current(k, r))
        session.replaceSource(kind, stream)
        setOpenKinds((prev) => (prev.includes(kind) ? prev : [...prev, kind]))
        setEverHeard((prev) => ({ ...prev, [kind]: false }))
        sourceOpenedAtRef.current[kind] = Date.now()
        showCaptureNotice('ok', `${what} reconnected.`, 4000)
        relay('recovered', `${what} reconnected.`)
        return true
      } catch (err) {
        console.error(`[record] failed to recover ${kind}:`, err)
        const message = `Couldn't reconnect ${kind === 'mic' ? 'the microphone' : 'system audio'}${
          err instanceof CaptureError ? ` — ${err.message}` : ''
        }`
        showCaptureNotice('warn', message)
        relay('lost', message)
        return false
      } finally {
        recoveringRef.current[kind] = false
      }
    },
    [acquireMic, showCaptureNotice]
  )

  // Track-`ended`/`mute` listeners (wired via `wireTrackWatchers`) are attached
  // once per source and outlive any single render, so they call through this
  // ref rather than closing over `recoverSource` directly — otherwise a
  // listener attached before a settings change would keep recovering with
  // stale mic-processing preferences.
  const recoverSourceRef = useRef<(kind: CaptureSourceKind, reason: string) => void>(() => {})
  useEffect(() => {
    recoverSourceRef.current = (kind, reason) => void recoverSource(kind, reason)
  }, [recoverSource])

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

      const streams: Array<{ kind: CaptureSourceKind; stream: MediaStream }> = []
      try {
        streams.push({ kind: 'mic', stream: await acquireMic() })
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

      const session = await startCapture(streams, handleLevel, handleBlock)

      for (const { kind, stream } of streams) {
        wireTrackWatchers(kind, stream, activeTrackRef.current, (k, r) => recoverSourceRef.current(k, r))
      }

      sessionRef.current = session
      setOpenKinds(streams.map((s) => s.kind))
      setSampleRate(Math.round(session.sampleRate))
      setEverHeard({})
      const now = Date.now()
      sourceOpenedAtRef.current = { mic: now, system: now }
      lastBlockAtRef.current = now
      void loadDevices()
    } finally {
      openingRef.current = false
    }
  }, [acquireMic, closeSession, handleBlock, handleLevel, loadDevices, recording, wantSystem])

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
  // running would hold the microphone for the rest of the session. This is a
  // safety net, not the primary guard against losing an in-progress
  // recording — App.tsx locks navigation away from this page for that —
  // so if it's ever accepting audio on the way out anyway, that take is
  // saved (recording:stop) rather than destroyed (recording:cancel, which
  // was this effect's original behavior and deleted the file outright).
  useEffect(() => {
    return () => {
      if (acceptingRef.current) void api.invoke('recording:stop')
      const session = sessionRef.current
      sessionRef.current = null
      acceptingRef.current = false
      if (session) void session.stop()
      if (micTestTimerRef.current) clearInterval(micTestTimerRef.current)
      micTestSourceRef.current?.stop()
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

  // Keeps the newest marker's note field in view the moment it's added,
  // rather than requiring a scroll to find it right after clicking Mark.
  useEffect(() => {
    if (!expandedMarkerId) return
    markersListRef.current?.scrollTo({ top: markersListRef.current.scrollHeight, behavior: 'smooth' })
  }, [expandedMarkerId])

  /**
   * Flags a source that has never once cleared SIGNAL_FLOOR since the graph
   * opened, given long enough that it plausibly should have — this is what
   * caught nothing the first time: a meter alone stayed quiet without ever
   * saying so out loud, and a 3-hour recording finished before anyone found
   * out. Runs through both monitoring and an actual recording, since that
   * incident happened well after Start was pressed, not at setup.
   *
   * A plain "quiet for N seconds" test would fire constantly on ordinary
   * listening pauses, so this checks total silence since the graph opened
   * instead — one real word is enough to clear it for good. The mic's own
   * grace period shortens once system audio is clearly carrying the call:
   * a live conversation with literally nothing from your side in that long
   * is a much stronger signal than silence with nothing corroborating it.
   */
  useEffect(() => {
    if (openKinds.length === 0) {
      setSilentTooLong({ mic: false, system: false })
      return
    }
    const monitoringSystem = openKinds.includes('system')
    const MIC_GRACE_MS = monitoringSystem && everHeard.system ? 12_000 : 30_000
    const SYSTEM_GRACE_MS = 30_000
    const check = (): void => {
      const micElapsed = Date.now() - sourceOpenedAtRef.current.mic
      const systemElapsed = Date.now() - sourceOpenedAtRef.current.system
      setSilentTooLong({
        mic: !everHeard.mic && micElapsed > MIC_GRACE_MS,
        system: monitoringSystem && !everHeard.system && systemElapsed > SYSTEM_GRACE_MS
      })
    }
    check()
    const timer = setInterval(check, 1000)
    return () => clearInterval(timer)
  }, [openKinds, everHeard.mic, everHeard.system])

  // A source that has stayed silent through its whole grace period (see
  // above) gets one automatic recovery attempt during an actual recording —
  // this is the safety net for a dropout that neither the track's `ended`/
  // `mute` events nor the graph-stall watchdog caught (a device that keeps
  // reporting "live" and "unmuted" while genuinely producing nothing, which
  // Windows exclusive-mode audio drivers can do). Guarded to fire once per
  // silent stretch, not once per second the warning stays up.
  useEffect(() => {
    if (!everHeard.mic) return
    silentRecoveryAttemptedRef.current.mic = false
  }, [everHeard.mic])
  useEffect(() => {
    if (!everHeard.system) return
    silentRecoveryAttemptedRef.current.system = false
  }, [everHeard.system])
  useEffect(() => {
    if (!recording) return
    for (const kind of ['mic', 'system'] as const) {
      if (silentTooLong[kind] && !silentRecoveryAttemptedRef.current[kind]) {
        silentRecoveryAttemptedRef.current[kind] = true
        void recoverSource(kind, `${kind} stayed silent through its grace period`)
      }
    }
  }, [recording, silentTooLong, recoverSource])

  /**
   * Rebuilds the whole capture graph when the combined node's heartbeat
   * (`lastBlockAtRef`, updated on every mixed block) goes quiet for longer
   * than a momentary hiccup — the signature of the AudioContext's own render
   * thread stalling, which happens when the default *output* device it's
   * bound to disappears (an audio interface usually supplies both input and
   * output, so unplugging it does this). Per-source recovery can't fix this:
   * nothing is wrong with the sources, the context driving them has stopped
   * pumping. `context.resume()` is tried first since it's cheap and covers
   * plain suspension; a full rebuild is pinned to the original sample rate
   * so a fallback output device running at a different rate doesn't shift
   * playback speed for the audio appended after the gap.
   */
  const handleGraphStall = useCallback(async (): Promise<void> => {
    const session = sessionRef.current
    if (!session || rebuildingGraphRef.current) return
    if (Date.now() - lastRebuildAttemptAtRef.current < 5000) return
    lastRebuildAttemptAtRef.current = Date.now()
    rebuildingGraphRef.current = true
    console.warn('[record] capture graph appears stalled')
    showCaptureNotice('warn', 'Audio capture stalled — attempting to recover…')

    try {
      if (session.context.state !== 'running') {
        try {
          await session.context.resume()
        } catch (err) {
          console.warn('[record] context.resume() failed:', err)
        }
        await new Promise((resolve) => setTimeout(resolve, 500))
        if (Date.now() - lastBlockAtRef.current < 2000) {
          showCaptureNotice('ok', 'Audio capture resumed.', 4000)
          return
        }
      }

      console.warn('[record] rebuilding capture graph from scratch')
      const wantedKinds = openKinds
      const originalRate = session.sampleRate
      await session.stop()
      sessionRef.current = null

      const streams: Array<{ kind: CaptureSourceKind; stream: MediaStream }> = []
      for (const kind of wantedKinds) {
        try {
          streams.push({ kind, stream: kind === 'mic' ? await acquireMic() : await requestSystemStream() })
        } catch (err) {
          console.error(`[record] rebuild: could not reacquire ${kind}:`, err)
        }
      }

      if (streams.length === 0) {
        setOpenKinds([])
        showCaptureNotice('warn', 'Audio capture was lost and could not be recovered automatically.')
        return
      }

      const rebuilt = await startCapture(streams, handleLevel, handleBlock, originalRate)
      for (const { kind, stream } of streams) {
        wireTrackWatchers(kind, stream, activeTrackRef.current, (k, r) => recoverSourceRef.current(k, r))
      }
      sessionRef.current = rebuilt
      setOpenKinds(streams.map((s) => s.kind))
      lastBlockAtRef.current = Date.now()
      showCaptureNotice('ok', 'Audio capture recovered.', 4000)
    } finally {
      rebuildingGraphRef.current = false
    }
  }, [acquireMic, handleBlock, handleLevel, openKinds, showCaptureNotice])

  // The watchdog itself: polls the heartbeat rather than reacting to an event,
  // since a stalled render thread produces no event of any kind to react to.
  useEffect(() => {
    if (openKinds.length === 0) return
    const STALL_MS = 2500
    const timer = setInterval(() => {
      if (rebuildingGraphRef.current) return
      if (Date.now() - lastBlockAtRef.current > STALL_MS) void handleGraphStall()
    }, 750)
    return () => clearInterval(timer)
  }, [openKinds, handleGraphStall])

  // "m" marks the current moment without reaching for the mouse — same
  // shortcut Trim.tsx already uses for adding a marker. Ignored while typing
  // anywhere (a marker's own note field included) so the letter just types
  // normally there instead of adding a new marker.
  useEffect(() => {
    if (!recording) return
    function isTypingTarget(target: EventTarget | null): boolean {
      return target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
    }
    function onKeyDown(e: KeyboardEvent): void {
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return
      if (e.key === 'm' || e.key === 'M') markRef.current?.()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [recording])

  async function start(): Promise<void> {
    setWarning(null)

    // The graph is already open and metering; if something closed it, open it
    // again rather than refusing.
    if (!sessionRef.current) await openMonitor()
    let session = sessionRef.current
    if (!session) return

    // Only reopens the mic on unambiguous evidence it's actually gone — no
    // track, or one that's literally `ended` — never on "hasn't produced a
    // peak yet" or `track.muted` alone. Both of those are common and totally
    // normal (a quiet room; a metadata flag that clears late on some
    // hardware) and reopening on them was what regressed a mic that was
    // already working fine into the wrong device — see `tryAcquireMic`'s doc
    // comment in capture.ts. A track that's live but genuinely silent is
    // instead caught later, from real measured audio (the silentTooLong
    // effect above), not from a snapshot taken right here.
    const micTrack = activeTrackRef.current.mic
    const micLooksDead = !micTrack || micTrack.readyState !== 'live'
    if (micLooksDead) {
      await recoverSource('mic', 'mic track was missing or ended before recording started')
      session = sessionRef.current
      if (!session) return
    }

    const rate = Math.round(session.sampleRate)
    setSampleRate(rate)

    try {
      await api.invoke('recording:start', {
        hasSystemAudio: openKinds.includes('system'),
        sampleRate: rate
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return
    }

    // From here the same blocks that were feeding the meters are written to disk.
    acceptingRef.current = true
    startedAtRef.current = Date.now()
    pausedMsRef.current = 0
    setElapsedMs(0)
    setMarkers([])
    setExpandedMarkerId(null)
    setRecording(true)
    setPaused(false)
    pausedRef.current = false
  }

  /** Flags the current moment for later — the position is exactly this window's own paused-time-excluding elapsed timer, which is also what's on screen. */
  function mark(): void {
    // Pinned immediately, synchronously with the click/keypress rather than
    // waiting on the IPC round trip — the pin is a visual "right here, right
    // now" marker on the live trace, and by the time recording:addMarker
    // resolves a few more blocks may already have scrolled past.
    liveWaveformRef.current?.markNow(markerColor)
    void api.invoke('recording:addMarker', { elapsedMs, color: markerColor }).then((marker) => {
      // Appended directly from the response rather than waiting on the
      // recording:markerAdded broadcast, so the note field can appear and
      // auto-focus with zero perceived latency; the broadcast listener above
      // is a no-op for this marker once it arrives, already deduped by id.
      setMarkers((prev) => (prev.some((m) => m.id === marker.id) ? prev : [...prev, marker]))
      // Also collapses whichever marker's note was previously open (via the
      // `active` prop below), saving it first — see useMarkerNote's doc
      // comment. Set in the same batch as the marker list update so the new
      // row renders already-expanded rather than opening a beat later.
      setExpandedMarkerId(marker.id)
    })
  }
  markRef.current = mark

  /** Saves a note typed into one of this session's markers — reflected locally right away, and to every window via the recording:markerUpdated broadcast this triggers. */
  function updateMarkerNote(id: string, notes: string): void {
    setMarkers((prev) => prev.map((m) => (m.id === id ? { ...m, notes } : m)))
    void api.invoke('recording:updateMarker', { id, notes })
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

  /** True for the one error this window should shrug off — see `finishing`'s doc comment. */
  function alreadyFinishing(err: unknown): boolean {
    return err instanceof Error && err.message.includes('No recording in progress')
  }

  async function stop(): Promise<void> {
    // Optimistic, for instant feedback on this window's own click — the
    // recording:sessionEnded/recording:stopped handlers above do the same
    // (and are what actually run when Stop is clicked from the mini window
    // instead), so this is belt-and-braces rather than load-bearing here.
    acceptingRef.current = false
    setRecording(false)
    setPaused(false)
    pausedRef.current = false
    setFinishing(true)

    try {
      await api.invoke('recording:stop')
    } catch (err) {
      // Losing the race with a stop already in flight elsewhere is not a
      // failure to report — recording:sessionEnded already caught it, and
      // recording:stopped is still coming.
      if (!alreadyFinishing(err)) {
        setFinishing(false)
        setError(err instanceof Error ? err.message : String(err))
      }
    }
  }

  async function discard(): Promise<void> {
    acceptingRef.current = false
    setRecording(false)
    setPaused(false)
    pausedRef.current = false
    setFinishing(true)
    setElapsedMs(0)

    try {
      await api.invoke('recording:cancel')
    } catch (err) {
      if (!alreadyFinishing(err)) {
        setFinishing(false)
        setError(err instanceof Error ? err.message : String(err))
      }
    }
  }

  /** How long a test clip runs before playing itself back automatically. */
  const MIC_TEST_MS = 4000

  function startMicTest(): void {
    if (!sessionRef.current || micTest === 'recording' || micTest === 'playing') return
    micTestChunksRef.current = []
    micTestActiveRef.current = true
    setMicTest('recording')
    let remaining = Math.ceil(MIC_TEST_MS / 1000)
    setMicTestSecondsLeft(remaining)
    micTestTimerRef.current = setInterval(() => {
      remaining -= 1
      if (remaining > 0) {
        setMicTestSecondsLeft(remaining)
        return
      }
      if (micTestTimerRef.current) {
        clearInterval(micTestTimerRef.current)
        micTestTimerRef.current = null
      }
      micTestActiveRef.current = false
      playMicTest()
    }, 1000)
  }

  /** Builds an AudioBuffer straight from the captured samples and plays it through the same context capture already uses — no re-encoding, so what plays back is exactly what was heard. */
  function playMicTest(): void {
    const context = sessionRef.current?.context
    const chunks = micTestChunksRef.current
    if (!context || chunks.length === 0) {
      setMicTest('idle')
      return
    }

    const totalSamples = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
    const buffer = context.createBuffer(1, totalSamples, context.sampleRate)
    const channel = buffer.getChannelData(0)
    let offset = 0
    for (const chunk of chunks) {
      for (let i = 0; i < chunk.length; i++) channel[offset + i] = chunk[i] / 32768
      offset += chunk.length
    }

    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(context.destination)
    source.onended = () => {
      if (micTestSourceRef.current === source) micTestSourceRef.current = null
      setMicTest((prev) => (prev === 'playing' ? 'ready' : prev))
    }
    micTestSourceRef.current = source
    source.start()
    setMicTest('playing')
  }

  const monitoringSystem = openKinds.includes('system')
  // Derived from state, not from the ref: a ref changing does not re-render, so
  // a button disabled on one would stay disabled until something else moved.
  const captureOpen = openKinds.length > 0
  const micLive = (levels.mic ?? 0) > SIGNAL_FLOOR

  const meters = (
    <div className="recorder__meters">
      <Meter
        label="Microphone"
        level={levels.mic ?? 0}
        color="var(--accent-strong)"
        warn={silentTooLong.mic}
        hint={
          silentTooLong.mic
            ? monitoringSystem && everHeard.system
              ? "No sound from your mic, but the call has audio — check your input device"
              : 'No sound detected from your mic — check your input device'
            : recording
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
          warn={silentTooLong.system}
          hint={
            silentTooLong.system
              ? 'No sound detected — check that audio is playing'
              : recording
                ? undefined
                : everHeard.system
                  ? 'Hearing playback'
                  : 'Play something to check the level'
          }
        />
      )}
    </div>
  )

  // The bar meters swap for the live waveform once actually recording — see
  // the comment where these are rendered. Their warning text survives the
  // swap even though the bars themselves don't, so it's split out here
  // rather than left buried inside the Meter elements above.
  const micSilentWarning = silentTooLong.mic
    ? monitoringSystem && everHeard.system
      ? 'No sound from your mic, but the call has audio — check your input device'
      : 'No sound detected from your mic — check your input device'
    : null
  const systemSilentWarning = silentTooLong.system
    ? 'No sound detected from system audio — check that audio is playing'
    : null

  return (
    <div className="page">
      <header className="page__header">
        <div>
          <h1>Record</h1>
          <p className="page__subtitle">Microphone and system audio, mixed into one recording</p>
        </div>
      </header>

      {error && <div className="banner banner--error">{error}</div>}
      {warning && <div className="banner banner--warn">{warning}</div>}
      {captureNotice && (
        <div className={captureNotice.tone === 'ok' ? 'banner banner--ok' : 'banner banner--warn'}>
          {captureNotice.message}
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
              : finishing
                ? 'Finishing the previous recording…'
                : !captureOpen
                  ? 'Opening the microphone…'
                  : micLive
                    ? `Ready — capturing at ${((sampleRate ?? 48000) / 1000).toFixed(1)} kHz`
                    : `Listening on ${
                        devices.find((d) => d.deviceId === deviceId)?.label || 'the default microphone'
                      }`}
          </p>
        </div>

        {/* The bar meters (useful before pressing record, to check levels) swap
            for the live waveform of the real captured signal once recording
            is actually running. The silent-mic warning text survives the
            swap even though the bars don't: it's what caught a real
            incident (a mic gone dead mid-call) that the combined waveform
            alone wouldn't show — system audio can keep the trace looking
            alive while the mic itself is silent. */}
        {recording ? (
          <div className="recorder__live">
            {micSilentWarning && <div className="banner banner--warn">{micSilentWarning}</div>}
            {systemSilentWarning && <div className="banner banner--warn">{systemSilentWarning}</div>}
            <LiveWaveform ref={liveWaveformRef} />
          </div>
        ) : (
          meters
        )}

        <div className="recorder__controls">
          {recording ? (
            <>
              <input
                type="color"
                className="player__marker-color"
                value={markerColor}
                onChange={(e) => setMarkerColor(e.target.value)}
                aria-label="Color for the next marker"
                title="Color for the next marker"
              />
              <button className="btn btn--ghost btn--icon" onClick={mark} title="Mark this moment, to jump back to it later (M)">
                <Icon name="flag" style={{ color: markerColor }} />
                Mark
              </button>
              <button className="btn btn--icon" onClick={togglePause}>
                <Icon name={paused ? 'play' : 'pause'} />
                {paused ? 'Resume' : 'Pause'}
              </button>
              <button className="btn btn--primary btn--icon" onClick={stop}>
                <Icon name="stop" />
                Stop and save
              </button>
              <button className="btn btn--ghost btn--icon" onClick={discard}>
                <Icon name="trash" />
                Discard
              </button>
              {markers.length > 0 && (
                <span className="recorder__marker-count">
                  <Icon name="flag" style={{ color: DEFAULT_MARKER_COLOR }} />
                  {markers.length} marked
                </span>
              )}
            </>
          ) : (
            <button
              className="btn btn--record btn--icon"
              onClick={start}
              disabled={!captureOpen || finishing}
              title={finishing ? 'Finishing the previous recording — starting again in a moment' : undefined}
            >
              {!finishing && <Icon name="record" />}
              {finishing ? 'Finishing…' : 'Start recording'}
            </button>
          )}
        </div>

        {recording && markers.length > 0 && (
          <div className="recorder__markers" ref={markersListRef}>
            {markers.map((marker, i) => (
              <MarkerNoteField
                key={marker.id}
                marker={marker}
                index={i + 1}
                startExpanded={marker.id === expandedMarkerId}
                active={expandedMarkerId === null || expandedMarkerId === marker.id}
                onExpandedChange={(isExpanded) => setExpandedMarkerId(isExpanded ? marker.id : null)}
                onCommit={(notes) => updateMarkerNote(marker.id, notes)}
              />
            ))}
          </div>
        )}

        {!recording && (
          <div className="recorder__detail">
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
                <div className="mictest">
                  {micTest === 'idle' && (
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={startMicTest}
                      disabled={!captureOpen}
                    >
                      🎤 Test your mic
                    </button>
                  )}
                  {micTest === 'recording' && (
                    <span className="mictest__status">
                      ● Recording — say something ({micTestSecondsLeft}s)
                    </span>
                  )}
                  {micTest === 'playing' && (
                    <span className="mictest__status">🔊 Playing back what was captured…</span>
                  )}
                  {micTest === 'ready' && (
                    <span className="mictest__row">
                      <button type="button" className="btn btn--ghost btn--sm" onClick={playMicTest}>
                        ▶ Play again
                      </button>
                      <button type="button" className="btn btn--ghost btn--sm" onClick={startMicTest}>
                        🎤 Test again
                      </button>
                    </span>
                  )}
                </div>
                {micNote && <p className="recorder__fine recorder__fine--warn">{micNote}</p>}
              </div>

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

              <div className="recorder__group">
                <span className="recorder__group-label">Audio processing</span>

                <div className="toolbar__toggle-row">
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
                  <HelpTip text="Gates out steady noise — fans, hum, keyboard clatter — on its own, without the echo cancellation below. The meter above updates as soon as you change it." />
                </div>

                <div className="toolbar__toggle-row">
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
                  <HelpTip text="Leave this off for an external or USB microphone — this is what makes a recording sound like a phone call. Turn it on only for a laptop mic with sound coming from its own speakers, where it stops the far end being recorded twice. Worth trying too if your mic ever reads as silent while another app is using it for a call." />
                </div>
              </div>

              <div className="recorder__group">
                <span className="recorder__group-label">Recording behavior</span>

                <div className="toolbar__toggle-row">
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
                  <HelpTip text="While recording, minimizing this window opens a small always-on-top controls window — pause/resume, stop & save, discard. This is the only way to reach it; leave it unticked and minimizing behaves normally. Closing that window brings this one back." />
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="recorder__note">
        <p>Microphone and system audio are mixed together into one recorded file.</p>
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
