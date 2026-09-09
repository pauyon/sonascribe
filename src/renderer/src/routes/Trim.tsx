import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import type { Cut, Marker } from '@shared/types'
import { sourceMediaUrl } from '@shared/ipc'
import { api, useEvent, useQuery } from '../lib/api'
import { useAudio } from '../lib/useAudio'
import { useCutAwarePlayback } from '../lib/useCutAwarePlayback'
import { useMarkers } from '../lib/useMarkers'
import { cutAt, realToVirtual, sliceCompressed, virtualToReal } from '../lib/cuts'
import { formatDuration } from '../lib/format'
import Waveform from '../components/Waveform'
import WaveformMinimap from '../components/WaveformMinimap'
import CutChips from '../components/CutChips'
import MarkerChips from '../components/MarkerChips'
import TimeRuler from '../components/TimeRuler'

const MIN_ZOOM = 1
const MAX_ZOOM = 40
const ZOOM_STEP = 1.5

/**
 * The dedicated editing page: cut sections out of a recording with a
 * zoomable waveform for precision. The only place cuts can be made or
 * undone — the recording-detail page (`Editor.tsx`) plays a recording back
 * respecting whatever cuts already exist, but doesn't offer to change them.
 *
 * Unlike the detail page's compact `PlayerBar`, this page drives `Waveform`
 * directly with its own toolbar (transport, tool mode, zoom) — zoom is just
 * a smaller *window* of the same compressed (virtual) data, sliced via
 * `lib/cuts.ts::sliceCompressed`.
 */
export default function Trim(): React.JSX.Element {
  const { id = '' } = useParams<{ id: string }>()
  const { data: recording, error, loading, refetch } = useQuery('recordings:get', { id })

  const [actionError, setActionError] = useState<string | null>(null)
  const [zoom, setZoom] = useState(MIN_ZOOM)
  const [viewportStartMs, setViewportStartMs] = useState(0)
  const [tool, setTool] = useState<'cut' | 'navigate'>('cut')

  const playbackSrc = recording?.sourcePath ? sourceMediaUrl(recording.id) : null
  const audio = useAudio(playbackSrc)
  const { compressed, virtualDur, virtualPosition, seekVirtual } = useCutAwarePlayback(recording, audio)
  const {
    markers,
    addMarkerAt,
    rename: renameMarker,
    recolor: recolorMarker,
    remove: removeMarker,
    clearAll: clearAllMarkers
  } = useMarkers(recording, refetch)

  const durationMs = recording?.durationMs ?? 0
  const cuts = useMemo(() => recording?.cuts ?? [], [recording?.cuts])

  const viewportLengthMs = zoom > 0 ? virtualDur / zoom : virtualDur
  const maxViewportStart = Math.max(0, virtualDur - viewportLengthMs)

  // Every marker's virtual position, unwindowed — the minimap always shows
  // all of them regardless of zoom. Markers a since-added cut has swallowed
  // are dropped here (nowhere on the compressed timeline for them to sit).
  const virtualMarkers = useMemo(
    () =>
      markers
        .filter((m) => !cutAt(m.timeMs, cuts))
        .map((m) => ({ positionMs: realToVirtual(m.timeMs, durationMs, cuts), color: m.color })),
    [markers, durationMs, cuts]
  )
  // The same markers, filtered to the current zoom viewport and rebased to
  // window-local ms — same treatment `sliceCompressed` gives the bars.
  const windowedMarkerPins = useMemo(
    () =>
      virtualMarkers
        .filter((m) => m.positionMs >= viewportStartMs && m.positionMs < viewportStartMs + viewportLengthMs)
        .map((m) => ({ positionMs: m.positionMs - viewportStartMs, color: m.color })),
    [virtualMarkers, viewportStartMs, viewportLengthMs]
  )
  const annotatedMarkers = useMemo(
    () => markers.map((m) => ({ ...m, jumpable: !cutAt(m.timeMs, cuts) })),
    [markers, cuts]
  )

  // A cut made or undone elsewhere in this same session can shrink or grow
  // the recording out from under the current viewport — keep it in range.
  // Zoom changes clamp explicitly (see applyZoom) since they also need to
  // preserve the viewport's center, which a generic re-clamp can't do.
  useEffect(() => {
    setViewportStartMs((prev) => Math.max(0, Math.min(prev, maxViewportStart)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [virtualDur])

  // Keeps the playhead in view during normal playback: once it reaches the
  // right edge of the current window, jump forward by one full window
  // rather than continuously smooth-scrolling.
  useEffect(() => {
    if (!audio.playing) return
    if (virtualPosition >= viewportStartMs + viewportLengthMs) {
      setViewportStartMs((prev) => Math.min(prev + viewportLengthMs, maxViewportStart))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [virtualPosition, audio.playing])

  useEvent('recording:updated', (updated) => {
    if (updated.id !== id) return
    refetch()
  })

  // Editor shortcuts, active whenever this page has audio loaded. Ignored
  // while a text field has focus (renaming a marker, editing the title from
  // elsewhere) so typing "c" or "v" there doesn't hijack the tool.
  useEffect(() => {
    if (!playbackSrc) return

    function isTypingTarget(target: EventTarget | null): boolean {
      if (!(target instanceof HTMLElement)) return false
      return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable
    }

    function onKeyDown(e: KeyboardEvent): void {
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return
      switch (e.key) {
        case ' ':
          e.preventDefault()
          audio.toggle()
          break
        case 'm':
        case 'M':
          addMarkerAt(audio.currentMs)
          break
        case 'c':
        case 'C':
          setTool('cut')
          break
        case 'v':
        case 'V':
          setTool('navigate')
          break
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [playbackSrc, audio, addMarkerAt])

  /** `centerMs` is absolute virtual time; omitted, it defaults to the current viewport's own midpoint (the +/-/Fit buttons' behavior). */
  function applyZoom(nextZoom: number, centerMs?: number): void {
    const clampedZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, nextZoom))
    const nextLength = virtualDur / clampedZoom
    const center = centerMs ?? viewportStartMs + viewportLengthMs / 2
    const nextStart = Math.max(0, Math.min(center - nextLength / 2, Math.max(0, virtualDur - nextLength)))
    setZoom(clampedZoom)
    setViewportStartMs(nextStart)
  }

  /** Pauses and rewinds to the start — a real editor's Stop, distinct from Pause. */
  function stop(): void {
    audio.pause()
    seekVirtual(0)
  }

  /** Incremental drag-to-pan: dragging right reveals earlier content, left reveals later — grabbing the waveform itself. */
  function panBy(deltaMs: number): void {
    setViewportStartMs((prev) => Math.max(0, Math.min(prev - deltaMs, maxViewportStart)))
  }

  /** Scroll-to-zoom in the Navigate tool, centered on the cursor rather than the viewport midpoint. */
  function zoomAt(direction: 1 | -1, windowLocalMs: number): void {
    applyZoom(direction === 1 ? zoom * ZOOM_STEP : zoom / ZOOM_STEP, viewportStartMs + windowLocalMs)
  }

  if (loading) return <div className="page">Loading…</div>
  if (error) return <div className="page banner banner--error">{error}</div>
  if (!recording) {
    return (
      <div className="page">
        <div className="empty">
          <h2>Recording not found</h2>
          <Link className="btn" to="/library">
            Back to library
          </Link>
        </div>
      </div>
    )
  }

  async function setCuts(next: Cut[]): Promise<void> {
    if (!recording) return
    setActionError(null)
    try {
      await api.invoke('recordings:setCuts', { id: recording.id, cuts: next })
      refetch()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    }
  }

  function addCut(windowStartMs: number, windowEndMs: number): void {
    void setCuts([
      ...cuts,
      {
        startMs: virtualToReal(viewportStartMs + windowStartMs, durationMs, cuts),
        endMs: virtualToReal(viewportStartMs + windowEndMs, durationMs, cuts)
      }
    ])
  }

  function removeCut(index: number): void {
    void setCuts(cuts.filter((_, i) => i !== index))
  }

  function restoreAll(): void {
    void setCuts([])
  }

  /** Seeks there and recenters the viewport — matching what clicking the minimap already does. */
  function jumpToMarker(marker: Marker): void {
    audio.seek(marker.timeMs)
    const virtualMs = realToVirtual(marker.timeMs, durationMs, cuts)
    setViewportStartMs(Math.max(0, Math.min(virtualMs - viewportLengthMs / 2, maxViewportStart)))
  }

  const windowed = sliceCompressed(compressed, virtualDur, viewportStartMs, viewportStartMs + viewportLengthMs)
  const windowedPosition = Math.max(0, Math.min(viewportLengthMs, virtualPosition - viewportStartMs))
  const seekWindowed = (windowMs: number): void => seekVirtual(viewportStartMs + windowMs)

  return (
    <div className={playbackSrc ? 'page page--has-player' : 'page'}>
      <header className="page__header">
        <div>
          <Link className="page__back" to={`/recordings/${recording.id}`}>
            ← {recording.title}
          </Link>
          <h1>Edit</h1>
          <p className="page__subtitle">
            Cut sections out of this recording. Drag across the waveform to select a
            range, then it's cut immediately — undo any cut from the list below. Zoom
            in for more precise edits. More editing tools may be added here over time.
          </p>
        </div>
      </header>

      {recording.error && <div className="banner banner--error">{recording.error}</div>}
      {actionError && <div className="banner banner--error">{actionError}</div>}

      {playbackSrc && (
        <>
          <audio ref={audio.ref} src={playbackSrc} preload="metadata" {...audio.bind} />

          <div className="trim__toolbar">
            <div className="trim__toolbar-group">
              <button
                type="button"
                className="btn btn--ghost trim__icon-btn"
                onClick={audio.play}
                disabled={audio.playing}
                aria-label="Play"
                title="Play (Space)"
              >
                ▶
              </button>
              <button
                type="button"
                className="btn btn--ghost trim__icon-btn"
                onClick={audio.pause}
                disabled={!audio.playing}
                aria-label="Pause"
                title="Pause (Space)"
              >
                ⏸
              </button>
              <button
                type="button"
                className="btn btn--ghost trim__icon-btn"
                onClick={stop}
                aria-label="Stop"
                title="Stop"
              >
                ⏹
              </button>
            </div>

            <div className="trim__toolbar-divider" />

            <div className="trim__toolbar-group">
              <button
                type="button"
                className={
                  tool === 'cut' ? 'btn btn--ghost trim__icon-btn trim__icon-btn--active' : 'btn btn--ghost trim__icon-btn'
                }
                onClick={() => setTool('cut')}
                aria-label="Cut tool: drag to select and cut a range"
                aria-pressed={tool === 'cut'}
                title="Cut tool (C)"
              >
                ✂️
              </button>
              <button
                type="button"
                className={
                  tool === 'navigate'
                    ? 'btn btn--ghost trim__icon-btn trim__icon-btn--active'
                    : 'btn btn--ghost trim__icon-btn'
                }
                onClick={() => setTool('navigate')}
                aria-label="Navigate tool: drag to scroll, scroll wheel to zoom"
                aria-pressed={tool === 'navigate'}
                title="Navigate tool (V)"
              >
                ✋
              </button>
            </div>

            <div className="trim__toolbar-divider" />

            <button
              type="button"
              className="btn btn--ghost trim__icon-btn"
              onClick={() => addMarkerAt(audio.currentMs)}
              aria-label={`Add marker at ${formatDuration(audio.currentMs)}`}
              title="Add marker (M)"
            >
              🚩
            </button>

            <div className="trim__toolbar-divider" />

            <div className="trim__toolbar-group">
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => applyZoom(zoom / ZOOM_STEP)}
                disabled={zoom <= MIN_ZOOM}
                aria-label="Zoom out"
              >
                −
              </button>
              <span className="trim__zoom-level">{zoom.toFixed(1)}×</span>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => applyZoom(zoom * ZOOM_STEP)}
                disabled={zoom >= MAX_ZOOM}
                aria-label="Zoom in"
              >
                +
              </button>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => applyZoom(MIN_ZOOM)}
                disabled={zoom === MIN_ZOOM}
              >
                Fit
              </button>
            </div>

            <span className="trim__toolbar-spacer" />

            <span className="trim__time">
              {formatDuration(windowedPosition)} / {formatDuration(viewportLengthMs)}
            </span>
          </div>

          <TimeRuler durationMs={viewportLengthMs} offsetMs={viewportStartMs} />

          <div className="trim__waveform">
            {windowed.max.length > 0 && (
              <Waveform
                peaks={windowed}
                durationMs={viewportLengthMs}
                positionMs={windowedPosition}
                onSeek={seekWindowed}
                seams={windowed.seams}
                markers={windowedMarkerPins}
                editable
                tool={tool}
                onSelectRange={addCut}
                onPan={panBy}
                onZoom={zoomAt}
              />
            )}
          </div>

          <WaveformMinimap
            peaks={compressed}
            durationMs={virtualDur}
            positionMs={virtualPosition}
            seams={compressed.seams}
            markers={virtualMarkers}
            viewportStartMs={viewportStartMs}
            viewportLengthMs={viewportLengthMs}
            onViewportChange={setViewportStartMs}
            onSeek={seekVirtual}
          />

          <CutChips cuts={cuts} onRemove={removeCut} onRestoreAll={restoreAll} />
          <MarkerChips
            markers={annotatedMarkers}
            onJump={jumpToMarker}
            onRename={renameMarker}
            onRecolor={recolorMarker}
            onRemove={removeMarker}
            onClearAll={clearAllMarkers}
          />
        </>
      )}

      {!playbackSrc && (
        <div className="empty">
          <h2>{recording.status === 'normalizing' ? 'Preparing…' : 'No audio'}</h2>
          <p>
            {recording.status === 'normalizing'
              ? 'This recording is still being prepared.'
              : 'This recording has no audio file.'}
          </p>
        </div>
      )}
    </div>
  )
}
