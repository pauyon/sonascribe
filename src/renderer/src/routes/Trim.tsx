import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import type { Cut } from '@shared/types'
import { sourceMediaUrl } from '@shared/ipc'
import { api, useEvent, useQuery } from '../lib/api'
import { useAudio } from '../lib/useAudio'
import { useCutAwarePlayback } from '../lib/useCutAwarePlayback'
import { sliceCompressed, virtualToReal } from '../lib/cuts'
import PlayerBar from '../components/PlayerBar'
import WaveformMinimap from '../components/WaveformMinimap'
import CutChips from '../components/CutChips'

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

  const durationMs = recording?.durationMs ?? 0
  const cuts = useMemo(() => recording?.cuts ?? [], [recording?.cuts])

  const viewportLengthMs = zoom > 0 ? virtualDur / zoom : virtualDur
  const maxViewportStart = Math.max(0, virtualDur - viewportLengthMs)

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
              editable
              onSelectRange={addCut}
            />
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
            viewportStartMs={viewportStartMs}
            viewportLengthMs={viewportLengthMs}
            onViewportChange={setViewportStartMs}
            onSeek={seekVirtual}
          />

          <CutChips cuts={cuts} onRemove={removeCut} onRestoreAll={restoreAll} />
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
