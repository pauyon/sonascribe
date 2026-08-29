import { useState } from 'react'
import { api } from '../lib/api'
import { formatDuration } from '../lib/format'

/**
 * Semantic search — finds a passage by meaning, not exact text.
 *
 * Deliberately separate from the plain-text search already in the editor
 * toolbar: that one is an instant client-side filter over lines already on
 * screen; this one calls the offline embedding pipeline and can find a
 * passage that never uses the words you typed.
 */

export interface SearchHit {
  recordingId: string
  recordingTitle: string
  text: string
  startMs: number
  endMs: number
  score: number
}

export default function SearchBox({
  recordingId,
  placeholder,
  onResultClick
}: {
  /** Scope to one recording, or omit to search every recording. */
  recordingId?: string
  placeholder: string
  onResultClick: (hit: SearchHit) => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchHit[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function runSearch(): Promise<void> {
    const trimmed = query.trim()
    if (!trimmed) {
      setResults(null)
      setError(null)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const hits = await api.invoke('search:query', { query: trimmed, recordingId })
      setResults(hits)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setResults(null)
    }
    setLoading(false)
  }

  return (
    <div className="search">
      <input
        className="input search__input"
        type="search"
        placeholder={placeholder}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void runSearch()
        }}
      />

      {loading && <p className="search__status">Searching…</p>}
      {error && <p className="search__status search__status--error">{error}</p>}
      {!loading && !error && results && results.length === 0 && (
        <p className="search__status">No matches.</p>
      )}

      {!loading && results && results.length > 0 && (
        <div className="search__results">
          {results.map((hit, i) => (
            <button
              key={i}
              type="button"
              className="search__result"
              onClick={() => onResultClick(hit)}
            >
              <span className="search__result-meta">
                {!recordingId && (
                  <span className="search__result-title">{hit.recordingTitle}</span>
                )}
                <span className="search__result-time">{formatDuration(hit.startMs)}</span>
              </span>
              <span className="search__result-text">{hit.text}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
