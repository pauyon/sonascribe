import { useEffect, useRef, useState } from 'react'
import type { PeakBuckets } from '../lib/cuts'

/**
 * Waveform strip with a playhead and click-to-seek.
 *
 * Drawn on a canvas from peaks supplied by the main process rather than with
 * wavesurfer.js: the audio is served over a custom scheme that the renderer
 * cannot fetch, so a library that loads the media itself has nothing to work
 * with. Given the peaks are already computed, drawing them is a small amount
 * of canvas code and keeps full control of theming and hit-testing. Each bar
 * is drawn from the real signed min/max sample in that bucket — the actual
 * (usually asymmetric) waveform envelope, not a magnitude reflected
 * symmetrically around the center line.
 *
 * Unit-agnostic on purpose: `durationMs`/`positionMs`/`onSeek` are always in
 * whatever unit the caller passes — usually real (original-file)
 * milliseconds, but the recording-detail page's trim editor feeds it
 * *virtual* (cuts-compressed) milliseconds instead and this component has no
 * idea, and doesn't need to (see `lib/cuts.ts`).
 */
export default function Waveform({
  peaks,
  durationMs,
  positionMs,
  onSeek,
  seams,
  markers,
  editable = false,
  tool = 'cut',
  onSelectRange,
  onPan,
  onZoom
}: {
  peaks: PeakBuckets
  durationMs: number
  positionMs: number
  onSeek: (ms: number) => void
  /** Virtual-ms positions of a seam between two kept regions — a cut happened here. */
  seams?: number[]
  /** Colored jump-to pins, same units as `durationMs`. Visual only — jumping happens through a chip list, not by clicking the pin. */
  markers?: Array<{ positionMs: number; color: string }>
  /** Enables dragging (for cutting or panning, per `tool`) instead of click-only seeking. */
  editable?: boolean
  /**
   * Only meaningful when `editable`. `'cut'` (default): drag selects a range
   * to cut, exactly as before. `'navigate'`: drag pans the view instead
   * (`onPan`) and the scroll wheel zooms (`onZoom`) — a plain click still
   * seeks in either tool.
   */
  tool?: 'cut' | 'navigate'
  /** Fires on drag-release with the selected range, same units as `durationMs`. Cut tool only. */
  onSelectRange?: (startMs: number, endMs: number) => void
  /** Fires per mouse-move while dragging in the navigate tool, with the incremental ms delta since the last event. */
  onPan?: (deltaMs: number) => void
  /** Fires on scroll in the navigate tool, with a zoom direction and the cursor's position (same units as `durationMs`). */
  onZoom?: (direction: 1 | -1, atMs: number) => void
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [hoverMs, setHoverMs] = useState<number | null>(null)
  const [selection, setSelection] = useState<{ startMs: number; endMs: number } | null>(null)
  // Read once and again only on an actual theme change, not on every draw:
  // during playback this component redraws ~4 times a second (see the
  // positionMs effect below), and getComputedStyle forces a synchronous
  // style recalculation — real cost to pay every tick for three colors that
  // are static almost all of the time.
  const [colorsVersion, setColorsVersion] = useState(0)
  const colorsRef = useRef<{ played: string; pending: string; text: string } | null>(null)

  useEffect(() => {
    const readColors = (): void => {
      const styles = getComputedStyle(document.documentElement)
      // The stronger blue rather than the brand blue: this is a graphical
      // object under WCAG 1.4.11, which asks 3:1 against the unplayed bars.
      // Unplayed bars use --border-strong, not --border: the waveform's own
      // panel background is --bg-hover, and --border sits too close to it in
      // both themes to read as a bar at all once drawn on top of it.
      colorsRef.current = {
        played:
          styles.getPropertyValue('--accent-strong').trim() ||
          styles.getPropertyValue('--accent').trim() ||
          '#3569ff',
        pending: styles.getPropertyValue('--border-strong').trim() || '#566c91',
        text: styles.getPropertyValue('--text').trim() || '#e8e9ef'
      }
      setColorsVersion((v) => v + 1)
    }
    readColors()

    const observer = new MutationObserver(readColors)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])

  // The two static bar layers — one drawn entirely in "played," one entirely
  // in "pending" — cached offscreen so a playback tick never has to refill up
  // to DEFAULT_BUCKETS (peaks.ts) bars from scratch. Rebuilt only when what
  // they'd draw could actually differ: the data, the box size, or the theme.
  const layersRef = useRef<{
    played: HTMLCanvasElement
    pending: HTMLCanvasElement
    width: number
    height: number
    dpr: number
  } | null>(null)
  // So a size/data/theme rebuild can repaint at the position play was already
  // at, without positionMs needing to be a dependency of that effect.
  const positionRef = useRef(positionMs)
  const seamsRef = useRef<number[]>(seams ?? [])
  const markersRef = useRef<Array<{ positionMs: number; color: string }>>(markers ?? [])

  // Composites the cached layers plus the playhead and any seam markers onto
  // the visible canvas — the only work a playback tick (~4/s, via useAudio's
  // timeupdate) actually needs: two drawImage calls, a hairline fillRect and
  // a handful of dashed lines, not a full re-fill of every bar.
  function composite(pos: number, duration: number): void {
    const canvas = canvasRef.current
    const layers = layersRef.current
    const colors = colorsRef.current
    if (!canvas || !layers || !colors) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const { width, height, dpr } = layers
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)

    // Amplitude gridlines, drawn under the bars so they only show through
    // gaps and quiet stretches — the center (zero) line a touch more visible
    // than the +0.5/-0.5 reference lines above and below it.
    const mid = height / 2
    ctx.save()
    ctx.strokeStyle = colors.text
    ctx.lineWidth = 1
    ctx.globalAlpha = 0.08
    ctx.beginPath()
    ctx.moveTo(0, mid / 2)
    ctx.lineTo(width, mid / 2)
    ctx.moveTo(0, mid + mid / 2)
    ctx.lineTo(width, mid + mid / 2)
    ctx.stroke()
    ctx.globalAlpha = 0.16
    ctx.beginPath()
    ctx.moveTo(0, mid)
    ctx.lineTo(width, mid)
    ctx.stroke()
    ctx.restore()

    ctx.drawImage(layers.pending, 0, 0, width * dpr, height * dpr, 0, 0, width, height)

    const progressX = duration > 0 ? (pos / duration) * width : 0
    const playedWidth = Math.min(width, Math.max(0, progressX))
    if (playedWidth > 0) {
      ctx.drawImage(
        layers.played,
        0,
        0,
        playedWidth * dpr,
        height * dpr,
        0,
        0,
        playedWidth,
        height
      )
    }

    // Seam markers: where a cut collapsed the timeline together.
    if (duration > 0 && seamsRef.current.length > 0) {
      ctx.save()
      ctx.strokeStyle = colors.text
      ctx.globalAlpha = 0.35
      ctx.setLineDash([3, 3])
      ctx.lineWidth = 1
      for (const seamMs of seamsRef.current) {
        const x = (seamMs / duration) * width
        ctx.beginPath()
        ctx.moveTo(x, 0)
        ctx.lineTo(x, height)
        ctx.stroke()
      }
      ctx.restore()
    }

    // Marker pins: a colored flag at the top plus a thin full-height line so
    // it's still findable once the flag itself scrolls out at small sizes.
    if (duration > 0 && markersRef.current.length > 0) {
      const FLAG_SIZE = 5
      for (const marker of markersRef.current) {
        const x = (marker.positionMs / duration) * width
        ctx.save()
        ctx.strokeStyle = marker.color
        ctx.globalAlpha = 0.45
        ctx.lineWidth = 1.5
        ctx.beginPath()
        ctx.moveTo(x, 0)
        ctx.lineTo(x, height)
        ctx.stroke()
        ctx.restore()

        ctx.fillStyle = marker.color
        ctx.beginPath()
        ctx.moveTo(x, 0)
        ctx.lineTo(x + FLAG_SIZE, FLAG_SIZE)
        ctx.lineTo(x, FLAG_SIZE * 2)
        ctx.closePath()
        ctx.fill()
      }
    }

    // Playhead.
    if (duration > 0) {
      ctx.fillStyle = colors.text
      ctx.fillRect(Math.min(progressX, width - 1), 0, 1.5, height)
    }
  }

  // Rebuilds the bar layers on any change to data, size, theme or seams.
  useEffect(() => {
    seamsRef.current = seams ?? []
    markersRef.current = markers ?? []
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return

    const rebuild = (): void => {
      const width = wrap.clientWidth
      const height = wrap.clientHeight
      if (width === 0 || height === 0) return

      // Match the backing store to the device pixel ratio, or the waveform is
      // blurry on any HiDPI display.
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.floor(width * dpr)
      canvas.height = Math.floor(height * dpr)
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`

      const bucketCount = peaks.max.length
      const colors = colorsRef.current
      if (bucketCount === 0 || !colors) {
        layersRef.current = null
        canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height)
        return
      }

      const mid = height / 2
      const barWidth = width / bucketCount

      const makeLayer = (color: string): HTMLCanvasElement => {
        const layer = document.createElement('canvas')
        layer.width = canvas.width
        layer.height = canvas.height
        const lctx = layer.getContext('2d')
        if (!lctx) return layer
        lctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        lctx.fillStyle = color
        for (let i = 0; i < bucketCount; i++) {
          const x = i * barWidth
          // The real signed envelope — usually asymmetric, unlike a plain
          // magnitude reflected the same amount above and below center.
          let top = mid - peaks.max[i] * mid
          let bottom = mid - peaks.min[i] * mid
          // Always leave a hairline so silence still reads as a track.
          if (bottom - top < 1) {
            top = mid - 0.5
            bottom = mid + 0.5
          }
          lctx.fillRect(x, top, Math.max(barWidth - 0.5, 0.5), bottom - top)
        }
        return layer
      }

      layersRef.current = {
        played: makeLayer(colors.played),
        pending: makeLayer(colors.pending),
        width,
        height,
        dpr
      }

      composite(positionRef.current, durationMs)
    }

    rebuild()

    // Rebuild on resize so the waveform stays sharp when the window changes.
    const observer = new ResizeObserver(rebuild)
    observer.observe(wrap)
    return () => observer.disconnect()
  }, [peaks, durationMs, colorsVersion, seams, markers])

  // The cheap per-tick path: just recomposite at the new position.
  useEffect(() => {
    positionRef.current = positionMs
    composite(positionMs, durationMs)
  }, [positionMs, durationMs])

  function msFromClientX(clientX: number): number {
    const wrap = wrapRef.current
    if (!wrap) return 0
    const rect = wrap.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    return Math.round(ratio * durationMs)
  }

  function msFromEvent(e: React.MouseEvent<HTMLDivElement>): number {
    return msFromClientX(e.clientX)
  }

  /**
   * Drag-to-select (cut tool) or drag-to-pan (navigate tool), active only
   * when `editable`. A plain click (negligible movement) always still
   * seeks, in either tool — distinguished from a real drag by a small
   * ms-distance threshold, not by a separate gesture, so there's nothing
   * extra for the user to learn.
   *
   * Tracked via window-level listeners (not React's onMouseMove/onMouseUp on
   * the div) so a drag that leaves the strip mid-gesture — normal mouse
   * behavior — still resolves correctly instead of getting stuck.
   */
  const dragStartMsRef = useRef<number | null>(null)
  const lastPanMsRef = useRef<number | null>(null)
  const draggedRef = useRef(false)
  /** Below this, a drag reads as a click instead of a selection/pan. */
  const DRAG_THRESHOLD_MS = 60

  useEffect(() => {
    if (!editable) return

    function onMove(e: MouseEvent): void {
      const startMs = dragStartMsRef.current
      if (startMs == null) return
      const currentMs = msFromClientX(e.clientX)

      if (tool === 'navigate') {
        if (Math.abs(currentMs - startMs) > DRAG_THRESHOLD_MS) draggedRef.current = true
        if (draggedRef.current && lastPanMsRef.current != null) {
          onPan?.(currentMs - lastPanMsRef.current)
        }
        lastPanMsRef.current = currentMs
        return
      }

      if (Math.abs(currentMs - startMs) > DRAG_THRESHOLD_MS) draggedRef.current = true
      if (draggedRef.current) {
        setSelection({ startMs: Math.min(startMs, currentMs), endMs: Math.max(startMs, currentMs) })
      }
    }

    function onUp(e: MouseEvent): void {
      const startMs = dragStartMsRef.current
      dragStartMsRef.current = null
      lastPanMsRef.current = null
      if (startMs == null) return

      if (tool === 'navigate') {
        if (!draggedRef.current) onSeek(startMs)
        draggedRef.current = false
        return
      }

      if (draggedRef.current) {
        const currentMs = msFromClientX(e.clientX)
        setSelection(null)
        onSelectRange?.(Math.min(startMs, currentMs), Math.max(startMs, currentMs))
      } else {
        onSeek(startMs)
      }
      draggedRef.current = false
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editable, tool, onSelectRange, onPan, onSeek, durationMs])

  function handleMouseDown(e: React.MouseEvent<HTMLDivElement>): void {
    if (!editable) return
    const ms = msFromEvent(e)
    dragStartMsRef.current = ms
    lastPanMsRef.current = ms
    draggedRef.current = false
  }

  function handleWheel(e: React.WheelEvent<HTMLDivElement>): void {
    if (!editable || tool !== 'navigate' || !onZoom) return
    e.preventDefault()
    onZoom(e.deltaY < 0 ? 1 : -1, msFromEvent(e))
  }

  return (
    <div
      ref={wrapRef}
      className={
        editable ? `waveform waveform--${tool === 'navigate' ? 'navigate' : 'editable'}` : 'waveform'
      }
      onClick={editable ? undefined : (e) => onSeek(msFromEvent(e))}
      onMouseDown={editable ? handleMouseDown : undefined}
      onMouseMove={(e) => setHoverMs(msFromEvent(e))}
      onMouseLeave={() => setHoverMs(null)}
      onWheel={editable && tool === 'navigate' ? handleWheel : undefined}
      role="slider"
      aria-label={
        editable
          ? tool === 'navigate'
            ? 'Drag to scroll, scroll wheel to zoom, or click to seek'
            : 'Select a range to cut, or click to seek'
          : 'Seek through recording'
      }
      aria-valuemin={0}
      aria-valuemax={durationMs}
      aria-valuenow={positionMs}
      tabIndex={0}
      onKeyDown={(e) => {
        // Arrow keys nudge, so seeking is reachable without a mouse.
        if (e.key === 'ArrowLeft') onSeek(Math.max(0, positionMs - 5000))
        if (e.key === 'ArrowRight') onSeek(Math.min(durationMs, positionMs + 5000))
      }}
    >
      <canvas ref={canvasRef} />
      {selection && durationMs > 0 && (
        <span
          className="waveform__selection"
          style={{
            left: `${(selection.startMs / durationMs) * 100}%`,
            width: `${((selection.endMs - selection.startMs) / durationMs) * 100}%`
          }}
        />
      )}
      {!selection && hoverMs != null && durationMs > 0 && (
        <span
          className="waveform__hover"
          style={{ left: `${(hoverMs / durationMs) * 100}%` }}
        />
      )}
    </div>
  )
}
