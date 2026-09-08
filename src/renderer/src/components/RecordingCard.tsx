import { useEffect, useRef, useState } from 'react'
import type { Recording } from '@shared/types'
import { sourceMediaUrl } from '@shared/ipc'
import { useAudio } from '../lib/useAudio'
import { formatDate, formatDuration } from '../lib/format'
import StatusPill from './StatusPill'

/** Titles the app generated itself, which only repeat the timestamp below them. */
const AUTO_TITLE = /^Recording \d{1,2}\/\d{1,2}\/\d{4}/

export default function RecordingCard({
  recording,
  playingId,
  onPlay,
  onOpen,
  onRename,
  onDelete,
  job
}: {
  recording: Recording
  /** Which card currently holds playback, or null when none does. */
  playingId: string | null
  onPlay: (id: string) => void
  onOpen: (id: string) => void
  onRename: (id: string, title: string) => Promise<void>
  onDelete: (id: string) => void
  /** In-flight import progress for this recording, if any. */
  job?: { fraction: number | null } | null
}): React.JSX.Element {
  // useAudio owns the state; the element's source is the caller's job.
  const mediaSrc = recording.sourcePath ? sourceMediaUrl(recording.id) : null
  const audio = useAudio(mediaSrc)
  const [menuOpen, setMenuOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(recording.title)
  const cardRef = useRef<HTMLDivElement>(null)

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

  // A menu that cannot be dismissed by clicking away is a trap.
  useEffect(() => {
    if (!menuOpen) return
    const close = (e: MouseEvent): void => {
      if (!cardRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [menuOpen])

  async function commitRename(): Promise<void> {
    const title = draft.trim()
    setEditing(false)
    if (!title || title === recording.title) {
      setDraft(recording.title)
      return
    }
    await onRename(recording.id, title)
  }

  return (
    <div ref={cardRef} className={audio.playing ? 'rec rec--playing' : 'rec'}>
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
          <div className="rec__menu">
            <button
              type="button"
              className="rec__menu-btn"
              aria-label={`Actions for ${recording.title}`}
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
            >
              ⋯
            </button>
            {menuOpen && (
              <div className="menu" role="menu">
                <button role="menuitem" onClick={() => onOpen(recording.id)}>
                  Open
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    setDraft(recording.title)
                    setEditing(true)
                    setMenuOpen(false)
                  }}
                >
                  Rename
                </button>
                <button
                  role="menuitem"
                  className="menu__danger"
                  onClick={() => {
                    setMenuOpen(false)
                    onDelete(recording.id)
                  }}
                >
                  Delete
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {recording.status === 'failed' && (
        <p className="rec__note">{recording.error ?? 'Nothing was saved.'}</p>
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
    </div>
  )
}
