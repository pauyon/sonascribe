import { memo, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { Screenshot, Speaker, TranscriptWordSpan, Utterance } from '@shared/types'
import { screenshotMediaUrl } from '@shared/ipc'
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

/**
 * Distributes screenshots across paragraph boundaries, so a screenshot lands
 * on the inline timestamp closest to when it was actually taken rather than
 * always the utterance's own timestamp at the top.
 *
 * Same two-pointer idea as `shotsByUtterance` below, just one level deeper:
 * both lists are already time-ordered, so each pointer only ever advances.
 */
function shotsByParagraph(
  paragraphs: TranscriptWordSpan[][],
  shots: Screenshot[]
): Screenshot[][] {
  const result: Screenshot[][] = paragraphs.map(() => [])
  if (shots.length === 0) return result
  const sorted = [...shots].sort((a, b) => a.timestampMs - b.timestampMs)
  let pi = 0
  for (const shot of sorted) {
    while (pi + 1 < paragraphs.length && paragraphs[pi + 1][0].startMs <= shot.timestampMs) pi++
    result[pi].push(shot)
  }
  return result
}

/** Shared so a shot-less utterance always hands its row the same array reference — a fresh `[]` every render would make the row's memo think its screenshots changed when they didn't. */
const EMPTY_SHOTS: Screenshot[] = []

/** Small inline marker for a screenshot taken around this timestamp. */
function ShotMarkers({
  shots,
  onOpen
}: {
  shots: Screenshot[]
  onOpen: (shot: Screenshot) => void
}): React.JSX.Element | null {
  if (shots.length === 0) return null
  return (
    <>
      {shots.map((shot) => (
        <button
          key={shot.id}
          type="button"
          className="utterance__shot"
          onClick={() => onOpen(shot)}
          title="View screenshot taken around here"
          aria-label="View screenshot taken around here"
        >
          📷
        </button>
      ))}
    </>
  )
}

/**
 * Where the playhead sits relative to one utterance's own span.
 *
 * 'before'/'after' are static — every word renders unspoken or fully spoken
 * respectively, and that doesn't change again until the playhead actually
 * crosses back into or out of this utterance, however far it jumps. 'during'
 * is the only phase where a word-by-word re-render is warranted at all.
 */
type Phase = 'before' | 'during' | 'after'

function phaseFor(u: Utterance, currentMs: number): Phase {
  if (currentMs < u.startMs) return 'before'
  if (currentMs > u.endMs) return 'after'
  return 'during'
}

interface UtteranceRowProps {
  u: Utterance
  speaker: Speaker | undefined
  speakers: Speaker[]
  isActive: boolean
  phase: Phase
  isEditing: boolean
  draft: string
  currentMs: number
  showHours: boolean
  query: string
  shots: Screenshot[]
  activeRef: RefObject<HTMLDivElement | null>
  onSeek: (ms: number) => void
  onReassign: (utteranceId: string, speakerId: string) => Promise<void>
  onDelete: (utteranceId: string) => void
  onStartEdit: (id: string, text: string) => void
  onDraftChange: (text: string) => void
  onCommitEdit: (id: string) => void
  onCancelEdit: () => void
  onOpenShot: (shot: Screenshot) => void
}

/**
 * One transcript line — the unit `React.memo` skips re-rendering for, which
 * is what keeps a multi-hour transcript's few-thousand word `<span>`s from
 * being diffed on every playback tick. See `rowPropsEqual` below for exactly
 * what's allowed to trigger a re-render.
 */
function UtteranceRowImpl({
  u,
  speaker,
  speakers,
  isActive,
  // phase isn't read here — it only exists to gate re-renders in
  // rowPropsEqual below; currentMs is what the render body actually uses.
  isEditing,
  draft,
  currentMs,
  showHours,
  query,
  shots,
  activeRef,
  onSeek,
  onReassign,
  onDelete,
  onStartEdit,
  onDraftChange,
  onCommitEdit,
  onCancelEdit,
  onOpenShot
}: UtteranceRowProps): React.JSX.Element {
  const shaky = u.confidence != null && u.confidence < 0.5

  // Paragraphs partition the utterance's shots by which one they're actually
  // closest to; the header marker then covers only paragraph 0's share
  // rather than the whole utterance's, so a shot from later in a long
  // monologue isn't shown next to its very first word. Scoped to this row so
  // it's recomputed only when this utterance's own words/shots change, never
  // on a playback tick.
  const paragraphs = useMemo(
    () => (u.words.length > 0 && !query ? paragraphize(u.words) : null),
    [u.words, query]
  )
  const perParagraphShots = useMemo(
    () => (paragraphs ? shotsByParagraph(paragraphs, shots) : null),
    [paragraphs, shots]
  )

  return (
    <div
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
        <ShotMarkers shots={perParagraphShots ? perParagraphShots[0] : shots} onOpen={onOpenShot} />
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
          onChange={(e) => onDraftChange(e.target.value)}
          onBlur={() => onCommitEdit(u.id)}
          onKeyDown={(e) => {
            // Enter saves; Shift+Enter inserts a newline.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              onCommitEdit(u.id)
            }
            if (e.key === 'Escape') onCancelEdit()
          }}
        />
      ) : /*
          Word by word (broken into paragraphs) when the timings are
          there, and the whole line otherwise — an edited line has no
          usable word timings, and a search is asking for its matches to
          be marked rather than the playhead. Falling back keeps both
          cases correct instead of showing one of them wrongly.
        */
      paragraphs ? (
        paragraphs.map((paragraph, pi) => (
          <p
            key={pi}
            className="utterance__text"
            onDoubleClick={() => onStartEdit(u.id, u.text)}
            title="Double-click to edit"
          >
            {pi > 0 && (
              <>
                <button
                  type="button"
                  className="utterance__time utterance__time--inline"
                  onClick={() => onSeek(paragraph[0].startMs)}
                  title="Jump to this moment"
                >
                  {formatTimestamp(paragraph[0].startMs, showHours)}
                </button>
                <ShotMarkers shots={perParagraphShots![pi]} onOpen={onOpenShot} />
              </>
            )}
            {paragraph.map((word, i) => {
              // Only meaningful while phase === 'during' — 'before'/'after'
              // already render every word in this paragraph the same way
              // ('during' is the only phase this row re-renders for anyway,
              // per rowPropsEqual below), so no per-phase branching is
              // needed here beyond what currentMs itself already implies.
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
          onDoubleClick={() => onStartEdit(u.id, u.text)}
          title="Double-click to edit"
        >
          {highlight(u.text, query)}
        </p>
      )}
    </div>
  )
}

/**
 * Gates re-renders down to what can actually have changed.
 *
 * `currentMs` ticks ~4x/second during playback; without this, every row in a
 * multi-hour transcript would re-render (and its few-thousand words get
 * diffed) that often regardless of whether anything about it changed. Only
 * `phase === 'during'` needs currentMs at all — see the `Phase` doc comment.
 */
function rowPropsEqual(prev: UtteranceRowProps, next: UtteranceRowProps): boolean {
  if (
    prev.u !== next.u ||
    prev.speaker !== next.speaker ||
    prev.isActive !== next.isActive ||
    prev.phase !== next.phase ||
    prev.isEditing !== next.isEditing ||
    prev.showHours !== next.showHours ||
    prev.query !== next.query ||
    prev.shots !== next.shots
  ) {
    return false
  }
  if (next.isEditing && prev.draft !== next.draft) return false
  if (next.phase === 'during' && prev.currentMs !== next.currentMs) return false
  return true
}

const UtteranceRow = memo(UtteranceRowImpl, rowPropsEqual)

export default function Transcript({
  utterances,
  speakers,
  screenshots,
  currentMs,
  showHours,
  query,
  speakerFilter,
  follow,
  onSeek,
  onEdit,
  onReassign,
  onDelete,
  onDeleteScreenshot
}: {
  utterances: Utterance[]
  speakers: Speaker[]
  /** Snapped during the recording; shown inline at the timestamp closest to when each was taken rather than in a separate strip. */
  screenshots: Screenshot[]
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
  onDeleteScreenshot: (id: string) => void
}): React.JSX.Element {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [previewShot, setPreviewShot] = useState<Screenshot | null>(null)
  const activeRef = useRef<HTMLDivElement>(null)

  // Which utterance each screenshot lands closest to in time — computed once
  // over the full (unfiltered) timeline, since ownership shouldn't shift
  // depending on what a search or speaker filter currently hides. A shot
  // taken before the first utterance has nothing earlier to attach to, so it
  // lands on the first one rather than being dropped.
  const shotsByUtterance = useMemo(() => {
    const map = new Map<string, Screenshot[]>()
    if (screenshots.length === 0 || utterances.length === 0) return map
    const sorted = [...screenshots].sort((a, b) => a.timestampMs - b.timestampMs)
    let ui = 0
    for (const shot of sorted) {
      while (ui + 1 < utterances.length && utterances[ui + 1].startMs <= shot.timestampMs) ui++
      const ownerId = utterances[ui].id
      const list = map.get(ownerId)
      if (list) list.push(shot)
      else map.set(ownerId, [shot])
    }
    return map
  }, [screenshots, utterances])

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

  useEffect(() => {
    if (!previewShot) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setPreviewShot(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [previewShot])

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
      {visible.map((u) => (
        <UtteranceRow
          key={u.id}
          u={u}
          speaker={speakers.find((s) => s.id === u.speakerId)}
          speakers={speakers}
          isActive={u.id === activeId}
          phase={phaseFor(u, currentMs)}
          isEditing={u.id === editingId}
          draft={draft}
          currentMs={currentMs}
          showHours={showHours}
          query={query}
          shots={shotsByUtterance.get(u.id) ?? EMPTY_SHOTS}
          activeRef={activeRef}
          onSeek={onSeek}
          onReassign={onReassign}
          onDelete={onDelete}
          onStartEdit={(id, text) => {
            setEditingId(id)
            setDraft(text)
          }}
          onDraftChange={setDraft}
          onCommitEdit={(id) => void commit(id)}
          onCancelEdit={() => setEditingId(null)}
          onOpenShot={setPreviewShot}
        />
      ))}

      {previewShot && (
        // Click on the backdrop closes; the panel stops that click reaching
        // it so clicking the image or the toolbar doesn't also close it.
        <div className="shots__lightbox" onClick={() => setPreviewShot(null)}>
          <div className="shots__lightbox-panel" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="shots__lightbox-close"
              onClick={() => setPreviewShot(null)}
              aria-label="Close preview"
            >
              ✕
            </button>

            <img
              className="shots__lightbox-img"
              src={screenshotMediaUrl(previewShot.id)}
              alt={`Screenshot at ${formatTimestamp(previewShot.timestampMs, showHours)}`}
            />

            <div className="shots__lightbox-bar">
              <span className="shots__lightbox-info">
                {formatTimestamp(previewShot.timestampMs, showHours)} · {previewShot.displayLabel}
              </span>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => onSeek(previewShot.timestampMs)}
              >
                Jump to this moment
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => {
                  onDeleteScreenshot(previewShot.id)
                  setPreviewShot(null)
                }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
