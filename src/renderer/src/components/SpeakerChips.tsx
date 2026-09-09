import { useState } from 'react'
import type { Speaker, Utterance } from '@shared/types'
import OverflowMenu, { type OverflowMenuItem } from './OverflowMenu'
import Icon from './Icon'

/**
 * One chip: color swatch, editable name, line count, and an action area that
 * swaps shape depending on merge state — the "⋯" menu at rest, an "✕" to
 * back out once this chip is the merge source, or a "←" target button on
 * every other chip while a merge is in progress. Direct manipulation (arm a
 * source, click a target) reads faster than a nested "pick from a list of
 * every other speaker" flyout for what the diarizer makes a routine
 * correction — one person split across two clusters by a voice change.
 */
function SpeakerChip({
  speaker,
  count,
  canMerge,
  mergeMode,
  isMergeSource,
  onStartMerge,
  onCancelMerge,
  onPickTarget,
  onRename,
  onRecolor,
  onRemove
}: {
  speaker: Speaker
  count: number
  canMerge: boolean
  /** True once any chip has become the merge source — every other chip's action area becomes a target button while this holds. */
  mergeMode: boolean
  isMergeSource: boolean
  onStartMerge: () => void
  onCancelMerge: () => void
  onPickTarget: () => void
  onRename: (name: string) => void
  onRecolor: (color: string) => void
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

  const menuGroups: OverflowMenuItem[][] = [
    canMerge ? [{ icon: 'shuffle', label: 'Merge into…', onClick: onStartMerge }] : [],
    [{ icon: 'trash', label: 'Remove speaker', danger: true, onClick: onRemove }]
  ]

  return (
    <span
      className={isMergeSource ? 'chip chip--merging' : 'chip'}
      style={{ '--speaker': speaker.color } as React.CSSProperties}
    >
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

      <span className="chip__count">{count}</span>

      {isMergeSource ? (
        <button
          type="button"
          className="chip__action"
          onClick={onCancelMerge}
          aria-label={`Cancel merging ${speaker.displayName}`}
          title="Cancel merge"
        >
          <Icon name="close" />
        </button>
      ) : mergeMode ? (
        <button
          type="button"
          className="chip__action chip__action--target"
          onClick={onPickTarget}
          aria-label={`Merge into ${speaker.displayName}`}
          title={`Merge into ${speaker.displayName}`}
        >
          <Icon name="arrowLeft" />
        </button>
      ) : (
        <span className="chip__menu">
          <OverflowMenu groups={menuGroups} ariaLabel={`Actions for ${speaker.displayName}`} />
        </span>
      )}
    </span>
  )
}

/**
 * The interaction surface for detected speakers: rename, recolor, merge two
 * clusters that are really the same person, or remove one that turned out to
 * be a diarization artifact rather than a real speaker.
 */
export default function SpeakerChips({
  speakers,
  utterances,
  onRename,
  onRecolor,
  onMerge,
  onRemove
}: {
  speakers: Speaker[]
  utterances: Utterance[]
  onRename: (id: string, name: string) => void
  onRecolor: (id: string, color: string) => void
  onMerge: (fromId: string, intoId: string) => void
  onRemove: (id: string) => void
}): React.JSX.Element | null {
  const [mergeFrom, setMergeFrom] = useState<string | null>(null)
  const [mergeTarget, setMergeTarget] = useState<string | null>(null)

  if (speakers.length === 0) return null

  const counts = new Map<string, number>()
  for (const u of utterances) {
    if (u.speaker) counts.set(u.speaker.id, (counts.get(u.speaker.id) ?? 0) + 1)
  }

  const from = mergeFrom ? (speakers.find((s) => s.id === mergeFrom) ?? null) : null
  const into = mergeTarget ? (speakers.find((s) => s.id === mergeTarget) ?? null) : null
  const fromCount = from ? (counts.get(from.id) ?? 0) : 0

  function cancel(): void {
    setMergeFrom(null)
    setMergeTarget(null)
  }

  return (
    <div className="speakers">
      <div className="speakers__list">
        {speakers.map((speaker) => (
          <SpeakerChip
            key={speaker.id}
            speaker={speaker}
            count={counts.get(speaker.id) ?? 0}
            canMerge={speakers.length > 1}
            mergeMode={mergeFrom !== null}
            isMergeSource={speaker.id === mergeFrom}
            onStartMerge={() => setMergeFrom(speaker.id)}
            onCancelMerge={cancel}
            onPickTarget={() => setMergeTarget(speaker.id)}
            onRename={(name) => onRename(speaker.id, name)}
            onRecolor={(color) => onRecolor(speaker.id, color)}
            onRemove={() => onRemove(speaker.id)}
          />
        ))}
      </div>

      {from && !into && (
        <p className="speakers__hint">
          Merging <strong style={{ color: from.color }}>{from.displayName}</strong> — click the{' '}
          <Icon name="arrowLeft" className="speakers__hint-icon" /> on the speaker to fold it into, or{' '}
          <button type="button" className="speakers__hint-cancel" onClick={cancel}>
            cancel
          </button>
          .
        </p>
      )}

      {from && into && (
        <div className="speakers__confirm">
          <p>
            Merge <strong style={{ color: from.color }}>{from.displayName}</strong> ({fromCount} line
            {fromCount === 1 ? '' : 's'}) into <strong style={{ color: into.color }}>{into.displayName}</strong>?
            Every line credited to {from.displayName} moves to {into.displayName}, and {from.displayName} is
            removed.
          </p>
          <div className="speakers__confirm-actions">
            <button
              type="button"
              className="btn btn--danger"
              onClick={() => {
                cancel()
                onMerge(from.id, into.id)
              }}
            >
              Merge
            </button>
            <button type="button" className="btn btn--ghost" onClick={() => setMergeTarget(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
