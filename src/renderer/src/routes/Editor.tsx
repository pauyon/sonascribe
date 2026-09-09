import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { sourceMediaUrl } from '@shared/ipc'
import { EXPORT_FORMATS } from '@shared/export'
import { api, useEvent, useQuery } from '../lib/api'
import { useAudio } from '../lib/useAudio'
import { useCutAwarePlayback } from '../lib/useCutAwarePlayback'
import { DEFAULT_MARKER_COLOR, useMarkers } from '../lib/useMarkers'
import { useTranscript } from '../lib/useTranscript'
import { useSpeakers } from '../lib/useSpeakers'
import { copyPlainText, copyWithSpeakers, copyWithTimestamps } from '../lib/transcriptCopy'
import { cutAt, realToVirtual } from '../lib/cuts'
import { formatDuration } from '../lib/format'
import StatusPill from '../components/StatusPill'
import PlayerBar from '../components/PlayerBar'
import MarkerChips from '../components/MarkerChips'
import SpeakerChips from '../components/SpeakerChips'
import TranscriptPanel from '../components/TranscriptPanel'
import OverflowMenu, { type OverflowMenuItem } from '../components/OverflowMenu'
import Icon from '../components/Icon'

/** A single recording: playback (respecting any cuts), rename, delete, reveal-in-folder. */
export default function Editor(): React.JSX.Element {
  const { id = '' } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { data: recording, error, loading, refetch } = useQuery('recordings:get', { id })

  const [draftTitle, setDraftTitle] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [transcriptMode, setTranscriptMode] = useState<'speakers' | 'timestamps'>('speakers')
  /** The color the next marker will use — sticky across adds until the user picks a different one, so a run of moments can be tagged the same color in one pass. */
  const [markerColor, setMarkerColor] = useState(DEFAULT_MARKER_COLOR)

  /**
   * Speakers (and their lines) hidden immediately on delete, before the
   * delete is actually committed — the real IPC call is deferred behind
   * `speakerDeleteTimers` so a misclick has a few seconds to be undone
   * before it's unrecoverable. Deleting a speaker also deletes every line
   * credited to them, so this is the one destructive action here that
   * genuinely needs a way back.
   */
  const [hiddenSpeakerIds, setHiddenSpeakerIds] = useState<Set<string>>(new Set())
  const [hiddenUtteranceIds, setHiddenUtteranceIds] = useState<Set<string>>(new Set())
  const [pendingSpeakerDelete, setPendingSpeakerDelete] = useState<{ id: string; label: string } | null>(null)
  // Deliberately never cleared on unmount: a delete the user didn't undo
  // should still land even if they navigate away before the timer fires,
  // rather than silently reverting. Keyed by speaker id (not a single ref)
  // so deleting a second speaker before the first one's window elapses
  // doesn't cancel the first one's real deletion — only the visible toast
  // (a single `pendingSpeakerDelete`) is limited to the most recent.
  const speakerDeleteTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

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
  const transcript = useTranscript(id)
  const speakers = useSpeakers(id, transcript.refetch)

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
    setActionError(null)
    try {
      await navigator.clipboard.writeText(text)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    }
  }

  async function exportTranscript(format: (typeof EXPORT_FORMATS)[number]['id']): Promise<void> {
    setActionError(null)
    try {
      await api.invoke('transcript:export', { recordingId: id, format })
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    }
  }

  async function exportAudio(): Promise<void> {
    setActionError(null)
    try {
      await api.invoke('audio:export', { recordingId: id })
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    }
  }

  const SPEAKER_DELETE_UNDO_MS = 6000

  /** Hides a speaker and their lines immediately; the real delete lands after the undo window unless `undoSpeakerDelete` cancels it first. */
  function removeSpeakerPending(speakerId: string): void {
    const target = speakers.speakers.find((s) => s.id === speakerId)
    if (!target) return
    const lineIds = (transcript.utterances ?? []).filter((u) => u.speaker?.id === speakerId).map((u) => u.id)

    setHiddenSpeakerIds((prev) => new Set(prev).add(speakerId))
    setHiddenUtteranceIds((prev) => {
      const next = new Set(prev)
      for (const lineId of lineIds) next.add(lineId)
      return next
    })
    setPendingSpeakerDelete({
      id: speakerId,
      label: `${target.displayName} removed (${lineIds.length} line${lineIds.length === 1 ? '' : 's'}).`
    })

    const existing = speakerDeleteTimers.current.get(speakerId)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      speakerDeleteTimers.current.delete(speakerId)
      setPendingSpeakerDelete((current) => (current?.id === speakerId ? null : current))
      void speakers.remove(speakerId)
    }, SPEAKER_DELETE_UNDO_MS)
    speakerDeleteTimers.current.set(speakerId, timer)
  }

  function undoSpeakerDelete(): void {
    const pending = pendingSpeakerDelete
    if (!pending) return
    const timer = speakerDeleteTimers.current.get(pending.id)
    if (timer) clearTimeout(timer)
    speakerDeleteTimers.current.delete(pending.id)

    setPendingSpeakerDelete(null)
    setHiddenSpeakerIds((prev) => {
      const next = new Set(prev)
      next.delete(pending.id)
      return next
    })
    setHiddenUtteranceIds((prev) => {
      const next = new Set(prev)
      for (const u of transcript.utterances ?? []) {
        if (u.speaker?.id === pending.id) next.delete(u.id)
      }
      return next
    })
  }

  const hasTranscript = recording.transcriptStatus === 'ready' && (transcript.utterances?.length ?? 0) > 0
  const hasSpeakers = speakers.speakers.length > 0
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
      ...(hasTranscript
        ? ([
            {
              icon: 'speakers',
              label: hasSpeakers ? 'Re-run Speaker Detection' : 'Detect Speakers',
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
          {hasSpeakers && (
            <button
              type="button"
              className={
                transcriptMode === 'speakers' ? 'btn btn--ghost icon-btn icon-btn--active' : 'btn btn--ghost icon-btn'
              }
              aria-pressed={transcriptMode === 'speakers'}
              aria-label={transcriptMode === 'speakers' ? 'Hide speaker labels' : 'Show speaker labels'}
              title={transcriptMode === 'speakers' ? 'Showing speakers & timestamps' : 'Showing timestamps only'}
              onClick={() => setTranscriptMode((m) => (m === 'speakers' ? 'timestamps' : 'speakers'))}
            >
              <Icon name="speakers" />
            </button>
          )}
          <OverflowMenu groups={overflowGroups} ariaLabel="More actions" />
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
          <div className="progress progress--wide" style={{ flex: 1 }}>
            <div
              className={
                speakers.progress == null ? 'progress__bar progress__bar--indeterminate' : 'progress__bar'
              }
              style={speakers.progress == null ? undefined : { width: `${Math.round(speakers.progress * 100)}%` }}
            />
            <span className="progress__label">
              {recording.speakerStatus === 'queued'
                ? 'Queued…'
                : speakers.progress == null
                  ? 'Detecting speakers…'
                  : `Detecting speakers… ${Math.round(speakers.progress * 100)}%`}
            </span>
          </div>
          <button type="button" className="btn btn--ghost btn--sm" onClick={speakers.cancel}>
            Cancel
          </button>
        </div>
      )}

      {(recording.transcriptStatus === 'queued' || recording.transcriptStatus === 'transcribing') && (
        <div className="toolbar">
          <div className="progress progress--wide" style={{ flex: 1 }}>
            <div
              className={
                transcript.progress == null ? 'progress__bar progress__bar--indeterminate' : 'progress__bar'
              }
              style={transcript.progress == null ? undefined : { width: `${Math.round(transcript.progress * 100)}%` }}
            />
            <span className="progress__label">
              {recording.transcriptStatus === 'queued'
                ? 'Queued…'
                : transcript.progress == null
                  ? 'Transcribing…'
                  : `Transcribing… ${Math.round(transcript.progress * 100)}%`}
            </span>
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
            <PlayerBar
              audio={audio}
              peaks={compressed}
              durationMs={recording.durationMs ?? 0}
              virtualDurationMs={virtualDur}
              positionMs={virtualPosition}
              onSeek={seekVirtual}
              seams={compressed.seams}
              markers={markerPins}
              onAddMarker={() => addMarkerAt(audio.currentMs, markerColor)}
              markerColor={markerColor}
              onMarkerColorChange={setMarkerColor}
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
              onAddMarker={() => addMarkerAt(audio.currentMs, markerColor)}
              markerColor={markerColor}
              onMarkerColorChange={setMarkerColor}
              floating
            />
          )}

          <MarkerChips
            markers={annotatedMarkers}
            onJump={(marker) => audio.seek(marker.timeMs)}
            onRename={renameMarker}
            onRecolor={recolorMarker}
            onRemove={removeMarker}
            onClearAll={clearAllMarkers}
          />

          {pendingSpeakerDelete && (
            <div className="toast">
              <span>{pendingSpeakerDelete.label}</span>
              <button type="button" className="toast__action" onClick={undoSpeakerDelete}>
                Undo
              </button>
            </div>
          )}

          {transcriptMode === 'speakers' && (
            <SpeakerChips
              speakers={speakers.speakers.filter((s) => !hiddenSpeakerIds.has(s.id))}
              utterances={transcript.utterances ?? []}
              onRename={speakers.rename}
              onRecolor={speakers.recolor}
              onMerge={speakers.merge}
              onRemove={removeSpeakerPending}
              onCreate={speakers.create}
            />
          )}

          {recording.transcriptStatus === 'ready' && transcript.utterances && (
            <TranscriptPanel
              utterances={transcript.utterances.filter((u) => !hiddenUtteranceIds.has(u.id))}
              currentMs={audio.currentMs}
              onSeek={audio.seek}
              mode={transcriptMode}
              speakers={speakers.speakers.filter((s) => !hiddenSpeakerIds.has(s.id))}
              onReassignSpeaker={speakers.reassignUtterance}
              onEditText={transcript.editText}
              markers={markers}
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
