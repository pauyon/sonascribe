import { useEffect, useRef, useState } from 'react'
import { pickTickIntervalMs } from '../lib/cuts'
import { formatDuration } from '../lib/format'

/**
 * A thin strip of tick marks and time labels above the main waveform —
 * plain positioned elements, not a second canvas.
 *
 * `offsetMs` is added to every tick before formatting, not to `durationMs`
 * itself: on the dedicated editor page this ruler spans only the current
 * zoom *window*, but the labels should still read as the recording's real
 * elapsed time rather than restarting at 0 every time the window scrolls.
 */
export default function TimeRuler({
  durationMs,
  offsetMs = 0
}: {
  durationMs: number
  offsetMs?: number
}): React.JSX.Element {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)

  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const observer = new ResizeObserver(() => setWidth(wrap.clientWidth))
    observer.observe(wrap)
    setWidth(wrap.clientWidth)
    return () => observer.disconnect()
  }, [])

  const intervalMs = pickTickIntervalMs(durationMs, width)
  const ticks: number[] = []
  if (durationMs > 0 && intervalMs > 0) {
    for (let t = 0; t <= durationMs; t += intervalMs) ticks.push(t)
  }

  return (
    <div ref={wrapRef} className="ruler" aria-hidden="true">
      {ticks.map((t) => (
        <div key={t} className="ruler__tick" style={{ left: `${(t / durationMs) * 100}%` }}>
          <span className="ruler__label">{formatDuration(offsetMs + t)}</span>
        </div>
      ))}
    </div>
  )
}
