import type { BrowserWindow } from 'electron'

/**
 * Tracks the main window so other main-process modules — `services/recorder.ts`
 * in particular, to bring it back after a recording finishes — can reach it
 * without importing `main/index.ts` directly. That import would run the other
 * way already (`main/index.ts` depends on `services/recorder.ts` for the
 * minimize-to-pop-out behavior), and a leaf module here is what keeps that
 * from becoming a cycle.
 */

let mainWindow: BrowserWindow | null = null

/** Called by main/index.ts once it creates (or destroys) the window. */
export function setMainWindow(win: BrowserWindow | null): void {
  mainWindow = win
}

/**
 * Restores (if minimized) and focuses the main window — so finishing or
 * discarding a recording from the mini controls window brings the result
 * back into view instead of leaving it to be found later.
 */
export function focusMainWindow(): void {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}
