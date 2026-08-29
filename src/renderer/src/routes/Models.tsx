import { useCallback, useState } from 'react'
import {
  ENGINES,
  MODELS,
  type ModelDownloadProgress,
  type ModelStatus
} from '@shared/models'
import type { SpeakerSplitting } from '@shared/types'
import { api, useEvent, useQuery } from '../lib/api'
import { formatBytes } from '../lib/format'
import Select from '../components/Select'
import LogViewer from '../components/LogViewer'

/** Languages the Whisper models accept, in the order the picker shows them. */
const LANGUAGES = [
  { value: 'en', label: 'English' },
  { value: 'auto', label: 'Detect automatically' },
  { value: 'es', label: 'Spanish' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
  { value: 'pt', label: 'Portuguese' },
  { value: 'it', label: 'Italian' },
  { value: 'nl', label: 'Dutch' },
  { value: 'ja', label: 'Japanese' },
  { value: 'zh', label: 'Chinese' }
]

/** Five dots showing a relative speed/accuracy rating. */
function Rating({ value, label }: { value: number; label: string }): React.JSX.Element {
  return (
    <span className="rating" title={`${label}: ${value} of 5`}>
      <span className="rating__label">{label}</span>
      {[1, 2, 3, 4, 5].map((n) => (
        <span key={n} className={n <= value ? 'dot dot--on' : 'dot'} />
      ))}
    </span>
  )
}

export default function Models(): React.JSX.Element {
  const { data: statuses, refetch } = useQuery('models:list')
  const { data: settings, refetch: refetchSettings } = useQuery('settings:get')
  const { data: info } = useQuery('app:info')
  const { data: profiles, refetch: refetchProfiles } = useQuery('profiles:list')

  const [progress, setProgress] = useState<Record<string, ModelDownloadProgress>>({})
  const [error, setError] = useState<string | null>(null)
  const [showLogs, setShowLogs] = useState(false)

  useEvent('model:progress', (payload) => {
    setProgress((prev) => ({ ...prev, [payload.modelId]: payload }))
    if (payload.error) setError(`${payload.modelId}: ${payload.error}`)
    if (payload.done || payload.error) {
      setProgress((prev) => {
        const next = { ...prev }
        delete next[payload.modelId]
        return next
      })
      refetch()
    }
  })

  const act = useCallback(
    async (fn: () => Promise<unknown>): Promise<void> => {
      setError(null)
      try {
        await fn()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
      refetch()
    },
    [refetch]
  )

  const actProfiles = useCallback(
    async (fn: () => Promise<unknown>): Promise<void> => {
      setError(null)
      try {
        await fn()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
      refetchProfiles()
    },
    [refetchProfiles]
  )

  const byId = new Map<string, ModelStatus>((statuses ?? []).map((s) => [s.id, s]))
  const selectedId = settings?.modelId ?? null

  return (
    <div className="page">
      <header className="page__header">
        <div>
          <h1>Settings</h1>
          <p className="page__subtitle">
            Models, language and speaker detection. Everything here stays on this device.
          </p>
        </div>
      </header>

      {info && !info.whisperAvailable && !info.parakeetAvailable && (
        <div className="banner banner--warn">
          No transcription helper is installed, so nothing can be transcribed. Run{' '}
          <code>npm run sidecars</code> — on macOS it prints install instructions,
          since upstream publishes no macOS binary.
        </div>
      )}
      {error && <div className="banner banner--error">{error}</div>}

      {ENGINES.map((engine) => {
        const engineAvailable =
          info == null
            ? true
            : engine.id === 'parakeet'
              ? info.parakeetAvailable
              : info.whisperAvailable

        return (
        <section key={engine.id} className="engine">
          <div className="engine__head">
            <h2 className="engine__name">{engine.label}</h2>
            {!engineAvailable && <span className="pill pill--failed">helper missing</span>}
          </div>
          <p className="engine__blurb">{engine.blurb}</p>

      <div className="models">
        {MODELS.filter((m) => m.engine === engine.id).map((spec) => {
          const status = byId.get(spec.id)
          const job = progress[spec.id]
          const isSelected = selectedId === spec.id
          const downloading = job != null || status?.downloading === true
          const partial = !status?.installed && (status?.bytesOnDisk ?? 0) > 0

          return (
            <div
              key={spec.id}
              className={isSelected ? 'model model--selected' : 'model'}
            >
              <div className="model__main">
                <div className="model__head">
                  <span className="model__name">{spec.label}</span>
                  {isSelected && <span className="pill pill--ready">In use</span>}
                  {status?.installed && !isSelected && (
                    <span className="pill">Downloaded</span>
                  )}
                  <span className="model__size">{formatBytes(spec.sizeBytes)}</span>
                </div>
                <p className="model__note">{spec.note}</p>
                <div className="model__ratings">
                  <Rating value={spec.speed} label="Speed" />
                  <Rating value={spec.accuracy} label="Accuracy" />
                  <span className="model__lang">
                    {spec.languages === 'english' ? 'English only' : 'All languages'}
                  </span>
                </div>

                {downloading && (
                  <div className="progress progress--wide">
                    <div
                      className={
                        job?.fraction == null
                          ? 'progress__bar progress__bar--indeterminate'
                          : 'progress__bar'
                      }
                      style={
                        job?.fraction == null
                          ? undefined
                          : { width: `${Math.round(job.fraction * 100)}%` }
                      }
                    />
                    <span className="progress__label">
                      {job
                        ? `${formatBytes(job.receivedBytes)} of ${formatBytes(job.totalBytes ?? spec.sizeBytes)}`
                        : 'Starting…'}
                    </span>
                  </div>
                )}

                {partial && !downloading && (
                  <p className="model__partial">
                    {formatBytes(status?.bytesOnDisk ?? 0)} downloaded — will resume
                    where it stopped.
                  </p>
                )}
              </div>

              <div className="model__actions">
                {status?.installed ? (
                  <>
                    <button
                      className="btn btn--primary btn--sm"
                      disabled={isSelected}
                      onClick={() =>
                        act(async () => {
                          await api.invoke('settings:set', { modelId: spec.id })
                          refetchSettings()
                        })
                      }
                    >
                      {isSelected ? 'Selected' : 'Use this'}
                    </button>
                    <button
                      className="btn btn--ghost btn--sm"
                      onClick={() => act(() => api.invoke('models:delete', { id: spec.id }))}
                    >
                      Remove
                    </button>
                  </>
                ) : downloading ? (
                  <button
                    className="btn btn--ghost btn--sm"
                    onClick={() => act(() => api.invoke('models:cancel', { id: spec.id }))}
                  >
                    Cancel
                  </button>
                ) : (
                  <button
                    className="btn btn--sm"
                    disabled={!engineAvailable}
                    title={engineAvailable ? undefined : `The ${engine.label} helper is not installed`}
                    onClick={() => act(() => api.invoke('models:download', { id: spec.id }))}
                  >
                    {partial ? 'Resume' : 'Download'}
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
        </section>
        )
      })}

      <section className="settings-row">
        <label htmlFor="language">Spoken language</label>
        <Select
          id="language"
          value={settings?.language ?? 'en'}
          options={LANGUAGES}
          onChange={(language) =>
            act(async () => {
              await api.invoke('settings:set', { language })
              refetchSettings()
            })
          }
        />
        <p className="settings-row__hint">
          Applies to Whisper models only — English-only ones ignore it, and
          detection costs an extra pass over the audio. Parakeet always
          auto-detects.
        </p>
      </section>

      <section className="settings-row">
        <label htmlFor="speakers">Speaker detection</label>
        <div className="settings-row__inline">
          <label className="toolbar__toggle">
            <input
              type="checkbox"
              checked={settings?.diarize ?? true}
              disabled={info != null && !info.diarizationAvailable}
              onChange={(e) =>
                act(async () => {
                  await api.invoke('settings:set', { diarize: e.target.checked })
                  refetchSettings()
                })
              }
            />
            Identify who is speaking
          </label>
        </div>
        <Select
          id="speakers"
          value={settings?.speakerCount != null ? String(settings.speakerCount) : ''}
          disabled={!(settings?.diarize ?? true)}
          options={[
            { value: '', label: 'Detect number of speakers' },
            ...[2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => ({
              value: String(n),
              label: `At most ${n} speakers`
            }))
          ]}
          onChange={(raw) =>
            act(async () => {
              await api.invoke('settings:set', {
                speakerCount: raw === '' ? null : Number(raw)
              })
              refetchSettings()
            })
          }
        />
        <p className="settings-row__hint">
          Telling it the headcount is noticeably more accurate than letting it
          guess. It acts as a ceiling rather than a quota — you will not get
          invented speakers to fill it.
        </p>
        <Select
          id="splitting"
          value={settings?.speakerSplitting ?? 'balanced'}
          disabled={!(settings?.diarize ?? true) || settings?.speakerCount != null}
          options={[
            { value: 'merge', label: 'Merge similar voices' },
            { value: 'balanced', label: 'Balanced' },
            { value: 'split', label: 'Split eagerly' }
          ]}
          onChange={(value) =>
            act(async () => {
              await api.invoke('settings:set', {
                speakerSplitting: value as SpeakerSplitting
              })
              refetchSettings()
            })
          }
        />
        <p className="settings-row__hint">
          {settings?.speakerCount != null
            ? 'Not used while an exact speaker count is set.'
            : 'Balanced matches the reference recordings. Choose Merge if one person keeps being split into several, or Split if two people are being treated as one.'}
        </p>
        {info != null && !info.diarizationAvailable && (
          <p className="settings-row__hint">
            The diarization helper is missing. Run <code>npm run sidecars</code>.
          </p>
        )}
      </section>

      <section className="settings-row">
        <label>Voice recognition</label>
        <div
          className="settings-row__inline"
          style={{ display: 'flex', alignItems: 'center', gap: 14 }}
        >
          <span>
            {profiles && profiles.length > 0
              ? `${profiles.length} voice${profiles.length === 1 ? '' : 's'} remembered`
              : 'No voices remembered yet'}
          </span>
          {profiles && profiles.length > 0 && (
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => actProfiles(async () => api.invoke('profiles:clearAll'))}
            >
              Clear remembered voices
            </button>
          )}
        </div>
        <p className="settings-row__hint">
          After each recording, this app quietly remembers voices it hasn't matched to anyone
          heard before, so a regular speaker is recognised instead of splitting into a new
          speaker every time. It only affects how many speakers are detected — it does not name
          anyone. Nothing to set up; clear it here if it ever seems off.
        </p>
      </section>

      {info && (
        <p className="page__path">
          Models are stored in {info.modelsPath}
          <br />
          Logs are stored in {info.logPath}{' '}
          <button type="button" className="banner__action" onClick={() => setShowLogs(true)}>
            View
          </button>{' '}
          <button
            type="button"
            className="banner__action"
            onClick={() => void api.invoke('shell:showItemInFolder', { path: info.logPath })}
          >
            Open folder
          </button>
        </p>
      )}

      {showLogs && <LogViewer onClose={() => setShowLogs(false)} />}
    </div>
  )
}
