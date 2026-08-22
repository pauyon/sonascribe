import { BrowserWindow } from 'electron'
import type { EventName, EventPayload } from '@shared/ipc'

/**
 * Push events from main to every open renderer.
 *
 * Broadcast rather than targeted: the app is single-window today, and a
 * renderer that does not care about an event simply has no listener for it.
 * Destroyed windows are skipped, since a webContents send after close throws.
 */
export function emit<E extends EventName>(event: E, payload: EventPayload<E>): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(event, payload)
    }
  }
}
