import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import App from './App'
// Bundled with the app rather than fetched: it must work offline, and the
// renderer's content security policy allows no outside origins.
import '@fontsource-variable/inter'
import './styles.css'

/**
 * Applies the saved theme before React paints.
 *
 * Read here rather than in a component so the first frame is already the right
 * colour: setting it after mount shows a flash of the wrong theme.
 */
try {
  const saved = localStorage.getItem('sonascribe.theme')
  if (saved === 'dark' || saved === 'light') {
    document.documentElement.dataset.theme = saved
  }
} catch {
  // Private mode or blocked storage: the default light theme is fine.
}

const container = document.getElementById('root')
if (!container) throw new Error('Root element not found')

createRoot(container).render(
  <StrictMode>
    {/* HashRouter, not BrowserRouter: the packaged app loads over file://,
        where path-based routing has no server to fall back on. */}
    <HashRouter>
      <App />
    </HashRouter>
  </StrictMode>
)
