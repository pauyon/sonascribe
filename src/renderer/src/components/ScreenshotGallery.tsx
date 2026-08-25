import { useEffect, useState } from 'react'
import type { Screenshot } from '@shared/types'
import { screenshotMediaUrl } from '@shared/ipc'
import { formatTimestamp } from '../lib/format'

/**
 * Screenshots snapped during a recording, laid out as a strip of thumbnails
 * in playback order.
 *
 * The thumbnail opens a full-size preview; the timestamp underneath it is
 * the "jump to this moment" action, the same idiom Transcript.tsx's timestamp
 * buttons already use — the two are kept separate rather than overloading
 * one click, since "look at this" and "go there" are different intents.
 */
export default function ScreenshotGallery({
  screenshots,
  showHours,
  onSeek,
  onDelete
}: {
  screenshots: Screenshot[]
  showHours: boolean
  onSeek: (ms: number) => void
  onDelete: (id: string) => void
}): React.JSX.Element | null {
  const [previewIndex, setPreviewIndex] = useState<number | null>(null)

  // Escape closes, arrow keys step through — only while a preview is open.
  useEffect(() => {
    if (previewIndex === null) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setPreviewIndex(null)
      else if (e.key === 'ArrowRight') {
        setPreviewIndex((i) => (i === null ? i : Math.min(i + 1, screenshots.length - 1)))
      } else if (e.key === 'ArrowLeft') {
        setPreviewIndex((i) => (i === null ? i : Math.max(i - 1, 0)))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [previewIndex, screenshots.length])

  if (screenshots.length === 0) return null

  const preview = previewIndex !== null ? (screenshots[previewIndex] ?? null) : null

  return (
    <div className="shots">
      <div className="shots__head">
        <span className="shots__title">Screenshots</span>
        <span className="shots__count">
          {screenshots.length} shot{screenshots.length === 1 ? '' : 's'}
        </span>
      </div>
      <div className="shots__list">
        {screenshots.map((shot, i) => (
          <div key={shot.id} className="shots__item">
            <button
              type="button"
              className="shots__thumb"
              onClick={() => setPreviewIndex(i)}
              title="Preview"
            >
              <img src={screenshotMediaUrl(shot.id)} alt="" loading="lazy" />
            </button>
            <div className="shots__meta">
              <button
                type="button"
                className="shots__time"
                onClick={() => onSeek(shot.timestampMs)}
                title="Jump to this moment"
              >
                {formatTimestamp(shot.timestampMs, showHours)}
              </button>
              <span className="shots__display">{shot.displayLabel}</span>
            </div>
            <button
              type="button"
              className="shots__delete"
              onClick={() => onDelete(shot.id)}
              title="Delete this screenshot"
              aria-label="Delete this screenshot"
            >
              🗑
            </button>
          </div>
        ))}
      </div>

      {preview && (
        // Click on the backdrop closes; the panel stops that click reaching
        // it so clicking the image or the toolbar doesn't also close it.
        <div className="shots__lightbox" onClick={() => setPreviewIndex(null)}>
          <div className="shots__lightbox-panel" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="shots__lightbox-close"
              onClick={() => setPreviewIndex(null)}
              aria-label="Close preview"
            >
              ✕
            </button>

            {previewIndex !== null && previewIndex > 0 && (
              <button
                type="button"
                className="shots__lightbox-nav shots__lightbox-nav--prev"
                onClick={() => setPreviewIndex((i) => (i ?? 0) - 1)}
                aria-label="Previous screenshot"
              >
                ‹
              </button>
            )}
            {previewIndex !== null && previewIndex < screenshots.length - 1 && (
              <button
                type="button"
                className="shots__lightbox-nav shots__lightbox-nav--next"
                onClick={() => setPreviewIndex((i) => (i ?? 0) + 1)}
                aria-label="Next screenshot"
              >
                ›
              </button>
            )}

            <img
              className="shots__lightbox-img"
              src={screenshotMediaUrl(preview.id)}
              alt={`Screenshot at ${formatTimestamp(preview.timestampMs, showHours)}`}
            />

            <div className="shots__lightbox-bar">
              <span className="shots__lightbox-info">
                {formatTimestamp(preview.timestampMs, showHours)} · {preview.displayLabel}
              </span>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => onSeek(preview.timestampMs)}
              >
                Jump to this moment
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => {
                  onDelete(preview.id)
                  setPreviewIndex(null)
                }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
