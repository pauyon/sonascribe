import { useEffect, useRef, useState } from 'react'
import { DEFAULT_MARKER_COLOR, type Marker } from '@shared/types'
import { api, useEvent, useQuery } from '../lib/api'
import { formatDuration } from '../lib/format'
import Icon from '../components/Icon'
import IconButton from '../components/IconButton'
import MarkerNoteField from '../components/MarkerNoteField'

/**
 * The pop-out recording controls: a small always-on-top window with the
 * full transport (pause/resume, stop & save, discard), so those stay
 * reachable with the main window minimized.
 *
 * State authority stays on the Record screen and in main, not here — this
 * only mirrors it. Pause is decided in main (`recorder.ts`), broadcast as
 * `recording:pauseChanged`, and this window's own Pause/Resume button just
 * asks for the same toggle Record.tsx does. Elapsed time is relayed from
 * Record.tsx, the one place that already tracks paused spans correctly,
 * rather than duplicating that bookkeeping here.
 *
 * Stop & Save / Discard triggered from here go through the exact same
 * `recording:stop` / `recording:cancel` calls Record.tsx's own buttons make,
 * and this window reacts to the resulting `recording:stopped` /
 * `recording:discarded` broadcast exactly like it would if triggered
 * elsewhere: it closes. Record.tsx does the corresponding navigation and
 * brings the main window forward — one place decides what "done" means,
 * regardless of which window asked for it.
 */
export default function MiniRecorder(): React.JSX.Element {
  const { data: status, loading: statusLoading } = useQuery('recording:status')

  const [paused, setPausedState] = useState(false)
  const [elapsedMs, setElapsedMs] = useState(0)
  /** This session's markers — this window shows a note field for only the last one (see the render below); the full list lives on the main Record screen. */
  const [markers, setMarkers] = useState<Marker[]>([])
  /** The marker this window's own Mark click most recently added — only that one autofocuses, not whichever marker merely happens to be latest (e.g. right after this window opens mid-session). */
  const [justAddedMarkerId, setJustAddedMarkerId] = useState<string | null>(null)
  /**
   * True from the moment Stop or Discard is clicked — here, or in the main
   * Record window, which is why this is driven by `recording:sessionEnded`
   * rather than only this window's own click. A second Pause/Stop/Discard
   * sent before the first finishes fails with "No recording in progress" — a
   * real error, but a confusing one when nothing on screen explained the
   * wait. This disables the transport instead of leaving it clickable
   * through that whole window.
   */
  const [finishing, setFinishing] = useState(false)
  /**
   * The most recent capture health report — main's own chunk-stall watchdog,
   * or the main Record window's capture supervisor relayed via
   * `recording:reportCaptureState` (this window has no getUserMedia access of
   * its own, so it can't detect any of this directly).
   */
  const [captureNotice, setCaptureNotice] = useState<{ tone: 'warn' | 'ok'; message: string } | null>(
    null
  )
  const captureNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Always points at the current render's `mark` — see Record.tsx's identical `markRef` for why this indirection is needed rather than calling `mark` directly from the shortcut effect below. */
  const markRef = useRef<(() => void) | null>(null)
  // Bootstraps from the query once; every change after that arrives as a
  // broadcast instead (recording:pauseChanged, recording:markerAdded), from
  // whichever window sent it. Markers added before this window even existed
  // — this can open mid-session — never fired a broadcast it was around to
  // hear, so its count starts from the real total, not zero.
  const appliedStatusRef = useRef(false)

  useEffect(() => {
    if (appliedStatusRef.current || !status) return
    appliedStatusRef.current = true
    setPausedState(status.paused)
    setMarkers(status.markers)
  }, [status])

  useEffect(() => {
    return () => {
      if (captureNoticeTimerRef.current) clearTimeout(captureNoticeTimerRef.current)
    }
  }, [])

  useEvent('recording:pauseChanged', (payload) => setPausedState(payload.paused))
  useEvent('recording:elapsedTick', (payload) => setElapsedMs(payload.elapsedMs))
  // Tracks every marker added this session, regardless of which window (this
  // one or the main Record screen) actually called recording:addMarker —
  // deduped the same way Record.tsx's own listener is, for the same reason:
  // this window's own mark() also appends directly from the response.
  useEvent('recording:markerAdded', (marker) => {
    setMarkers((prev) => (prev.some((m) => m.id === marker.id) ? prev : [...prev, marker]))
  })
  useEvent('recording:markerUpdated', (marker) => {
    setMarkers((prev) => prev.map((m) => (m.id === marker.id ? marker : m)))
  })
  // Fired the instant a stop begins anywhere — before the slow work that
  // follows it — so the transport disables immediately even when Stop was
  // clicked on the main window rather than here. See `finishing` above.
  useEvent('recording:sessionEnded', () => setFinishing(true))
  // The recording this window was opened for is over — nothing left to
  // control, so it closes itself rather than sitting there pointing at a
  // session that's gone. Record.tsx's own listeners for these same two
  // events are what navigate the main window and bring it forward.
  useEvent('recording:stopped', () => window.close())
  useEvent('recording:discarded', () => window.close())
  useEvent('recording:captureWarning', (payload) => {
    if (captureNoticeTimerRef.current) {
      clearTimeout(captureNoticeTimerRef.current)
      captureNoticeTimerRef.current = null
    }
    if (payload.state === 'lost') {
      setCaptureNotice({ tone: 'warn', message: payload.message })
      return
    }
    setCaptureNotice({ tone: 'ok', message: payload.message })
    captureNoticeTimerRef.current = setTimeout(() => setCaptureNotice(null), 4000)
  })

  /** True for the one error this window should shrug off — see `finishing`'s doc comment. */
  function alreadyFinishing(err: unknown): boolean {
    return err instanceof Error && err.message.includes('No recording in progress')
  }

  async function stop(): Promise<void> {
    setFinishing(true)
    try {
      await api.invoke('recording:stop')
    } catch (err) {
      // A genuine failure re-enables the transport — it's still here, and
      // still usable, if that happens (surfaced as Record.tsx's own error
      // banner on the main window, which recording:stopped never arrives to
      // close this one over). Losing the race with a stop already in flight
      // elsewhere is not a failure: recording:sessionEnded already disabled
      // this before the click was even possible, and recording:stopped is
      // still coming.
      if (!alreadyFinishing(err)) setFinishing(false)
    }
  }

  async function discard(): Promise<void> {
    setFinishing(true)
    try {
      await api.invoke('recording:cancel')
    } catch (err) {
      if (!alreadyFinishing(err)) setFinishing(false)
    }
  }

  /** Flags the current moment — `elapsedMs` here is the relayed copy of Record.tsx's own timer, the same position it shows. */
  function mark(): void {
    void api.invoke('recording:addMarker', { elapsedMs }).then((marker) => {
      setMarkers((prev) => (prev.some((m) => m.id === marker.id) ? prev : [...prev, marker]))
      setJustAddedMarkerId(marker.id)
    })
  }
  markRef.current = mark

  // "m" marks the current moment — same shortcut Record.tsx's main window
  // offers, so it works no matter which window has focus. Ignored while
  // typing (the quick-note field included) and while a stop/discard is
  // already in flight, matching the Mark button's own disabled state.
  useEffect(() => {
    if (!status || finishing) return
    function isTypingTarget(target: EventTarget | null): boolean {
      return target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
    }
    function onKeyDown(e: KeyboardEvent): void {
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return
      if (e.key === 'm' || e.key === 'M') markRef.current?.()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [status, finishing])

  /** Saves a note on the most-recently-added marker (the only one this window edits — see `markers`' doc comment). */
  function updateMarkerNote(id: string, notes: string): void {
    setMarkers((prev) => prev.map((m) => (m.id === id ? { ...m, notes } : m)))
    void api.invoke('recording:updateMarker', { id, notes })
  }

  const latestMarker = markers.length > 0 ? markers[markers.length - 1] : null

  return (
    <div className="mini">
      <div className="mini__head">
        <span className={paused ? 'mini__dot mini__dot--paused' : 'mini__dot'} aria-hidden="true" />
        <span className="mini__status">
          {finishing ? 'Finishing…' : paused ? 'Paused' : 'Recording'}
        </span>
        {/* Not an <IconButton>: .mini__close is a complete, bespoke recipe
            (background/color/hover) predating this refactor, not one of the
            duplicated small-button patterns IconButton consolidates — and
            IconButton's `variant="ghost"` pulls in .btn--ghost:hover, which
            is red (var(--danger)), wrongly implying this closes/discards
            the recording rather than just hiding this window. */}
        <button
          type="button"
          className="mini__close"
          onClick={() => window.close()}
          aria-label="Close pop-out controls"
          title="Close (the recording keeps going)"
        >
          <Icon name="close" />
        </button>
      </div>

      {statusLoading ? (
        <p className="mini__empty">Connecting…</p>
      ) : !status ? (
        <p className="mini__empty">No recording in progress.</p>
      ) : (
        <>
          <div className="mini__time">{formatDuration(elapsedMs)}</div>

          {captureNotice && (
            <p
              className={
                captureNotice.tone === 'warn' ? 'mini__notice mini__notice--warn' : 'mini__notice'
              }
            >
              {captureNotice.message}
            </p>
          )}

          <div className="mini__toolbar">
            <div className="mini__icon-btn mini__mark-btn">
              <IconButton
                size="sm"
                variant="ghost"
                style={{ width: '100%', height: '100%', padding: 0 }}
                onClick={mark}
                disabled={finishing}
                title="Mark this moment, to jump back to it later"
                aria-label="Mark this moment"
                icon="flag"
                iconStyle={{ color: DEFAULT_MARKER_COLOR }}
              />
              {markers.length > 0 && <span className="mini__mark-count">{markers.length}</span>}
            </div>
            <IconButton
              size="sm"
              variant="plain"
              className="mini__icon-btn"
              style={{ height: 'auto' }}
              onClick={() => void api.invoke('recording:pause', { paused: !paused })}
              disabled={finishing}
              title={paused ? 'Resume' : 'Pause'}
              aria-label={paused ? 'Resume' : 'Pause'}
              icon={paused ? 'play' : 'pause'}
            />
            <IconButton
              size="sm"
              variant="primary"
              className="mini__icon-btn"
              style={{ height: 'auto' }}
              onClick={stop}
              disabled={finishing}
              title="Stop & save"
              aria-label="Stop and save"
              icon="stop"
            />
            <IconButton
              size="sm"
              variant="ghost"
              className="mini__icon-btn"
              style={{ height: 'auto' }}
              onClick={discard}
              disabled={finishing}
              title="Discard (delete this recording)"
              aria-label="Discard this recording"
              icon="trash"
            />
          </div>

          {latestMarker && (
            <MarkerNoteField
              key={latestMarker.id}
              marker={latestMarker}
              index={markers.length}
              compact
              startExpanded={latestMarker.id === justAddedMarkerId}
              onCommit={(notes) => updateMarkerNote(latestMarker.id, notes)}
            />
          )}
        </>
      )}
    </div>
  )
}
