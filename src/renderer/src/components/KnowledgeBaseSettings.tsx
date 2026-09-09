import { useCallback, useState } from 'react'
import { RECOMMENDED_OLLAMA_MODELS, type OllamaPullProgress } from '@shared/ollama'
import { api, useEvent, useQuery } from '../lib/api'
import { formatBytes } from '../lib/format'
import Select from './Select'
import Icon from './Icon'

/**
 * "Knowledge Base" Settings card: Ollama status, its installed models, a
 * curated Pull list for the two roles this app needs (one embedding model,
 * one chat model), and the semantic-memory index (chunk count + a manual
 * reindex). Ollama itself is never bundled or managed by this app the way
 * the ASR sidecars are — this card only ever talks to whatever the user
 * already has running, and degrades to a plain "not detected" state when
 * they don't.
 */
export default function KnowledgeBaseSettings(): React.JSX.Element {
  const { data: status, refetch: refetchStatus } = useQuery('ollama:status')
  const { data: settings, refetch: refetchSettings } = useQuery('rag:getSettings')
  const { data: indexStatus, refetch: refetchIndex } = useQuery('rag:getIndexStatus')

  const [pulls, setPulls] = useState<Record<string, OllamaPullProgress>>({})
  const [reindexing, setReindexing] = useState(false)
  const [serverUrlDraft, setServerUrlDraft] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEvent('ollama:pullProgress', (payload) => {
    setPulls((prev) => ({ ...prev, [payload.modelName]: payload }))
    if (payload.error) setError(`${payload.modelName}: ${payload.error}`)
    if (payload.done) {
      setPulls((prev) => {
        const next = { ...prev }
        delete next[payload.modelName]
        return next
      })
      refetchStatus()
    }
  })

  useEvent('rag:indexProgress', (payload) => {
    setReindexing(!payload.done)
    if (payload.done) {
      refetchIndex()
    }
  })

  const act = useCallback(async (fn: () => Promise<unknown>): Promise<void> => {
    setError(null)
    try {
      await fn()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const serverUrl = serverUrlDraft ?? settings?.serverUrl ?? ''

  async function commitServerUrl(): Promise<void> {
    const trimmed = serverUrlDraft?.trim()
    setServerUrlDraft(null)
    if (!trimmed || trimmed === settings?.serverUrl) return
    await act(async () => {
      await api.invoke('rag:setSettings', { serverUrl: trimmed })
      refetchSettings()
      refetchStatus()
    })
  }

  // Ollama's own model listing doesn't reliably expose which models can
  // embed vs. chat, so this only guards against our own curated catalogue —
  // e.g. picking nomic-embed-text (embedding-only) as the chat model fails
  // every question with a 400 from Ollama, which is what prompted this.
  // An installed model outside the catalogue is left selectable in both,
  // since its role genuinely isn't known.
  const knownEmbeddingNames = new Set(
    RECOMMENDED_OLLAMA_MODELS.filter((m) => m.role === 'embedding').map((m) => m.name)
  )
  const knownChatNames = new Set(RECOMMENDED_OLLAMA_MODELS.filter((m) => m.role === 'chat').map((m) => m.name))
  const embeddingOptions = (status?.models ?? [])
    .filter((m) => !knownChatNames.has(m.name))
    .map((m) => ({ value: m.name, label: m.name }))
  const chatOptions = (status?.models ?? [])
    .filter((m) => !knownEmbeddingNames.has(m.name))
    .map((m) => ({ value: m.name, label: m.name }))

  return (
    <div>
      {error && <div className="banner banner--error">{error}</div>}

      <div className="settings-card">
        <div className="settings-card__row">
          <span className={status?.running ? 'kb-dot kb-dot--on' : 'kb-dot'} aria-hidden="true" />
          <span className="settings-card__row-label">
            {status?.running
              ? `Running${status.version ? ` — v${status.version}` : ''} at ${settings?.serverUrl ?? ''}`
              : 'Ollama not detected'}
          </span>
          {!status?.running && (
            <a
              className="btn btn--sm kb-download-link"
              href="https://ollama.com/download"
              target="_blank"
              rel="noreferrer"
            >
              <Icon name="download" />
              Download Ollama
            </a>
          )}
          <button
            type="button"
            className="kb-refresh-btn"
            onClick={() => refetchStatus()}
            aria-label="Refresh"
            title="Refresh"
          >
            <Icon name="refresh" />
          </button>
        </div>

        <div className="settings-card__row">
          <span className="kb-field-label">Server URL</span>
          <input
            type="text"
            className="input settings-card__row-input"
            value={serverUrl}
            onChange={(e) => setServerUrlDraft(e.target.value)}
            onBlur={() => void commitServerUrl()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            }}
          />
        </div>
      </div>

      {status?.running && (
        <>
          <div className="settings-card kb-models">
            <div className="settings-card__row">
              <span className="settings-card__row-label">Embedding model</span>
              <Select
                value={settings?.embeddingModel ?? ''}
                options={embeddingOptions}
                placeholder="Not set"
                onChange={(value) =>
                  void act(async () => {
                    await api.invoke('rag:setSettings', { embeddingModel: value })
                    refetchSettings()
                  })
                }
                ariaLabel="Embedding model"
                align="end"
              />
            </div>
            <div className="settings-card__row">
              <span className="settings-card__row-label">Chat model</span>
              <Select
                value={settings?.chatModel ?? ''}
                options={chatOptions}
                placeholder="Not set"
                onChange={(value) =>
                  void act(async () => {
                    await api.invoke('rag:setSettings', { chatModel: value })
                    refetchSettings()
                  })
                }
                ariaLabel="Chat model"
                align="end"
              />
            </div>
          </div>

          <div className="settings-section__title kb-subtitle">Recommended</div>
          <div className="settings-card">
            {RECOMMENDED_OLLAMA_MODELS.map((rec) => {
              const installed = (status.models ?? []).some((m) => m.name === rec.name)
              const pull = pulls[rec.name]
              return (
                <div key={rec.name} className="settings-card__row kb-recommend-row">
                  <div className="kb-recommend-main">
                    <div className="kb-recommend-head">
                      <span className="settings-card__row-label">{rec.label}</span>
                      <span className="pill">{rec.role === 'embedding' ? 'Embeddings' : 'Chat'}</span>
                    </div>
                    <p className="kb-recommend-blurb">{rec.blurb}</p>
                    {pull && (
                      <div className="progress progress--wide">
                        <div
                          className={
                            pull.fraction == null ? 'progress__bar progress__bar--indeterminate' : 'progress__bar'
                          }
                          style={pull.fraction == null ? undefined : { width: `${Math.round(pull.fraction * 100)}%` }}
                        />
                        <span className="progress__label">
                          {pull.totalBytes
                            ? `${formatBytes(pull.receivedBytes)} of ${formatBytes(pull.totalBytes)}`
                            : 'Starting…'}
                        </span>
                      </div>
                    )}
                  </div>
                  {installed ? (
                    <span className="pill">Installed</span>
                  ) : pull ? (
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() => void act(() => api.invoke('ollama:cancelPull', { modelName: rec.name }))}
                    >
                      Cancel
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn btn--sm"
                      onClick={() => void act(() => api.invoke('ollama:pullModel', { modelName: rec.name }))}
                    >
                      Pull
                    </button>
                  )}
                </div>
              )
            })}
          </div>

          <div className="settings-section__title kb-subtitle">Semantic memory</div>
          <div className="settings-card">
            <div className="settings-card__row">
              <span className="settings-card__row-label">
                {indexStatus
                  ? `${indexStatus.chunkCount} chunk${indexStatus.chunkCount === 1 ? '' : 's'} indexed across ${indexStatus.indexedRecordings} of ${indexStatus.totalRecordings} recording${indexStatus.totalRecordings === 1 ? '' : 's'}`
                  : 'Loading…'}
              </span>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                disabled={reindexing || !settings?.embeddingModel}
                title={settings?.embeddingModel ? undefined : 'Pick an embedding model first'}
                onClick={() => void act(() => api.invoke('rag:reindexAll'))}
              >
                {reindexing ? 'Reindexing…' : 'Reindex now'}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
