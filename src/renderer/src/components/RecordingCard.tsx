import { useEffect, useRef, useState } from 'react'
import type { RecordingSummary, Utterance } from '@shared/types'
import { sourceMediaUrl } from '@shared/ipc'
import { api } from '../lib/api'
import { useAudio } from '../lib/useAudio'
import { formatDate, formatDuration } from '../lib/format'

/**
 * One recording, as a card that plays and reads without leaving the library.
 *
 * The list used to be a table, which answered "what do I have" and nothing more:
 * hearing thirty seconds of something meant opening it, waiting for the editor
 * to load a transcript and peaks, then going back. The card carries the opening
 * of the transcript, plays in place, and follows along while it does.
 */

/** Titles the app generated itself, which only repeat the timestamp below them. */
const AUTO_TITLE = /^Recording \d{1,2}\/\d{1,2}\/\d{4}/

/** Roughly how much of the transcript a card shows before trailing off. */
const PREVIEW_CHARS = 340

export default function RecordingCard({
  recording,
  playingId,
  onPlay,
  onOpen,
  onRename,
  onDelete,
  onRetry
}: {
  recording: RecordingSummary
  /** Which card currently holds playback, or null when none does. */
  playingId: string | null
  onPlay: (id: string) => void
  onOpen: (id: string) => void
  onRename: (id: string, title: string) => Promise<void>
  onDelete: (id: string) => void
  onRetry: (id: string) => void
}): React.JSX.Element {
  // useAudio owns the state; the element's source is the caller's job.
  const mediaSrc = recording.sourcePath ? sourceMediaUrl(recording.id) : null
  const audio = useAudio(mediaSrc)
  const [utterances, setUtterances] = useState<Utterance[] | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(recording.title)
  const cardRef = useRef<HTMLDivElement>(null)

  const playable = recording.sourcePath != null && recording.status !== 'normalizing'
  const named = !AUTO_TITLE.test(recording.title)

  /**
   * Timed lines are fetched only once playback starts.
   *
   * The preview text arrives with the list and is enough to read; the timings
   * are only needed to follow along, so a library of long recordings does not
   * load every transcript on the chance that one gets played.
   */
  useEffect(() => {
    if (!audio.playing || utterances) return
    let cancelled = false
    api
      .invoke('recordings:get', { id: recording.id })
      .then((bundle) => {
        if (!cancelled && bundle) setUtterances(bundle.utterances)
      })
      .catch(() => {
        // Following along is a nicety; the audio plays regardless.
      })
    return () => {
      cancelled = true
    }
  }, [audio.playing, utterances, recording.id])

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

  /**
   * The preview, split so the line being spoken can be picked out.
   *
   * Before playback there are no timings, so the whole preview is one inert
   * block. Once the timed lines arrive the same text is rebuilt from them and
   * the one under the playhead is marked.
   */
  const lines = utterances
    ? (() => {
        const out: Array<{ text: string; startMs: number; endMs: number }> = []
        let used = 0
        for (const u of utterances) {
          if (used >= PREVIEW_CHARS) break
          out.push({ text: u.text, startMs: u.startMs, endMs: u.endMs })
          used += u.text.length
        }
        return out
      })()
    : null

  const truncated =
    (recording.preview ?? '').length >= PREVIEW_CHARS ||
    (utterances != null && lines != null && lines.length < utterances.length)

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
          {recording.status === 'failed' && (
            <button
              type="button"
              className="rec__retry"
              aria-label={`Try transcribing ${recording.title} again`}
              title="Try again"
              onClick={() => onRetry(recording.id)}
            >
              ↻
            </button>
          )}
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
                  onClick={() => {
                    setMenuOpen(false)
                    onRetry(recording.id)
                  }}
                >
                  Transcribe again
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

      {recording.status === 'failed' ? (
        <p className="rec__note">
          {recording.error ?? 'Nothing was transcribed. Try again.'}
        </p>
      ) : recording.preview ? (
        <p className="rec__preview">
          {lines
            ? lines.map((line, i) => {
                const active = audio.currentMs >= line.startMs && audio.currentMs < line.endMs
                return (
                  <span key={i} className={active ? 'rec__line rec__line--now' : 'rec__line'}>
                    {line.text}{' '}
                  </span>
                )
              })
            : recording.preview.slice(0, PREVIEW_CHARS)}
          {truncated && <span className="rec__more">…</span>}
        </p>
      ) : (
        recording.status === 'ready' && <p className="rec__note">No speech was found.</p>
      )}

      <div className="rec__foot">
        {recording.preview && (
          <button className="rec__full" onClick={() => onOpen(recording.id)}>
            View full transcript
          </button>
        )}

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
    </div>
  )
}
