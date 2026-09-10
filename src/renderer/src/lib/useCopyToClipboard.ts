import { useEffect, useRef, useState } from 'react'

export type CopyState = 'idle' | 'copied' | 'failed'

/**
 * Copy-to-clipboard with a "Copied"/"failed" state that reverts after a
 * couple seconds — was hand-rolled identically in LogViewer.tsx and
 * AskPanel.tsx (state, a ref-held revert timeout, and a cleanup effect so
 * closing/unmounting mid-revert doesn't set state on a gone component).
 */
export function useCopyToClipboard(resetAfterMs = 2000): {
  copyState: CopyState
  copy: (text: string) => Promise<void>
  reset: () => void
} {
  const [copyState, setCopyState] = useState<CopyState>('idle')
  const resetRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (resetRef.current) clearTimeout(resetRef.current)
    }
  }, [])

  async function copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text)
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
    if (resetRef.current) clearTimeout(resetRef.current)
    resetRef.current = setTimeout(() => setCopyState('idle'), resetAfterMs)
  }

  function reset(): void {
    if (resetRef.current) clearTimeout(resetRef.current)
    setCopyState('idle')
  }

  return { copyState, copy, reset }
}
