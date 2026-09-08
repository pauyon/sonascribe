import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { readFile } from 'node:fs/promises'
import type { Channel, Request, Response, RecordingSettings } from '@shared/ipc'
import { SUPPORTED_MEDIA_EXTENSIONS, type Platform } from '@shared/types'
import { defaultMediaPath, userDataPath } from '../paths'
import { logFilePath } from '../log'
import {
  getAutoPopOutOnMinimize,
  getCaptureSystemAudio,
  getEchoCancellation,
  getMicDeviceId,
  getNoiseSuppression,
  setAutoPopOutOnMinimize,
  setCaptureSystemAudio,
  setEchoCancellation,
  setMicDeviceId,
  setNoiseSuppression
} from '../db/settings'
import { DEFAULT_BUCKETS, getPeaks } from '../services/peaks'
import {
  createRecording,
  deleteRecording,
  getRecording,
  listRecordings,
  renameRecording,
  setRecordingCuts
} from '../db/recordings'
import { hasSidecar } from '../services/sidecars'
import { queueImport } from '../services/importer'
import { deleteRecordingMedia } from '../services/media-cleanup'
import { getMediaRoot, isDefaultMediaRoot, relocateMediaRoot } from '../services/storage'
import {
  cancelRecording,
  getRecordingStatus,
  isRecording,
  setPaused,
  startRecording,
  stopRecording,
  writeChunk
} from '../services/recorder'
import { openMiniRecorderWindow } from '../windows/mini-recorder'
import { emit } from './events'

/**
 * Main-process implementation of the IPC contract.
 *
 * `handlers` must implement every channel in ApiSchema — the mapped type makes a
 * missing or misnamed channel a compile error rather than a runtime "no handler
 * registered" rejection in the renderer.
 */

type Handlers = {
  [C in Channel]: (payload: Request<C>) => Response<C> | Promise<Response<C>>
}

/**
 * Narrow Node's wide `process.platform` to the three targets we build for.
 * Anything else is treated as linux, which is the closest behavioural match for
 * the remaining POSIX platforms.
 */
function currentPlatform(): Platform {
  switch (process.platform) {
    case 'darwin':
    case 'win32':
      return process.platform
    default:
      return 'linux'
  }
}

const handlers: Handlers = {
  'recordings:list': () => listRecordings(),

  'recordings:get': ({ id }) => getRecording(id),

  'recordings:create': (input) => createRecording(input),

  'recordings:rename': ({ id, title }) => {
    const trimmed = title.trim()
    if (!trimmed) throw new Error('Title cannot be empty')
    return renameRecording(id, trimmed)
  },

  'recordings:delete': async ({ id }) => {
    deleteRecording(id)
    await deleteRecordingMedia(id)
  },

  'recordings:setCuts': ({ id, cuts }) => {
    const recording = getRecording(id)
    if (!recording) throw new Error(`Recording ${id} not found`)
    if (recording.durationMs == null) throw new Error('Recording has no known duration yet')
    return setRecordingCuts(id, cuts, recording.durationMs)
  },

  'dialog:pickMediaFiles': async () => {
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const options: Electron.OpenDialogOptions = {
      title: 'Import audio or video',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Audio and video', extensions: [...SUPPORTED_MEDIA_EXTENSIONS] },
        { name: 'All files', extensions: ['*'] }
      ]
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? [] : result.filePaths
  },

  'recordings:import': ({ paths }) => {
    if (!Array.isArray(paths) || paths.length === 0) return []
    // Each call returns immediately with a row in 'normalizing'; the actual
    // transcode reports completion through the recording:updated event.
    return paths.map((path) => queueImport(path))
  },

  'app:info': () => ({
    version: app.getVersion(),
    platform: currentPlatform(),
    userDataPath: userDataPath(),
    mediaPath: getMediaRoot(),
    logPath: logFilePath(),
    ffmpegAvailable: hasSidecar('ffmpeg')
  }),

  'storage:get': () => ({
    mediaRoot: getMediaRoot(),
    isDefault: isDefaultMediaRoot(),
    defaultMediaRoot: defaultMediaPath()
  }),

  'storage:pickFolder': async () => {
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const options: Electron.OpenDialogOptions = {
      title: 'Choose a folder for recordings',
      properties: ['openDirectory', 'createDirectory']
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  },

  'storage:relocate': async ({ folder }) => {
    // The recorder holds an open file handle under the current root; moving
    // the directory out from under it would corrupt or lose the recording.
    if (isRecording()) {
      throw new Error('Stop the current recording before moving where recordings are stored.')
    }
    const mediaRoot = await relocateMediaRoot(folder)
    return { mediaRoot }
  },

  'settings:get': () => currentSettings(),

  'settings:set': (patch) => {
    if (patch.noiseSuppression != null) setNoiseSuppression(patch.noiseSuppression)
    if (patch.echoCancellation != null) setEchoCancellation(patch.echoCancellation)
    // undefined means "not supplied"; null explicitly means "system default",
    // so the two cannot be collapsed.
    if (patch.micDeviceId !== undefined) setMicDeviceId(patch.micDeviceId)
    if (patch.captureSystemAudio != null) setCaptureSystemAudio(patch.captureSystemAudio)
    if (patch.autoPopOutOnMinimize != null) setAutoPopOutOnMinimize(patch.autoPopOutOnMinimize)
    return currentSettings()
  },

  'peaks:get': async ({ recordingId, buckets }) => {
    const recording = getRecording(recordingId)
    if (!recording?.sourcePath) throw new Error('Recording has no audio yet')
    return getPeaks(recording.sourcePath, buckets ?? DEFAULT_BUCKETS)
  },

  'recording:start': ({ title, hasSystemAudio, sampleRate }) =>
    startRecording({ title, hasSystemAudio, sampleRate }),

  'recording:chunk': ({ samples }) => {
    // Arrives as a Uint8Array view of the renderer's Int16Array. Buffer.from on
    // the view (not the ArrayBuffer) respects byteOffset/byteLength, and copies
    // rather than aliasing memory the structured clone owns.
    writeChunk(Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength))
  },

  'recording:pause': ({ paused }) => setPaused(paused),

  'recording:stop': () => stopRecording(),

  'recording:cancel': () => cancelRecording(),

  'recording:openMiniControls': () => {
    openMiniRecorderWindow()
  },

  'recording:status': () => getRecordingStatus(),

  'recording:elapsed': ({ elapsedMs }) => {
    emit('recording:elapsedTick', { elapsedMs })
  },

  'shell:showItemInFolder': ({ path }) => {
    shell.showItemInFolder(path)
  },

  'logs:read': () => readFile(logFilePath(), 'utf8').catch(() => '')
}

function currentSettings(): RecordingSettings {
  return {
    noiseSuppression: getNoiseSuppression(),
    echoCancellation: getEchoCancellation(),
    micDeviceId: getMicDeviceId(),
    captureSystemAudio: getCaptureSystemAudio(),
    autoPopOutOnMinimize: getAutoPopOutOnMinimize()
  }
}

export function registerIpcHandlers(): void {
  for (const channel of Object.keys(handlers) as Channel[]) {
    ipcMain.handle(channel, async (_event, payload: unknown) => {
      const handler = handlers[channel] as (p: unknown) => unknown
      try {
        return await handler(payload)
      } catch (err) {
        // Electron serializes a thrown Error across IPC with the stack attached
        // and an "Error invoking remote method" prefix. Log the real one here so
        // the main-process console keeps the useful trace.
        console.error(`[ipc] ${channel} failed:`, err)
        throw err instanceof Error ? err : new Error(String(err))
      }
    })
  }
}
