import { useCallback, useState } from 'react'
import { MODELS, type AsrEngine, type ModelDownloadProgress, type ModelStatus } from '@shared/models'
import { api, useEvent, useQuery } from '../lib/api'
import { formatBytes } from '../lib/format'
import Select from './Select'

/** Languages Whisper's `-l` flag accepts, in the order the picker shows them. Parakeet ignores this entirely. */
const LANGUAGES = [
  { value: 'auto', label: 'Detect automatically' },
  { value: 'en', label: 'English' },
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

/**
 * One unified "Transcription Models" list — engine and model are chosen
 * together, one radio button per model, rather than picking an engine first
 * and then a model within it. `availableEngines` (from `app:info`) hides
 * any engine whose sidecar binary doesn't actually resolve on this
 * platform, rather than offering a choice that can only fail.
 */
export default function ModelPicker({
  availableEngines
}: {
  availableEngines: AsrEngine[]
}): React.JSX.Element {
  const { data: settings, refetch: refetchSettings } = useQuery('transcription:getSettings')
  const { data: statuses, refetch: refetchModels } = useQuery('models:list')
  const [progress, setProgress] = useState<Record<string, ModelDownloadProgress>>({})
  const [error, setError] = useState<string | null>(null)

  useEvent('model:progress', (payload) => {
    setProgress((prev) => ({ ...prev, [payload.modelId]: payload }))
    if (payload.error) setError(`${payload.modelId}: ${payload.error}`)
    if (payload.done || payload.error) {
      setProgress((prev) => {
        const next = { ...prev }
        delete next[payload.modelId]
        return next
      })
      refetchModels()
    }
  })

  const actModels = useCallback(
    async (fn: () => Promise<unknown>): Promise<void> => {
      setError(null)
      try {
        await fn()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
      refetchModels()
    },
    [refetchModels]
  )

  const actSettings = useCallback(
    async (fn: () => Promise<unknown>): Promise<void> => {
      setError(null)
      try {
        await fn()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
      refetchSettings()
    },
    [refetchSettings]
  )

  if (availableEngines.length === 0) {
    return (
      <div className="banner banner--warn">
        No transcription helper is installed, so nothing can be transcribed. Run{' '}
        <code>npm run sidecars</code> — on macOS it prints install instructions, since upstream
        publishes no macOS binary.
      </div>
    )
  }

  const byId = new Map<string, ModelStatus>((statuses ?? []).map((s) => [s.id, s]))
  const engine = settings && availableEngines.includes(settings.engine) ? settings.engine : availableEngines[0]
  const available = MODELS.filter((m) => availableEngines.includes(m.engine))

  return (
    <div>
      {error && <div className="banner banner--error">{error}</div>}

      <div className="models">
        {available.map((spec) => {
          const status = byId.get(spec.id)
          const job = progress[spec.id]
          const isSelected = engine === spec.engine && settings?.modelId[spec.engine] === spec.id
          const downloading = job != null || status?.downloading === true
          const partial = !status?.installed && (status?.bytesOnDisk ?? 0) > 0

          return (
            <div key={spec.id} className={isSelected ? 'model model--selected' : 'model'}>
              <input
                type="radio"
                className="model__radio"
                name="transcription-model"
                checked={isSelected}
                onChange={() =>
                  void actSettings(() =>
                    api.invoke('transcription:setSettings', {
                      engine: spec.engine,
                      modelId: { [spec.engine]: spec.id }
                    })
                  )
                }
                aria-label={`Use ${spec.label}`}
              />

              <div className="model__main">
                <div className="model__head">
                  <span className="model__name">{spec.label}</span>
                  {status?.installed && <span className="pill">Downloaded</span>}
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
                        job?.fraction == null ? 'progress__bar progress__bar--indeterminate' : 'progress__bar'
                      }
                      style={job?.fraction == null ? undefined : { width: `${Math.round(job.fraction * 100)}%` }}
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
                    {formatBytes(status?.bytesOnDisk ?? 0)} downloaded — will resume where it stopped.
                  </p>
                )}
              </div>

              <div className="model__actions">
                {status?.installed ? (
                  <button
                    type="button"
                    className="model__trash"
                    onClick={() => void actModels(() => api.invoke('models:delete', { modelId: spec.id }))}
                    aria-label={`Remove ${spec.label}`}
                    title="Remove this model"
                  >
                    🗑
                  </button>
                ) : downloading ? (
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => void actModels(() => api.invoke('models:cancelDownload', { modelId: spec.id }))}
                  >
                    Cancel
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={() => void actModels(() => api.invoke('models:download', { modelId: spec.id }))}
                  >
                    {partial ? 'Resume' : 'Download'}
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {engine === 'whisper' && (
        <section className="settings-row">
          <label htmlFor="transcription-language">Spoken language</label>
          <Select
            id="transcription-language"
            value={settings?.language ?? 'auto'}
            options={LANGUAGES}
            onChange={(language) => void actSettings(() => api.invoke('transcription:setSettings', { language }))}
          />
          <p className="settings-row__hint">
            Applies to Whisper only — Parakeet always auto-detects. Naming the language is faster
            than detection and usually more accurate.
          </p>
        </section>
      )}
    </div>
  )
}
