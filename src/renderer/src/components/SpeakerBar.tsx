import { useState } from 'react'
import type { Speaker, Utterance } from '@shared/types'

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
  onMerge
}: {
  speakers: Speaker[]
  utterances: Utterance[]
  /** Speaker id the transcript is narrowed to, or null to show everyone. */
  filter: string | null
  onFilterChange: (id: string | null) => void
  onRename: (id: string, name: string) => Promise<void>
  onMerge: (fromId: string, intoId: string) => Promise<void>
}): React.JSX.Element | null {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [mergeFrom, setMergeFrom] = useState<string | null>(null)

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

              <span className="chip__count">{count}</span>

              {mergeFrom === null ? (
                speakers.length > 1 && (
                  <button
                    className="chip__action"
                    onClick={() => setMergeFrom(speaker.id)}
                    title="Merge this speaker into another"
                  >
                    ⋯
                  </button>
                )
              ) : isMergeSource ? (
                <button className="chip__action" onClick={() => setMergeFrom(null)}>
                  ✕
                </button>
              ) : (
                <button
                  className="chip__action chip__action--target"
                  onClick={() => {
                    const source = mergeFrom
                    setMergeFrom(null)
                    if (source) void onMerge(source, speaker.id)
                  }}
                  title={`Merge ${from?.displayName} into ${speaker.displayName}`}
                >
                  ←
                </button>
              )}
            </div>
          )
        })}
      </div>

      {from && (
        <p className="speakers__hint">
          Merging <strong style={{ color: from.color }}>{from.displayName}</strong> — pick
          the speaker to merge into, or press ✕ to cancel.
        </p>
      )}
    </div>
  )
}
