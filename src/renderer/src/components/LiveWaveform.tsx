import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'

export interface LiveWaveformHandle {
  /** Appends one block's peak amplitude (0..1) as the newest bar. */
  push(peak: number): void
}

/**
 * A scrolling strip of the actual mixed signal being recorded, drawn live
 * from block peaks (see `Record.tsx`'s combined-node callback) — not the
 * fixed peaks array `Waveform.tsx` draws from a finished file, and with no
 * seek/playhead: recording only ever moves forward.
 *
 * Newest bar at the right edge, oldest falls off the left, a fixed-size ring
 * buffer rather than a resizing one — a live recording has no fixed length to
 * fit into the strip the way a finished file's waveform does.
 *
 * Drawing happens directly in `push()`, called imperatively from the block
 * callback, not through React state — redrawing a canvas ~12 times a second
 * has no business going through a render of the whole Record screen.
 */
const LiveWaveform = forwardRef<LiveWaveformHandle>(function LiveWaveform(_props, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const bufferRef = useRef<number[]>([])
  const colorRef = useRef('#3569ff')
  const sizeRef = useRef({ width: 0, height: 0, dpr: 1 })

  /** Roughly 20-25s of history at the worklet's ~85ms block cadence. */
  const CAPACITY = 240

  function draw(): void {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const { width, height, dpr } = sizeRef.current
    if (width === 0 || height === 0) return

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)

    const buffer = bufferRef.current
    const barWidth = width / CAPACITY
    const mid = height / 2
    // Right-aligned: the newest bar always sits at the right edge, empty
    // space (not yet filled, early in a recording) stays blank on the left.
    const offset = CAPACITY - buffer.length

    ctx.fillStyle = colorRef.current
    for (let i = 0; i < buffer.length; i++) {
      const x = (offset + i) * barWidth
      // Always leave a hairline so silence still reads as a live trace.
      const amplitude = Math.max(buffer[i] * mid, 1)
      ctx.fillRect(x, mid - amplitude, Math.max(barWidth - 1, 1), amplitude * 2)
    }
  }

  useImperativeHandle(
    ref,
    () => ({
      push(peak: number) {
        const buffer = bufferRef.current
        buffer.push(Math.min(1, Math.max(0, peak)))
        if (buffer.length > CAPACITY) buffer.shift()
        draw()
      }
    }),
    []
  )

  useEffect(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return

    const readColor = (): void => {
      colorRef.current =
        getComputedStyle(document.documentElement).getPropertyValue('--accent-strong').trim() ||
        '#3569ff'
    }
    readColor()

    const resize = (): void => {
      const width = wrap.clientWidth
      const height = wrap.clientHeight
      if (width === 0 || height === 0) return
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.floor(width * dpr)
      canvas.height = Math.floor(height * dpr)
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      sizeRef.current = { width, height, dpr }
      draw()
    }
    resize()

    const resizeObserver = new ResizeObserver(resize)
    resizeObserver.observe(wrap)

    const themeObserver = new MutationObserver(() => {
      readColor()
      draw()
    })
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })

    return () => {
      resizeObserver.disconnect()
      themeObserver.disconnect()
    }
  }, [])

  return (
    <div ref={wrapRef} className="live-waveform" aria-hidden="true">
      <canvas ref={canvasRef} />
    </div>
  )
})

export default LiveWaveform
