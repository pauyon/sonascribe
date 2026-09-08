import type { Cut } from '@shared/types'

export type { Cut }

/**
 * Non-destructive trim math.
 *
 * A `Cut` is always in the original file's own ("real") time — the only
 * anchor that stays valid no matter how many other cuts exist. Everything a
 * user actually sees — the compressed waveform, the running clock, where
 * clicking or dragging lands — is "virtual" time: real time with every cut
 * collapsed out of it, recomputed on the fly from the cut list rather than
 * stored. The audio file itself is never touched; a cut is purely a
 * playback transform, which is what makes it free to revert.
 *
 * These are pure functions — no DOM, no React — so the mapping is easy to
 * reason about (and check) in isolation from the canvas/playback code that
 * calls them.
 */

interface Region {
  start: number
  end: number
}

/** Complement of `cuts` within [0, durationMs] — what's actually left to play. */
export function keptRegions(durationMs: number, cuts: Cut[]): Region[] {
  const regions: Region[] = []
  let cursor = 0
  for (const cut of cuts) {
    if (cut.startMs > cursor) regions.push({ start: cursor, end: cut.startMs })
    cursor = Math.max(cursor, cut.endMs)
  }
  if (cursor < durationMs) regions.push({ start: cursor, end: durationMs })
  return regions
}

/** Sum of kept-region lengths — the compressed/displayed duration. */
export function virtualDuration(durationMs: number, cuts: Cut[]): number {
  return keptRegions(durationMs, cuts).reduce((sum, r) => sum + (r.end - r.start), 0)
}

/**
 * Real (original-file) ms -> virtual (compressed) ms.
 *
 * A real position that falls inside a cut has no virtual position of its
 * own — it's not on the compressed timeline at all — so it maps to the
 * virtual position of the cut's start, the nearest point that is.
 */
export function realToVirtual(realMs: number, durationMs: number, cuts: Cut[]): number {
  let accumulated = 0
  for (const region of keptRegions(durationMs, cuts)) {
    if (realMs < region.start) return accumulated
    if (realMs < region.end) return accumulated + (realMs - region.start)
    accumulated += region.end - region.start
  }
  return accumulated
}

/** Virtual ms -> real ms — inverse of `realToVirtual`, for seeking. */
export function virtualToReal(virtualMs: number, durationMs: number, cuts: Cut[]): number {
  const regions = keptRegions(durationMs, cuts)
  let accumulated = 0
  for (const region of regions) {
    const length = region.end - region.start
    if (virtualMs < accumulated + length) return region.start + (virtualMs - accumulated)
    accumulated += length
  }
  // Past the end (or nothing left at all): the last playable instant.
  const last = regions[regions.length - 1]
  return last ? last.end : 0
}

/**
 * Whether `realMs` currently sits inside a cut, and if so, the real ms to
 * jump to in order to skip past it — the whole of the playback-skip logic.
 */
export function cutAt(realMs: number, cuts: Cut[]): Cut | null {
  return cuts.find((cut) => realMs >= cut.startMs && realMs < cut.endMs) ?? null
}

/**
 * Filters the full (evenly-spaced, real-time) peaks array down to the
 * buckets that fall in a kept region, concatenated with no gap — the
 * compressed waveform's bar data — plus the virtual-ms offset of each seam
 * between two consecutive kept regions, so the waveform can mark where a
 * cut happened even though the removed audio itself is invisible.
 */
export function compressPeaks(
  peaks: number[],
  durationMs: number,
  cuts: Cut[]
): { values: number[]; seams: number[] } {
  if (peaks.length === 0 || durationMs <= 0) return { values: [], seams: [] }

  const regions = keptRegions(durationMs, cuts)
  const msPerBucket = durationMs / peaks.length

  const values: number[] = []
  const seams: number[] = []
  let accumulatedMs = 0
  for (let i = 0; i < regions.length; i++) {
    const region = regions[i]
    // A seam marks a join between two kept regions — not the very start.
    if (i > 0) seams.push(accumulatedMs)

    const startBucket = Math.floor(region.start / msPerBucket)
    const endBucket = Math.min(peaks.length, Math.ceil(region.end / msPerBucket))
    for (let b = startBucket; b < endBucket; b++) values.push(peaks[b])

    accumulatedMs += region.end - region.start
  }

  return { values, seams }
}

/**
 * Slices an already-compressed peaks array down to a virtual-ms window,
 * re-based to window-local ms — the zoom viewport on the dedicated editor
 * page. `compressed.values` is assumed evenly spaced across
 * `[0, virtualDurationMs)`, same assumption `compressPeaks` builds it under.
 */
export function sliceCompressed(
  compressed: { values: number[]; seams: number[] },
  virtualDurationMs: number,
  windowStartMs: number,
  windowEndMs: number
): { values: number[]; seams: number[] } {
  const { values, seams } = compressed
  if (values.length === 0 || virtualDurationMs <= 0) return { values: [], seams: [] }

  const start = Math.max(0, Math.min(windowStartMs, virtualDurationMs))
  const end = Math.max(start, Math.min(windowEndMs, virtualDurationMs))
  const msPerBucket = virtualDurationMs / values.length

  const startBucket = Math.floor(start / msPerBucket)
  const endBucket = Math.min(values.length, Math.ceil(end / msPerBucket))

  return {
    values: values.slice(startBucket, endBucket),
    seams: seams.filter((s) => s >= start && s < end).map((s) => s - start)
  }
}
