import { PLAYBACK_RATES, type AudioController } from '../lib/useAudio'
import { formatDuration } from '../lib/format'
import Waveform from './Waveform'

/** Transport controls plus the waveform, driven by a shared AudioController. */
export default function PlayerBar({
  audio,
  peaks,
  durationMs,
  floating = false
}: {
  audio: AudioController
  peaks: number[] | null
  /** Duration from the database, used until the media element reports its own. */
  durationMs: number
  /** Pinned to the bottom of the window, in place of the normal in-flow card. */
  floating?: boolean
}): React.JSX.Element {
  const total = audio.durationMs ?? durationMs

  return (
    <div className={floating ? 'player player--floating' : 'player'}>
      <button
        className="player__play"
        onClick={audio.toggle}
        aria-label={audio.playing ? 'Pause' : 'Play'}
      >
        {audio.playing ? '❚❚' : '▶'}
      </button>

      <span className="player__time">{formatDuration(audio.currentMs)}</span>

      {peaks && peaks.length > 0 ? (
        <Waveform
          peaks={peaks}
          durationMs={total}
          positionMs={audio.currentMs}
          onSeek={audio.seek}
        />
      ) : (
        // Peaks arrive a moment after the page; a range input keeps the player
        // usable in the meantime rather than showing a dead gap.
        <input
          className="player__scrub"
          type="range"
          min={0}
          max={total}
          value={audio.currentMs}
          onChange={(e) => audio.seek(Number(e.target.value))}
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
