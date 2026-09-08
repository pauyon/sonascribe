import { PLAYBACK_RATES, type AudioController } from '../lib/useAudio'
import { formatDuration } from '../lib/format'
import Waveform from './Waveform'

/** Transport controls plus the waveform, driven by a shared AudioController. */
export default function PlayerBar({
  audio,
  peaks,
  durationMs,
  floating = false,
  virtualDurationMs,
  positionMs,
  onSeek,
  seams,
  editable = false,
  onSelectRange
}: {
  audio: AudioController
  peaks: number[] | null
  /** Duration from the database, used until the media element reports its own. */
  durationMs: number
  /** Pinned to the bottom of the window, in place of the normal in-flow card. */
  floating?: boolean
  /**
   * Overrides the displayed/waveform total, ignoring both `audio.durationMs`
   * and `durationMs` — the recording-detail page passes the cuts-compressed
   * duration here while trimming is in play. `audio.durationMs` always
   * reflects the real underlying file (the `<audio>` element never knows
   * about cuts), so it must not win over this when it's supplied.
   */
  virtualDurationMs?: number
  /** Overrides `audio.currentMs` for display/waveform position — virtual (compressed) time instead of the real underlying playback position. */
  positionMs?: number
  /** Overrides `audio.seek` — converts a virtual seek target back to a real one before actually seeking. */
  onSeek?: (ms: number) => void
  seams?: number[]
  editable?: boolean
  onSelectRange?: (startMs: number, endMs: number) => void
}): React.JSX.Element {
  const total = virtualDurationMs ?? audio.durationMs ?? durationMs
  const position = positionMs ?? audio.currentMs
  const seek = onSeek ?? audio.seek

  return (
    <div className={floating ? 'player player--floating' : 'player'}>
      <button
        className="player__play"
        onClick={audio.toggle}
        aria-label={audio.playing ? 'Pause' : 'Play'}
      >
        {audio.playing ? '❚❚' : '▶'}
      </button>

      <span className="player__time">{formatDuration(position)}</span>

      {peaks && peaks.length > 0 ? (
        <Waveform
          peaks={peaks}
          durationMs={total}
          positionMs={position}
          onSeek={seek}
          seams={seams}
          editable={editable}
          onSelectRange={onSelectRange}
        />
      ) : (
        // Peaks arrive a moment after the page; a range input keeps the player
        // usable in the meantime rather than showing a dead gap.
        <input
          className="player__scrub"
          type="range"
          min={0}
          max={total}
          value={position}
          onChange={(e) => seek(Number(e.target.value))}
          disabled={total === 0}
          aria-label="Seek"
        />
      )}

      <span className="player__time player__time--total">{formatDuration(total)}</span>

      <button
        type="button"
        className="player__rate"
        onClick={() => {
          const i = PLAYBACK_RATES.indexOf(audio.rate)
          audio.setRate(PLAYBACK_RATES[(i + 1) % PLAYBACK_RATES.length])
        }}
        title="Playback speed"
        aria-label={`Playback speed: ${audio.rate}×. Click to change.`}
      >
        {audio.rate}×
      </button>

      {audio.error && <span className="player__error">{audio.error}</span>}
    </div>
  )
}
