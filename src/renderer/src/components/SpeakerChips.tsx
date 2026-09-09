import { useState } from 'react'
import type { Speaker } from '@shared/types'
import OverflowMenu, { type OverflowMenuItem } from './OverflowMenu'

/** One chip: color swatch, editable name, a "⋯" for merge/remove. */
function SpeakerChip({
  speaker,
  otherSpeakers,
  onRename,
  onRecolor,
  onMergeInto,
  onRemove
}: {
  speaker: Speaker
  otherSpeakers: Speaker[]
  onRename: (name: string) => void
  onRecolor: (color: string) => void
  onMergeInto: (intoId: string) => void
  onRemove: () => void
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(speaker.displayName)

  function commit(): void {
    setEditing(false)
    const trimmed = draft.trim()
    if (trimmed && trimmed !== speaker.displayName) onRename(trimmed)
    else setDraft(speaker.displayName)
  }

  // "Merge into…" collapses every target speaker into one flyout row rather
  // than a row per speaker, then remove trails below a divider — same
  // "related actions grouped, destructive one trails" shape as the
  // recording-page menu.
  const menuGroups: OverflowMenuItem[][] = [
    otherSpeakers.length > 0
      ? [
          {
            icon: 'shuffle',
            label: 'Merge into…',
            children: otherSpeakers.map((s) => ({ label: s.displayName, onClick: () => onMergeInto(s.id) }))
          }
        ]
      : [],
    [{ icon: 'trash', label: 'Remove speaker', danger: true, onClick: onRemove }]
  ]

  return (
    <span className="chip">
      <input
        type="color"
        className="speakers__swatch"
        value={speaker.color}
        onChange={(e) => onRecolor(e.target.value)}
        aria-label={`Color for ${speaker.displayName}`}
        title="Speaker color"
      />
      {editing ? (
        <input
          className="chip__input"
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape') {
              setDraft(speaker.displayName)
              setEditing(false)
            }
          }}
        />
      ) : (
        <button
          type="button"
          className="chip__name"
          onClick={() => {
            setDraft(speaker.displayName)
            setEditing(true)
          }}
          title="Click to rename"
        >
          {speaker.displayName}
        </button>
      )}

      <span className="chip__menu">
        <OverflowMenu groups={menuGroups} ariaLabel={`Actions for ${speaker.displayName}`} />
      </span>
    </span>
  )
}

/**
 * The interaction surface for detected speakers: rename, recolor, merge two
 * clusters that are really the same person, or remove one that turned out
 * to be a diarization artifact rather than a real speaker.
 */
export default function SpeakerChips({
  speakers,
  onRename,
  onRecolor,
  onMerge,
  onRemove
}: {
  speakers: Speaker[]
  onRename: (id: string, name: string) => void
  onRecolor: (id: string, color: string) => void
  onMerge: (fromId: string, intoId: string) => void
  onRemove: (id: string) => void
}): React.JSX.Element | null {
  if (speakers.length === 0) return null

  return (
    <div className="speakers">
      <div className="speakers__list">
        {speakers.map((speaker) => (
          <SpeakerChip
            key={speaker.id}
            speaker={speaker}
            otherSpeakers={speakers.filter((s) => s.id !== speaker.id)}
            onRename={(name) => onRename(speaker.id, name)}
            onRecolor={(color) => onRecolor(speaker.id, color)}
            onMergeInto={(intoId) => onMerge(speaker.id, intoId)}
            onRemove={() => onRemove(speaker.id)}
          />
        ))}
      </div>
    </div>
  )
}
