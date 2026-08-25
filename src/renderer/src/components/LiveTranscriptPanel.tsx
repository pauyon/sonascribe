import { useEffect, useRef } from 'react'
import type { LiveTranscriptChunk } from '@shared/types'
import { formatDuration } from '../lib/format'

/**
 * The "Transcript so far" panel shown while a recording is running.
 *
 * Shared between the Record screen and the mini pop-out controls window —
 * both listen to the same `live:transcript` broadcast and just render
 * whatever chunks they've accumulated.
 */
export default function LiveTranscriptPanel({
  chunks,
  monitoringSystem,
  micLabel
}: {
  /** Ordered by when the audio was spoken, not by when transcription finished it. */
  chunks: LiveTranscriptChunk[]
  /** Whether a system-audio track is open — kind tags are pointless with only one source. */
  monitoringSystem: boolean
  /** What to call the mic track: "You" for a call, "Mic" otherwise. */
  micLabel: string
}): React.JSX.Element {
  const bodyRef = useRef<HTMLDivElement>(null)
  // Only auto-scrolls while the user is already at the bottom, so scrolling up
  // to reread an earlier line does not get yanked back down by the next chunk.
  const stickToBottomRef = useRef(true)

  // Keeps the newest line in view as it's typed out, the way a chat log does —
  // otherwise the scrollable transcript stays pinned to its first lines and
  // visibly falls behind the recording.
  useEffect(() => {
    if (!stickToBottomRef.current) return
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [chunks])

  return (
    <div className="live">
      <div className="live__head">
        <span className="live__title">Transcript so far</span>
        <span className="live__count">
          {chunks.length === 0
            ? 'listening…'
            : `${chunks.reduce((n, c) => n + c.text.split(/\s+/).filter(Boolean).length, 0)} words`}
        </span>
      </div>
      {chunks.length === 0 ? (
        <p className="live__empty">
          Text appears about fifteen seconds behind the audio — it is transcribed in short
          windows as you speak, so there is nothing left to wait for when you stop.
        </p>
      ) : (
        <div
          className="live__body"
          ref={bodyRef}
          onScroll={(e) => {
            const el = e.currentTarget
            stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
          }}
        >
          {chunks.map((chunk) => (
            <p key={`${chunk.kind}-${chunk.startMs}`} className="live__line">
              <span className="live__at">{formatDuration(chunk.startMs)}</span>
              {monitoringSystem && (
                <span className={`live__kind live__kind--${chunk.kind}`}>
                  {chunk.kind === 'mic' ? micLabel : 'System'}
                </span>
              )}
              {chunk.text}
            </p>
          ))}
        </div>
      )}
    </div>
  )
}
