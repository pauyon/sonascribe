/** Formatting shared by the library list and the recording detail view. */

export function formatDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short'
  })
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** Compact clock for durations: 4:31, or 1:04:31 once past an hour. */
export function formatDuration(ms: number | null): string {
  if (ms == null) return '—'
  const total = Math.round(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

/** Model/download sizes: 147 MB, or 1.6 GB past a gigabyte. */
export function formatBytes(bytes: number): string {
  const mb = bytes / 1_000_000
  return mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${Math.round(mb)} MB`
}
