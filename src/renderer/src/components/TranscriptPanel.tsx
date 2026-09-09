import { useEffect, useMemo, useRef, useState } from 'react'
import type { Marker, Speaker, TranscriptWord, Utterance } from '@shared/types'
import { formatDuration } from '../lib/format'
import Select from './Select'
import Icon from './Icon'

/** The first marker landing in `[startMs, endMs)`, if any — used to flag a timestamp that has one nearby. */
function markerIn(markers: Marker[], startMs: number, endMs: number): Marker | undefined {
  return markers.find((m) => m.timeMs >= startMs && m.timeMs < endMs)
}

/** Splits `text` around every case-insensitive occurrence of `query`, wrapping matches in a highlight span. */
function highlightText(text: string, query: string): React.ReactNode {
  if (!query) return text
  const lower = text.toLowerCase()
  const parts: React.ReactNode[] = []
  let start = 0
  let index = lower.indexOf(query, start)
  while (index !== -1) {
    if (index > start) parts.push(text.slice(start, index))
    parts.push(
      <mark className="hl" key={index}>
        {text.slice(index, index + query.length)}
      </mark>
    )
    start = index + query.length
    index = lower.indexOf(query, start)
  }
  if (start < text.length) parts.push(text.slice(start))
  return parts
}

/**
 * Roughly how many characters a paragraph is allowed to reach before the
 * next sentence end splits it. Low enough that a paragraph is usually one
 * or two sentences — a timestamp every 500 characters let four or five
 * unrelated sentences pile up under one, which read as a single dense block
 * instead of a spread of moments to jump between.
 */
const PARAGRAPH_TARGET_CHARS = 160

/**
 * Breaks one utterance's words into readable paragraphs, splitting only at
 * sentence ends.
 *
 * A monologue with no 800ms pause stays a single utterance in the data
 * model (see `groupWordsIntoSegments` in the main process) — one stretch of
 * speech can run for minutes. Rendered as one block it reads as an unbroken
 * wall of text under a single timestamp, which makes a paragraph near the
 * end look like it happened in the same instant as the one at the top.
 * Splitting is display-only: it never touches the stored utterance.
 */
function paragraphize(words: TranscriptWord[]): TranscriptWord[][] {
  const paragraphs: TranscriptWord[][] = []
  let current: TranscriptWord[] = []
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

/**
 * A recording's transcript: playback-synced, click-to-seek, broken into
 * paragraphs rather than one wall of text per utterance. `currentMs` and
 * `onSeek` are both in the recording's real (original-file) time — the same
 * space `Utterance.startMs`/`endMs` are stored in — matching how markers are
 * jumped to elsewhere in this app. `mode` is controlled by the caller (a
 * header toggle next to the "⋯" menu) rather than owned here, since that
 * toggle needs to live outside this panel's own DOM subtree. A mislabeled
 * line's speaker is fixed right where it's wrong — the name doubles as a
 * picker over every known speaker, not just a link to the chips above. A
 * wrong word an edit-button turns into a plain textarea for the whole
 * line — editing loses that line's word-level timing/highlighting, since a
 * hand-typed correction has no ASR timings of its own to offer. A timestamp
 * with a marker nearby carries a small flag in that marker's own color, so a
 * marked moment stays findable while scrolling or reading instead of living
 * only in the chip row above. Two people's sentences the diarizer ran
 * together into one line can be split at any word boundary — both halves
 * keep their real per-word ASR timing, and the new second line starts
 * credited to the same speaker as the original, ready for the existing
 * per-line reassignment picker to fix.
 */
export default function TranscriptPanel({
  utterances,
  currentMs,
  onSeek,
  mode,
  speakers,
  onReassignSpeaker,
  onEditText,
  onSplitUtterance,
  markers,
  highlightQuery,
  isolatedSpeakerName
}: {
  utterances: Utterance[]
  currentMs: number
  onSeek: (ms: number) => void
  mode: 'speakers' | 'timestamps'
  speakers: Speaker[]
  onReassignSpeaker: (utteranceId: string, speakerId: string) => void
  onEditText: (utteranceId: string, text: string) => void
  onSplitUtterance: (utteranceId: string, wordIndex: number) => void
  markers: Marker[]
  /** A lowercased keyword search term — matching words get a highlight and `utterances` has already been narrowed to lines containing it. */
  highlightQuery?: string
  /** Name of the speaker `utterances` has already been narrowed to, if any — distinguishes "this speaker has no lines" from "no transcript yet" in the empty state. */
  isolatedSpeakerName?: string | null
}): React.JSX.Element {
  const activeRef = useRef<HTMLDivElement>(null)
  const hasSpeakers = useMemo(() => utterances.some((u) => u.speaker != null), [utterances])
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [splittingId, setSplittingId] = useState<string | null>(null)

  function startEdit(u: Utterance): void {
    setSplittingId(null)
    setEditingId(u.id)
    setDraft(u.text)
  }

  function startSplit(u: Utterance): void {
    setEditingId(null)
    setSplittingId(u.id)
  }

  function splitAt(u: Utterance, wordIndex: number): void {
    setSplittingId(null)
    onSplitUtterance(u.id, wordIndex)
  }

  /** Grows the edit textarea to fit its content instead of leaving it a fixed size with a scrollbar/manual resize handle. Reset to 'auto' first so shrinking a line (not just growing one) is picked up too. */
  function autoResizeTextarea(el: HTMLTextAreaElement | null): void {
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }

  function commitEdit(u: Utterance): void {
    setEditingId(null)
    const trimmed = draft.trim()
    if (trimmed && trimmed !== u.text) onEditText(u.id, trimmed)
  }

  /**
   * The utterance covering the playhead, falling back to the last one that
   * has started so the highlight persists through the silence between
   * utterances rather than flickering off.
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
    activeRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [activeId])

  if (utterances.length === 0) {
    return (
      <div className="empty">
        <h2>
          {highlightQuery
            ? `No matches for "${highlightQuery}"`
            : isolatedSpeakerName
              ? `No lines from ${isolatedSpeakerName}`
              : 'No transcript yet'}
        </h2>
        <p>
          {highlightQuery
            ? 'Try a different word or phrase.'
            : isolatedSpeakerName
              ? 'Every line here turned out to be someone else — try another speaker, or show everyone again.'
              : 'Transcribe this recording to see its text here.'}
        </p>
      </div>
    )
  }

  const showSpeakers = hasSpeakers && mode === 'speakers'

  return (
    <div className="transcript">
      {utterances.map((u) => {
        const isActive = u.id === activeId
        const paragraphs = u.words.length > 0 ? paragraphize(u.words) : null

        return (
          <div
            key={u.id}
            ref={isActive ? activeRef : undefined}
            className={isActive ? 'utterance utterance--active' : 'utterance'}
          >
            <div className="utterance__meta">
              {showSpeakers && u.speaker && (
                <Select
                  variant="bare"
                  value={u.speaker.id}
                  options={speakers.map((s) => ({ value: s.id, label: s.displayName, color: s.color }))}
                  onChange={(speakerId) => onReassignSpeaker(u.id, speakerId)}
                  ariaLabel={`Reassign this line's speaker (currently ${u.speaker.name})`}
                  title="Click to reassign this line to a different speaker"
                  align="start"
                />
              )}
              <button
                type="button"
                className="utterance__time"
                onClick={() => onSeek(u.startMs)}
                title="Jump to this moment"
              >
                {(() => {
                  const marker = markerIn(markers, u.startMs, u.endMs)
                  return marker && <Icon name="flag" className="utterance__time-flag" style={{ color: marker.color }} />
                })()}
                {formatDuration(u.startMs)}
              </button>
              {editingId !== u.id && splittingId !== u.id && (
                <div className="utterance__actions">
                  <button
                    type="button"
                    className="utterance__edit-btn"
                    onClick={() => startEdit(u)}
                    aria-label="Edit this line's text"
                    title="Edit this line's text"
                  >
                    <Icon name="edit" />
                  </button>
                  {u.words.length > 1 && (
                    <button
                      type="button"
                      className="utterance__edit-btn"
                      onClick={() => startSplit(u)}
                      aria-label="Split this line into two"
                      title="Split this line into two — for two speakers run together"
                    >
                      <Icon name="split" />
                    </button>
                  )}
                </div>
              )}
            </div>

            {splittingId === u.id ? (
              <div className="utterance__split">
                <p className="utterance__split-hint">Click the word where the new line should start.</p>
                <p className="utterance__text">
                  {u.words.map((word, i) => (
                    <span
                      key={i}
                      className={i === 0 ? 'word word--split-disabled' : 'word word--split-target'}
                      onClick={() => i > 0 && splitAt(u, i)}
                      title={i === 0 ? undefined : `Split before "${word.text}"`}
                    >
                      {word.text}{' '}
                    </span>
                  ))}
                </p>
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => setSplittingId(null)}>
                  Cancel
                </button>
              </div>
            ) : editingId === u.id ? (
              <textarea
                className="utterance__input"
                value={draft}
                autoFocus
                rows={1}
                ref={autoResizeTextarea}
                onChange={(e) => {
                  setDraft(e.target.value)
                  autoResizeTextarea(e.target)
                }}
                onBlur={() => commitEdit(u)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    commitEdit(u)
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault()
                    setEditingId(null)
                  }
                }}
              />
            ) : paragraphs ? (
              paragraphs.map((paragraph, pi) => (
                <p key={pi} className="utterance__text">
                  {pi > 0 &&
                    (() => {
                      const paragraphEndMs = paragraphs[pi + 1]?.[0]?.startMs ?? u.endMs
                      const marker = markerIn(markers, paragraph[0].startMs, paragraphEndMs)
                      return (
                        <button
                          type="button"
                          className="utterance__time utterance__time--inline"
                          onClick={() => onSeek(paragraph[0].startMs)}
                          title="Jump to this moment"
                        >
                          {marker && (
                            <Icon name="flag" className="utterance__time-flag" style={{ color: marker.color }} />
                          )}
                          {formatDuration(paragraph[0].startMs)}
                        </button>
                      )
                    })()}
                  {paragraph.map((word, i) => {
                    const spoken = currentMs >= word.startMs
                    const now = spoken && currentMs < word.endMs
                    return (
                      <span
                        key={i}
                        className={now ? 'word word--now' : spoken ? 'word word--said' : 'word'}
                        onClick={() => onSeek(word.startMs)}
                        title={formatDuration(word.startMs)}
                      >
                        {highlightQuery ? highlightText(word.text, highlightQuery) : word.text}{' '}
                      </span>
                    )
                  })}
                </p>
              ))
            ) : (
              <p className="utterance__text">
                {highlightQuery ? highlightText(u.text, highlightQuery) : u.text}
              </p>
            )}
          </div>
        )
      })}
    </div>
  )
}
