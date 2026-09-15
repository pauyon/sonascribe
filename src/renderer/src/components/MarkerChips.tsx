import { useState } from 'react'
import type { Marker } from '@shared/types'
import { formatDuration } from '../lib/format'
import { useMarkerNote } from '../lib/useMarkerNote'
import Icon from './Icon'

/**
 * One marker, one row: color swatch, ordinal, jump time, an optional label
 * (edited via the pencil icon, not by clicking the time — that used to
 * double as a label placeholder, showing the same time twice over when no
 * label was set), a note preview that expands in place, and remove. Two
 * rows per marker (a chip plus a separate note row underneath) turned into a
 * scroll-heavy list fast; this is the compressed, single-row version.
 */
function MarkerChip({
  marker,
  index,
  jumpable,
  onJump,
  onRename,
  onRecolor,
  onNote,
  onRemove
}: {
  marker: Marker
  index: number
  /** False once the marker's time falls inside a since-added cut — nowhere to jump to. */
  jumpable: boolean
  onJump: () => void
  onRename: (label: string) => void
  onRecolor: (color: string) => void
  onNote: (notes: string) => void
  onRemove: () => void
}): React.JSX.Element {
  const [editingLabel, setEditingLabel] = useState(false)
  const [labelDraft, setLabelDraft] = useState(marker.label)
  const note = useMarkerNote(marker, onNote)

  function commitLabel(): void {
    setEditingLabel(false)
    const trimmed = labelDraft.trim()
    if (trimmed !== marker.label) onRename(trimmed)
  }

  return (
    <div className="markers__item">
      <div className="markers__row">
        <input
          type="color"
          className="markers__swatch"
          value={marker.color}
          onChange={(e) => onRecolor(e.target.value)}
          aria-label={`Color for marker #${index}`}
          title="Marker color"
        />
        <span className="markers__index">#{index}</span>

        {jumpable ? (
          <button type="button" className="markers__jump" onClick={onJump} title="Jump here">
            {formatDuration(marker.timeMs)}
          </button>
        ) : (
          <span className="markers__orphaned" title="This marker's timestamp is inside a cut">
            in a cut
          </span>
        )}

        {editingLabel ? (
          <input
            className="input markers__label-input"
            value={labelDraft}
            autoFocus
            placeholder="Label…"
            onChange={(e) => setLabelDraft(e.target.value)}
            onBlur={commitLabel}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitLabel()
              if (e.key === 'Escape') {
                setLabelDraft(marker.label)
                setEditingLabel(false)
              }
            }}
          />
        ) : (
          <>
            {marker.label && <span className="markers__label">{marker.label}</span>}
            <button
              type="button"
              className="markers__rename"
              onClick={() => {
                setLabelDraft(marker.label)
                setEditingLabel(true)
              }}
              aria-label={marker.label ? 'Rename' : 'Add a label'}
              title={marker.label ? 'Rename' : 'Add a label'}
            >
              <Icon name="edit" />
            </button>
          </>
        )}

        <button
          type="button"
          className="markers__note-trigger"
          onClick={() => (note.expanded ? note.done() : note.open())}
          aria-expanded={note.expanded}
          title={note.expanded ? 'Collapse' : note.hasNote ? 'View / edit note' : 'Add a note'}
        >
          {!note.expanded &&
            (note.hasNote ? (
              <span className="marker-note__preview">{marker.notes}</span>
            ) : (
              <span className="marker-note__placeholder">Add a note…</span>
            ))}
        </button>

        <button
          type="button"
          className="markers__remove"
          onClick={onRemove}
          aria-label={`Remove marker #${index}`}
          title="Remove this marker"
        >
          <Icon name="close" />
        </button>
      </div>

      {note.expanded && (
        <div className="marker-note__panel">
          <textarea
            className="marker-note__input"
            rows={3}
            placeholder="Add a note…"
            autoFocus
            value={note.draft}
            onChange={(e) => note.onChange(e.target.value)}
            onKeyDown={note.onKeyDown}
          />
          <button type="button" className="btn btn--ghost btn--sm btn--icon marker-note__done" onClick={note.done}>
            <Icon name="check" />
            Done
          </button>
        </div>
      )}
    </div>
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
  onNote,
  onRemove,
  onClearAll
}: {
  markers: Array<Marker & { jumpable: boolean }>
  onJump: (marker: Marker) => void
  onRename: (id: string, label: string) => void
  onRecolor: (id: string, color: string) => void
  onNote: (id: string, notes: string) => void
  onRemove: (id: string) => void
  onClearAll: () => void
}): React.JSX.Element | null {
  if (markers.length === 0) return null

  return (
    <div className="markers">
      <div className="chip-section__header">
        <span className="chip-section__label">Markers</span>
        <button type="button" className="btn btn--ghost btn--sm" onClick={onClearAll}>
          Clear all
        </button>
      </div>
      <div className="markers__list">
        {markers.map((marker, i) => (
          <MarkerChip
            key={marker.id}
            marker={marker}
            index={i + 1}
            jumpable={marker.jumpable}
            onJump={() => onJump(marker)}
            onRename={(label) => onRename(marker.id, label)}
            onRecolor={(color) => onRecolor(marker.id, color)}
            onNote={(notes) => onNote(marker.id, notes)}
            onRemove={() => onRemove(marker.id)}
          />
        ))}
      </div>
    </div>
  )
}
