import { useCallback, useEffect, useRef, useState } from 'react'
import type { Channel, EventName, EventPayload, Request, Response } from '@shared/ipc'

/** Direct, fully typed call into the main process. */
export const api = {
  invoke: <C extends Channel>(
    ...args: Request<C> extends void ? [channel: C] : [channel: C, payload: Request<C>]
  ): Promise<Response<C>> => window.api.invoke<C>(...args)
}

export interface QueryState<T> {
  data: T | null
  error: string | null
  loading: boolean
  refetch: () => void
}

/**
 * Minimal fetch-on-mount hook for IPC reads.
 *
 * Deliberately not a full query cache — the app has a handful of screens and
 * pulling in a data-fetching library for them would be more machinery than the
 * problem needs. Revisit if cross-screen cache invalidation becomes common.
 */
export function useQuery<C extends Channel>(
  ...args: Request<C> extends void ? [channel: C] : [channel: C, payload: Request<C>]
): QueryState<Response<C>> {
  const [data, setData] = useState<Response<C> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [nonce, setNonce] = useState(0)

  // Serialize the payload so an inline object literal doesn't refire every render.
  const key = JSON.stringify(args)

  // Keep the latest args without making them a dependency of the effect.
  const argsRef = useRef(args)
  argsRef.current = args

  // Whether anything has been fetched yet. A refetch must not report `loading`,
  // or every screen that renders a spinner while loading blanks itself on each
  // action — losing scroll position, focus, and any in-progress edit.
  const hasDataRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    if (!hasDataRef.current) setLoading(true)
    setError(null)

    window.api
      .invoke<C>(...argsRef.current)
      .then((result) => {
        if (cancelled) return
        hasDataRef.current = true
        setData(result)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [key, nonce])

  const refetch = useCallback(() => setNonce((n) => n + 1), [])

  return { data, error, loading, refetch }
}

/**
 * Subscribes to a main-process push event for the lifetime of the component.
 *
 * The listener is held in a ref so callers can pass an inline arrow function
 * without resubscribing on every render — a subscribe/unsubscribe churn that
 * would drop events landing in the gap.
 */
export function useEvent<E extends EventName>(
  event: E,
  listener: (payload: EventPayload<E>) => void
): void {
  const ref = useRef(listener)
  ref.current = listener

  useEffect(() => {
    return window.api.on(event, (payload) => ref.current(payload))
  }, [event])
}
