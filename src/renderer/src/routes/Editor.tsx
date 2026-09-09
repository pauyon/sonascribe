import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { sourceMediaUrl } from '@shared/ipc'
import { api, useEvent, useQuery } from '../lib/api'
import { useAudio } from '../lib/useAudio'
import { useCutAwarePlayback } from '../lib/useCutAwarePlayback'
import { useMarkers } from '../lib/useMarkers'
import { cutAt, realToVirtual } from '../lib/cuts'
import { formatDuration } from '../lib/format'
import StatusPill from '../components/StatusPill'
import PlayerBar from '../components/PlayerBar'
import MarkerChips from '../components/MarkerChips'

/** A single recording: playback (respecting any cuts), rename, delete, reveal-in-folder. */
export default function Editor(): React.JSX.Element {
  const { id = '' } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { data: recording, error, loading, refetch } = useQuery('recordings:get', { id })

  const [draftTitle, setDraftTitle] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

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
  const { compressed, virtualDur, virtualPosition, seekVirtual } = useCutAwarePlayback(recording, audio)
  const {
    markers,
    addMarkerAt,
    rename: renameMarker,
    recolor: recolorMarker,
    remove: removeMarker,
    clearAll: clearAllMarkers
  } = useMarkers(recording, refetch)

  const durationMs = recording?.durationMs ?? 0
  const cuts = useMemo(() => recording?.cuts ?? [], [recording?.cuts])

  // Pins on the waveform: only the ones a cut hasn't since swallowed, mapped
  // into the same compressed/virtual space the waveform itself is drawn in.
  const markerPins = useMemo(
    () =>
      markers
        .filter((m) => !cutAt(m.timeMs, cuts))
        .map((m) => ({ positionMs: realToVirtual(m.timeMs, durationMs, cuts), color: m.color })),
    [markers, durationMs, cuts]
  )
  const annotatedMarkers = useMemo(
    () => markers.map((m) => ({ ...m, jumpable: !cutAt(m.timeMs, cuts) })),
    [markers, cuts]
  )

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

  // Space to play/pause, matching the dedicated editor page. Ignored while a
  // text field has focus (renaming the title, editing a marker label) so it
  // types a literal space instead of hijacking playback.
  useEffect(() => {
    if (!playbackSrc) return

    function isTypingTarget(target: EventTarget | null): boolean {
      if (!(target instanceof HTMLElement)) return false
      return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable
    }

    function onKeyDown(e: KeyboardEvent): void {
      if (e.key !== ' ' || e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return
      e.preventDefault()
      audio.toggle()
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [playbackSrc, audio])

  useEffect(() => {
    if (!confirmingDelete) return
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') setConfirmingDelete(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [confirmingDelete])

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

  function deleteRecording(): void {
    if (!recording) return
    setActionError(null)
    api
      .invoke('recordings:delete', { id: recording.id })
      .then(() => navigate('/library'))
      .catch((err: unknown) => {
        setActionError(err instanceof Error ? err.message : String(err))
        setConfirmingDelete(false)
      })
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

        <div className="page__actions">
          {recording.sourcePath && (
            <>
              <Link className="btn btn--primary" to={`/recordings/${recording.id}/edit`}>
                Edit
              </Link>
              <button
                className="btn"
                onClick={() =>
                  void api.invoke('shell:showItemInFolder', { path: recording.sourcePath! })
                }
              >
                Reveal in folder
              </button>
            </>
          )}
          <button className="btn btn--danger" onClick={() => setConfirmingDelete(true)}>
            Delete recording
          </button>
        </div>
      </header>

      {confirmingDelete && (
        <div className="modal-overlay" onClick={() => setConfirmingDelete(false)}>
          <div
            className="modal modal--confirm"
            onClick={(e) => e.stopPropagation()}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="delete-confirm-title"
          >
            <div className="modal__header">
              <h2 id="delete-confirm-title">Delete recording?</h2>
            </div>
            <p>
              This can&rsquo;t be undone — the audio file, and any cuts or markers on it, will
              be permanently removed.
            </p>
            <div className="modal__footer">
              <button
                type="button"
                className="btn btn--ghost"
                autoFocus
                onClick={() => setConfirmingDelete(false)}
              >
                Cancel
              </button>
              <button type="button" className="btn btn--danger" onClick={deleteRecording}>
                Delete permanently
              </button>
            </div>
          </div>
        </div>
      )}

      {recording.error && <div className="banner banner--error">{recording.error}</div>}
      {actionError && <div className="banner banner--error">{actionError}</div>}

      {playbackSrc && (
        <>
          <audio ref={audio.ref} src={playbackSrc} preload="metadata" {...audio.bind} />
          <div ref={playerSentinelRef}>
            <PlayerBar
              audio={audio}
              peaks={compressed}
              durationMs={recording.durationMs ?? 0}
              virtualDurationMs={virtualDur}
              positionMs={virtualPosition}
              onSeek={seekVirtual}
              seams={compressed.seams}
              markers={markerPins}
            />
          </div>
          {playerFloating && (
            <PlayerBar
              audio={audio}
              peaks={compressed}
              durationMs={recording.durationMs ?? 0}
              virtualDurationMs={virtualDur}
              positionMs={virtualPosition}
              onSeek={seekVirtual}
              seams={compressed.seams}
              markers={markerPins}
              floating
            />
          )}

          <div className="page__actions page__actions--inline">
            <button
              type="button"
              className="btn btn--ghost icon-btn"
              onClick={() => addMarkerAt(audio.currentMs)}
              aria-label={`Add marker at ${formatDuration(audio.currentMs)}`}
              title={`Add marker at ${formatDuration(audio.currentMs)}`}
            >
              🚩
            </button>
          </div>

          <MarkerChips
            markers={annotatedMarkers}
            onJump={(marker) => audio.seek(marker.timeMs)}
            onRename={renameMarker}
            onRecolor={recolorMarker}
            onRemove={removeMarker}
            onClearAll={clearAllMarkers}
          />
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
    </div>
  )
}
