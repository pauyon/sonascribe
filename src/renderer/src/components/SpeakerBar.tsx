import { useEffect, useRef, useState } from 'react'
import type { Speaker, Utterance } from '@shared/types'
import { SPEAKER_COLORS } from '@shared/colors'

/**
 * Speaker chips: rename, merge, and a per-speaker line count.
 *
 * Merging matters more than it might look. Diarization routinely splits one
 * person across two clusters when their voice changes — leaning toward the mic
 * is enough to do it — so folding two labels together is the single most common
 * correction a user needs to make.
 */
export default function SpeakerBar({
  speakers,
  utterances,
  filter,
  onFilterChange,
  onRename,
  onMerge,
  onDelete,
  onSetColor
}: {
  speakers: Speaker[]
  utterances: Utterance[]
  /** Speaker id the transcript is narrowed to, or null to show everyone. */
  filter: string | null
  onFilterChange: (id: string | null) => void
  onRename: (id: string, name: string) => Promise<void>
  /** Folds one speaker into another, once the confirm step below is accepted. */
  onMerge: (fromId: string, intoId: string) => void
  /** Removes a speaker and every line attributed to them. */
  onDelete: (speakerId: string) => void
  /** Sets a speaker's color. Swaps with whoever already has it, so colors always stay unique. */
  onSetColor: (speakerId: string, color: string) => void
}): React.JSX.Element | null {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [mergeFrom, setMergeFrom] = useState<string | null>(null)
  /** Target picked for `mergeFrom`, awaiting the confirm/cancel step below. */
  const [mergeTarget, setMergeTarget] = useState<string | null>(null)
  /** Speaker armed for deletion, awaiting the confirm/cancel step below. */
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  /** Chip whose ⋯ menu (Merge into… / Delete speaker) is open. */
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null)
  /** Chip whose color swatch picker is open. Mutually exclusive with the ⋯ menu. */
  const [colorPickerId, setColorPickerId] = useState<string | null>(null)
  const popoverRef = useRef<HTMLDivElement>(null)

  // A popover that cannot be dismissed by clicking away is a trap.
  useEffect(() => {
    if (!menuOpenId && !colorPickerId) return
    const close = (e: MouseEvent): void => {
      if (!popoverRef.current?.contains(e.target as Node)) {
        setMenuOpenId(null)
        setColorPickerId(null)
      }
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [menuOpenId, colorPickerId])

  if (speakers.length === 0) return null

  const counts = new Map<string, number>()
  for (const u of utterances) {
    if (u.speakerId) counts.set(u.speakerId, (counts.get(u.speakerId) ?? 0) + 1)
  }

  async function commit(id: string): Promise<void> {
    const name = draft.trim()
    setEditingId(null)
    const original = speakers.find((s) => s.id === id)
    if (!name || !original || name === original.displayName) return
    await onRename(id, name)
  }

  const from = mergeFrom ? speakers.find((s) => s.id === mergeFrom) : null
  const into = mergeTarget ? speakers.find((s) => s.id === mergeTarget) : null
  const deleting = confirmDeleteId ? speakers.find((s) => s.id === confirmDeleteId) : null
  const deletingCount = deleting ? (counts.get(deleting.id) ?? 0) : 0

  return (
    <div className="speakers">
      <div className="speakers__list">
        {speakers.map((speaker) => {
          const count = counts.get(speaker.id) ?? 0
          const isMergeSource = speaker.id === mergeFrom

          const isFiltered = speaker.id === filter

          return (
            <div
              key={speaker.id}
              className={
                (isMergeSource ? 'chip chip--merging' : 'chip') +
                (isFiltered ? ' chip--filtered' : '')
              }
              // Handed to CSS as a variable rather than as a border colour, so the
              // stylesheet can derive the fill, the edge and the text from one hue
              // and stay right in both themes.
              style={{ '--speaker': speaker.color } as React.CSSProperties}
            >
              <button
                type="button"
                className="chip__dot"
                style={{ background: speaker.color }}
                onClick={() => onFilterChange(isFiltered ? null : speaker.id)}
                title={
                  isFiltered
                    ? 'Showing only this speaker — click to show everyone'
                    : `Show only ${speaker.displayName}`
                }
                aria-pressed={isFiltered}
              />

              {editingId === speaker.id ? (
                <input
                  className="chip__input"
                  value={draft}
                  autoFocus
                  size={Math.max(6, draft.length)}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => void commit(speaker.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void commit(speaker.id)
                    if (e.key === 'Escape') setEditingId(null)
                  }}
                />
              ) : (
                <button
                  className="chip__name"
                  onClick={() => {
                    setEditingId(speaker.id)
                    setDraft(speaker.displayName)
                  }}
                  title="Click to rename"
                >
                  {speaker.displayName}
                </button>
              )}

              {speaker.profileId && (
                <span className="chip__profile" title="Recognised — this app has heard this voice before">
                  ✓
                </span>
              )}

              <span className="chip__count">{count}</span>

              {/* Hidden once a merge target is picked — the confirm/cancel
                  step below takes over and a chip click here would just be
                  confusing mid-decision. */}
              {mergeTarget === null &&
                (mergeFrom === null ? (
                  <div
                    className="chip__menu"
                    ref={
                      menuOpenId === speaker.id || colorPickerId === speaker.id
                        ? popoverRef
                        : undefined
                    }
                  >
                    <button
                      type="button"
                      className="chip__action"
                      onClick={() => {
                        setColorPickerId(null)
                        setMenuOpenId(menuOpenId === speaker.id ? null : speaker.id)
                      }}
                      title="More actions"
                      aria-label={`More actions for ${speaker.displayName}`}
                      aria-haspopup="menu"
                      aria-expanded={menuOpenId === speaker.id}
                    >
                      ⋯
                    </button>
                    {menuOpenId === speaker.id && (
                      <div className="menu" role="menu">
                        {speakers.length > 1 && (
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setMenuOpenId(null)
                              setMergeFrom(speaker.id)
                            }}
                          >
                            Merge into…
                          </button>
                        )}
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setMenuOpenId(null)
                            setColorPickerId(speaker.id)
                          }}
                        >
                          Change color…
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          className="menu__danger"
                          onClick={() => {
                            setMenuOpenId(null)
                            setConfirmDeleteId(speaker.id)
                          }}
                        >
                          Delete speaker
                        </button>
                      </div>
                    )}
                    {colorPickerId === speaker.id && (
                      <div className="menu menu--colors" role="menu">
                        {SPEAKER_COLORS.map((color) => (
                          <button
                            key={color}
                            type="button"
                            className="color-swatch"
                            style={{ background: color }}
                            aria-label={`Use this color for ${speaker.displayName}`}
                            aria-pressed={color === speaker.color}
                            onClick={() => {
                              setColorPickerId(null)
                              onSetColor(speaker.id, color)
                            }}
                          >
                            {color === speaker.color ? '✓' : null}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ) : isMergeSource ? (
                  <button className="chip__action" onClick={() => setMergeFrom(null)}>
                    ✕
                  </button>
                ) : (
                  <button
                    className="chip__action chip__action--target"
                    // Arms the confirm step below rather than merging right away —
                    // this is the one editing action here that reassigns a whole
                    // speaker's lines at once, so it earns a second click.
                    onClick={() => setMergeTarget(speaker.id)}
                    title={`Merge ${from?.displayName} into ${speaker.displayName}`}
                  >
                    ←
                  </button>
                ))}
            </div>
          )
        })}
      </div>

      {from && !into && (
        <p className="speakers__hint">
          Merging <strong style={{ color: from.color }}>{from.displayName}</strong> — pick
          the speaker to merge into, or press ✕ to cancel.
        </p>
      )}

      {from && into && (
        <div className="speakers__confirm">
          <p>
            Merge <strong style={{ color: from.color }}>{from.displayName}</strong>{' '}
            ({counts.get(from.id) ?? 0} line{(counts.get(from.id) ?? 0) === 1 ? '' : 's'}) into{' '}
            <strong style={{ color: into.color }}>{into.displayName}</strong>? This can still
            be undone for a few seconds after confirming.
          </p>
          <div className="speakers__confirm-actions">
            <button
              type="button"
              className="btn btn--danger"
              onClick={() => {
                const source = mergeFrom
                const target = mergeTarget
                setMergeFrom(null)
                setMergeTarget(null)
                if (source && target) void onMerge(source, target)
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

      {deleting && (
        <div className="speakers__confirm">
          <p>
            Delete <strong style={{ color: deleting.color }}>{deleting.displayName}</strong> and{' '}
            {deletingCount} line{deletingCount === 1 ? '' : 's'}? This can still be undone for
            a few seconds after confirming.
          </p>
          <div className="speakers__confirm-actions">
            <button
              type="button"
              className="btn btn--danger"
              onClick={() => {
                const id = confirmDeleteId
                setConfirmDeleteId(null)
                if (id) onDelete(id)
              }}
            >
              Delete
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => setConfirmDeleteId(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
