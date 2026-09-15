import { useEffect, useState } from 'react'

/**
 * A boolean UI preference (collapsed/expanded, shown/hidden) that survives a
 * restart — same try/catch-wrapped localStorage shape as `useTheme.ts`,
 * generalized since a second collapsible surface needed the identical
 * read-once/write-on-change behavior with nothing theme-specific about it.
 */
export function usePersistedBoolean(key: string, defaultValue: boolean): [boolean, (next: boolean) => void] {
  const [value, setValue] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem(key)
      if (saved === 'true') return true
      if (saved === 'false') return false
    } catch {
      // Private mode or blocked storage — fall through to the default below.
    }
    return defaultValue
  })

  useEffect(() => {
    try {
      localStorage.setItem(key, String(value))
    } catch {
      // Blocked storage only costs the preference surviving a restart.
    }
  }, [key, value])

  return [value, setValue]
}
