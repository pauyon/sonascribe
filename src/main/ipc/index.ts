import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import type { Channel, Request, Response, TranscriptionSettings } from '@shared/ipc'
import { SUPPORTED_MEDIA_EXTENSIONS, type Platform } from '@shared/types'
import { mediaPath, modelsPath, userDataPath } from '../paths'
import {
  getAutoPopOutOnMinimize,
  getCaptureSystemAudio,
  getDiarizationEnabled,
  getEchoCancellation,
  getLanguage,
  getSelectedModelId,
  getMicDeviceId,
  getMicSoloSpeaker,
  getNoiseSuppression,
  getScreenshotDisplayId,
  getSpeakerCount,
  getSpeakerSplitting,
  setAutoPopOutOnMinimize,
  setCaptureSystemAudio,
  setDiarizationEnabled,
  setEchoCancellation,
  setLanguage,
  setMicDeviceId,
  setMicSoloSpeaker,
  setNoiseSuppression,
  setScreenshotDisplayId,
  setSelectedModelId,
  setSpeakerCount,
  setSpeakerSplitting
} from '../db/settings'
import { deleteSpeaker, mergeSpeakers, reassignUtterance, renameSpeaker } from '../db/speakers'
import { deleteScreenshot, getScreenshotPath } from '../db/screenshots'
import { captureScreenshots, listDisplaySources } from '../services/screenshots'
import { screenshotFileName } from '../services/screenshot-naming'
import {
  cancelModelDownload,
  deleteModel,
  downloadModel,
  listModelStatuses
} from '../services/models'
import { cancelJob, listActiveJobs, queueTranscription } from '../services/jobs'
import { forgetLiveWords } from '../services/live-transcribe'
import { getWaveformPath } from '../db/tracks'
import { deleteUtterance, updateUtteranceText } from '../db/transcript'
import { DEFAULT_BUCKETS, getPeaks } from '../services/peaks'
import { renderTranscript } from '../services/export'
import { EXPORT_FORMATS } from '@shared/export'
import {
  createRecording,
  deleteRecording,
  getTranscriptBundle,
  listRecordings,
  renameRecording
} from '../db/recordings'
import { hasBundledModel, hasSidecar } from '../services/sidecars'
import { queueImport } from '../services/importer'
import { deleteRecordingMedia } from '../services/media-cleanup'
import {
  cancelRecording,
  getRecordingStatus,
  setPaused,
  startRecording,
  stopRecording,
  writeChunk
} from '../services/recorder'
import {
  openMiniRecorderWindow,
  resizeMiniRecorderWindow
} from '../windows/mini-recorder'
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

  'recordings:get': ({ id }) => getTranscriptBundle(id),

  'recordings:create': (input) => createRecording(input),

  'recordings:rename': ({ id, title }) => {
    const trimmed = title.trim()
    if (!trimmed) throw new Error('Title cannot be empty')
    return renameRecording(id, trimmed)
  },

  'recordings:delete': async ({ id }) => {
    // Stop any job on this recording before its audio disappears underneath it.
    // Otherwise the pipeline carries on transcribing a recording the user has
    // deleted, then tries to save a transcript against a row that is gone — and
    // on Windows the sidecar's open file handles block the media delete outright.
    cancelJob(id)
    // Live results are keyed by recording; a deleted one will never claim them.
    forgetLiveWords(id)

    deleteRecording(id)
    // Child rows cascade, but the audio is on disk and only referenced by row.
    await deleteRecordingMedia(id)
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
    mediaPath: mediaPath(),
    modelsPath: modelsPath(),
    ffmpegAvailable: hasSidecar('ffmpeg'),
    whisperAvailable: hasSidecar('whisper-cli'),
    parakeetAvailable: hasSidecar('parakeet-cli'),
    diarizationAvailable:
      hasSidecar('sherpa-onnx-offline-speaker-diarization') &&
      hasBundledModel('segmentation.onnx') &&
      hasBundledModel('speaker-embedding.onnx')
  }),

  'models:list': () => listModelStatuses(),

  'models:download': async ({ id }) => {
    // Deliberately not awaited: a 1.6 GB transfer must not hold an IPC call
    // open. The renderer follows it through model:progress events.
    void downloadModel(id).catch((err: unknown) => {
      console.error(`[models] download ${id} failed:`, err)
    })
  },

  'models:cancel': ({ id }) => cancelModelDownload(id),

  'models:delete': ({ id }) => deleteModel(id),

  'settings:get': () => currentSettings(),

  'settings:set': (patch) => {
    if (patch.modelId != null) setSelectedModelId(patch.modelId)
    if (patch.language != null) setLanguage(patch.language)
    if (patch.diarize != null) setDiarizationEnabled(patch.diarize)
    // undefined means "not supplied"; null explicitly means "cluster
    // automatically", so the two cannot be collapsed.
    if (patch.speakerCount !== undefined) setSpeakerCount(patch.speakerCount)
    if (patch.speakerSplitting != null) setSpeakerSplitting(patch.speakerSplitting)
    if (patch.noiseSuppression != null) setNoiseSuppression(patch.noiseSuppression)
    if (patch.echoCancellation != null) setEchoCancellation(patch.echoCancellation)
    if (patch.micSoloSpeaker != null) setMicSoloSpeaker(patch.micSoloSpeaker)
    // undefined means "not supplied"; null explicitly means "system default",
    // so — as with speakerCount above — the two cannot be collapsed.
    if (patch.micDeviceId !== undefined) setMicDeviceId(patch.micDeviceId)
    if (patch.captureSystemAudio != null) setCaptureSystemAudio(patch.captureSystemAudio)
    if (patch.autoPopOutOnMinimize != null) setAutoPopOutOnMinimize(patch.autoPopOutOnMinimize)
    // Same null-is-meaningful reasoning as micDeviceId above: null means
    // "every display," not "not supplied."
    if (patch.screenshotDisplayId !== undefined) setScreenshotDisplayId(patch.screenshotDisplayId)
    return currentSettings()
  },

  'transcribe:start': ({ id }) => queueTranscription(id),

  'transcribe:cancel': ({ id }) => {
    cancelJob(id)
  },

  'transcribe:active': () => listActiveJobs(),

  'peaks:get': async ({ recordingId, buckets }) => {
    const wavPath = getWaveformPath(recordingId)
    if (!wavPath) throw new Error('Recording has no audio yet')
    return getPeaks(wavPath, buckets ?? DEFAULT_BUCKETS)
  },

  'utterances:update': ({ id, text }) => {
    updateUtteranceText(id, text.trim())
  },

  'utterances:delete': ({ id }) => {
    deleteUtterance(id)
  },

  'transcript:export': async ({ id, format, includeScreenshots }) => {
    const bundle = getTranscriptBundle(id)
    if (!bundle) throw new Error('Recording not found')
    if (bundle.utterances.length === 0) {
      throw new Error('There is no transcript to export yet')
    }

    const spec = EXPORT_FORMATS.find((f) => f.id === format)
    if (!spec) throw new Error(`Unknown export format: ${format}`)

    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const options: Electron.SaveDialogOptions = {
      title: 'Export transcript',
      defaultPath: join(
        app.getPath('documents'),
        `${safeFileName(bundle.recording.title)}.${spec.extension}`
      ),
      filters: [{ name: spec.label, extensions: [spec.extension] }]
    }

    const result = window
      ? await dialog.showSaveDialog(window, options)
      : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null

    // Neither subtitle format has a sensible way to carry an inline image.
    const withScreenshots =
      includeScreenshots && bundle.screenshots.length > 0 && format !== 'srt' && format !== 'vtt'

    let screenshotsRelativeDir: string | undefined
    if (withScreenshots) {
      // A sibling folder named after the exported file, not the recording —
      // if the file gets renamed or moved, the two stay findable together.
      screenshotsRelativeDir = `${basename(result.filePath, extname(result.filePath))}.screenshots`
      const shotsDir = join(dirname(result.filePath), screenshotsRelativeDir)
      await mkdir(shotsDir, { recursive: true })
      for (const shot of bundle.screenshots) {
        const src = getScreenshotPath(shot.id)
        if (src) await copyFile(src, join(shotsDir, screenshotFileName(shot.id)))
      }
    }

    await writeFile(
      result.filePath,
      renderTranscript(bundle, format, screenshotsRelativeDir),
      'utf8'
    )
    return result.filePath
  },

  'speakers:rename': ({ id, displayName }) => {
    const trimmed = displayName.trim()
    if (!trimmed) throw new Error('Speaker name cannot be empty')
    renameSpeaker(id, trimmed)
  },

  'speakers:merge': ({ recordingId, fromId, intoId }) =>
    mergeSpeakers(recordingId, fromId, intoId),

  'speakers:reassign': ({ utteranceId, speakerId }) =>
    reassignUtterance(utteranceId, speakerId),

  'speakers:delete': ({ id }) => {
    deleteSpeaker(id)
  },

  'recording:start': ({ title, kinds, sampleRate }) =>
    startRecording({ title, kinds, sampleRate }),

  'recording:chunk': ({ kind, samples }) => {
    // Arrives as a Uint8Array view of the renderer's Int16Array. Buffer.from on
    // the view (not the ArrayBuffer) respects byteOffset/byteLength, and copies
    // rather than aliasing memory the structured clone owns.
    writeChunk(kind, Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength))
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

  'recording:resizeMiniControls': ({ expanded }) => {
    resizeMiniRecorderWindow(expanded)
  },

  'screenshots:capture': ({ recordingId, elapsedMs }) => {
    const status = getRecordingStatus()
    if (!status || status.recordingId !== recordingId) {
      throw new Error('No recording in progress')
    }
    return captureScreenshots(recordingId, elapsedMs)
  },

  'screenshots:delete': async ({ id }) => {
    const path = deleteScreenshot(id)
    if (path) await rm(path, { force: true })
  },

  'screenshots:listDisplays': () => listDisplaySources(),

  'shell:showItemInFolder': ({ path }) => {
    shell.showItemInFolder(path)
  }
}

function currentSettings(): TranscriptionSettings {
  return {
    modelId: getSelectedModelId(),
    language: getLanguage(),
    diarize: getDiarizationEnabled(),
    speakerCount: getSpeakerCount(),
    speakerSplitting: getSpeakerSplitting(),
    noiseSuppression: getNoiseSuppression(),
    echoCancellation: getEchoCancellation(),
    micSoloSpeaker: getMicSoloSpeaker(),
    micDeviceId: getMicDeviceId(),
    captureSystemAudio: getCaptureSystemAudio(),
    autoPopOutOnMinimize: getAutoPopOutOnMinimize(),
    screenshotDisplayId: getScreenshotDisplayId()
  }
}

/**
 * Strips characters that are illegal in filenames on Windows or macOS.
 *
 * Spaces are kept — they are legal on both and the title reads better with
 * them. A trailing dot is removed because Windows silently drops it.
 */
function safeFileName(title: string): string {
  return (
    title
      .replace(/[<>:"/\\|?*]/g, '_')
      .replace(/\.+$/, '')
      .trim()
      .slice(0, 120) || 'transcript'
  )
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
