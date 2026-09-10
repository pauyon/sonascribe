import { useEffect, useRef, type RefObject } from 'react'

/**
 * Closes on a click outside `ref`'s element, optionally on Escape too —
 * the identical `mousedown`-outside-check effect Select.tsx and
 * OverflowMenu.tsx each implemented separately (OverflowMenu's own comment
 * even says it reuses Select's behavior, though the code didn't). Only
 * attaches listeners while `active`, matching both original call sites
 * (which only listened while their own dropdown/menu was open).
 *
 * `onClose` is held in a ref — same reason `lib/api.ts`'s `useEvent` does —
 * so a caller passing a fresh inline arrow function each render doesn't
 * resubscribe the listener every time, and never calls a stale closure.
 */
export function useClickOutside(
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
  options: { active: boolean; escape?: boolean } = { active: true }
): void {
  const { active, escape = false } = options
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    if (!active) return

    const onMouseDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) onCloseRef.current()
    }
    document.addEventListener('mousedown', onMouseDown)

    let onKeyDown: ((e: KeyboardEvent) => void) | undefined
    if (escape) {
      onKeyDown = (e: KeyboardEvent): void => {
        if (e.key === 'Escape') onCloseRef.current()
      }
      document.addEventListener('keydown', onKeyDown)
    }

    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      if (onKeyDown) document.removeEventListener('keydown', onKeyDown)
    }
  }, [active, escape, ref])
}
