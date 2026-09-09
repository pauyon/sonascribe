import { useEffect, useRef, useState } from 'react'
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { useEvent, useQuery } from './lib/api'
import { formatDuration } from './lib/format'
import Library from './routes/Library'
import Record from './routes/Record'
import Editor from './routes/Editor'
import Trim from './routes/Trim'
import Ask from './routes/Ask'
import Settings from './routes/Settings'
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
  ),
  ask: (
    <path d="M4 4h16a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H9l-5 4v-4H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z" />
  )
} as const

const NAV = [
  { to: '/library', label: 'Library', icon: 'library' as const },
  { to: '/record', label: 'Record', icon: 'record' as const },
  { to: '/ask', label: 'Ask', icon: 'ask' as const },
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
/** `locked`: a recording is in progress, so following this link would silently end it (see App.tsx's own nav lock for why). */
function RecentList({ locked }: { locked: boolean }): React.JSX.Element | null {
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
          className={({ isActive }) =>
            [
              'recent__item',
              isActive ? 'recent__item--active' : null,
              locked ? 'recent__item--locked' : null
            ]
              .filter(Boolean)
              .join(' ')
          }
          onClick={(e) => {
            if (locked) e.preventDefault()
          }}
          aria-disabled={locked}
          title={locked ? 'Finish or discard the current recording first' : recording.title}
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

export default function App(): React.JSX.Element {
  const { data: info } = useQuery('app:info')
  const location = useLocation()

  /**
   * Whether a recording is currently in progress, anywhere — locks every
   * sidebar link except Record itself so leaving the page can't silently
   * end it the way it used to (Record.tsx's own capture teardown fires on
   * unmount; navigating away mid-recording used to discard the take
   * outright). Bootstraps from the same `recording:status` query
   * `MiniRecorder.tsx` uses, then tracks live via broadcasts so it stays
   * correct regardless of which window (this one or the mini pop-out)
   * actually started/stopped/discarded it.
   */
  const { data: recordingStatus, loading: statusLoading } = useQuery('recording:status')
  const [recordingActive, setRecordingActive] = useState(false)
  const appliedInitialStatus = useRef(false)

  useEffect(() => {
    if (appliedInitialStatus.current || statusLoading) return
    appliedInitialStatus.current = true
    setRecordingActive(recordingStatus !== null)
  }, [statusLoading, recordingStatus])

  useEvent('recording:started', () => setRecordingActive(true))
  useEvent('recording:stopped', () => setRecordingActive(false))
  useEvent('recording:discarded', () => setRecordingActive(false))

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
          {NAV.map((item) => {
            // Record itself stays clickable — there must always be a way
            // back to the live page — everything else is locked while a
            // recording is in progress, the same reasoning as RecentList.
            const locked = recordingActive && item.to !== '/record'
            return (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  [
                    'navlink',
                    isActive ? 'navlink--active' : null,
                    locked ? 'navlink--locked' : null
                  ]
                    .filter(Boolean)
                    .join(' ')
                }
                onClick={(e) => {
                  if (locked) e.preventDefault()
                }}
                aria-disabled={locked}
                title={locked ? 'Finish or discard the current recording first' : undefined}
              >
                <NavIcon name={item.icon} />
                {item.label}
              </NavLink>
            )
          })}
        </nav>

        <RecentList locked={recordingActive} />

        <div className="sidebar__footer">
          <span>Local-only · nothing leaves this device</span>
          {info?.version && <span className="sidebar__version">v{info.version}</span>}
        </div>
      </aside>

      <main className="content">
        <Routes>
          <Route path="/" element={<Navigate to="/library" replace />} />
          <Route path="/library" element={<Library />} />
          <Route path="/record" element={<Record />} />
          <Route path="/ask" element={<Ask />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/recordings/:id" element={<Editor />} />
          <Route path="/recordings/:id/edit" element={<Trim />} />
          <Route path="*" element={<Navigate to="/library" replace />} />
        </Routes>
      </main>
    </div>
  )
}
