import { useCallback, useState } from 'react'
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { useEvent, useQuery } from './lib/api'
import { formatDuration } from './lib/format'
import Library from './routes/Library'
import Record from './routes/Record'
import Editor from './routes/Editor'
import Models from './routes/Models'
import MiniRecorder from './routes/MiniRecorder'

/**
 * Nav icons, inline rather than from an icon package.
 *
 * They are three shapes; a dependency for that is not worth the bundle, and
 * inline SVG inherits currentColor so each one takes the active or muted colour
 * without a second rule. 2px strokes with rounded caps, per the brand sheet.
 */
const ICON = {
  library: (
    <path d="M4 5.5h16M4 12h16M4 18.5h10" />
  ),
  record: (
    <>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6" />
    </>
  )
} as const

const NAV = [
  { to: '/library', label: 'Library', icon: 'library' as const },
  { to: '/record', label: 'Record', icon: 'record' as const },
  { to: '/settings', label: 'Settings', icon: 'settings' as const }
]

function NavIcon({ name }: { name: keyof typeof ICON }): React.JSX.Element {
  return (
    <svg
      className="navlink__icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICON[name]}
    </svg>
  )
}

/**
 * The last few recordings, reachable without going through the library first.
 *
 * Kept short on purpose: this is a way back to what you were just working on,
 * not a second copy of the library. It refreshes on the same event the library
 * listens to, so a recording that finishes transcribing updates here too.
 */
function RecentList(): React.JSX.Element | null {
  const { data: recordings, refetch } = useQuery('recordings:list')
  useEvent('recording:updated', () => refetch())

  const recent = (recordings ?? []).slice(0, 5)
  if (recent.length === 0) return null

  return (
    <div className="recent">
      <div className="recent__label">Recent</div>
      {recent.map((recording) => (
        <NavLink
          key={recording.id}
          to={`/recordings/${recording.id}`}
          className={({ isActive }) => (isActive ? 'recent__item recent__item--active' : 'recent__item')}
          title={recording.title}
        >
          <span className="recent__title">{recording.title}</span>
          <span className="recent__meta">
            {recording.status === 'ready'
              ? formatDuration(recording.durationMs)
              : recording.status === 'failed'
                ? 'Failed'
                : 'Working…'}
          </span>
        </NavLink>
      ))}
    </div>
  )
}

/**
 * The theme already applied to the document.
 *
 * Read from the element rather than from storage: main.tsx sets it before React
 * mounts so the first frame is the right colour, and this keeps the button in
 * step with whatever it decided.
 */
function currentTheme(): 'light' | 'dark' {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

export default function App(): React.JSX.Element {
  const [theme, setTheme] = useState<'light' | 'dark'>(currentTheme)
  const { data: info } = useQuery('app:info')
  const location = useLocation()

  const toggleTheme = useCallback(() => {
    const next = theme === 'dark' ? 'light' : 'dark'
    // Light is the default, so it is expressed by the absence of the attribute
    // rather than by a value — one less state for the stylesheet to handle.
    if (next === 'dark') document.documentElement.dataset.theme = 'dark'
    else delete document.documentElement.dataset.theme
    try {
      localStorage.setItem('sonascribe.theme', next)
    } catch {
      // Blocked storage only costs the preference surviving a restart.
    }
    setTheme(next)
  }, [theme])

  // The mini controls window loads this same bundle at a different hash
  // route and has no sidebar of its own — it's a bare, frameless utility
  // window, not a second copy of the app shell. Below every hook, so this
  // stays clean under the rules-of-hooks check regardless of route.
  if (location.pathname === '/mini-recorder') {
    return <MiniRecorder />
  }

  return (

    <div className="app">
      <aside className="sidebar">
        {/* Drag region so the frameless macOS title bar can still move the window. */}
        <div className="sidebar__drag" />
        <div className="sidebar__brand">
          {/* The logo mark, drawn from four bars rather than shipped as an asset:
              it has to recolour with the theme, and an SVG file would not. */}
          <span className="brand__mark" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
          </span>
          <span>SonaScribe</span>
        </div>
        <nav className="sidebar__nav">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                isActive ? 'navlink navlink--active' : 'navlink'
              }
            >
              <NavIcon name={item.icon} />
              {item.label}
            </NavLink>
          ))}
        </nav>

        <RecentList />

        <div className="sidebar__footer">
          <button
            type="button"
            className="theme-toggle"
            onClick={toggleTheme}
            aria-label={theme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme'}
          >
            {theme === 'dark' ? '☀' : '☾'}
            {theme === 'dark' ? 'Light' : 'Dark'}
          </button>
          <span>Local-only · nothing leaves this device</span>
          {info?.version && <span className="sidebar__version">v{info.version}</span>}
        </div>
      </aside>

      <main className="content">
        <Routes>
          <Route path="/" element={<Navigate to="/library" replace />} />
          <Route path="/library" element={<Library />} />
          <Route path="/record" element={<Record />} />
          <Route path="/settings" element={<Models />} />
          {/* The page was called Models before it grew transcription and speaker
              settings; an old hash should still land somewhere sensible. */}
          <Route path="/models" element={<Navigate to="/settings" replace />} />
          <Route path="/recordings/:id" element={<Editor />} />
          <Route path="*" element={<Navigate to="/library" replace />} />
        </Routes>
      </main>
    </div>
  )
}
