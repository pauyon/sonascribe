import type { Marker } from '@shared/types'
import { formatDuration } from '../lib/format'
import { useMarkerNote } from '../lib/useMarkerNote'
import Icon from './Icon'

/**
 * One marker's note, collapsed to a single compact row by default — a
 * numbered flag, timestamp, and either a one-line truncated preview of the
 * note or an "Add a note…" placeholder. Clicking it expands a small editor
 * in its place; clicking "Done" (or pressing Escape to discard instead)
 * collapses it back. A standalone row, used by the main Record screen's live
 * list and the mini pop-out window's single quick-note field — `MarkerChips`
 * uses the same underlying state (`useMarkerNote`) but merges it into its
 * own row instead of rendering this component, since it already has a chip
 * to put the note next to.
 */
export default function MarkerNoteField({
  marker,
  /** 1-based position in the marker list — shown as "#N" so a collapsed row still reads as part of a sequence. */
  index,
  /** Starts expanded and focused — for the marker just added, so typing can begin immediately. */
  startExpanded,
  /** When explicitly `false` while expanded, saves and collapses this instance — see `useMarkerNote`'s doc comment for the "only one open at a time" contract this enables. */
  active,
  onExpandedChange,
  compact,
  onCommit
}: {
  marker: Marker
  index: number
  startExpanded?: boolean
  active?: boolean
  onExpandedChange?: (expanded: boolean) => void
  compact?: boolean
  onCommit: (notes: string) => void
}): React.JSX.Element {
  const note = useMarkerNote(marker, onCommit, { startExpanded, active, onExpandedChange })

  return (
    <div className={compact ? 'marker-note marker-note--compact' : 'marker-note'}>
      <button
        type="button"
        className="marker-note__trigger"
        onClick={() => (note.expanded ? note.done() : note.open())}
        aria-expanded={note.expanded}
        title={note.expanded ? 'Collapse' : note.hasNote ? 'View / edit note' : 'Add a note'}
      >
        <Icon name="flag" className="marker-note__flag" style={{ color: marker.color }} />
        <span className="marker-note__index">#{index}</span>
        <span className="marker-note__time">{formatDuration(marker.timeMs)}</span>
        {!note.expanded &&
          (note.hasNote ? (
            <span className="marker-note__preview">{marker.notes}</span>
          ) : (
            <span className="marker-note__placeholder">Add a note…</span>
          ))}
      </button>

      {note.expanded && (
        <div className="marker-note__panel">
          <textarea
            className="marker-note__input"
            rows={compact ? 2 : 3}
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
