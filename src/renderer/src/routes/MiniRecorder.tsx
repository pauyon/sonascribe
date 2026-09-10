import { useEffect, useRef, useState } from 'react'
import { DEFAULT_MARKER_COLOR } from '@shared/types'
import { api, useEvent, useQuery } from '../lib/api'
import { formatDuration } from '../lib/format'
import Icon from '../components/Icon'
import IconButton from '../components/IconButton'

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
  const [markerCount, setMarkerCount] = useState(0)
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
    setMarkerCount(status.markerCount)
  }, [status])

  useEvent('recording:pauseChanged', (payload) => setPausedState(payload.paused))
  useEvent('recording:elapsedTick', (payload) => setElapsedMs(payload.elapsedMs))
  // Counts every marker added this session, regardless of which window (this
  // one or the main Record screen) actually called recording:addMarker.
  useEvent('recording:markerAdded', () => setMarkerCount((n) => n + 1))
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
    void api.invoke('recording:addMarker', { elapsedMs })
  }

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
              {markerCount > 0 && <span className="mini__mark-count">{markerCount}</span>}
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
        </>
      )}
    </div>
  )
}
