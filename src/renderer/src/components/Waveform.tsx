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

  // Redraw on any change to data, position or size.
  useEffect(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return

    const draw = (): void => {
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

      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, width, height)

      if (peaks.length === 0) return

      const styles = getComputedStyle(document.documentElement)
      // The stronger blue rather than the brand blue: this is a graphical
      // object under WCAG 1.4.11, which asks 3:1 against the unplayed bars.
      const played =
        styles.getPropertyValue('--accent-strong').trim() ||
        styles.getPropertyValue('--accent').trim() ||
        '#3569ff'
      const pending = styles.getPropertyValue('--border').trim() || '#2a2d3a'

      const mid = height / 2
      const barWidth = width / peaks.length
      const progressX = durationMs > 0 ? (positionMs / durationMs) * width : 0

      for (let i = 0; i < peaks.length; i++) {
        const x = i * barWidth
        // Always leave a hairline so silence still reads as a track.
        const amplitude = Math.max(peaks[i] * (height / 2), 0.5)
        ctx.fillStyle = x + barWidth <= progressX ? played : pending
        ctx.fillRect(x, mid - amplitude, Math.max(barWidth - 0.5, 0.5), amplitude * 2)
      }

      // Playhead.
      if (durationMs > 0) {
        ctx.fillStyle = styles.getPropertyValue('--text').trim() || '#e8e9ef'
        ctx.fillRect(Math.min(progressX, width - 1), 0, 1.5, height)
      }
    }

    draw()

    // Redraw on resize so the waveform stays sharp when the window changes.
    const observer = new ResizeObserver(draw)
    observer.observe(wrap)
    return () => observer.disconnect()
  }, [peaks, durationMs, positionMs])

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
