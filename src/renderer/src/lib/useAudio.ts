import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Owns a single <audio> element and exposes its state plus seek/play controls.
 *
 * Lifted out of the player component because the waveform and the transcript
 * both need to drive playback, and passing a ref around between siblings is a
 * worse arrangement than one hook the parent holds.
 */

/** Speeds offered on the player — the common set most players expose. */
export const PLAYBACK_RATES = [1, 1.5, 2] as const
export type PlaybackRate = (typeof PLAYBACK_RATES)[number]

export interface AudioController {
  /** Attach to an <audio> element rendered by the caller. */
  ref: React.RefObject<HTMLAudioElement | null>
  playing: boolean
  currentMs: number
  /** From the media element itself; null until metadata loads. */
  durationMs: number | null
  error: string | null
  rate: PlaybackRate
  setRate: (rate: PlaybackRate) => void
  toggle: () => void
  seek: (ms: number) => void
  /** Bind to the <audio> element to keep this hook's state in sync. */
  bind: {
    onPlay: () => void
    onPause: () => void
    onEnded: () => void
    onTimeUpdate: (e: React.SyntheticEvent<HTMLAudioElement>) => void
    onLoadedMetadata: (e: React.SyntheticEvent<HTMLAudioElement>) => void
    onError: () => void
  }
}

export function useAudio(src: string | null): AudioController {
  const ref = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [currentMs, setCurrentMs] = useState(0)
  const [durationMs, setDurationMs] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [rate, setRateState] = useState<PlaybackRate>(1)

  // Reset when switching recordings, or the previous position and duration
  // briefly show against the new file. Speed is left alone — it reads as a
  // listening preference, not something tied to one recording.
  useEffect(() => {
    setPlaying(false)
    setCurrentMs(0)
    setDurationMs(null)
    setError(null)
  }, [src])

  // The element's own playbackRate is the source of truth; this just keeps a
  // freshly (re)mounted <audio> — a new src swaps the element's state, not
  // the element itself, but this stays correct either way — in step with it.
  useEffect(() => {
    const el = ref.current
    if (el) el.playbackRate = rate
  }, [rate, src])

  const setRate = useCallback((next: PlaybackRate) => {
    setRateState(next)
  }, [])

  const toggle = useCallback(() => {
    const el = ref.current
    if (!el) return
    if (el.paused) {
      void el.play().catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err))
      })
    } else {
      el.pause()
    }
  }, [])

  const seek = useCallback((ms: number) => {
    const el = ref.current
    if (!el) return
    el.currentTime = Math.max(0, ms) / 1000
    // Update immediately rather than waiting for the next timeupdate, so the
    // playhead does not lag a click by up to a quarter second.
    setCurrentMs(Math.max(0, ms))
  }, [])

  return {
    ref,
    playing,
    currentMs,
    durationMs,
    error,
    rate,
    setRate,
    toggle,
    seek,
    bind: {
      onPlay: () => setPlaying(true),
      onPause: () => setPlaying(false),
      onEnded: () => setPlaying(false),
      onTimeUpdate: (e) => setCurrentMs(Math.round(e.currentTarget.currentTime * 1000)),
      onLoadedMetadata: (e) => {
        const d = e.currentTarget.duration
        // A stream whose length is unknown reports Infinity.
        setDurationMs(Number.isFinite(d) ? Math.round(d * 1000) : null)
      },
      onError: () => setError('This file could not be played.')
    }
  }
}
