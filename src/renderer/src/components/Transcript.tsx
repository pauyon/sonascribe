import { useEffect, useMemo, useRef, useState } from 'react'
import type { Speaker, TranscriptWordSpan, Utterance } from '@shared/types'
import { formatTimestamp } from '../lib/format'
import Select from './Select'

/**
 * The transcript body: playback-synced, click-to-seek, inline-editable.
 */

/** Splits text around case-insensitive matches so hits can be marked. */
function highlight(text: string, query: string): React.ReactNode {
  if (!query) return text
  const lower = text.toLowerCase()
  const needle = query.toLowerCase()

  const nodes: React.ReactNode[] = []
  let from = 0
  for (;;) {
    const at = lower.indexOf(needle, from)
    if (at === -1) break
    if (at > from) nodes.push(text.slice(from, at))
    nodes.push(
      <mark key={`${at}-${needle}`} className="hit">
        {text.slice(at, at + needle.length)}
      </mark>
    )
    from = at + needle.length
  }
  if (from === 0) return text
  if (from < text.length) nodes.push(text.slice(from))
  return nodes
}

/** Roughly how many characters a paragraph is allowed to reach before the next sentence end splits it. */
const PARAGRAPH_TARGET_CHARS = 500

/**
 * Breaks one utterance's words into readable paragraphs, splitting only at
 * sentence ends.
 *
 * A monologue with no 2s pause stays a single utterance in the data model
 * (see merge.ts) — one speaker turn can run for minutes. Rendered as one
 * block it reads as an unbroken wall of text under a single timestamp, which
 * makes a paragraph near the end look like it happened in the same instant
 * as the one at the top. Splitting is display-only: it doesn't touch the
 * utterance, so editing/reassigning/deleting still act on the whole thing.
 */
function paragraphize(words: TranscriptWordSpan[]): TranscriptWordSpan[][] {
  const paragraphs: TranscriptWordSpan[][] = []
  let current: TranscriptWordSpan[] = []
  let currentChars = 0
  for (const word of words) {
    current.push(word)
    currentChars += word.text.length + 1
    if (/[.!?]["')\]]?$/.test(word.text) && currentChars >= PARAGRAPH_TARGET_CHARS) {
      paragraphs.push(current)
      current = []
      currentChars = 0
    }
  }
  if (current.length > 0) paragraphs.push(current)
  return paragraphs
}

export default function Transcript({
  utterances,
  speakers,
  currentMs,
  showHours,
  query,
  speakerFilter,
  follow,
  onSeek,
  onEdit,
  onReassign,
  onDelete
}: {
  utterances: Utterance[]
  speakers: Speaker[]
  currentMs: number
  showHours: boolean
  query: string
  /** Narrow the transcript to one speaker's lines, or null to show everyone. */
  speakerFilter: string | null
  /** Auto-scroll the active line into view during playback. */
  follow: boolean
  onSeek: (ms: number) => void
  onEdit: (id: string, text: string) => Promise<void>
  onReassign: (utteranceId: string, speakerId: string) => Promise<void>
  /** Removes one line — for a diarization false-positive, not a misattribution. */
  onDelete: (utteranceId: string) => void
}): React.JSX.Element {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const activeRef = useRef<HTMLDivElement>(null)

  const visible = useMemo(() => {
    let result = utterances
    if (speakerFilter) result = result.filter((u) => u.speakerId === speakerFilter)
    if (query) {
      const needle = query.toLowerCase()
      result = result.filter((u) => u.text.toLowerCase().includes(needle))
    }
    return result
  }, [utterances, query, speakerFilter])

  /**
   * Index of the line covering the playhead.
   *
   * Falls back to the last line that has started, so the highlight persists
   * through the silence between utterances rather than flickering off.
   */
  const activeId = useMemo(() => {
    let candidate: string | null = null
    for (const u of utterances) {
      if (u.startMs <= currentMs) candidate = u.id
      else break
      if (currentMs <= u.endMs) return u.id
    }
    return candidate
  }, [utterances, currentMs])

  useEffect(() => {
    if (!follow || editingId) return
    activeRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [activeId, follow, editingId])

  async function commit(id: string): Promise<void> {
    const text = draft.trim()
    setEditingId(null)
    const original = utterances.find((u) => u.id === id)
    if (!text || !original || text === original.text) return
    await onEdit(id, text)
  }

  if (visible.length === 0) {
    return (
      <div className="empty">
        <h2>{query || speakerFilter ? 'No matches' : 'No transcript yet'}</h2>
        {query && <p>Nothing in this transcript matches “{query}”.</p>}
        {!query && speakerFilter && <p>This speaker has no lines in this transcript.</p>}
      </div>
    )
  }

  return (
    <div className="transcript">
      {visible.map((u) => {
        const speaker = speakers.find((s) => s.id === u.speakerId)
        const isActive = u.id === activeId
        const isEditing = u.id === editingId
        const shaky = u.confidence != null && u.confidence < 0.5

        return (
          <div
            key={u.id}
            ref={isActive ? activeRef : undefined}
            className={isActive ? 'utterance utterance--active' : 'utterance'}
          >
            <div className="utterance__meta">
              {speakers.length > 0 ? (
                <Select
                  variant="bare"
                  value={u.speakerId ?? ''}
                  // Each option carries its own speaker's colour rather than
                  // inheriting the trigger's, so the open list reads as the
                  // same set of people as the chips above it.
                  options={[
                    ...(u.speakerId ? [] : [{ value: '', label: 'Unknown' }]),
                    ...speakers.map((s) => ({
                      value: s.id,
                      label: s.displayName,
                      color: s.color
                    }))
                  ]}
                  onChange={(id) => void onReassign(u.id, id)}
                  ariaLabel="Reassign this line to another speaker"
                  title="Reassign this line to another speaker"
                />
              ) : (
                speaker && (
                  <span className="utterance__speaker" style={{ color: speaker.color }}>
                    {speaker.displayName}
                  </span>
                )
              )}
              <button
                className="utterance__time"
                onClick={() => onSeek(u.startMs)}
                title="Jump to this moment"
              >
                {formatTimestamp(u.startMs, showHours)}
              </button>
              {u.edited && <span className="utterance__edited">edited</span>}
              {shaky && !u.edited && (
                <span className="utterance__flag" title="Low model confidence">
                  low confidence
                </span>
              )}
              <button
                type="button"
                className="utterance__delete"
                onClick={() => onDelete(u.id)}
                title="Delete this line (e.g. background noise mistaken for speech)"
                aria-label="Delete this line"
              >
                🗑
              </button>
            </div>

            {isEditing ? (
              <textarea
                className="utterance__input"
                value={draft}
                autoFocus
                rows={Math.max(2, Math.ceil(draft.length / 90))}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => void commit(u.id)}
                onKeyDown={(e) => {
                  // Enter saves; Shift+Enter inserts a newline.
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    void commit(u.id)
                  }
                  if (e.key === 'Escape') setEditingId(null)
                }}
              />
            ) : /*
                Word by word (broken into paragraphs) when the timings are
                there, and the whole line otherwise — an edited line has no
                usable word timings, and a search is asking for its matches to
                be marked rather than the playhead. Falling back keeps both
                cases correct instead of showing one of them wrongly.
              */
            u.words.length > 0 && !query ? (
              paragraphize(u.words).map((paragraph, pi) => (
                <p
                  key={pi}
                  className="utterance__text"
                  onDoubleClick={() => {
                    setEditingId(u.id)
                    setDraft(u.text)
                  }}
                  title="Double-click to edit"
                >
                  {pi > 0 && (
                    <button
                      type="button"
                      className="utterance__time utterance__time--inline"
                      onClick={() => onSeek(paragraph[0].startMs)}
                      title="Jump to this moment"
                    >
                      {formatTimestamp(paragraph[0].startMs, showHours)}
                    </button>
                  )}
                  {paragraph.map((word, i) => {
                    const spoken = currentMs >= word.startMs
                    const now = spoken && currentMs < word.endMs
                    return (
                      <span
                        key={i}
                        className={now ? 'word word--now' : spoken ? 'word word--said' : 'word'}
                        // Single click seeks; the paragraph keeps double-click
                        // for editing, so neither gets in the other's way.
                        onClick={() => onSeek(word.startMs)}
                        title={formatTimestamp(word.startMs, showHours)}
                      >
                        {word.text}{' '}
                      </span>
                    )
                  })}
                </p>
              ))
            ) : (
              <p
                className="utterance__text"
                onDoubleClick={() => {
                  setEditingId(u.id)
                  setDraft(u.text)
                }}
                title="Double-click to edit"
              >
                {highlight(u.text, query)}
              </p>
            )}
          </div>
        )
      })}
    </div>
  )
}
