import { useEffect, useRef } from 'react'
import Waveform from './Waveform'

/**
 * The whole (virtual) recording at a glance, with a draggable rectangle
 * showing what the zoomed main waveform is currently showing.
 *
 * Composed from the existing `Waveform` for the background bars — reused
 * exactly as it already draws a read-only strip — plus a plain absolutely
 * positioned overlay for the viewport rectangle, a sibling rather than a
 * child of it, so dragging the rectangle never fires `Waveform`'s own
 * click-to-seek underneath it.
 */
export default function WaveformMinimap({
  peaks,
  durationMs,
  positionMs,
  seams,
  markers,
  viewportStartMs,
  viewportLengthMs,
  onViewportChange,
  onSeek
}: {
  peaks: number[]
  /** Virtual duration of the whole recording. */
  durationMs: number
  /** Overall playhead position, for the background strip's own progress line. */
  positionMs: number
  seams?: number[]
  /** Every marker's virtual position, unwindowed — the minimap always shows all of them regardless of zoom. */
  markers?: Array<{ positionMs: number; color: string }>
  viewportStartMs: number
  viewportLengthMs: number
  /** Fires while dragging the rectangle, or after a background click recenters it. */
  onViewportChange: (startMs: number) => void
  /** Also seeks real playback — a background click both jumps there and recenters. */
  onSeek?: (ms: number) => void
}): React.JSX.Element {
  const wrapRef = useRef<HTMLDivElement>(null)
  /** ms offset from the rectangle's left edge to where the drag grabbed it. */
  const dragOffsetMsRef = useRef<number | null>(null)

  function msFromClientX(clientX: number): number {
    const wrap = wrapRef.current
    if (!wrap) return 0
    const rect = wrap.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    return ratio * durationMs
  }

  function clampStart(startMs: number): number {
    return Math.max(0, Math.min(startMs, Math.max(0, durationMs - viewportLengthMs)))
  }

  function handleRectMouseDown(e: React.MouseEvent<HTMLDivElement>): void {
    dragOffsetMsRef.current = msFromClientX(e.clientX) - viewportStartMs
  }

  useEffect(() => {
    function onMove(e: MouseEvent): void {
      if (dragOffsetMsRef.current == null) return
      onViewportChange(clampStart(msFromClientX(e.clientX) - dragOffsetMsRef.current))
    }
    function onUp(): void {
      dragOffsetMsRef.current = null
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [durationMs, viewportLengthMs, onViewportChange])

  /** A click on the background (not the rectangle) both seeks and recenters the viewport there. */
  function handleBackgroundSeek(ms: number): void {
    onSeek?.(ms)
    onViewportChange(clampStart(ms - viewportLengthMs / 2))
  }

  const leftPct = durationMs > 0 ? (viewportStartMs / durationMs) * 100 : 0
  const widthPct = durationMs > 0 ? Math.min(100, (viewportLengthMs / durationMs) * 100) : 100

  return (
    <div ref={wrapRef} className="minimap">
      <Waveform
        peaks={peaks}
        durationMs={durationMs}
        positionMs={positionMs}
        onSeek={handleBackgroundSeek}
        seams={seams}
        markers={markers}
      />
      <div
        className="minimap__viewport"
        style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
        onMouseDown={handleRectMouseDown}
      />
    </div>
  )
}
