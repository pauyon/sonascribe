import { useRef, useState } from 'react'
import type { Speaker, Utterance } from '@shared/types'

const SPEAKER_DELETE_UNDO_MS = 6000

/**
 * Speaker deletion, deferred behind a toast-undo window. Deleting a speaker
 * also deletes every line credited to them, so this is the one destructive
 * action on the editor that genuinely needs a way back — a speaker (and,
 * unless `keepLines`, their lines) is hidden immediately, and the real IPC
 * delete lands only after `SPEAKER_DELETE_UNDO_MS` unless `undo` cancels it
 * first.
 */
export function useSpeakerDeleteUndo(params: {
  speakers: Speaker[]
  utterances: Utterance[] | null | undefined
  speakerFilter: string | null
  setSpeakerFilter: (id: string | null) => void
  remove: (id: string) => Promise<unknown>
  removeKeepLines: (id: string) => Promise<unknown>
}): {
  hiddenSpeakerIds: Set<string>
  hiddenUtteranceIds: Set<string>
  pendingDelete: { id: string; label: string; keepLines: boolean } | null
  /** Hides the speaker (and, unless `keepLines`, their lines) now; schedules the real delete. */
  removePending: (speakerId: string, keepLines: boolean) => void
  /** Cancels the pending delete for the currently-toasted speaker and un-hides it. */
  undo: () => void
} {
  const { speakers, utterances, speakerFilter, setSpeakerFilter, remove, removeKeepLines } = params

  const [hiddenSpeakerIds, setHiddenSpeakerIds] = useState<Set<string>>(new Set())
  const [hiddenUtteranceIds, setHiddenUtteranceIds] = useState<Set<string>>(new Set())
  const [pendingDelete, setPendingDelete] = useState<{
    id: string
    label: string
    keepLines: boolean
  } | null>(null)
  // Deliberately never cleared on unmount: a delete the user didn't undo
  // should still land even if they navigate away before the timer fires,
  // rather than silently reverting. Keyed by speaker id (not a single ref)
  // so deleting a second speaker before the first one's window elapses
  // doesn't cancel the first one's real deletion — only the visible toast
  // (a single `pendingDelete`) is limited to the most recent.
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  function removePending(speakerId: string, keepLines: boolean): void {
    const target = speakers.find((s) => s.id === speakerId)
    if (!target) return
    const lineIds = keepLines
      ? []
      : (utterances ?? []).filter((u) => u.speaker?.id === speakerId).map((u) => u.id)

    if (speakerFilter === speakerId) setSpeakerFilter(null)
    setHiddenSpeakerIds((prev) => new Set(prev).add(speakerId))
    if (!keepLines) {
      setHiddenUtteranceIds((prev) => {
        const next = new Set(prev)
        for (const lineId of lineIds) next.add(lineId)
        return next
      })
    }
    setPendingDelete({
      id: speakerId,
      keepLines,
      label: keepLines
        ? `${target.displayName} removed — their lines are kept, unassigned.`
        : `${target.displayName} removed (${lineIds.length} line${lineIds.length === 1 ? '' : 's'}).`
    })

    const existing = timers.current.get(speakerId)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      timers.current.delete(speakerId)
      setPendingDelete((current) => (current?.id === speakerId ? null : current))
      void (keepLines ? removeKeepLines(speakerId) : remove(speakerId))
    }, SPEAKER_DELETE_UNDO_MS)
    timers.current.set(speakerId, timer)
  }

  function undo(): void {
    const pending = pendingDelete
    if (!pending) return
    const timer = timers.current.get(pending.id)
    if (timer) clearTimeout(timer)
    timers.current.delete(pending.id)

    setPendingDelete(null)
    setHiddenSpeakerIds((prev) => {
      const next = new Set(prev)
      next.delete(pending.id)
      return next
    })
    setHiddenUtteranceIds((prev) => {
      const next = new Set(prev)
      for (const u of utterances ?? []) {
        if (u.speaker?.id === pending.id) next.delete(u.id)
      }
      return next
    })
  }

  return { hiddenSpeakerIds, hiddenUtteranceIds, pendingDelete, removePending, undo }
}
