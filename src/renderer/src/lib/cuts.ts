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

/** The real (signed) waveform envelope per bucket — `min` <= 0 <= `max`, same length. */
export interface PeakBuckets {
  min: number[]
  max: number[]
}

/**
 * Filters the full (evenly-spaced, real-time) peaks down to the buckets that
 * fall in a kept region, concatenated with no gap — the compressed
 * waveform's bar data — plus the virtual-ms offset of each seam between two
 * consecutive kept regions, so the waveform can mark where a cut happened
 * even though the removed audio itself is invisible.
 *
 * `min`/`max` are sliced together from the same bucket-index selection, not
 * computed independently — they must never drift out of sync with each other.
 */
export function compressPeaks(
  peaks: PeakBuckets,
  durationMs: number,
  cuts: Cut[]
): PeakBuckets & { seams: number[] } {
  const bucketCount = peaks.max.length
  if (bucketCount === 0 || durationMs <= 0) return { min: [], max: [], seams: [] }

  const regions = keptRegions(durationMs, cuts)
  const msPerBucket = durationMs / bucketCount

  const min: number[] = []
  const max: number[] = []
  const seams: number[] = []
  let accumulatedMs = 0
  for (let i = 0; i < regions.length; i++) {
    const region = regions[i]
    // A seam marks a join between two kept regions — not the very start.
    if (i > 0) seams.push(accumulatedMs)

    const startBucket = Math.floor(region.start / msPerBucket)
    const endBucket = Math.min(bucketCount, Math.ceil(region.end / msPerBucket))
    for (let b = startBucket; b < endBucket; b++) {
      min.push(peaks.min[b])
      max.push(peaks.max[b])
    }

    accumulatedMs += region.end - region.start
  }

  return { min, max, seams }
}

/**
 * Slices already-compressed peaks down to a virtual-ms window, re-based to
 * window-local ms — the zoom viewport on the dedicated editor page.
 * `compressed`'s buckets are assumed evenly spaced across
 * `[0, virtualDurationMs)`, same assumption `compressPeaks` builds under.
 */
export function sliceCompressed(
  compressed: PeakBuckets & { seams: number[] },
  virtualDurationMs: number,
  windowStartMs: number,
  windowEndMs: number
): PeakBuckets & { seams: number[] } {
  const { min, max, seams } = compressed
  const bucketCount = max.length
  if (bucketCount === 0 || virtualDurationMs <= 0) return { min: [], max: [], seams: [] }

  const start = Math.max(0, Math.min(windowStartMs, virtualDurationMs))
  const end = Math.max(start, Math.min(windowEndMs, virtualDurationMs))
  const msPerBucket = virtualDurationMs / bucketCount

  const startBucket = Math.floor(start / msPerBucket)
  const endBucket = Math.min(bucketCount, Math.ceil(end / msPerBucket))

  return {
    min: min.slice(startBucket, endBucket),
    max: max.slice(startBucket, endBucket),
    seams: seams.filter((s) => s >= start && s < end).map((s) => s - start)
  }
}

/**
 * Picks a readable tick interval (in ms) for a time ruler spanning
 * `durationMs` across `pixelWidth` — the smallest "nice" interval (1/5/10/15/
 * 30s, 1/5/10/30min, ...) that still leaves at least ~70px between labels, so
 * they never crowd regardless of zoom level.
 */
export function pickTickIntervalMs(durationMs: number, pixelWidth: number): number {
  const NICE_SECONDS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600]
  const MIN_LABEL_SPACING_PX = 70
  if (pixelWidth <= 0 || durationMs <= 0) return 1000

  for (const seconds of NICE_SECONDS) {
    const px = (seconds * 1000 * pixelWidth) / durationMs
    if (px >= MIN_LABEL_SPACING_PX) return seconds * 1000
  }
  // Longer than an hour: fall back to whole-hour steps.
  const hours = Math.ceil(durationMs / 3_600_000 / (pixelWidth / MIN_LABEL_SPACING_PX))
  return Math.max(1, hours) * 3_600_000
}
