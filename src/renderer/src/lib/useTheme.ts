import { useEffect, useState } from 'react'

export type ThemePreference = 'light' | 'dark' | 'system'

const STORAGE_KEY = 'sonascribe.theme'

function prefersDark(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
}

/**
 * Applies a preference to the document — the single place that decides what
 * `data-theme` actually is. Light stays expressed by the attribute's
 * absence rather than a value, same as before "system" existed: one less
 * state for the stylesheet to handle.
 */
function applyTheme(pref: ThemePreference): void {
  const dark = pref === 'dark' || (pref === 'system' && prefersDark())
  if (dark) document.documentElement.dataset.theme = 'dark'
  else delete document.documentElement.dataset.theme
}

function readSavedPreference(): ThemePreference {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === 'light' || saved === 'dark' || saved === 'system') return saved
  } catch {
    // Private mode or blocked storage — fall through to the default below.
  }
  // Not "light": a fresh install with no saved choice yet should follow the
  // machine's own theme, not silently default to light regardless of it.
  return 'system'
}

/**
 * The app's theme preference — light, dark, or follow the OS. Mirrors
 * `main.tsx`'s pre-mount read/apply so the very first frame is already
 * correct; this hook just keeps the document in sync afterward and reacts
 * live to an OS theme change while the preference is "system".
 */
export function useTheme(): {
  preference: ThemePreference
  setPreference: (next: ThemePreference) => void
} {
  const [preference, setPreference] = useState<ThemePreference>(readSavedPreference)

  useEffect(() => {
    applyTheme(preference)
    try {
      localStorage.setItem(STORAGE_KEY, preference)
    } catch {
      // Blocked storage only costs the preference surviving a restart.
    }
  }, [preference])

  useEffect(() => {
    if (preference !== 'system') return
    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (): void => applyTheme('system')
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [preference])

  return { preference, setPreference }
}
