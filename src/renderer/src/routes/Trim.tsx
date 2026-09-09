import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import type { Cut, Marker } from '@shared/types'
import { sourceMediaUrl } from '@shared/ipc'
import { api, useEvent, useQuery } from '../lib/api'
import { useAudio } from '../lib/useAudio'
import { useCutAwarePlayback } from '../lib/useCutAwarePlayback'
import { useMarkers } from '../lib/useMarkers'
import { cutAt, realToVirtual, sliceCompressed, virtualToReal } from '../lib/cuts'
import PlayerBar from '../components/PlayerBar'
import WaveformMinimap from '../components/WaveformMinimap'
import CutChips from '../components/CutChips'
import MarkerChips from '../components/MarkerChips'

const MIN_ZOOM = 1
const MAX_ZOOM = 40
const ZOOM_STEP = 1.5

/**
 * The dedicated editing page: cut sections out of a recording with a
 * zoomable waveform for precision. The only place cuts can be made or
 * undone — the recording-detail page (`Editor.tsx`) plays a recording back
 * respecting whatever cuts already exist, but doesn't offer to change them.
 *
 * Reuses `Waveform`/`PlayerBar` exactly as built for the detail page's
 * inline editor — zoom is just a smaller *window* of the same compressed
 * (virtual) data, sliced via `lib/cuts.ts::sliceCompressed`, so neither of
 * those components needed to change for this page to exist.
 */
export default function Trim(): React.JSX.Element {
  const { id = '' } = useParams<{ id: string }>()
  const { data: recording, error, loading, refetch } = useQuery('recordings:get', { id })

  const [actionError, setActionError] = useState<string | null>(null)
  const [zoom, setZoom] = useState(MIN_ZOOM)
  const [viewportStartMs, setViewportStartMs] = useState(0)

  const playbackSrc = recording?.sourcePath ? sourceMediaUrl(recording.id) : null
  const audio = useAudio(playbackSrc)
  const { compressed, virtualDur, virtualPosition, seekVirtual } = useCutAwarePlayback(recording, audio)
  const { markers, addMarkerAt, rename: renameMarker, recolor: recolorMarker, remove: removeMarker } =
    useMarkers(recording, refetch)

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

  function applyZoom(nextZoom: number): void {
    const clampedZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, nextZoom))
    const nextLength = virtualDur / clampedZoom
    const center = viewportStartMs + viewportLengthMs / 2
    const nextStart = Math.max(0, Math.min(center - nextLength / 2, Math.max(0, virtualDur - nextLength)))
    setZoom(clampedZoom)
    setViewportStartMs(nextStart)
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

          <div className="trim__player">
            <PlayerBar
              audio={audio}
              peaks={windowed.values}
              durationMs={recording.durationMs ?? 0}
              virtualDurationMs={viewportLengthMs}
              positionMs={windowedPosition}
              onSeek={seekWindowed}
              seams={windowed.seams}
              markers={windowedMarkerPins}
              editable
              onSelectRange={addCut}
            />
          </div>

          <div className="trim__actions">
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => addMarkerAt(audio.currentMs)}>
              Add marker here
            </button>
          </div>

          <div className="trim__zoom">
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

          <WaveformMinimap
            peaks={compressed.values}
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
