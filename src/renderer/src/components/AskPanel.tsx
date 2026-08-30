import { useState } from 'react'
import { api } from '../lib/api'
import { formatDuration } from '../lib/format'

/**
 * Offline RAG: ask a plain-language question about this recording and get a
 * written answer grounded in its transcript, with clickable citations.
 *
 * Deliberately a distinct card with an explicit "Ask" action, not another
 * instant-as-you-type input like the keyword filter above it — a real
 * generation call takes a few seconds, and this session's search UI already
 * proved that making two different kinds of action look like the same
 * control just confuses which one you're using.
 */

interface Citation {
  text: string
  startMs: number
  endMs: number
}

export default function AskPanel({
  recordingId,
  onSeek
}: {
  recordingId: string
  onSeek: (ms: number) => void
}): React.JSX.Element {
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState<string | null>(null)
  const [citations, setCitations] = useState<Citation[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function ask(): Promise<void> {
    const trimmed = question.trim()
    if (!trimmed || loading) return

    setLoading(true)
    setError(null)
    setAnswer(null)
    setCitations([])
    try {
      const result = await api.invoke('ask:query', { question: trimmed, recordingId })
      setAnswer(result.answer)
      setCitations(result.citations)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
    setLoading(false)
  }

  return (
    <div className="ask-panel">
      <label className="ask-panel__label" htmlFor="ask-question">
        Ask about this recording
      </label>
      <form
        className="ask-panel__form"
        onSubmit={(e) => {
          e.preventDefault()
          void ask()
        }}
      >
        <input
          id="ask-question"
          className="input ask-panel__input"
          type="text"
          placeholder="e.g. What did we decide about the budget?"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
        />
        <button type="submit" className="btn btn--primary" disabled={loading || !question.trim()}>
          Ask
        </button>
      </form>

      {loading && <p className="ask-panel__status">Thinking…</p>}
      {error && <p className="ask-panel__status ask-panel__status--error">{error}</p>}

      {answer && !loading && (
        <>
          <p className="ask-panel__answer">{answer}</p>
          {citations.length > 0 && (
            <div className="ask-panel__citations">
              {citations.map((citation, i) => (
                <button
                  key={i}
                  type="button"
                  className="ask-panel__citation"
                  onClick={() => onSeek(citation.startMs)}
                  title={citation.text}
                >
                  {formatDuration(citation.startMs)}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
