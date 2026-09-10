import { BrowserWindow, dialog } from 'electron'

/**
 * Shared window-picking for save/open dialogs.
 *
 * Electron makes a dialog modal to a window when one is passed, which is
 * what a user expects — but a dialog can be triggered when no window has
 * focus (e.g. from the mini recorder), so every call site falls back to
 * whatever window exists rather than opening detached from the app.
 */
export function pickWindow(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
}

export function showOpenDialog(
  options: Electron.OpenDialogOptions
): Promise<Electron.OpenDialogReturnValue> {
  const window = pickWindow()
  return window ? dialog.showOpenDialog(window, options) : dialog.showOpenDialog(options)
}

export function showSaveDialog(
  options: Electron.SaveDialogOptions
): Promise<Electron.SaveDialogReturnValue> {
  const window = pickWindow()
  return window ? dialog.showSaveDialog(window, options) : dialog.showSaveDialog(options)
}
