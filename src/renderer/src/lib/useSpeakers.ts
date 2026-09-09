import { useEffect, useState } from 'react'
import type { Speaker } from '@shared/types'
import { api, useEvent, useQuery } from './api'

/**
 * Speaker CRUD for a recording, plus the controls to run detection —
 * mirrors `useTranscript.ts`'s shape (its own `transcript:get`-style query,
 * a `transcript:listActive`-style seed for progress that survives
 * navigating away and back, live progress events layered on top).
 */
export function useSpeakers(
  recordingId: string,
  /** Called after a rename/recolor/merge/delete/reassign — none of which touch `speakerStatus`, so `useTranscript`'s own refetch (gated on that) won't otherwise notice an utterance's embedded speaker name/color changed. */
  onChange?: () => void
): {
  speakers: Speaker[]
  loading: boolean
  loadError: string | null
  /** Fractional progress 0..1, or null while running with no known fraction, or null when nothing is running. */
  progress: number | null
  detect: () => Promise<void>
  cancel: () => void
  detectError: string | null
  /** Adds a new, empty speaker — for detection undercounting (missed someone) rather than misattributing a line. */
  create: () => Promise<void>
  rename: (id: string, displayName: string) => Promise<void>
  recolor: (id: string, color: string) => Promise<void>
  merge: (fromId: string, intoId: string) => Promise<void>
  remove: (id: string) => Promise<void>
  reassignUtterance: (utteranceId: string, speakerId: string | null) => Promise<void>
} {
  const { data, loading, error: loadError, refetch } = useQuery('speakers:list', { recordingId })
  const { data: active } = useQuery('speakers:listActive')
  const [liveFraction, setLiveFraction] = useState<number | null | undefined>(undefined)
  const [detectError, setDetectError] = useState<string | null>(null)

  useEvent('speaker:progress', (payload) => {
    if (payload.recordingId !== recordingId) return
    setLiveFraction(payload.fraction)
  })

  useEffect(() => {
    setLiveFraction(undefined)
  }, [recordingId])

  const seededFraction = active?.find((a) => a.recordingId === recordingId)?.fraction ?? null
  const progress = liveFraction !== undefined ? liveFraction : seededFraction

  useEvent('recording:updated', (updated) => {
    if (updated.id !== recordingId) return
    if (updated.speakerStatus === 'ready') refetch()
  })

  async function detect(): Promise<void> {
    setDetectError(null)
    setLiveFraction(undefined)
    try {
      await api.invoke('speakers:detect', { recordingId })
    } catch (err) {
      setDetectError(err instanceof Error ? err.message : String(err))
    }
  }

  function cancel(): void {
    void api.invoke('speakers:cancel', { recordingId })
  }

  async function create(): Promise<void> {
    await api.invoke('speakers:create', { recordingId })
    refetch()
    onChange?.()
  }

  async function rename(id: string, displayName: string): Promise<void> {
    await api.invoke('speakers:rename', { id, displayName })
    refetch()
    onChange?.()
  }

  async function recolor(id: string, color: string): Promise<void> {
    await api.invoke('speakers:recolor', { recordingId, id, color })
    refetch()
    onChange?.()
  }

  async function merge(fromId: string, intoId: string): Promise<void> {
    await api.invoke('speakers:merge', { recordingId, fromId, intoId })
    refetch()
    onChange?.()
  }

  async function remove(id: string): Promise<void> {
    await api.invoke('speakers:delete', { id })
    refetch()
    onChange?.()
  }

  async function reassignUtterance(utteranceId: string, speakerId: string | null): Promise<void> {
    await api.invoke('speakers:reassignUtterance', { utteranceId, speakerId })
    refetch()
    onChange?.()
  }

  return {
    speakers: data ?? [],
    loading,
    loadError,
    progress,
    detect,
    cancel,
    detectError,
    create,
    rename,
    recolor,
    merge,
    remove,
    reassignUtterance
  }
}
