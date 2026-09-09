import { useEffect, useRef, useState } from 'react'
import type { AskCitation, AskResult } from '@shared/ollama'
import { api } from '../lib/api'
import { formatDuration } from '../lib/format'
import Icon from './Icon'

/**
 * Question + answer, grounded in retrieved transcript chunks. Mounted two
 * ways: scoped to one recording (`Editor.tsx` passes `recordingId` and
 * `onSeek`, its player's own seek function) or across the whole library
 * (`Ask.tsx` passes neither, and instead `onNavigateToRecording` for
 * jumping to a citation that isn't the currently-open recording).
 */
export default function AskPanel({
  recordingId,
  onSeek,
  onNavigateToRecording
}: {
  recordingId?: string
  /** Jumps the currently-open recording's playback — only used for a citation that belongs to it. */
  onSeek?: (ms: number) => void
  /** Navigates to a different recording and seeks there once it loads. */
  onNavigateToRecording?: (recordingId: string, ms: number) => void
}): React.JSX.Element {
  const [question, setQuestion] = useState('')
  const [result, setResult] = useState<AskResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const copyResetRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // The copy button's "Copied"/"failed" state reverts after 2s; without
  // clearing this on unmount, asking another question or closing the panel
  // within that window still fires the timeout and calls setState after
  // this component is gone.
  useEffect(() => {
    return () => {
      if (copyResetRef.current) clearTimeout(copyResetRef.current)
    }
  }, [])

  async function ask(): Promise<void> {
    const trimmed = question.trim()
    if (!trimmed || loading) return
    setLoading(true)
    setError(null)
    setCopyState('idle')
    try {
      const response = await api.invoke('ask:ask', { question: trimmed, recordingId })
      setResult(response)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setResult(null)
    } finally {
      setLoading(false)
    }
  }

  async function copyAnswer(): Promise<void> {
    try {
      await navigator.clipboard.writeText(result?.answer ?? '')
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
    if (copyResetRef.current) clearTimeout(copyResetRef.current)
    copyResetRef.current = setTimeout(() => setCopyState('idle'), 2000)
  }

  function jump(citation: AskCitation): void {
    if (citation.recordingId === recordingId && onSeek) onSeek(citation.startMs)
    else onNavigateToRecording?.(citation.recordingId, citation.startMs)
  }

  return (
    <div className="ask">
      <form
        className="ask__form"
        onSubmit={(e) => {
          e.preventDefault()
          void ask()
        }}
      >
        <input
          type="text"
          className="input ask__input"
          value={question}
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder={recordingId ? 'Ask about this recording…' : 'Ask about your recordings…'}
        />
        <button
          type="submit"
          className="btn ask__submit"
          disabled={!question.trim() || loading}
          aria-label="Ask"
        >
          <Icon name="send" />
        </button>
      </form>

      {error && <div className="banner banner--error">{error}</div>}

      {loading && <p className="ask__loading">Thinking…</p>}

      {result && !loading && (
        <div className="ask__result">
          <div className="ask__answer-row">
            <p className="ask__answer">{result.answer}</p>
            <button
              type="button"
              className="ask__copy"
              onClick={() => void copyAnswer()}
              aria-label={copyState === 'copied' ? 'Copied' : 'Copy answer'}
              title={copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy answer'}
            >
              <Icon name={copyState === 'copied' ? 'check' : 'copy'} />
            </button>
          </div>
          {result.citations.length > 0 && (
            <div className="ask__sources">
              <span className="ask__sources-label">Sources</span>
              <div className="ask__citations">
                {result.citations.map((c, i) => (
                  <button
                    type="button"
                    key={i}
                    className="ask__citation"
                    onClick={() => jump(c)}
                    title={c.text}
                  >
                    {!recordingId && <span className="ask__citation-title">{c.recordingTitle}</span>}
                    <span className="ask__citation-time">{formatDuration(c.startMs)}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
