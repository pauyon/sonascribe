import type { Marker } from '@shared/types'
import MarkerRow from './MarkerRow'

/**
 * The interaction surface for markers: pins on the waveform show *where*
 * they are, this list is where you actually jump, rename, recolor, or
 * remove one — same split `CutChips` already uses for cuts. The row itself
 * (`MarkerRow`) is shared with the live Record screen's marker list.
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
          <MarkerRow
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
