import { useEffect, useState } from 'react'
import type { Recording } from '@shared/types'
import { sourceMediaUrl } from '@shared/ipc'
import { useAudio } from '../lib/useAudio'
import { formatDate, formatDuration } from '../lib/format'
import StatusPill from './StatusPill'
import OverflowMenu, { type OverflowMenuItem } from './OverflowMenu'

/** Titles the app generated itself, which only repeat the timestamp below them. */
const AUTO_TITLE = /^Recording \d{1,2}\/\d{1,2}\/\d{4}/

export default function RecordingCard({
  recording,
  playingId,
  onPlay,
  onOpen,
  onRename,
  onDelete,
  onTranscribe,
  onExportTranscript,
  onExportAudio,
  job,
  transcribing
}: {
  recording: Recording
  /** Which card currently holds playback, or null when none does. */
  playingId: string | null
  onPlay: (id: string) => void
  onOpen: (id: string) => void
  onRename: (id: string, title: string) => Promise<void>
  onDelete: (id: string) => void
  onTranscribe: (id: string) => void
  onExportTranscript: (id: string) => void
  onExportAudio: (id: string) => void
  /** In-flight import progress for this recording, if any. */
  job?: { fraction: number | null } | null
  /** In-flight transcription progress for this recording, if any — null fraction while queued or indeterminate. */
  transcribing?: { fraction: number | null } | null
}): React.JSX.Element {
  // useAudio owns the state; the element's source is the caller's job.
  const mediaSrc = recording.sourcePath ? sourceMediaUrl(recording.id) : null
  const audio = useAudio(mediaSrc)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(recording.title)

  const playable = recording.sourcePath != null && recording.status === 'ready'
  const named = !AUTO_TITLE.test(recording.title)

  // Only one card plays at a time — but only another card actually claiming
  // playback stops this one. Testing "am I the chosen card" instead treats
  // "nobody has claimed it" as a reason to stop, which cancelled the play()
  // that was still starting up.
  useEffect(() => {
    if (playingId != null && playingId !== recording.id && audio.playing) {
      audio.ref.current?.pause()
    }
  }, [playingId, recording.id, audio.playing, audio.ref])

  async function commitRename(): Promise<void> {
    const title = draft.trim()
    setEditing(false)
    if (!title || title === recording.title) {
      setDraft(recording.title)
      return
    }
    await onRename(recording.id, title)
  }

  const menuGroups: OverflowMenuItem[][] = [
    [
      { icon: '▶', label: 'Open', onClick: () => onOpen(recording.id) },
      {
        icon: '✏️',
        label: 'Rename',
        onClick: () => {
          setDraft(recording.title)
          setEditing(true)
        }
      }
    ],
    [
      ...(recording.transcriptStatus === 'ready'
        ? [{ icon: '📝', label: 'Re-Transcribe', onClick: () => onTranscribe(recording.id) }]
        : recording.sourcePath
          ? [{ icon: '📝', label: 'Transcribe', onClick: () => onTranscribe(recording.id) }]
          : [])
    ],
    [
      ...(recording.transcriptStatus === 'ready'
        ? [{ icon: '⬇️', label: 'Export Transcript', onClick: () => onExportTranscript(recording.id) }]
        : []),
      ...(recording.sourcePath ? [{ icon: '🔊', label: 'Export Audio', onClick: () => onExportAudio(recording.id) }] : [])
    ],
    [{ icon: '🗑️', label: 'Delete', danger: true, onClick: () => onDelete(recording.id) }]
  ]

  return (
    <div className={audio.playing ? 'rec rec--playing' : 'rec'}>
      <div className="rec__head">
        <div className="rec__heading">
          {editing ? (
            <input
              className="input rec__title-input"
              value={draft}
              autoFocus
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void commitRename()
                if (e.key === 'Escape') {
                  setDraft(recording.title)
                  setEditing(false)
                }
              }}
            />
          ) : (
            // An auto-generated title only repeats the timestamp under it, so
            // only a title the user chose is worth the line.
            <h2 className="rec__title">{recording.title}</h2>
          )}
          {/* The generated titles already read "Recording <date> <time>", so a
              stamp under one of those would say the same thing twice. */}
          {!named && <span className="rec__stamp">{formatDate(recording.createdAt)}</span>}
        </div>

        <div className="rec__actions">
          <StatusPill status={recording.status} />
          <OverflowMenu groups={menuGroups} ariaLabel={`Actions for ${recording.title}`} />
        </div>
      </div>

      {recording.status === 'failed' && (
        <p className="rec__note">{recording.error ?? 'Nothing was saved.'}</p>
      )}
      {/* A hint of what the recording is about, from its transcript — only
          worth showing once one exists, and not while a stale one from
          before a re-transcription might be misleading mid-run. */}
      {recording.transcriptPreview && recording.transcriptStatus === 'ready' && (
        <p className="rec__preview">{recording.transcriptPreview}</p>
      )}

      <div className="rec__foot">
        {playable && (
          <button
            type="button"
            className="rec__play"
            aria-label={audio.playing ? `Pause ${recording.title}` : `Play ${recording.title}`}
            onClick={() => {
              onPlay(recording.id)
              audio.toggle()
            }}
          >
            <span className="rec__glyph" aria-hidden="true">
              {audio.playing ? '❚❚' : '▶'}
            </span>
            <span className="rec__time">
              {formatDuration(
                audio.playing || audio.currentMs > 0 ? audio.currentMs : recording.durationMs
              )}
            </span>
          </button>
        )}
        {/* preload="none": a library of long recordings must not fetch every
            one of them just to render the list. */}
        <audio ref={audio.ref} src={mediaSrc ?? undefined} preload="none" {...audio.bind} />
      </div>

      {job && (
        <div className="rec__job">
          <div className="progress" title="Preparing">
            <div
              className={
                job.fraction == null ? 'progress__bar progress__bar--indeterminate' : 'progress__bar'
              }
              style={job.fraction == null ? undefined : { width: `${Math.round(job.fraction * 100)}%` }}
            />
            <span className="progress__label">
              Preparing
              {job.fraction != null && ` ${Math.round(job.fraction * 100)}%`}
            </span>
          </div>
        </div>
      )}
      {transcribing && (
        <div className="rec__job">
          <div className="progress" title="Transcribing">
            <div
              className={
                transcribing.fraction == null
                  ? 'progress__bar progress__bar--indeterminate'
                  : 'progress__bar'
              }
              style={
                transcribing.fraction == null
                  ? undefined
                  : { width: `${Math.round(transcribing.fraction * 100)}%` }
              }
            />
            <span className="progress__label">
              {recording.transcriptStatus === 'queued'
                ? 'Queued to transcribe…'
                : transcribing.fraction == null
                  ? 'Transcribing…'
                  : `Transcribing… ${Math.round(transcribing.fraction * 100)}%`}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
