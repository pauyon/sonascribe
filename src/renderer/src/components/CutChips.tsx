import type { Cut } from '@shared/types'
import { formatDuration } from '../lib/format'

/**
 * The undo surface for trims: one chip per cut, labelled with its real
 * (original-file) time range so it stays meaningful no matter how the other
 * cuts have shifted the compressed waveform, each removable on its own.
 *
 * A cut region is otherwise invisible once made — the whole point of the
 * compressed timeline is that it's gone from what you see and hear — so
 * this list is the only place an existing cut can be found again.
 */
export default function CutChips({
  cuts,
  onRemove,
  onRestoreAll
}: {
  cuts: Cut[]
  onRemove: (index: number) => void
  onRestoreAll: () => void
}): React.JSX.Element | null {
  if (cuts.length === 0) return null

  return (
    <div className="cuts">
      {cuts.map((cut, i) => (
        <span className="cuts__chip" key={`${cut.startMs}-${cut.endMs}`}>
          Cut {formatDuration(cut.startMs)}–{formatDuration(cut.endMs)}
          <button
            type="button"
            className="cuts__undo"
            onClick={() => onRemove(i)}
            aria-label={`Undo cut from ${formatDuration(cut.startMs)} to ${formatDuration(cut.endMs)}`}
            title="Undo this cut"
          >
            ×
          </button>
        </span>
      ))}
      <button type="button" className="btn btn--ghost btn--sm" onClick={onRestoreAll}>
        Restore full recording
      </button>
    </div>
  )
}
