import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import {
  CHANNELS,
  EVENTS,
  type Channel,
  type EventName,
  type EventPayload,
  type RendererApi
} from '@shared/ipc'

/**
 * The only bridge between renderer and main.
 *
 * Both directions are allowlisted from the shared contract, so a compromised or
 * buggy renderer cannot reach arbitrary ipcMain handlers, nor subscribe to
 * internal Electron events, by guessing names. The renderer never sees
 * `ipcRenderer` itself.
 */

const allowedChannels = new Set<string>(CHANNELS)
const allowedEvents = new Set<string>(EVENTS)

const api: RendererApi = {
  invoke: ((channel: Channel, payload?: unknown) => {
    if (!allowedChannels.has(channel)) {
      return Promise.reject(new Error(`Blocked unknown IPC channel: ${channel}`))
    }
    return ipcRenderer.invoke(channel, payload)
  }) as RendererApi['invoke'],

  on<E extends EventName>(event: E, listener: (payload: EventPayload<E>) => void): () => void {
    if (!allowedEvents.has(event)) {
      throw new Error(`Blocked unknown IPC event: ${event}`)
    }
    // The IpcRendererEvent is deliberately not forwarded: it carries a `sender`
    // the renderer has no business holding.
    const wrapped = (_e: IpcRendererEvent, payload: EventPayload<E>): void => listener(payload)
    ipcRenderer.on(event, wrapped)
    return () => {
      ipcRenderer.removeListener(event, wrapped)
    }
  },

  getPathForFile(file: File): string {
    return webUtils.getPathForFile(file)
  }
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('api', api)
} else {
  // Only reachable if contextIsolation is ever turned off, which main/index.ts
  // does not do. Kept so a misconfiguration fails loudly in dev rather than
  // leaving `window.api` undefined.
  throw new Error('contextIsolation must be enabled')
}
