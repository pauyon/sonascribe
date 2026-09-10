import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { sourceMediaUrl } from '@shared/ipc'
import { EXPORT_FORMATS } from '@shared/export'
import { DEFAULT_MARKER_COLOR } from '@shared/types'
import { api, useEvent, useQuery } from '../lib/api'
import { useAudio } from '../lib/useAudio'
import { useCutAwarePlayback } from '../lib/useCutAwarePlayback'
import { useMarkers } from '../lib/useMarkers'
import { useTranscript } from '../lib/useTranscript'
import { useSpeakers } from '../lib/useSpeakers'
import { useSpeakerDeleteUndo } from '../lib/useSpeakerDeleteUndo'
import { useAsyncAction } from '../lib/useAsyncAction'
import { copyPlainText, copyWithSpeakers, copyWithTimestamps } from '../lib/transcriptCopy'
import { cutAt, realToVirtual } from '../lib/cuts'
import { formatDuration } from '../lib/format'
import StatusPill from '../components/StatusPill'
import PlayerBar from '../components/PlayerBar'
import MarkerChips from '../components/MarkerChips'
import SpeakerChips from '../components/SpeakerChips'
import TranscriptPanel from '../components/TranscriptPanel'
import AskPanel from '../components/AskPanel'
import OverflowMenu, { type OverflowMenuItem } from '../components/OverflowMenu'
import ProgressBar from '../components/ProgressBar'
import ConfirmDialog from '../components/ConfirmDialog'
import IconButton from '../components/IconButton'
import Icon from '../components/Icon'

/** A single recording: playback (respecting any cuts), rename, delete, reveal-in-folder. */
export default function Editor(): React.JSX.Element {
  const { id = '' } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const { data: recording, error, loading, refetch } = useQuery('recordings:get', { id })

  const [draftTitle, setDraftTitle] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [transcriptMode, setTranscriptMode] = useState<'speakers' | 'timestamps'>('speakers')
  /** The color the next marker will use — sticky across adds until the user picks a different one, so a run of moments can be tagged the same color in one pass. */
  const [markerColor, setMarkerColor] = useState(DEFAULT_MARKER_COLOR)
  /** Speaker id the transcript below is narrowed to, or null to show every speaker. */
  const [speakerFilter, setSpeakerFilter] = useState<string | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [askOpen, setAskOpen] = useState(false)
  /** Shared error surface for the clipboard-copy/export actions below. */
  const { error: actionAsyncError, run: runAction } = useAsyncAction()

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

  /**
   * A citation from the library-wide Ask screen navigates here with a
   * target timestamp in router state (`Ask.tsx`) rather than a query
   * param, since it's a one-shot "jump once loaded" rather than a
   * shareable URL. Waits for `durationMs` — metadata loaded — since a
   * seek issued before that can be silently dropped by the media element.
   * Clears the state afterward so revisiting this page normally (back
   * button, sidebar) doesn't reseek.
   */
  useEffect(() => {
    const seekMs = (location.state as { seekMs?: number } | null)?.seekMs
    if (seekMs == null || audio.durationMs == null) return
    audio.seek(seekMs)
    navigate(location.pathname, { replace: true, state: null })
  }, [audio.durationMs, audio.seek, location.state, location.pathname, navigate])
  const { compressed, virtualDur, virtualPosition, seekVirtual } = useCutAwarePlayback(recording, audio)
  const {
    markers,
    addMarkerAt,
    rename: renameMarker,
    recolor: recolorMarker,
    remove: removeMarker,
    clearAll: clearAllMarkers
  } = useMarkers(recording, refetch)
  const transcript = useTranscript(id)
  const speakers = useSpeakers(id, transcript.refetch)
  const speakerDeleteUndo = useSpeakerDeleteUndo({
    speakers: speakers.speakers,
    utterances: transcript.utterances,
    speakerFilter,
    setSpeakerFilter,
    remove: speakers.remove,
    removeKeepLines: speakers.removeKeepLines
  })

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

  async function copy(text: string): Promise<void> {
    await runAction(() => navigator.clipboard.writeText(text))
  }

  async function exportTranscript(format: (typeof EXPORT_FORMATS)[number]['id']): Promise<void> {
    await runAction(() => api.invoke('transcript:export', { recordingId: id, format }))
  }

  async function exportAudio(): Promise<void> {
    await runAction(() => api.invoke('audio:export', { recordingId: id }))
  }

  const hasTranscript = recording.transcriptStatus === 'ready' && (transcript.utterances?.length ?? 0) > 0
  const hasSpeakers = speakers.speakers.length > 0
  const normalizedSearch = searchQuery.trim().toLowerCase()
  const visibleUtterances = (transcript.utterances ?? []).filter(
    (u) =>
      !speakerDeleteUndo.hiddenUtteranceIds.has(u.id) &&
      (!speakerFilter || u.speaker?.id === speakerFilter) &&
      (!normalizedSearch || u.text.toLowerCase().includes(normalizedSearch))
  )
  const speakerBusy = recording.speakerStatus === 'queued' || recording.speakerStatus === 'detecting'

  const overflowGroups: OverflowMenuItem[][] = [
    // Edit — the one action used almost every time, so it leads.
    recording.sourcePath
      ? [{ icon: 'edit', label: 'Edit', onClick: () => navigate(`/recordings/${recording.id}/edit`) }]
      : [],
    // Processing: (re-)transcribe, then detect speakers off that transcript.
    [
      ...(recording.sourcePath && (recording.transcriptStatus === 'none' || recording.transcriptStatus === 'failed')
        ? ([
            {
              icon: 'transcribe',
              label: recording.transcriptStatus === 'failed' ? 'Retry transcription' : 'Transcribe',
              onClick: () => void transcript.start()
            }
          ] satisfies OverflowMenuItem[])
        : []),
      ...(recording.sourcePath && recording.transcriptStatus === 'ready'
        ? ([{ icon: 'transcribe', label: 'Re-transcribe', onClick: () => void transcript.start() }] satisfies OverflowMenuItem[])
        : []),
      // First-time detection now lives in the always-visible header button
      // (see .page__actions) — this stays for re-running it after the fact,
      // once there's something to re-run.
      ...(hasTranscript && hasSpeakers
        ? ([
            {
              icon: 'speakers',
              label: 'Re-run Speaker Detection',
              onClick: () => void speakers.detect(),
              disabled: speakerBusy
            }
          ] satisfies OverflowMenuItem[])
        : [])
    ],
    // Copy: quick clipboard variants of the transcript already in view — collapsed
    // into one flyout so the three variants don't each cost a row of their own.
    hasTranscript
      ? [
          {
            icon: 'copy',
            label: 'Copy Transcript',
            children: [
              { label: 'Copy Text', onClick: () => void copy(copyPlainText(transcript.utterances!)) },
              { label: 'Copy with Timestamps', onClick: () => void copy(copyWithTimestamps(transcript.utterances!)) },
              ...(hasSpeakers
                ? [{ label: 'Copy with Speakers', onClick: () => void copy(copyWithSpeakers(transcript.utterances!)) }]
                : [])
            ]
          }
        ]
      : [],
    // File actions: reveal on disk, export audio and transcript to a file —
    // the five transcript formats collapse into one flyout for the same reason.
    [
      ...(recording.sourcePath
        ? ([
            {
              icon: 'folder',
              label: 'Reveal in folder',
              onClick: () => void api.invoke('shell:showItemInFolder', { path: recording.sourcePath! })
            },
            { icon: 'volume', label: 'Export Audio', onClick: () => void exportAudio() }
          ] satisfies OverflowMenuItem[])
        : []),
      ...(hasTranscript
        ? ([
            {
              icon: 'download',
              label: 'Export Transcript',
              children: EXPORT_FORMATS.map((spec) => ({
                label: spec.label,
                onClick: () => void exportTranscript(spec.id)
              }))
            }
          ] satisfies OverflowMenuItem[])
        : [])
    ],
    // Delete — destructive, so it trails on its own.
    [{ icon: 'trash', label: 'Delete recording', danger: true, onClick: () => setConfirmingDelete(true) }]
  ]

  // Shared props between the in-flow and floating `PlayerBar` — they differ
  // only in the `floating` flag applied at each call site.
  const playerProps = {
    audio,
    peaks: compressed,
    durationMs: recording.durationMs ?? 0,
    virtualDurationMs: virtualDur,
    positionMs: virtualPosition,
    onSeek: seekVirtual,
    seams: compressed.seams,
    markers: markerPins,
    onAddMarker: () => addMarkerAt(audio.currentMs, markerColor),
    markerColor,
    onMarkerColorChange: setMarkerColor
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
          {hasTranscript && (
            <IconButton
              icon="search"
              active={searchOpen}
              aria-pressed={searchOpen}
              aria-label={searchOpen ? 'Close transcript search' : 'Search transcript'}
              title="Search transcript"
              onClick={() =>
                setSearchOpen((open) => {
                  if (open) setSearchQuery('')
                  return !open
                })
              }
            />
          )}
          {hasTranscript && (
            <IconButton
              icon="chat"
              active={askOpen}
              aria-pressed={askOpen}
              aria-label={askOpen ? 'Close Ask panel' : 'Ask about this recording'}
              title="Ask about this recording"
              onClick={() => setAskOpen((open) => !open)}
            />
          )}
          {hasTranscript && (
            <IconButton
              icon="speakers"
              active={hasSpeakers && transcriptMode === 'speakers'}
              disabled={speakerBusy}
              aria-pressed={hasSpeakers && transcriptMode === 'speakers'}
              aria-label={
                !hasSpeakers
                  ? 'Detect speakers'
                  : transcriptMode === 'speakers'
                    ? 'Hide speaker labels'
                    : 'Show speaker labels'
              }
              title={
                speakerBusy
                  ? 'Detecting speakers…'
                  : !hasSpeakers
                    ? 'Detect speakers'
                    : transcriptMode === 'speakers'
                      ? 'Showing speakers & timestamps'
                      : 'Showing timestamps only'
              }
              onClick={() =>
                hasSpeakers
                  ? setTranscriptMode((m) => (m === 'speakers' ? 'timestamps' : 'speakers'))
                  : void speakers.detect()
              }
            />
          )}
          <OverflowMenu groups={overflowGroups} ariaLabel="More actions" />
        </div>
      </header>

      {confirmingDelete && (
        <ConfirmDialog
          title="Delete recording?"
          message={
            <>
              This can&rsquo;t be undone — the audio file, and any cuts or markers on it, will
              be permanently removed.
            </>
          }
          confirmLabel="Delete permanently"
          onConfirm={deleteRecording}
          onCancel={() => setConfirmingDelete(false)}
        />
      )}

      {recording.error && <div className="banner banner--error">{recording.error}</div>}
      {actionError && <div className="banner banner--error">{actionError}</div>}
      {actionAsyncError && <div className="banner banner--error">{actionAsyncError}</div>}
      {transcript.startError && <div className="banner banner--error">{transcript.startError}</div>}
      {recording.transcriptStatus === 'failed' && recording.transcriptError && (
        <div className="banner banner--error">{recording.transcriptError}</div>
      )}
      {speakers.detectError && <div className="banner banner--error">{speakers.detectError}</div>}
      {recording.speakerStatus === 'failed' && recording.speakerError && (
        <div className="banner banner--error">{recording.speakerError}</div>
      )}

      {(recording.speakerStatus === 'queued' || recording.speakerStatus === 'detecting') && (
        <div className="toolbar">
          <div style={{ flex: 1 }}>
            <ProgressBar
              fraction={speakers.progress}
              label={
                recording.speakerStatus === 'queued'
                  ? 'Queued…'
                  : speakers.progress == null
                    ? 'Detecting speakers…'
                    : `Detecting speakers… ${Math.round(speakers.progress * 100)}%`
              }
            />
          </div>
          <button type="button" className="btn btn--ghost btn--sm" onClick={speakers.cancel}>
            Cancel
          </button>
        </div>
      )}

      {(recording.transcriptStatus === 'queued' || recording.transcriptStatus === 'transcribing') && (
        <div className="toolbar">
          <div style={{ flex: 1 }}>
            <ProgressBar
              fraction={transcript.progress}
              label={
                recording.transcriptStatus === 'queued'
                  ? 'Queued…'
                  : transcript.progress == null
                    ? 'Transcribing…'
                    : `Transcribing… ${Math.round(transcript.progress * 100)}%`
              }
            />
          </div>
          <button type="button" className="btn btn--ghost btn--sm" onClick={transcript.cancel}>
            Cancel
          </button>
        </div>
      )}

      {playbackSrc && (
        <>
          <audio ref={audio.ref} src={playbackSrc} preload="metadata" {...audio.bind} />
          <div ref={playerSentinelRef}>
            <PlayerBar {...playerProps} />
          </div>
          {playerFloating && <PlayerBar {...playerProps} floating />}

          <MarkerChips
            markers={annotatedMarkers}
            onJump={(marker) => audio.seek(marker.timeMs)}
            onRename={renameMarker}
            onRecolor={recolorMarker}
            onRemove={removeMarker}
            onClearAll={clearAllMarkers}
          />

          {speakerDeleteUndo.pendingDelete && (
            <div className="toast">
              <span>{speakerDeleteUndo.pendingDelete.label}</span>
              <button type="button" className="toast__action" onClick={speakerDeleteUndo.undo}>
                Undo
              </button>
            </div>
          )}

          {askOpen && (
            <div className="ask-card">
              <AskPanel
                recordingId={recording.id}
                onSeek={audio.seek}
                onNavigateToRecording={(targetId, ms) =>
                  navigate(`/recordings/${targetId}`, { state: { seekMs: ms } })
                }
              />
            </div>
          )}

          {searchOpen && (
            <div className="search-bar">
              <Icon name="search" className="search-bar__icon" />
              <input
                type="text"
                className="input search-bar__input"
                value={searchQuery}
                autoFocus
                onFocus={(e) => e.currentTarget.select()}
                placeholder="Search transcript…"
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault()
                    setSearchOpen(false)
                    setSearchQuery('')
                  }
                }}
              />
              {normalizedSearch && (
                <span className="search-bar__count">
                  {visibleUtterances.length} {visibleUtterances.length === 1 ? 'match' : 'matches'}
                </span>
              )}
              <button
                type="button"
                className="search-bar__close"
                onClick={() => {
                  setSearchOpen(false)
                  setSearchQuery('')
                }}
                aria-label="Close search"
              >
                <Icon name="close" />
              </button>
            </div>
          )}

          {transcriptMode === 'speakers' && (
            <SpeakerChips
              speakers={speakers.speakers.filter((s) => !speakerDeleteUndo.hiddenSpeakerIds.has(s.id))}
              utterances={transcript.utterances ?? []}
              filter={speakerFilter}
              onFilterChange={setSpeakerFilter}
              onRename={speakers.rename}
              onRecolor={speakers.recolor}
              onMerge={speakers.merge}
              onRemove={speakerDeleteUndo.removePending}
              onCreate={speakers.create}
            />
          )}

          {recording.transcriptStatus === 'ready' && transcript.utterances && (
            <TranscriptPanel
              utterances={visibleUtterances}
              currentMs={audio.currentMs}
              onSeek={audio.seek}
              mode={transcriptMode}
              speakers={speakers.speakers.filter((s) => !speakerDeleteUndo.hiddenSpeakerIds.has(s.id))}
              onReassignSpeaker={speakers.reassignUtterance}
              onEditText={transcript.editText}
              onSplitUtterance={transcript.splitUtterance}
              markers={markers}
              highlightQuery={normalizedSearch || undefined}
              isolatedSpeakerName={speakerFilter ? (speakers.speakers.find((s) => s.id === speakerFilter)?.displayName ?? null) : null}
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
    </div>
  )
}
