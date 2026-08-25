import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { sourceMediaUrl, trackMediaUrl } from '@shared/ipc'
import { findModel } from '@shared/models'
import { EXPORT_FORMATS, type ExportFormat } from '@shared/export'
import type { JobProgress as JobProgressPayload } from '@shared/types'
import { api, useEvent, useQuery } from '../lib/api'
import { useAudio } from '../lib/useAudio'
import { formatDuration } from '../lib/format'
import StatusPill from '../components/StatusPill'
import PlayerBar from '../components/PlayerBar'
import Transcript from '../components/Transcript'
import JobProgress from '../components/JobProgress'
import SpeakerBar from '../components/SpeakerBar'
import Select from '../components/Select'

type PendingAction =
  | { kind: 'line'; id: string; label: string }
  | { kind: 'speaker'; id: string; label: string; lineIds: string[] }
  | { kind: 'merge'; id: string; label: string; lineIds: string[]; intoId: string }

export default function Editor(): React.JSX.Element {
  const { id = '' } = useParams<{ id: string }>()
  const { data, error, loading, refetch } = useQuery('recordings:get', { id })
  const { data: settings } = useQuery('settings:get')

  const [draftTitle, setDraftTitle] = useState<string | null>(null)
  const [job, setJob] = useState<JobProgressPayload | null>(null)
  /**
   * Whether a job is really running for this recording.
   *
   * Deliberately not derived from the 'queued' status: that is the resting
   * state a recording sits in after import, waiting for the user to press
   * Transcribe. Treating it as "busy" hides the Transcribe button behind a
   * Cancel button and shows a progress bar for a job that was never started.
   */
  const [jobActive, setJobActive] = useState(false)
  const [jobStartedAt, setJobStartedAt] = useState(0)
  const [actionError, setActionError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [exportedPath, setExportedPath] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [speakerFilter, setSpeakerFilter] = useState<string | null>(null)
  const [follow, setFollow] = useState(true)
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

  /**
   * Lines (and speakers, with their lines) hidden immediately on delete,
   * before the delete is actually committed. The real IPC call is deferred
   * behind `deleteTimers` so a misclick — background noise turning out to be
   * a word after all — has a few seconds to be undone before it is
   * unrecoverable.
   */
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set())
  const [hiddenSpeakerIds, setHiddenSpeakerIds] = useState<Set<string>>(new Set())
  /** Lines shown under a different speaker while a merge is pending undo. */
  const [pendingReassign, setPendingReassign] = useState<Map<string, string>>(new Map())
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null)
  // Deliberately never cleared on unmount: a delete the user didn't undo
  // should still land even if they navigate away before the timer fires,
  // rather than silently reverting.
  const deleteTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  const recording = data?.recording ?? null
  const tracks = data?.tracks ?? []

  // Prefer the original file: it is full quality, where the normalized track is
  // 16 kHz mono and sounds noticeably worse. Fall back to the track when the
  // original is gone.
  const playbackSrc = recording
    ? recording.sourcePath
      ? sourceMediaUrl(recording.id)
      : tracks[0]
        ? trackMediaUrl(tracks[0].id)
        : null
    : null

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
    // A terminal state ends the job; intermediate ones (transcribing,
    // diarizing) are just stage changes and must not clear it.
    if (updated.status === 'ready' || updated.status === 'failed' || updated.status === 'queued') {
      setJob(null)
      setJobActive(false)
    }
    refetch()
  })

  useEvent('job:progress', (payload) => {
    if (payload.recordingId !== id) return
    setJob(payload)
    setJobActive(true)
  })

  // A job may already be running when this screen opens — after navigating away
  // and back, or straight from the recorder.
  //
  // Its stage, percentage and start time come from the main process rather than
  // being rebuilt from whatever event arrives next. Leaving the screen used to
  // discard all of it, so returning showed an empty bar and an elapsed counter
  // restarting from zero on a job that was twenty minutes old.
  useEffect(() => {
    let cancelled = false
    api.invoke('transcribe:active').then((active) => {
      if (cancelled) return
      const mine = active.find((job) => job.recordingId === id)
      if (!mine) return
      setJobActive(true)
      setJobStartedAt(mine.startedAt)
      setJob(mine.progress)
    })
    return () => {
      cancelled = true
    }
  }, [id])

  // Peaks come from the main process; the renderer cannot read the audio itself,
  // and main is also what decides which file the waveform should describe — the
  // mixdown when a recording has one, so the drawn envelope matches what plays.
  //
  // Re-fetched when the track count or the status changes: audio appears partway
  // through stopping a recording, and the mixdown lands after the tracks do, so
  // the first answer for a recording still in flight can be the wrong file.
  const trackCount = tracks.length
  const status = recording?.status
  useEffect(() => {
    if (!id || trackCount === 0) {
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
  }, [id, trackCount, status])

  if (loading) return <div className="page">Loading…</div>
  if (error) return <div className="page banner banner--error">{error}</div>
  if (!data || !recording) {
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

  const { speakers, utterances } = data
  // A plain string, unlike `recording` itself: TS doesn't carry the `!recording`
  // early-return's narrowing into the function declarations below (they're
  // hoisted, so in principle callable before that guard runs), and this
  // sidesteps needing every one of them to re-check it.
  const recordingId = recording.id

  async function commitTitle(): Promise<void> {
    const next = draftTitle?.trim()
    setDraftTitle(null)
    if (!next || !recording || next === recording.title) return
    await api.invoke('recordings:rename', { id: recording.id, title: next })
    refetch()
  }

  async function run(fn: () => Promise<unknown>): Promise<void> {
    setActionError(null)
    try {
      await fn()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    }
    refetch()
  }

  const UNDO_WINDOW_MS = 6000

  function deleteLine(utteranceId: string): void {
    const target = utterances.find((u) => u.id === utteranceId)
    if (!target) return

    setHiddenIds((prev) => new Set(prev).add(utteranceId))
    setPendingAction({ kind: 'line', id: utteranceId, label: 'Line deleted.' })

    const timer = setTimeout(() => {
      deleteTimers.current.delete(utteranceId)
      setPendingAction((current) => (current?.id === utteranceId ? null : current))
      api.invoke('utterances:delete', { id: utteranceId }).catch((err: unknown) => {
        setActionError(err instanceof Error ? err.message : String(err))
        setHiddenIds((prev) => {
          const next = new Set(prev)
          next.delete(utteranceId)
          return next
        })
      })
    }, UNDO_WINDOW_MS)
    deleteTimers.current.set(utteranceId, timer)
  }

  /** Removes a speaker and every line attributed to them, undo included. */
  function deleteSpeakerBulk(speakerId: string): void {
    const target = speakers.find((s) => s.id === speakerId)
    if (!target) return
    const lineIds = utterances.filter((u) => u.speakerId === speakerId).map((u) => u.id)

    setHiddenIds((prev) => {
      const next = new Set(prev)
      for (const id of lineIds) next.add(id)
      return next
    })
    setHiddenSpeakerIds((prev) => new Set(prev).add(speakerId))
    setPendingAction({
      kind: 'speaker',
      id: speakerId,
      lineIds,
      label: `${target.displayName} deleted (${lineIds.length} line${lineIds.length === 1 ? '' : 's'}).`
    })

    const timer = setTimeout(() => {
      deleteTimers.current.delete(speakerId)
      setPendingAction((current) => (current?.id === speakerId ? null : current))
      api.invoke('speakers:delete', { id: speakerId }).catch((err: unknown) => {
        setActionError(err instanceof Error ? err.message : String(err))
        setHiddenSpeakerIds((prev) => {
          const next = new Set(prev)
          next.delete(speakerId)
          return next
        })
        setHiddenIds((prev) => {
          const next = new Set(prev)
          for (const id of lineIds) next.delete(id)
          return next
        })
      })
    }, UNDO_WINDOW_MS)
    deleteTimers.current.set(speakerId, timer)
  }

  /** Folds one speaker into another, undoable for the same window as a delete. */
  function mergeSpeakersUndoable(fromId: string, intoId: string): void {
    const fromSpeaker = speakers.find((s) => s.id === fromId)
    const intoSpeaker = speakers.find((s) => s.id === intoId)
    if (!fromSpeaker || !intoSpeaker) return
    const lineIds = utterances.filter((u) => u.speakerId === fromId).map((u) => u.id)

    // Optimistic: the source chip disappears and its lines show under the
    // target immediately, the same as the real merge would leave them —
    // reverting either half on undo is what makes the undo convincing.
    setHiddenSpeakerIds((prev) => new Set(prev).add(fromId))
    setPendingReassign((prev) => {
      const next = new Map(prev)
      for (const lineId of lineIds) next.set(lineId, intoId)
      return next
    })
    setPendingAction({
      kind: 'merge',
      id: fromId,
      intoId,
      lineIds,
      label: `${fromSpeaker.displayName} merged into ${intoSpeaker.displayName} (${lineIds.length} line${lineIds.length === 1 ? '' : 's'}).`
    })

    const timer = setTimeout(() => {
      deleteTimers.current.delete(fromId)
      setPendingAction((current) => (current?.id === fromId ? null : current))
      api
        .invoke('speakers:merge', { recordingId, fromId, intoId })
        .then(() => refetch())
        .catch((err: unknown) => {
          setActionError(err instanceof Error ? err.message : String(err))
          setHiddenSpeakerIds((prev) => {
            const next = new Set(prev)
            next.delete(fromId)
            return next
          })
          setPendingReassign((prev) => {
            const next = new Map(prev)
            for (const lineId of lineIds) next.delete(lineId)
            return next
          })
        })
    }, UNDO_WINDOW_MS)
    deleteTimers.current.set(fromId, timer)
  }

  function undoPendingAction(): void {
    const pending = pendingAction
    if (!pending) return
    const timer = deleteTimers.current.get(pending.id)
    if (timer) clearTimeout(timer)
    deleteTimers.current.delete(pending.id)

    if (pending.kind === 'line') {
      setHiddenIds((prev) => {
        const next = new Set(prev)
        next.delete(pending.id)
        return next
      })
    } else if (pending.kind === 'speaker') {
      setHiddenSpeakerIds((prev) => {
        const next = new Set(prev)
        next.delete(pending.id)
        return next
      })
      setHiddenIds((prev) => {
        const next = new Set(prev)
        for (const id of pending.lineIds) next.delete(id)
        return next
      })
    } else {
      setHiddenSpeakerIds((prev) => {
        const next = new Set(prev)
        next.delete(pending.id)
        return next
      })
      setPendingReassign((prev) => {
        const next = new Map(prev)
        for (const lineId of pending.lineIds) next.delete(lineId)
        return next
      })
    }
    setPendingAction(null)
  }

  async function exportAs(format: ExportFormat): Promise<void> {
    setActionError(null)
    setNotice(null)
    setExportedPath(null)
    try {
      const path = await api.invoke('transcript:export', { id, format })
      if (path) {
        setNotice(`Saved to ${path}`)
        setExportedPath(path)
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    }
  }

  const visibleSpeakers = speakers.filter((s) => !hiddenSpeakerIds.has(s.id))

  // Guards against a filter left pointing at a speaker that a merge — or a
  // pending delete — just removed. The chip it came from is gone, so the
  // filter should clear rather than silently hide the whole transcript.
  const activeFilter = visibleSpeakers.some((s) => s.id === speakerFilter) ? speakerFilter : null
  const visibleUtterances = utterances
    .filter((u) => !hiddenIds.has(u.id))
    .map((u) => {
      const reassignedTo = pendingReassign.get(u.id)
      return reassignedTo ? { ...u, speakerId: reassignedTo } : u
    })

  const showHours = (recording.durationMs ?? 0) >= 3_600_000
  // 'queued' is excluded on purpose — see jobActive above.
  const busy =
    jobActive ||
    recording.status === 'transcribing' ||
    recording.status === 'diarizing' ||
    recording.status === 'merging'
  const canTranscribe = tracks.length > 0 && settings?.modelId != null
  const usedModel = recording.modelId ? findModel(recording.modelId) : undefined
  const hasTranscript = utterances.length > 0

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
            {usedModel && <span className="page__meta">{usedModel.label}</span>}
            {speakers.length > 0 && (
              <span className="page__meta">
                {speakers.length} speaker{speakers.length === 1 ? '' : 's'}
              </span>
            )}
          </p>
        </div>

        <div className="page__actions">
          {hasTranscript && (
            <Select
              // Nothing stays chosen: picking a format performs the export
              // rather than setting a preference, so the trigger keeps reading
              // "Export…" and every pick fires.
              value=""
              placeholder="Export…"
              align="end"
              options={EXPORT_FORMATS.map((f) => ({ value: f.id, label: f.label }))}
              onChange={(id) => void exportAs(id as ExportFormat)}
              ariaLabel="Export transcript"
            />
          )}
          {busy ? (
            <button
              className="btn btn--ghost"
              onClick={() => {
                setJobActive(false)
                setJob(null)
                void run(() => api.invoke('transcribe:cancel', { id: recording.id }))
              }}
            >
              Cancel
            </button>
          ) : (
            <button
              className="btn btn--primary"
              disabled={!canTranscribe}
              title={!canTranscribe ? 'Choose a model on the Settings page first' : undefined}
              onClick={() => {
                // Optimistic: the first progress event can take a moment on a
                // large model, and the button must respond immediately.
                setJobActive(true)
                setJobStartedAt(Date.now())
                setJob(null)
                void run(() => api.invoke('transcribe:start', { id: recording.id })).catch(() =>
                  setJobActive(false)
                )
              }}
            >
              {hasTranscript ? 'Transcribe again' : 'Transcribe'}
            </button>
          )}
        </div>
      </header>

      {recording.error && <div className="banner banner--error">{recording.error}</div>}
      {actionError && <div className="banner banner--error">{actionError}</div>}
      {notice && (
        <div className="banner banner--ok">
          <span>{notice}</span>
          {exportedPath && (
            <button
              className="banner__action"
              onClick={() => void api.invoke('shell:showItemInFolder', { path: exportedPath })}
            >
              Open folder
            </button>
          )}
        </div>
      )}
      {!canTranscribe && tracks.length > 0 && (
        <div className="banner banner--warn">
          No transcription model selected. Pick one on the <Link to="/settings">Settings</Link>{' '}
          page.
        </div>
      )}

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

      {busy && <JobProgress job={job} startedAt={jobStartedAt || Date.now()} />}

      {hasTranscript && (
        <SpeakerBar
          speakers={visibleSpeakers}
          utterances={visibleUtterances}
          filter={activeFilter}
          onFilterChange={setSpeakerFilter}
          onRename={async (speakerId, displayName) => {
            await api.invoke('speakers:rename', { id: speakerId, displayName })
            refetch()
          }}
          onMerge={mergeSpeakersUndoable}
          onDelete={deleteSpeakerBulk}
        />
      )}

      {hasTranscript && (
        <div className="toolbar">
          <input
            className="input toolbar__search"
            type="search"
            placeholder="Search transcript…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <label className="toolbar__toggle">
            <input
              type="checkbox"
              checked={follow}
              onChange={(e) => setFollow(e.target.checked)}
            />
            Follow playback
          </label>
          {activeFilter ? (
            <button className="btn btn--ghost" onClick={() => setSpeakerFilter(null)}>
              Showing {speakers.find((s) => s.id === activeFilter)?.displayName} only ✕
            </button>
          ) : (
            <span className="toolbar__hint">Double-click a line to edit</span>
          )}
        </div>
      )}

      {pendingAction && (
        <div className="toast">
          <span>{pendingAction.label}</span>
          <button className="toast__action" onClick={undoPendingAction}>
            Undo
          </button>
        </div>
      )}

      {hasTranscript ? (
        <Transcript
          utterances={visibleUtterances}
          speakers={visibleSpeakers}
          currentMs={audio.currentMs}
          showHours={showHours}
          query={query}
          speakerFilter={activeFilter}
          follow={follow}
          onSeek={audio.seek}
          onEdit={async (utteranceId, text) => {
            await api.invoke('utterances:update', { id: utteranceId, text })
            refetch()
          }}
          onReassign={async (utteranceId, speakerId) => {
            await api.invoke('speakers:reassign', { utteranceId, speakerId })
            refetch()
          }}
          onDelete={deleteLine}
        />
      ) : (
        <div className="empty">
          <h2>No transcript yet</h2>
          <p>
            {busy
              ? 'Working — this runs entirely on your machine, so it takes a while.'
              : recording.status === 'queued'
                ? 'Audio is ready. Press Transcribe to start.'
                : 'This recording has no transcript.'}
          </p>
        </div>
      )}
    </div>
  )
}
