import { useEffect, useRef, useState } from 'react'
import type { Marker } from '@shared/types'

/** How long to wait after the last keystroke before saving, in ms. */
const COMMIT_DEBOUNCE_MS = 600

/**
 * Shared expand/collapse/save/discard state for one marker's note editor —
 * used by both `MarkerNoteField` (a standalone row, for the live Record
 * screen and the mini window) and `MarkerChips` (merged into the same row as
 * the rest of a marker's controls). Different layouts, identical rules for
 * what "open", "save", and "discard" mean, so the logic lives once here.
 *
 * `active` and `onExpandedChange` together let a parent enforce "only one of
 * these open at a time" (Record.tsx's live list does; `MarkerChips` and the
 * mini window don't pass them, so they're unaffected): when a caller passes
 * `active={false}` while this instance is expanded, it saves and collapses
 * itself, same as if Done had been clicked — a marker placed while a
 * previous one's note was still open used to leave both open at once, which
 * read as broken rather than intentional.
 */
export function useMarkerNote(
  marker: Marker,
  onCommit: (notes: string) => void,
  options: { startExpanded?: boolean; active?: boolean; onExpandedChange?: (expanded: boolean) => void } = {}
) {
  const { startExpanded, active, onExpandedChange } = options
  const [expanded, setExpanded] = useState(!!startExpanded)
  const [draft, setDraft] = useState(marker.notes)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // What to revert to on discard — captured when editing starts, not read
  // off `marker.notes` at discard time, since the debounce below can itself
  // have already pushed a mid-edit value out as an autosave; without
  // tracking this separately, discarding would only reset local state and
  // that autosave would silently stick.
  const openedWithRef = useRef(marker.notes)
  // Mirrors draft/onCommit for the unmount-flush effect below, which must
  // read whatever was most recently typed/passed — not whatever they were
  // when that effect's closure was created (mount time, since it only runs
  // once) — otherwise flushing on unmount would save a stale, earlier draft.
  const draftRef = useRef(draft)
  draftRef.current = draft
  const onCommitRef = useRef(onCommit)
  onCommitRef.current = onCommit

  // Picks up an external change (the same marker edited from another window,
  // or offline) while this field isn't the one currently being typed into.
  useEffect(() => {
    if (!expanded) setDraft(marker.notes)
  }, [marker.notes, expanded])

  // A pending debounced autosave must still land even if this instance
  // unmounts before it fires — e.g. the mini window's single note field is
  // keyed by marker id and remounts fresh on every new marker, so marking
  // again shortly after typing would otherwise silently drop the edit.
  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
        onCommitRef.current(draftRef.current)
      }
    }
  }, [])

  // Enforces "only one open at a time" for callers that opt in (see the doc
  // comment above) — collapses (saving first) when told this instance is no
  // longer the allowed one.
  useEffect(() => {
    if (active === false && expanded) done()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  useEffect(() => {
    onExpandedChange?.(expanded)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded])

  function clearPendingCommit(): void {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
      debounceRef.current = null
    }
  }

  function scheduleCommit(next: string): void {
    clearPendingCommit()
    debounceRef.current = setTimeout(() => onCommit(next), COMMIT_DEBOUNCE_MS)
  }

  function open(): void {
    openedWithRef.current = marker.notes
    setDraft(marker.notes)
    setExpanded(true)
  }

  /** Saves immediately without collapsing — Enter's action (see `onKeyDown`), and available for a caller that wants to force an immediate save mid-edit. */
  function save(): void {
    clearPendingCommit()
    onCommit(draft)
  }

  /** Saves immediately and collapses — the explicit "close this note" action (the note-icon toggle, or a dedicated Done button; not Enter — see `onKeyDown`). */
  function done(): void {
    save()
    setExpanded(false)
  }

  /** Reverts to whatever was there before this editing session, undoing any debounced autosave along the way, and collapses. */
  function discard(): void {
    clearPendingCommit()
    if (draft !== openedWithRef.current) onCommit(openedWithRef.current)
    setDraft(openedWithRef.current)
    setExpanded(false)
  }

  function onChange(next: string): void {
    setDraft(next)
    scheduleCommit(next)
  }

  /** Enter saves but leaves the note open — the note icon (or a Done button)
      is the toggle that closes it, not Enter; Shift+Enter still inserts a
      newline; Escape discards and closes. */
  function onKeyDown(e: { key: string; shiftKey: boolean; preventDefault: () => void }): void {
    if (e.key === 'Escape') discard()
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      save()
    }
  }

  return {
    expanded,
    draft,
    hasNote: marker.notes.trim().length > 0,
    open,
    done,
    discard,
    onChange,
    onKeyDown
  }
}
