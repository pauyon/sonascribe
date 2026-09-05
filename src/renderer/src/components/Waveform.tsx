import { useEffect, useRef, useState } from 'react'

/**
 * Waveform strip with a playhead and click-to-seek.
 *
 * Drawn on a canvas from a peaks array supplied by the main process rather than
 * with wavesurfer.js: the audio is served over a custom scheme that the renderer
 * cannot fetch, so a library that loads the media itself has nothing to work
 * with. Given the peaks are already computed, drawing them is a small amount of
 * canvas code and keeps full control of theming and hit-testing.
 */
export default function Waveform({
  peaks,
  durationMs,
  positionMs,
  onSeek
}: {
  peaks: number[]
  durationMs: number
  positionMs: number
  onSeek: (ms: number) => void
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [hoverMs, setHoverMs] = useState<number | null>(null)
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
      colorsRef.current = {
        played:
          styles.getPropertyValue('--accent-strong').trim() ||
          styles.getPropertyValue('--accent').trim() ||
          '#3569ff',
        pending: styles.getPropertyValue('--border').trim() || '#2a2d3a',
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

  // Composites the cached layers plus the playhead onto the visible canvas —
  // the only work a playback tick (~4/s, via useAudio's timeupdate) actually
  // needs: two drawImage calls and one hairline fillRect, not a full re-fill
  // of every bar.
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

    // Playhead.
    if (duration > 0) {
      ctx.fillStyle = colors.text
      ctx.fillRect(Math.min(progressX, width - 1), 0, 1.5, height)
    }
  }

  // Rebuilds the bar layers on any change to data, size or theme.
  useEffect(() => {
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

      const colors = colorsRef.current
      if (peaks.length === 0 || !colors) {
        layersRef.current = null
        canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height)
        return
      }

      const mid = height / 2
      const barWidth = width / peaks.length

      const makeLayer = (color: string): HTMLCanvasElement => {
        const layer = document.createElement('canvas')
        layer.width = canvas.width
        layer.height = canvas.height
        const lctx = layer.getContext('2d')
        if (!lctx) return layer
        lctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        lctx.fillStyle = color
        for (let i = 0; i < peaks.length; i++) {
          const x = i * barWidth
          // Always leave a hairline so silence still reads as a track.
          const amplitude = Math.max(peaks[i] * (height / 2), 0.5)
          lctx.fillRect(x, mid - amplitude, Math.max(barWidth - 0.5, 0.5), amplitude * 2)
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
  }, [peaks, durationMs, colorsVersion])

  // The cheap per-tick path: just recomposite at the new position.
  useEffect(() => {
    positionRef.current = positionMs
    composite(positionMs, durationMs)
  }, [positionMs, durationMs])

  function msFromEvent(e: React.MouseEvent<HTMLDivElement>): number {
    const rect = e.currentTarget.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
    return Math.round(ratio * durationMs)
  }

  return (
    <div
      ref={wrapRef}
      className="waveform"
      onClick={(e) => onSeek(msFromEvent(e))}
      onMouseMove={(e) => setHoverMs(msFromEvent(e))}
      onMouseLeave={() => setHoverMs(null)}
      role="slider"
      aria-label="Seek through recording"
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
      {hoverMs != null && durationMs > 0 && (
        <span
          className="waveform__hover"
          style={{ left: `${(hoverMs / durationMs) * 100}%` }}
        />
      )}
    </div>
  )
}
