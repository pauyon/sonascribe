import { BrowserWindow, shell } from 'electron'
import { is } from '@electron-toolkit/utils'
import { join } from 'node:path'
import { focusMainWindow } from './main-window'

/**
 * The mini recording-controls window: a small always-on-top pause/resume and
 * status panel, so those stay reachable with the main window minimized.
 *
 * Loads the same renderer bundle as the main window, at the `#/mini-recorder`
 * hash route — `App.tsx` recognises that path and renders the mini UI in
 * place of the normal sidebar/content shell. `HashRouter` makes this free, no
 * separate HTML entry point needed. electron-vite bundles the whole main
 * process into one `out/main/index.js`, so `__dirname` here resolves exactly
 * as it does in `main/index.ts` regardless of this file's own nesting.
 */

let miniWindow: BrowserWindow | null = null

const WIDTH = 300
// One icon-button toolbar row now instead of three text-button rows, plus
// room for the screenshot confirmation text.
const COLLAPSED_HEIGHT = 180
// Same +290px transcript budget above COLLAPSED as before the toolbar shrank.
const TRANSCRIPT_HEIGHT = COLLAPSED_HEIGHT + 290
// Generous for a handful of monitors; the picker itself scrolls past that
// rather than this needing to grow with however many are connected.
const DISPLAYS_HEIGHT = COLLAPSED_HEIGHT + 140

const HEIGHTS = {
  collapsed: COLLAPSED_HEIGHT,
  transcript: TRANSCRIPT_HEIGHT,
  displays: DISPLAYS_HEIGHT
} as const

/** Opens the window, or focuses it if one is already open. */
export function openMiniRecorderWindow(): void {
  if (miniWindow) {
    miniWindow.show()
    miniWindow.focus()
    return
  }

  miniWindow = new BrowserWindow({
    width: WIDTH,
    height: COLLAPSED_HEIGHT,
    // width/height above and setContentSize() below both then mean the same
    // thing — the web content area, not the outer window frame.
    useContentSize: true,
    show: false,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    backgroundColor: '#f7f8fa',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Matches the main window: this is exactly the window meant to stay
      // live while backgrounded or minimized.
      backgroundThrottling: false
    }
  })

  miniWindow.on('ready-to-show', () => miniWindow?.show())
  miniWindow.on('closed', () => {
    miniWindow = null
    // This is now the only route to the mini window (the manual "Pop out
    // controls" button is gone), so losing it should read as "back to the
    // main window" rather than leaving the user looking at whatever else was
    // on screen. Harmless no-op if the main window is already visible, or
    // gone too (e.g. the app is quitting).
    focusMainWindow()
  })
  miniWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void miniWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#/mini-recorder`)
  } else {
    // Electron's `hash` option doesn't prepend a leading slash on its own —
    // HashRouter needs one for this to resolve to the /mini-recorder route
    // rather than an unmatched relative path.
    void miniWindow.loadFile(join(__dirname, '../renderer/index.html'), {
      hash: '/mini-recorder'
    })
  }
}

/**
 * Resizes the window to fit whichever panel is open — 'collapsed' for
 * neither. The transcript and the display picker are mutually exclusive (see
 * the IPC doc comment), so this is a single preset pick, not two independent
 * heights to add together.
 */
export function resizeMiniRecorderWindow(mode: 'collapsed' | 'transcript' | 'displays'): void {
  if (!miniWindow) return
  // A non-resizable window can silently ignore a programmatic resize that
  // shrinks it back down on Windows — growing worked, but the collapse back
  // to the original size did not. Lifting the resizable constraint just for
  // the call, then reinstating it, is the standard workaround; the user
  // still can't drag-resize it in between since both calls are synchronous.
  miniWindow.setResizable(true)
  miniWindow.setContentSize(WIDTH, HEIGHTS[mode])
  miniWindow.setResizable(false)
}

/** Closes the window if open — a no-op otherwise. */
export function closeMiniRecorderWindow(): void {
  miniWindow?.close()
}
