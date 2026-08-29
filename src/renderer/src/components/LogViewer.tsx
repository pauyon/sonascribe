import { useEffect, useState } from 'react'
import { api } from '../lib/api'

/**
 * Read-only view of the current log file, with a one-click copy.
 *
 * Exists for a user who hits a problem and needs to hand over diagnostics
 * without being asked to go find a file path themselves — the textarea is
 * there as a fallback (select-all still works) if the Clipboard API call
 * itself fails for some reason.
 */
export default function LogViewer({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [content, setContent] = useState<string | null>(null)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')

  useEffect(() => {
    let cancelled = false
    api.invoke('logs:read').then((text) => {
      if (!cancelled) setContent(text)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(content ?? '')
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
    setTimeout(() => setCopyState('idle'), 2000)
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Logs">
        <div className="modal__header">
          <h2>Logs</h2>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Close
          </button>
        </div>

        <textarea
          className="modal__log"
          readOnly
          value={content == null ? 'Loading…' : content || '(Nothing has been logged yet.)'}
          onFocus={(e) => e.currentTarget.select()}
        />

        <div className="modal__footer">
          <button type="button" className="btn btn--primary" onClick={() => void copy()} disabled={!content}>
            {copyState === 'copied' ? 'Copied!' : copyState === 'failed' ? 'Copy failed — select and press Ctrl+C' : 'Copy to clipboard'}
          </button>
        </div>
      </div>
    </div>
  )
}
