import type { Marker, Recording } from '@shared/types'
import { api } from './api'

const DEFAULT_COLOR = '#3569ff'

/**
 * Marker CRUD for a recording — labeled, colored jump-to points in the
 * original file's own time. Same whole-list-replace shape as the cut-editing
 * functions in `Editor.tsx`/`Trim.tsx`: every action computes the next full
 * array client-side and sends it via `recordings:setMarkers`, which comes
 * back normalized (clamped, sorted) so the caller's next `refetch()` reflects
 * exactly what was persisted.
 */
export function useMarkers(
  recording: Recording | null | undefined,
  refetch: () => void
): {
  markers: Marker[]
  addMarkerAt: (realMs: number) => void
  rename: (id: string, label: string) => void
  recolor: (id: string, color: string) => void
  remove: (id: string) => void
} {
  const markers = recording?.markers ?? []

  function persist(next: Marker[]): void {
    if (!recording) return
    void api.invoke('recordings:setMarkers', { id: recording.id, markers: next }).then(refetch)
  }

  function addMarkerAt(realMs: number): void {
    persist([
      ...markers,
      { id: crypto.randomUUID(), timeMs: realMs, label: '', color: DEFAULT_COLOR }
    ])
  }

  function rename(id: string, label: string): void {
    persist(markers.map((m) => (m.id === id ? { ...m, label } : m)))
  }

  function recolor(id: string, color: string): void {
    persist(markers.map((m) => (m.id === id ? { ...m, color } : m)))
  }

  function remove(id: string): void {
    persist(markers.filter((m) => m.id !== id))
  }

  return { markers, addMarkerAt, rename, recolor, remove }
}
