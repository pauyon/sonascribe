import type { Marker, Recording } from '@shared/types'
import { api } from './api'

/**
 * A warm amber rather than the app's own accent blue: a new marker's default
 * color used to match the waveform's "played" bar fill exactly (both drew
 * from `--accent-strong`), which read fine against the light theme's near-
 * white waveform panel but all but vanished against the dark theme's navy
 * one. Picked from `SPEAKER_COLORS` for the same colourblind-safe reasoning
 * that palette was built for.
 */
export const DEFAULT_MARKER_COLOR = '#e5a43b'

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
  /** `color` defaults to `DEFAULT_MARKER_COLOR` — pass the caller's own "current" color to batch-tag a run of markers the same hue before switching to another. */
  addMarkerAt: (realMs: number, color?: string) => void
  rename: (id: string, label: string) => void
  recolor: (id: string, color: string) => void
  remove: (id: string) => void
  clearAll: () => void
} {
  const markers = recording?.markers ?? []

  function persist(next: Marker[]): void {
    if (!recording) return
    void api.invoke('recordings:setMarkers', { id: recording.id, markers: next }).then(refetch)
  }

  function addMarkerAt(realMs: number, color: string = DEFAULT_MARKER_COLOR): void {
    persist([...markers, { id: crypto.randomUUID(), timeMs: realMs, label: '', color }])
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

  function clearAll(): void {
    persist([])
  }

  return { markers, addMarkerAt, rename, recolor, remove, clearAll }
}
