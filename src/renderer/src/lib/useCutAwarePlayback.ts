import { useEffect, useMemo, useState } from 'react'
import type { Recording } from '@shared/types'
import { api } from './api'
import type { AudioController } from './useAudio'
import { compressPeaks, cutAt, realToVirtual, virtualDuration, virtualToReal } from './cuts'

/**
 * The "respect whatever cuts exist" layer shared by every page that plays a
 * recording — the recording-detail page and the dedicated editor page alike.
 * Owns fetching peaks, compressing them around the recording's cuts, mapping
 * the real `<audio>` position to virtual (compressed) time, and skipping the
 * real element past a cut the instant playback drifts into one.
 *
 * Everything here operates in *virtual* ms — real time with every cut
 * collapsed out. The dedicated editor page layers its own zoom window on top
 * of this (see `lib/cuts.ts::sliceCompressed`); this hook doesn't know zoom
 * exists.
 */
export function useCutAwarePlayback(
  recording: Recording | null | undefined,
  audio: AudioController
): {
  compressed: { values: number[]; seams: number[] }
  virtualDur: number
  virtualPosition: number
  /** Seeks real playback to the real ms that corresponds to a virtual ms. */
  seekVirtual: (virtualMs: number) => void
} {
  const [peaks, setPeaks] = useState<number[] | null>(null)

  const id = recording?.id
  const status = recording?.status
  const durationMs = recording?.durationMs ?? 0
  const cuts = useMemo(() => recording?.cuts ?? [], [recording?.cuts])

  // Peaks come from the main process; the renderer cannot read the audio
  // itself. Re-fetched once the recording becomes ready, since there is
  // nothing to compute a waveform from before that.
  useEffect(() => {
    if (!id || status !== 'ready') {
      setPeaks(null)
      return
    }
    let cancelled = false
    api
      .invoke('peaks:get', { recordingId: id })
      .then((result) => {
        if (!cancelled) setPeaks(result.values)
      })
      .catch(() => {
        // A missing waveform is cosmetic — the range-input fallback still seeks.
        if (!cancelled) setPeaks(null)
      })
    return () => {
      cancelled = true
    }
  }, [id, status])

  // The trim math (lib/cuts.ts) is pure and cheap, but there's no reason to
  // re-run it on every playback tick — only when the underlying data (peaks,
  // duration, or the cut list itself) actually changes.
  const compressed = useMemo(() => compressPeaks(peaks ?? [], durationMs, cuts), [peaks, durationMs, cuts])
  const virtualDur = useMemo(() => virtualDuration(durationMs, cuts), [durationMs, cuts])
  const virtualPosition = useMemo(
    () => realToVirtual(audio.currentMs, durationMs, cuts),
    [audio.currentMs, durationMs, cuts]
  )

  // Playback skip: the real <audio> element has no idea cuts exist, so once
  // its position drifts into one, jump it past the end — same `seek` already
  // used for click-to-seek. Only fires forward, and only while playing, so
  // it can never fight a seek the user just made.
  useEffect(() => {
    if (!audio.playing) return
    const cut = cutAt(audio.currentMs, cuts)
    if (cut) audio.seek(cut.endMs)
  }, [audio.currentMs, audio.playing, audio.seek, cuts])

  const seekVirtual = (virtualMs: number): void => audio.seek(virtualToReal(virtualMs, durationMs, cuts))

  return { compressed, virtualDur, virtualPosition, seekVirtual }
}
