import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { ImportProgress, JobProgress, RecordingSummary } from '@shared/types'
import { SUPPORTED_MEDIA_EXTENSIONS } from '@shared/types'
import { api, useEvent, useQuery } from '../lib/api'
import RecordingCard from '../components/RecordingCard'

const STAGE_LABEL: Record<ImportProgress['stage'], string> = {
  copying: 'Copying',
  normalizing: 'Converting audio'
}

export default function Library(): React.JSX.Element {
  const navigate = useNavigate()
  const { data, error, loading, refetch } = useQuery('recordings:list')
  const { data: info } = useQuery('app:info')

  const [progress, setProgress] = useState<Record<string, ImportProgress>>({})
  const [jobs, setJobs] = useState<Record<string, JobProgress>>({})
  const [dragging, setDragging] = useState(false)
  /** Which card holds playback: starting one stops whichever was going. */
  const [playingId, setPlayingId] = useState<string | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  // Drag events fire for every child element; a counter avoids the highlight
  // flickering as the pointer moves between them.
  const dragDepth = useRef(0)

  useEvent('import:progress', (payload) => {
    setProgress((prev) => ({ ...prev, [payload.recordingId]: payload }))
  })

  useEvent('job:progress', (payload) => {
    setJobs((prev) => ({ ...prev, [payload.recordingId]: payload }))
  })

  // Jobs already running when the list opens. Without this the rows show no bar
  // until each job's next progress event lands, which on a slow stage can be a
  // long time to look like nothing is happening.
  useEffect(() => {
    let cancelled = false
    void api.invoke('transcribe:active').then((active) => {
      if (cancelled) return
      setJobs((prev) => {
        const next = { ...prev }
        for (const job of active) {
          // Never overwrite a live event with a snapshot fetched before it.
          if (job.progress && !next[job.recordingId]) next[job.recordingId] = job.progress
        }
        return next
      })
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEvent('recording:updated', (updated) => {
    setProgress((prev) => {
      const next = { ...prev }
      delete next[updated.id]
      return next
    })
    setJobs((prev) => {
      const next = { ...prev }
      delete next[updated.id]
      return next
    })
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

  function onDrop(e: React.DragEvent): void {
    e.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    // File.path was removed in Electron 32; the preload bridge resolves it.
    const paths = Array.from(e.dataTransfer.files).map((f) => window.api.getPathForFile(f))
    void importPaths(paths.filter(Boolean))
  }

  const recordings: RecordingSummary[] = data ?? []
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

      {!loading && recordings.length === 0 && !error ? (
        <div className="empty empty--drop">
          {/* The logo's waveform, drawn from the same bars the brand mark uses,
              so an empty library still looks like the product. */}
          <div className="empty__mark" aria-hidden="true">
            {[10, 20, 32, 24, 14, 26, 18, 8].map((height, i) => (
              <span key={i} style={{ height: `${height}px` }} />
            ))}
          </div>
          <h2>Turn audio into text</h2>
          <p>
            Record straight from your microphone, or bring in a file you already have.
            Supported: {SUPPORTED_MEDIA_EXTENSIONS.slice(0, 6).join(', ')} and more.
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
          {recordings.map((r) => {
            const job = progress[r.id] ?? jobs[r.id]
            return (
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
                onRetry={(id) => {
                  void api.invoke('transcribe:start', { id }).catch(() => undefined)
                }}
                job={
                  job ? { label: STAGE_LABEL[job.stage] ?? 'Working', fraction: job.fraction } : null
                }
              />
            )
          })}
        </div>
      )}

      {dragging && <div className="dropzone">Drop to import</div>}
    </div>
  )
}
