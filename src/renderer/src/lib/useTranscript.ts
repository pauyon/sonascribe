import { useEffect, useState } from 'react'
import type { Utterance } from '@shared/types'
import { api, useEvent, useQuery } from './api'

/**
 * A recording's transcript plus the controls to produce one — start/cancel
 * a transcription and the live progress while it runs. Fetching utterances
 * is its own query (`transcript:get`) rather than living on `Recording`
 * itself, since a transcript is a whole separate table, unlike cuts/markers.
 */
export function useTranscript(recordingId: string): {
  utterances: Utterance[] | null
  loading: boolean
  loadError: string | null
  /** Fractional progress 0..1, or null while running with no known fraction, or null when nothing is running. */
  progress: number | null
  start: () => Promise<void>
  cancel: () => void
  startError: string | null
  /** Hand-corrects one utterance's text. */
  editText: (utteranceId: string, text: string) => Promise<void>
  /** Splits one utterance into two at a word boundary — two people's sentences the diarizer ran together into one line. */
  splitUtterance: (utteranceId: string, wordIndex: number) => Promise<void>
  /** Re-fetches utterances — needed after a speaker rename/recolor/merge, which changes what each utterance's embedded `speaker` carries without touching `transcriptStatus`. */
  refetch: () => void
} {
  const { data, loading, error: loadError, refetch } = useQuery('transcript:get', { recordingId })
  // The main process's own record of what's in flight — the source a fresh
  // mount reads from, so a job already running when this page opens (or
  // reopens after the user navigated away and back) shows real progress
  // immediately instead of nothing until the next event happens to arrive.
  const { data: active } = useQuery('transcript:listActive')
  // `undefined` means "no live update received yet this mount" — distinct
  // from `null`, which is a real "no known fraction" from the engine —
  // so the seeded value from `active` above isn't shadowed by a stale
  // default before the first live event (if any) arrives.
  const [liveFraction, setLiveFraction] = useState<number | null | undefined>(undefined)
  const [startError, setStartError] = useState<string | null>(null)

  useEvent('transcript:progress', (payload) => {
    if (payload.recordingId !== recordingId) return
    setLiveFraction(payload.fraction)
  })

  // A fresh recording (route change, not just a re-render) has no live
  // update of its own yet — fall back to the seeded value again rather than
  // keeping the previous recording's last-known fraction.
  useEffect(() => {
    setLiveFraction(undefined)
  }, [recordingId])

  const seededFraction = active?.find((a) => a.recordingId === recordingId)?.fraction ?? null
  const progress = liveFraction !== undefined ? liveFraction : seededFraction

  // The recording row (status, error) is whoever renders this hook's own
  // concern — they already have their own `recordings:get` query. This just
  // needs to know when to go re-fetch the utterances a finished job wrote.
  useEvent('recording:updated', (updated) => {
    if (updated.id !== recordingId) return
    if (updated.transcriptStatus === 'ready') refetch()
  })

  async function start(): Promise<void> {
    setStartError(null)
    setLiveFraction(undefined)
    try {
      await api.invoke('transcript:start', { recordingId })
    } catch (err) {
      setStartError(err instanceof Error ? err.message : String(err))
    }
  }

  function cancel(): void {
    void api.invoke('transcript:cancel', { recordingId })
  }

  async function editText(utteranceId: string, text: string): Promise<void> {
    await api.invoke('transcript:editUtterance', { utteranceId, text })
    refetch()
  }

  async function splitUtterance(utteranceId: string, wordIndex: number): Promise<void> {
    await api.invoke('transcript:splitUtterance', { utteranceId, wordIndex })
    refetch()
  }

  return {
    utterances: data,
    loading,
    loadError,
    progress,
    start,
    cancel,
    startError,
    editText,
    splitUtterance,
    refetch
  }
}
