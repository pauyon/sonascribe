import { useCallback, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { ImportProgress, Recording } from '@shared/types'
import { SUPPORTED_MEDIA_EXTENSIONS } from '@shared/types'
import { api, useEvent, useQuery } from '../lib/api'
import RecordingCard from '../components/RecordingCard'

export default function Library(): React.JSX.Element {
  const navigate = useNavigate()
  const { data, error, loading, refetch } = useQuery('recordings:list')
  const { data: info } = useQuery('app:info')
  const { data: activeTranscriptions } = useQuery('transcript:listActive')

  const [progress, setProgress] = useState<Record<string, ImportProgress>>({})
  // Keyed by recording id; a fraction here overrides `activeTranscriptions`'
  // seeded value once a live event has actually arrived for that recording.
  const [transcribeProgress, setTranscribeProgress] = useState<Record<string, number | null>>({})
  const [dragging, setDragging] = useState(false)
  /** Which card holds playback: starting one stops whichever was going. */
  const [playingId, setPlayingId] = useState<string | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const [cardActionError, setCardActionError] = useState<string | null>(null)
  // Drag events fire for every child element; a counter avoids the highlight
  // flickering as the pointer moves between them.
  const dragDepth = useRef(0)

  useEvent('import:progress', (payload) => {
    setProgress((prev) => ({ ...prev, [payload.recordingId]: payload }))
  })

  useEvent('transcript:progress', (payload) => {
    setTranscribeProgress((prev) => ({ ...prev, [payload.recordingId]: payload.fraction }))
  })

  useEvent('recording:updated', (updated) => {
    setProgress((prev) => {
      const next = { ...prev }
      delete next[updated.id]
      return next
    })
    // Only cleared once the transcript is no longer in flight — a status
    // update mid-run (e.g. 'queued' -> 'transcribing') must not drop the
    // fraction already tracked for it.
    if (updated.transcriptStatus !== 'queued' && updated.transcriptStatus !== 'transcribing') {
      setTranscribeProgress((prev) => {
        const next = { ...prev }
        delete next[updated.id]
        return next
      })
    }
    refetch()
  })

  const importPaths = useCallback(
    async (paths: string[]): Promise<void> => {
      if (paths.length === 0) return
      setImportError(null)
      try {
        await api.invoke('recordings:import', { paths })
        refetch()
      } catch (err) {
        setImportError(err instanceof Error ? err.message : String(err))
      }
    },
    [refetch]
  )

  async function pickFiles(): Promise<void> {
    const paths = await api.invoke('dialog:pickMediaFiles')
    await importPaths(paths)
  }

  async function cardAction(fn: () => Promise<unknown>): Promise<void> {
    setCardActionError(null)
    try {
      await fn()
    } catch (err) {
      setCardActionError(err instanceof Error ? err.message : String(err))
    }
  }

  function onDrop(e: React.DragEvent): void {
    e.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    // File.path was removed in Electron 32; the preload bridge resolves it.
    const paths = Array.from(e.dataTransfer.files).map((f) => window.api.getPathForFile(f))
    void importPaths(paths.filter(Boolean))
  }

  const recordings: Recording[] = data ?? []
  const ffmpegMissing = info != null && !info.ffmpegAvailable

  return (
    <div
      className={dragging ? 'page page--dropping' : 'page'}
      onDragEnter={(e) => {
        e.preventDefault()
        dragDepth.current += 1
        setDragging(true)
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={(e) => {
        e.preventDefault()
        dragDepth.current -= 1
        if (dragDepth.current <= 0) setDragging(false)
      }}
      onDrop={onDrop}
    >
      <header className="page__header">
        <div>
          <h1>Library</h1>
          <p className="page__subtitle">
            {loading
              ? 'Loading…'
              : `${recordings.length} recording${recordings.length === 1 ? '' : 's'}`}
          </p>
        </div>
        <div className="page__actions">
          <button className="btn btn--primary" onClick={pickFiles} disabled={ffmpegMissing}>
            Import file
          </button>
        </div>
      </header>

      {ffmpegMissing && (
        <div className="banner banner--warn">
          The ffmpeg helper is missing, so importing is disabled. Run{' '}
          <code>npm run sidecars</code> and restart.
        </div>
      )}
      {error && <div className="banner banner--error">{error}</div>}
      {importError && <div className="banner banner--error">{importError}</div>}
      {cardActionError && <div className="banner banner--error">{cardActionError}</div>}

      {!loading && recordings.length === 0 && !error ? (
        <div className="empty empty--drop">
          {/* The logo's waveform, drawn from the same bars the brand mark uses,
              so an empty library still looks like the product. */}
          <div className="empty__mark" aria-hidden="true">
            {[10, 20, 32, 24, 14, 26, 18, 8].map((height, i) => (
              <span key={i} style={{ height: `${height}px` }} />
            ))}
          </div>
          <h2>Record and keep your audio</h2>
          <p>
            Record straight from your microphone and system audio, or bring in a file
            you already have. Supported: {SUPPORTED_MEDIA_EXTENSIONS.slice(0, 6).join(', ')} and more.
          </p>
          <div className="empty__actions">
            <button className="btn btn--primary" onClick={pickFiles}>
              Import audio
            </button>
            <button className="btn" onClick={() => navigate('/record')}>
              Record
            </button>
          </div>
        </div>
      ) : (
        <div className="cards">
          {recordings.map((r) => (
            <RecordingCard
              key={r.id}
              recording={r}
              playingId={playingId}
              onPlay={setPlayingId}
              onOpen={(id) => navigate(`/recordings/${id}`)}
              onRename={async (id, title) => {
                await api.invoke('recordings:rename', { id, title })
                refetch()
              }}
              onDelete={(id) => {
                void api.invoke('recordings:delete', { id }).then(refetch)
              }}
              onTranscribe={(id) => void cardAction(() => api.invoke('transcript:start', { recordingId: id }))}
              onExportTranscript={(id) =>
                void cardAction(() => api.invoke('transcript:export', { recordingId: id, format: 'txt' }))
              }
              onExportAudio={(id) => void cardAction(() => api.invoke('audio:export', { recordingId: id }))}
              job={progress[r.id] ? { fraction: progress[r.id].fraction } : null}
              transcribing={
                r.transcriptStatus === 'queued' || r.transcriptStatus === 'transcribing'
                  ? {
                      fraction:
                        r.id in transcribeProgress
                          ? transcribeProgress[r.id]
                          : (activeTranscriptions?.find((a) => a.recordingId === r.id)?.fraction ?? null)
                    }
                  : null
              }
            />
          ))}
        </div>
      )}

      {dragging && <div className="dropzone">Drop to import</div>}
    </div>
  )
}
