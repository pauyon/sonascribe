import { useState } from 'react'
import { api, useQuery } from '../lib/api'
import LogViewer from '../components/LogViewer'

/** Where recordings are stored, and diagnostics. The only settings that don't
 * belong on the Record screen next to what they affect. */
export default function Settings(): React.JSX.Element {
  const { data: storage, error, refetch } = useQuery('storage:get')

  const [moving, setMoving] = useState(false)
  const [moveError, setMoveError] = useState<string | null>(null)
  const [showLogs, setShowLogs] = useState(false)

  async function relocate(folder: string): Promise<void> {
    setMoveError(null)
    setMoving(true)
    try {
      await api.invoke('storage:relocate', { folder })
      refetch()
    } catch (err) {
      setMoveError(err instanceof Error ? err.message : String(err))
    } finally {
      setMoving(false)
    }
  }

  async function chooseFolder(): Promise<void> {
    const folder = await api.invoke('storage:pickFolder')
    if (folder) await relocate(folder)
  }

  return (
    <div className="page">
      <header className="page__header">
        <div>
          <h1>Settings</h1>
          <p className="page__subtitle">Where your recordings live, and diagnostics</p>
        </div>
      </header>

      {error && <div className="banner banner--error">{error}</div>}
      {moveError && <div className="banner banner--error">{moveError}</div>}

      <div className="recorder__group">
        <span className="recorder__group-label">Recordings folder</span>

        <p className="recorder__fine">
          {storage
            ? storage.mediaRoot
            : 'Loading…'}
        </p>

        <div className="toolbar">
          <button
            type="button"
            className="btn"
            onClick={() => void chooseFolder()}
            disabled={!storage || moving}
          >
            {moving ? 'Moving files…' : 'Choose folder…'}
          </button>
          {storage && !storage.isDefault && (
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => void relocate(storage.defaultMediaRoot)}
              disabled={moving}
            >
              Use default location
            </button>
          )}
        </div>

        <p className="recorder__fine">
          Existing recordings are moved to the new folder — this can take a moment for a
          large library. Recording must be stopped first.
        </p>
      </div>

      <div className="recorder__group">
        <span className="recorder__group-label">Diagnostics</span>
        <div className="toolbar">
          <button type="button" className="btn btn--ghost" onClick={() => setShowLogs(true)}>
            View logs
          </button>
        </div>
      </div>

      {showLogs && <LogViewer onClose={() => setShowLogs(false)} />}
    </div>
  )
}
