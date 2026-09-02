import { useEffect, useRef, useState } from 'react'
import type { LiveTranscriptChunk } from '@shared/types'
import { api, useEvent, useQuery } from '../lib/api'
import { formatDuration } from '../lib/format'
import LiveTranscriptPanel from '../components/LiveTranscriptPanel'

/**
 * The pop-out recording controls: a small always-on-top window with the
 * full transport (pause/resume, stop & save, discard) and a collapsible
 * live transcript, so those stay reachable with the main window minimized.
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
  const { data: settings, refetch: refetchSettings } = useQuery('settings:get')
  const { data: displays } = useQuery('screenshots:listDisplays')

  const [paused, setPausedState] = useState(false)
  const [elapsedMs, setElapsedMs] = useState(0)
  const [live, setLive] = useState<LiveTranscriptChunk[]>([])
  const [expanded, setExpanded] = useState(false)
  const [showDisplays, setShowDisplays] = useState(false)
  const [screenshotNotice, setScreenshotNotice] = useState<string | null>(null)
  /**
   * True from the moment Stop or Discard is clicked — here, or in the main
   * Record window, which is why this is driven by `recording:sessionEnded`
   * rather than only this window's own click. Stopping can legitimately take
   * a while now (finishing the live transcript retries any window it never
   * got words for, which is common on a marginal mic), and until then
   * `session` in main is already gone: a second Pause/Stop/Discard sent
   * before the first finishes fails with "No recording in progress" — a real
   * error, but a confusing one when nothing on screen explained the wait.
   * This disables the transport instead of leaving it clickable through that
   * whole window.
   */
  const [finishing, setFinishing] = useState(false)
  // Bootstraps from the query once; every toggle after that arrives as a
  // recording:pauseChanged broadcast instead, from whichever window sent it.
  const appliedStatusRef = useRef(false)
  const displayPickerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (appliedStatusRef.current || !status) return
    appliedStatusRef.current = true
    setPausedState(status.paused)
  }, [status])

  useEvent('recording:pauseChanged', (payload) => setPausedState(payload.paused))
  useEvent('recording:elapsedTick', (payload) => setElapsedMs(payload.elapsedMs))
  useEvent('live:transcript', (chunk) => setLive((prev) => [...prev, chunk]))
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

  // Clicking away closes the display picker — same rule Select.tsx's own
  // dropdown follows. Shrinks the window back down too, not just the state:
  // this is the one place that closes the picker without already going
  // through toggleDisplays below.
  useEffect(() => {
    if (!showDisplays) return
    const close = (e: MouseEvent): void => {
      if (displayPickerRef.current?.contains(e.target as Node)) return
      setShowDisplays(false)
      void api.invoke('recording:resizeMiniControls', { mode: 'collapsed' })
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [showDisplays])

  // The transcript panel and the display picker are mutually exclusive —
  // each is this tiny, fixed-size window's one expanded state at a time, not
  // two heights that would need to add together. Opening one closes the other.
  function toggleExpanded(): void {
    const next = !expanded
    setExpanded(next)
    setShowDisplays(false)
    void api.invoke('recording:resizeMiniControls', { mode: next ? 'transcript' : 'collapsed' })
  }

  function toggleDisplays(): void {
    const next = !showDisplays
    setShowDisplays(next)
    setExpanded(false)
    void api.invoke('recording:resizeMiniControls', { mode: next ? 'displays' : 'collapsed' })
  }

  async function setDisplayIds(ids: string[]): Promise<void> {
    await api.invoke('settings:set', { screenshotDisplayIds: ids })
    refetchSettings()
  }

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

  async function snap(): Promise<void> {
    if (!status) return
    try {
      const shots = await api.invoke('screenshots:capture', {
        recordingId: status.recordingId,
        elapsedMs
      })
      setScreenshotNotice(
        shots.length > 1 ? `Saved (${shots.length} displays)` : 'Screenshot saved'
      )
      setTimeout(() => setScreenshotNotice(null), 2500)
    } catch (err) {
      setScreenshotNotice(err instanceof Error ? err.message : String(err))
      setTimeout(() => setScreenshotNotice(null), 2500)
    }
  }

  // Same ordering rule as Record.tsx: two tracks transcribe independently and
  // don't finish in step, so a system-audio window can land after a later
  // microphone one.
  const orderedLive = [...live].sort((a, b) => a.startMs - b.startMs)
  // Inferred rather than queried: no system-kind chunk will ever arrive if
  // system audio isn't open, so this is exactly as accurate as a dedicated
  // channel would be, for one less IPC surface.
  const monitoringSystem = live.some((c) => c.kind === 'system')

  return (
    <div className="mini">
      <div className="mini__head">
        <span className={paused ? 'mini__dot mini__dot--paused' : 'mini__dot'} aria-hidden="true" />
        <span className="mini__status">
          {finishing ? 'Finishing…' : paused ? 'Paused' : 'Recording'}
        </span>
        <button
          type="button"
          className="mini__close"
          onClick={() => window.close()}
          aria-label="Close pop-out controls"
          title="Close (the recording keeps going)"
        >
          ✕
        </button>
      </div>

      {statusLoading ? (
        <p className="mini__empty">Connecting…</p>
      ) : !status ? (
        <p className="mini__empty">No recording in progress.</p>
      ) : (
        <>
          <div className="mini__time">{formatDuration(elapsedMs)}</div>

          {/* One icon row rather than three text-button rows: icons, unlike
              "Stop & Save"/"Discard", fit six actions across 300px with room
              to spare, which is what actually let this window shrink. */}
          <div className="mini__toolbar">
            <button
              type="button"
              className="btn mini__icon-btn"
              onClick={() => void api.invoke('recording:pause', { paused: !paused })}
              disabled={finishing}
              title={paused ? 'Resume' : 'Pause'}
              aria-label={paused ? 'Resume' : 'Pause'}
            >
              {paused ? '▶' : '⏸'}
            </button>
            <button
              type="button"
              className="btn btn--primary mini__icon-btn"
              onClick={stop}
              disabled={finishing}
              title="Stop & save"
              aria-label="Stop and save"
            >
              ⏹
            </button>
            <button
              type="button"
              className="btn btn--ghost mini__icon-btn"
              onClick={discard}
              disabled={finishing}
              title="Discard (delete this recording)"
              aria-label="Discard this recording"
            >
              🗑
            </button>
            {displays && displays.length > 1 && (
              <div className="mini__display-picker" ref={displayPickerRef}>
                <button
                  type="button"
                  className={
                    showDisplays ? 'btn btn--ghost mini__icon-btn mini__icon-btn--active' : 'btn btn--ghost mini__icon-btn'
                  }
                  onClick={toggleDisplays}
                  title="Choose which screen(s) a snap captures"
                  aria-label="Choose which screens a snap captures"
                  aria-expanded={showDisplays}
                >
                  🖥️
                </button>
                {showDisplays && (
                  <div className="mini__display-popover">
                    {(() => {
                      const selectedIds = settings?.screenshotDisplayIds ?? []
                      const allSelected = selectedIds.length === 0
                      return (
                        <>
                          <label className="toolbar__toggle">
                            <input
                              type="checkbox"
                              checked={allSelected}
                              onChange={() => void setDisplayIds([])}
                            />
                            All displays
                          </label>
                          {displays.map((d) => (
                            <label key={d.id} className="toolbar__toggle">
                              <input
                                type="checkbox"
                                checked={!allSelected && selectedIds.includes(d.id)}
                                onChange={(e) => {
                                  const next = e.target.checked
                                    ? [...selectedIds, d.id]
                                    : selectedIds.filter((id) => id !== d.id)
                                  void setDisplayIds(next)
                                }}
                              />
                              {d.name}
                            </label>
                          ))}
                        </>
                      )
                    })()}
                  </div>
                )}
              </div>
            )}
            <button
              type="button"
              className="btn btn--ghost mini__icon-btn"
              onClick={() => void snap()}
              disabled={finishing}
              title="Snap screenshot"
              aria-label="Snap screenshot"
            >
              📷
            </button>
            <button
              type="button"
              className={
                expanded ? 'btn btn--ghost mini__icon-btn mini__icon-btn--active' : 'btn btn--ghost mini__icon-btn'
              }
              onClick={toggleExpanded}
              title={expanded ? 'Hide live transcript' : 'Show live transcript'}
              aria-label={expanded ? 'Hide live transcript' : 'Show live transcript'}
              aria-expanded={expanded}
            >
              📝
            </button>
          </div>

          {screenshotNotice && <p className="mini__notice">{screenshotNotice}</p>}

          {expanded && (
            <div className="mini__transcript">
              <LiveTranscriptPanel
                chunks={orderedLive}
                monitoringSystem={monitoringSystem}
                micLabel={settings?.micSoloSpeaker ? 'You' : 'Mic'}
              />
            </div>
          )}
        </>
      )}
    </div>
  )
}
