import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { sourceMediaUrl } from '@shared/ipc'
import { api, useEvent, useQuery } from '../lib/api'
import { useAudio } from '../lib/useAudio'
import { formatDuration } from '../lib/format'
import StatusPill from '../components/StatusPill'
import PlayerBar from '../components/PlayerBar'

/** A single recording: playback, rename, delete, reveal-in-folder. */
export default function Editor(): React.JSX.Element {
  const { id = '' } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { data: recording, error, loading, refetch } = useQuery('recordings:get', { id })

  const [draftTitle, setDraftTitle] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [peaks, setPeaks] = useState<number[] | null>(null)

  /**
   * Whether the in-flow player card has scrolled above the top of the window.
   *
   * The player sits at the top of the page, so — unlike a sticky-top bar,
   * which only has to catch itself before leaving through the same edge it's
   * pinned to — there is no scroll edge it naturally approaches on the way to
   * the bottom. A floating bottom copy is swapped in via this flag instead,
   * once the real one has scrolled out of view above the fold.
   */
  const [playerFloating, setPlayerFloating] = useState(false)
  const playerSentinelRef = useRef<HTMLDivElement>(null)

  const playbackSrc = recording?.sourcePath ? sourceMediaUrl(recording.id) : null
  const audio = useAudio(playbackSrc)

  useEffect(() => {
    const sentinel = playerSentinelRef.current
    if (!sentinel) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        // Not intersecting *and above* the viewport — as opposed to not yet
        // scrolled to — is what "scrolled past" means here.
        setPlayerFloating(!entry.isIntersecting && entry.boundingClientRect.top < 0)
      },
      { threshold: 0 }
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [playbackSrc])

  useEvent('recording:updated', (updated) => {
    if (updated.id !== id) return
    refetch()
  })

  // Peaks come from the main process; the renderer cannot read the audio
  // itself. Re-fetched once the recording becomes ready, since there is
  // nothing to compute a waveform from before that.
  const status = recording?.status
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

  if (loading) return <div className="page">Loading…</div>
  if (error) return <div className="page banner banner--error">{error}</div>
  if (!recording) {
    return (
      <div className="page">
        <div className="empty">
          <h2>Recording not found</h2>
          <Link className="btn" to="/library">
            Back to library
          </Link>
        </div>
      </div>
    )
  }

  async function commitTitle(): Promise<void> {
    const next = draftTitle?.trim()
    setDraftTitle(null)
    if (!next || !recording || next === recording.title) return
    await api.invoke('recordings:rename', { id: recording.id, title: next })
    refetch()
  }

  return (
    <div className={playbackSrc ? 'page page--has-player' : 'page'}>
      <header className="page__header">
        <div>
          <Link className="page__back" to="/library">
            ← Library
          </Link>
          {draftTitle === null ? (
            <h1
              className="page__title-editable"
              onClick={() => setDraftTitle(recording.title)}
              title="Click to rename"
            >
              {recording.title}
            </h1>
          ) : (
            <input
              className="input input--title"
              value={draftTitle}
              autoFocus
              onChange={(e) => setDraftTitle(e.target.value)}
              onBlur={commitTitle}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void commitTitle()
                if (e.key === 'Escape') setDraftTitle(null)
              }}
            />
          )}
          <p className="page__subtitle">
            <StatusPill status={recording.status} />
            <span className="page__meta">{formatDuration(recording.durationMs)}</span>
          </p>
        </div>

        {recording.sourcePath && (
          <div className="page__actions">
            <button
              className="btn"
              onClick={() =>
                void api.invoke('shell:showItemInFolder', { path: recording.sourcePath! })
              }
            >
              Reveal in folder
            </button>
          </div>
        )}
      </header>

      {recording.error && <div className="banner banner--error">{recording.error}</div>}
      {actionError && <div className="banner banner--error">{actionError}</div>}

      {playbackSrc && (
        <>
          <audio ref={audio.ref} src={playbackSrc} preload="metadata" {...audio.bind} />
          <div ref={playerSentinelRef}>
            <PlayerBar audio={audio} peaks={peaks} durationMs={recording.durationMs ?? 0} />
          </div>
          {playerFloating && (
            <PlayerBar
              audio={audio}
              peaks={peaks}
              durationMs={recording.durationMs ?? 0}
              floating
            />
          )}
        </>
      )}

      {!playbackSrc && (
        <div className="empty">
          <h2>{recording.status === 'normalizing' ? 'Preparing…' : 'No audio'}</h2>
          <p>
            {recording.status === 'normalizing'
              ? 'This recording is still being prepared.'
              : 'This recording has no audio file.'}
          </p>
        </div>
      )}

      <div className="page__footer">
        <button
          className="btn btn--ghost menu__danger"
          onClick={() => {
            setActionError(null)
            api
              .invoke('recordings:delete', { id: recording.id })
              .then(() => navigate('/library'))
              .catch((err: unknown) => {
                setActionError(err instanceof Error ? err.message : String(err))
              })
          }}
        >
          Delete recording
        </button>
      </div>
    </div>
  )
}
