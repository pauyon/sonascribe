import { useState } from 'react'
import type { Marker } from '@shared/types'
import { formatDuration } from '../lib/format'

/** One chip: color swatch, editable label, timestamp, jump/remove. */
function MarkerChip({
  marker,
  jumpable,
  onJump,
  onRename,
  onRecolor,
  onRemove
}: {
  marker: Marker
  /** False once the marker's time falls inside a since-added cut — nowhere to jump to. */
  jumpable: boolean
  onJump: () => void
  onRename: (label: string) => void
  onRecolor: (color: string) => void
  onRemove: () => void
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(marker.label)

  function commit(): void {
    setEditing(false)
    const trimmed = draft.trim()
    if (trimmed !== marker.label) onRename(trimmed)
  }

  return (
    <span className="markers__chip">
      <input
        type="color"
        className="markers__swatch"
        value={marker.color}
        onChange={(e) => onRecolor(e.target.value)}
        aria-label={`Color for marker ${marker.label || formatDuration(marker.timeMs)}`}
        title="Marker color"
      />
      {editing ? (
        <input
          className="input markers__label-input"
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape') {
              setDraft(marker.label)
              setEditing(false)
            }
          }}
        />
      ) : (
        <button
          type="button"
          className="markers__label"
          onClick={() => {
            setDraft(marker.label)
            setEditing(true)
          }}
          title="Click to rename"
        >
          {marker.label || formatDuration(marker.timeMs)}
        </button>
      )}

      {jumpable ? (
        <button type="button" className="markers__jump" onClick={onJump} title="Jump here">
          {formatDuration(marker.timeMs)}
        </button>
      ) : (
        <span className="markers__orphaned" title="This marker's timestamp is inside a cut">
          in a cut
        </span>
      )}

      <button
        type="button"
        className="markers__remove"
        onClick={onRemove}
        aria-label={`Remove marker ${marker.label || formatDuration(marker.timeMs)}`}
        title="Remove this marker"
      >
        ×
      </button>
    </span>
  )
}

/**
 * The interaction surface for markers: pins on the waveform show *where*
 * they are, this list is where you actually jump, rename, recolor, or
 * remove one — same split `CutChips` already uses for cuts.
 */
export default function MarkerChips({
  markers,
  onJump,
  onRename,
  onRecolor,
  onRemove,
  onClearAll
}: {
  markers: Array<Marker & { jumpable: boolean }>
  onJump: (marker: Marker) => void
  onRename: (id: string, label: string) => void
  onRecolor: (id: string, color: string) => void
  onRemove: (id: string) => void
  onClearAll: () => void
}): React.JSX.Element | null {
  if (markers.length === 0) return null

  return (
    <div className="markers">
      {markers.map((marker) => (
        <MarkerChip
          key={marker.id}
          marker={marker}
          jumpable={marker.jumpable}
          onJump={() => onJump(marker)}
          onRename={(label) => onRename(marker.id, label)}
          onRecolor={(color) => onRecolor(marker.id, color)}
          onRemove={() => onRemove(marker.id)}
        />
      ))}
      <button type="button" className="btn btn--ghost btn--sm" onClick={onClearAll}>
        Clear all markers
      </button>
    </div>
  )
}
