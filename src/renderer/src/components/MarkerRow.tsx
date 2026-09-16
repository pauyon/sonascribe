import { useState } from 'react'
import type { Marker } from '@shared/types'
import { formatDuration } from '../lib/format'
import { useMarkerNote } from '../lib/useMarkerNote'
import Icon from './Icon'

/**
 * One marker, one row: color swatch, ordinal, jump time, an optional label
 * (edited via the pencil icon, not by clicking the time — that used to
 * double as a label placeholder, showing the same time twice over when no
 * label was set), a note icon that peeks then edits in place, and remove.
 * Two rows per marker (a chip plus a separate note row underneath) turned
 * into a scroll-heavy list fast; this is the compressed, single-row
 * version — shared by the Editor rail (`MarkerChips.tsx`) and the live
 * Record screen's marker list, which don't need identical rows: `onJump`
 * is omitted live (nothing to seek to yet, so the timestamp renders as
 * plain text instead of a jump button), and `active`/`startExpanded`/
 * `onExpandedChange` (passed straight through to `useMarkerNote`) are
 * only used live, to enforce one note open at a time — the rail leaves
 * them undefined and doesn't need that.
 */
export default function MarkerRow({
  marker,
  index,
  jumpable,
  onJump,
  onRename,
  onRecolor,
  onNote,
  onRemove,
  active,
  startExpanded,
  onExpandedChange
}: {
  marker: Marker
  index: number
  /** False once the marker's time falls inside a since-added cut — nowhere to jump to. Meaningless (and ignored) when `onJump` is omitted. */
  jumpable?: boolean
  /** Omit for a context with nothing to seek to yet (the live Record screen) — renders plain time text instead of a jump button. */
  onJump?: () => void
  onRename: (label: string) => void
  onRecolor: (color: string) => void
  onNote: (notes: string) => void
  onRemove: () => void
  /** "Only one note open at a time" enforcement — see `useMarkerNote`'s own doc comment. Undefined everywhere except the live Record screen's list. */
  active?: boolean
  startExpanded?: boolean
  onExpandedChange?: (expanded: boolean) => void
}): React.JSX.Element {
  const [editingLabel, setEditingLabel] = useState(false)
  const [labelDraft, setLabelDraft] = useState(marker.label)
  const note = useMarkerNote(marker, onNote, { active, startExpanded, onExpandedChange })
  /** Read-only reveal, distinct from `note.expanded` (the actual textarea) —
      clicking the note icon peeks at an existing note first; editing it is a
      separate, deliberate step from there, not the click-to-open default. */
  const [peeking, setPeeking] = useState(false)
  /** Brief "Saved" flash when Enter saves without closing — otherwise there's
      no visible sign anything happened at all (the textarea's own content
      doesn't change, and the note stays open on purpose), which read as
      broken rather than intentional. */
  const [justSaved, setJustSaved] = useState(false)

  function commitLabel(): void {
    setEditingLabel(false)
    const trimmed = labelDraft.trim()
    if (trimmed !== marker.label) onRename(trimmed)
  }

  return (
    <div className="markers__item" style={{ '--marker-color': marker.color } as React.CSSProperties}>
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

        {onJump ? (
          jumpable ? (
            <button type="button" className="markers__jump" onClick={onJump} title="Jump here">
              {formatDuration(marker.timeMs)}
            </button>
          ) : (
            <span className="markers__orphaned" title="This marker's timestamp is inside a cut">
              in a cut
            </span>
          )
        ) : (
          <span className="markers__jump markers__jump--static">{formatDuration(marker.timeMs)}</span>
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
            {/* Always rendered, even empty — it's the row's one flex:1
                spacer (see styles.css), keeping the note icon and remove
                button consistently right-aligned whether or not a label
                is set, not just a conditional label display. */}
            <span className="markers__label">{marker.label}</span>
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

        {/* An icon, not a truncated preview — this row (especially at the
            rail's 300px width) doesn't have room to show both a label and
            a snippet of note text legibly, so the note's presence is all
            the row itself conveys. Click reveals it read-only first
            (peeking) rather than dropping straight into an editable,
            auto-focused textarea — editing is a separate, deliberate step
            from there (or a hover away via the title tooltip, for a
            shorter note that doesn't need the panel at all). */}
        <button
          type="button"
          className={[
            'markers__note-trigger',
            note.hasNote && 'markers__note-trigger--active',
            // Distinct from --active (has content): this one just means
            // "open right now" (editing or peeking), replacing the removed
            // Done button as the row's own signal that it's mid-edit.
            (note.expanded || peeking) && 'markers__note-trigger--open'
          ]
            .filter(Boolean)
            .join(' ')}
          onClick={() => {
            if (note.expanded) {
              note.done()
            } else if (peeking) {
              setPeeking(false)
            } else if (note.hasNote) {
              setPeeking(true)
            } else {
              note.open()
            }
          }}
          aria-expanded={note.expanded || peeking}
          aria-label={note.expanded ? 'Done editing note' : peeking ? 'Collapse note' : note.hasNote ? 'View note' : 'Add a note'}
          title={note.expanded ? 'Editing — click to finish' : peeking ? 'Collapse' : note.hasNote ? marker.notes : 'Add a note'}
        >
          <Icon name="note" />
        </button>

        <button
          type="button"
          className="markers__remove"
          onClick={onRemove}
          aria-label={`Remove marker #${index}`}
          title="Remove this marker"
        >
          <Icon name="trash" />
        </button>
      </div>

      {peeking && !note.expanded && (
        <div className="marker-note__panel marker-note__panel--peek">
          <p
            className="marker-note__peek-text"
            onClick={() => {
              setPeeking(false)
              note.open()
            }}
            title="Click to edit"
          >
            {marker.notes}
          </p>
        </div>
      )}

      {note.expanded && (
        <div className="marker-note__panel">
          {/* Grows with the text instead of needing a manual resize drag —
              a CSS-only trick (see styles.css): an invisible ::after mirrors
              the textarea's own value via data-value, and both share one
              grid cell, so the grid track (and the textarea inside it)
              sizes to whichever is taller. */}
          <div className="marker-note__grow" data-value={`${note.draft} `}>
            <textarea
              className="marker-note__input"
              placeholder="Add a note…"
              autoFocus
              value={note.draft}
              onChange={(e) => note.onChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  setJustSaved(true)
                  setTimeout(() => setJustSaved(false), 1200)
                  // Saves but stays open (see useMarkerNote's onKeyDown) —
                  // blurring here is what actually frees the keyboard back
                  // up afterward. Left focused, the textarea keeps eating
                  // every keystroke, which on the live Record screen meant
                  // the "m" mark-a-new-moment shortcut couldn't fire again
                  // without first clicking away by hand.
                  e.currentTarget.blur()
                }
                note.onKeyDown(e)
              }}
            />
          </div>
          {justSaved && <span className="marker-note__saved-hint">Saved</span>}
        </div>
      )}
    </div>
  )
}
