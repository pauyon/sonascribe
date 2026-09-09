import { useState } from 'react'
import { api, useQuery } from '../lib/api'
import { useTheme, type ThemePreference } from '../lib/useTheme'
import LogViewer from '../components/LogViewer'
import ModelPicker from '../components/ModelPicker'
import KnowledgeBaseSettings from '../components/KnowledgeBaseSettings'
import Select from '../components/Select'
import Icon from '../components/Icon'

const THEME_OPTIONS: Array<{ value: ThemePreference; label: string }> = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' }
]

/** Where recordings are stored, transcription models, and diagnostics. The
 * only settings that don't belong on the Record screen next to what they
 * affect. */
export default function Settings(): React.JSX.Element {
  const { data: storage, error, refetch } = useQuery('storage:get')
  const { data: appInfo } = useQuery('app:info')
  const { preference, setPreference } = useTheme()

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
          <p className="page__subtitle">
            Where your recordings live, transcription models, and diagnostics
          </p>
        </div>
      </header>

      {error && <div className="banner banner--error">{error}</div>}
      {moveError && <div className="banner banner--error">{moveError}</div>}

      <div className="settings-section">
        <h2 className="settings-section__title">General</h2>
        <div className="settings-card">
          <div className="settings-card__row">
            <span className="settings-card__row-icon">
              <Icon name="contrast" />
            </span>
            <span className="settings-card__row-label">Appearance</span>
            <Select
              value={preference}
              options={THEME_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
              onChange={(value) => setPreference(value as ThemePreference)}
              ariaLabel="Appearance"
              align="end"
            />
          </div>

          <button
            type="button"
            className="settings-card__row settings-card__row--link"
            onClick={() => void chooseFolder()}
            disabled={!storage || moving}
          >
            <span className="settings-card__row-icon">
              <Icon name="folder" />
            </span>
            <span className="settings-card__row-label">Recordings folder</span>
            <span className="settings-card__row-value">
              {storage ? storage.mediaRoot : moving ? 'Moving files…' : 'Loading…'}
            </span>
            <Icon name="chevronRight" className="settings-card__row-chevron" />
          </button>

          <button type="button" className="settings-card__row settings-card__row--link" onClick={() => setShowLogs(true)}>
            <span className="settings-card__row-icon">
              <Icon name="transcribe" />
            </span>
            <span className="settings-card__row-label">View Logs</span>
            <Icon name="chevronRight" className="settings-card__row-chevron" />
          </button>
        </div>

        <p className="settings-card__hint">
          Existing recordings are moved to the new folder — this can take a moment for a large
          library, and recording must be stopped first.
          {storage && !storage.isDefault && (
            <>
              {' '}
              <button
                type="button"
                className="settings-card__hint-action"
                onClick={() => void relocate(storage.defaultMediaRoot)}
                disabled={moving}
              >
                Use default location
              </button>
              .
            </>
          )}
        </p>
      </div>

      <div className="settings-section">
        <h2 className="settings-section__title">Transcription Models</h2>
        {appInfo ? (
          <ModelPicker availableEngines={appInfo.availableEngines} />
        ) : (
          <p className="recorder__fine">Loading…</p>
        )}
      </div>

      <div className="settings-section">
        <h2 className="settings-section__title">Knowledge Base</h2>
        <KnowledgeBaseSettings />
      </div>

      {showLogs && <LogViewer onClose={() => setShowLogs(false)} />}
    </div>
  )
}
