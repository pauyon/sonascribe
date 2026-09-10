import { useCallback, useState } from 'react'

/**
 * Wraps an async action with the "clear any previous error, run it, catch
 * and surface a failure, then run a settle callback (usually a refetch)"
 * shape that kept getting hand-rolled per component (ModelPicker's
 * `actModels`/`actSettings`, KnowledgeBaseSettings' `act`). `onSettled` runs
 * whether the action succeeded or failed — matching what every one of those
 * call sites already did, since a failed model download can still change
 * what's on disk (a partial file) and is worth a refetch too.
 */
export function useAsyncAction(onSettled?: () => void): {
  error: string | null
  run: (fn: () => Promise<unknown>) => Promise<void>
} {
  const [error, setError] = useState<string | null>(null)

  const run = useCallback(
    async (fn: () => Promise<unknown>): Promise<void> => {
      setError(null)
      try {
        await fn()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
      onSettled?.()
    },
    [onSettled]
  )

  return { error, run }
}
