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
  const { data: settings } = useQuery('settings:get')

  const [paused, setPausedState] = useState(false)
  const [elapsedMs, setElapsedMs] = useState(0)
  const [live, setLive] = useState<LiveTranscriptChunk[]>([])
  const [expanded, setExpanded] = useState(false)
  const [screenshotNotice, setScreenshotNotice] = useState<string | null>(null)
  // Bootstraps from the query once; every toggle after that arrives as a
  // recording:pauseChanged broadcast instead, from whichever window sent it.
  const appliedStatusRef = useRef(false)

  useEffect(() => {
    if (appliedStatusRef.current || !status) return
    appliedStatusRef.current = true
    setPausedState(status.paused)
  }, [status])

  useEvent('recording:pauseChanged', (payload) => setPausedState(payload.paused))
  useEvent('recording:elapsedTick', (payload) => setElapsedMs(payload.elapsedMs))
  useEvent('live:transcript', (chunk) => setLive((prev) => [...prev, chunk]))
  // The recording this window was opened for is over — nothing left to
  // control, so it closes itself rather than sitting there pointing at a
  // session that's gone. Record.tsx's own listeners for these same two
  // events are what navigate the main window and bring it forward.
  useEvent('recording:stopped', () => window.close())
  useEvent('recording:discarded', () => window.close())

  function toggleExpanded(): void {
    const next = !expanded
    setExpanded(next)
    void api.invoke('recording:resizeMiniControls', { expanded: next })
  }

  async function stop(): Promise<void> {
    try {
      await api.invoke('recording:stop')
    } catch {
      // Failure surfaces as Record.tsx's own error banner on the main
      // window, which recording:stopped never arrives to close this one
      // over — it's still here, and still usable, if that happens.
    }
  }

  async function discard(): Promise<void> {
    try {
      await api.invoke('recording:cancel')
    } catch {
      // Same as stop() above.
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
        <span className="mini__status">{paused ? 'Paused' : 'Recording'}</span>
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

          <div className="mini__controls">
            <button
              type="button"
              className="btn"
              onClick={() => void api.invoke('recording:pause', { paused: !paused })}
            >
              {paused ? 'Resume' : 'Pause'}
            </button>
            <button type="button" className="btn btn--primary" onClick={stop}>
              Stop &amp; Save
            </button>
          </div>

          <div className="mini__controls">
            <button type="button" className="btn btn--ghost" onClick={discard}>
              Discard
            </button>
            <button type="button" className="mini__disclosure" onClick={toggleExpanded}>
              {expanded ? '▾' : '▸'} Transcript
            </button>
          </div>

          <div className="mini__controls">
            <button type="button" className="btn btn--ghost" onClick={() => void snap()}>
              📷 Snap screenshot
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
