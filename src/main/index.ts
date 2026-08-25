import { app, BrowserWindow, shell } from 'electron'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { join } from 'node:path'
import { closeDb, initDb } from './db'
import { registerIpcHandlers } from './ipc'
import { registerMediaProtocolHandler, registerMediaProtocolScheme } from './protocol'
import { registerDisplayMediaHandler } from './display-media'
import { migrateLegacyUserData } from './migrate-legacy-data'
import { repairMediaPaths, resetInterruptedJobs } from './db/repair-paths'
import { cancelAllJobs } from './services/jobs'
import { sweepOrphanedChunks } from './services/audio-chunks'
import { sweepOrphanedMedia } from './services/media-cleanup'
import { isRecording } from './services/recorder'
import { getAutoPopOutOnMinimize } from './db/settings'
import { closeMiniRecorderWindow, openMiniRecorderWindow } from './windows/mini-recorder'
import { setMainWindow } from './windows/main-window'

// Must run at module load: registerSchemesAsPrivileged is only honoured before
// the app 'ready' event fires.
registerMediaProtocolScheme()

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 940,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    // Matches the light theme the app now opens in; the old dark value flashed
    // a near-black window for a frame before the first paint.
    backgroundColor: '#f7f8fa',
    // Packaged builds take their icon from electron-builder, but a dev run has
    // none and shows Electron's own — this points both at the same artwork.
    icon: join(__dirname, '../../build/icon.png'),
    // Match the dark chrome on macOS so the traffic lights sit on our own header.
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const }
      : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      // Non-negotiable: the renderer gets no Node access. Everything privileged
      // goes through the typed IPC bridge in src/preload.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Long transcriptions and recordings continue while the window is not in
      // front; Chromium's background throttling would otherwise stall timers
      // and pause media in a minimized window.
      backgroundThrottling: false
    }
  })

  setMainWindow(mainWindow)

  // Avoid the white flash before React paints.
  mainWindow.on('ready-to-show', () => mainWindow?.show())

  mainWindow.on('closed', () => {
    mainWindow = null
    setMainWindow(null)
    // A satellite of the main window — it must not be able to keep the app
    // alive on its own once that window is gone.
    closeMiniRecorderWindow()
  })

  // Opt-in convenience: only while a recording is actually running, and only
  // for users who have asked for it — see getAutoPopOutOnMinimize's own doc
  // for why this defaults off.
  mainWindow.on('minimize', () => {
    if (isRecording() && getAutoPopOutOnMinimize()) openMiniRecorderWindow()
  })

  // Any target="_blank" or external link opens in the user's browser, never in
  // an app window with our preload attached.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.sonascribe.app')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Must run before the database is opened: it may be moving that database in
  // from the directory the previous product name used.
  migrateLegacyUserData()

  initDb()
  // Media rows hold absolute paths; a moved user-data directory invalidates
  // them, so repoint anything that no longer resolves.
  repairMediaPaths()
  resetInterruptedJobs()
  // Reclaim audio stranded by earlier versions, or by a crash between deleting
  // a row and deleting its files.
  void sweepOrphanedMedia()
  void sweepOrphanedChunks()
  registerMediaProtocolHandler()
  registerDisplayMediaHandler()
  registerIpcHandlers()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

/**
 * Stop the sidecars before the app goes.
 *
 * Closing the window quits the app on Windows and Linux, and a transcription in
 * flight has no say in it. The child processes doing that work are not the
 * app's own, so nothing stops them: without this, quitting mid-job leaves
 * parakeet-cli running with a window of audio in memory and no interface left
 * to cancel it from.
 *
 * before-quit rather than will-quit, so the children are signalled while the
 * app is still winding down rather than at the very end of it.
 */
app.on('before-quit', () => {
  cancelAllJobs()
})

app.on('will-quit', () => {
  closeDb()
})

