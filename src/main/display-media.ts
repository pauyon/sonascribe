import { desktopCapturer, session } from 'electron'

/**
 * Answers the renderer's getDisplayMedia() request with a system-audio loopback
 * stream.
 *
 * Chromium will not grant an audio-only display capture, so the renderer has to
 * ask for video too; a source is supplied here and the renderer discards the
 * video track immediately. What we actually want is the `audio: 'loopback'`
 * reply, which captures what the machine is playing.
 *
 * On macOS this rides Chromium's CoreAudio Tap support (Electron 39+), so no
 * virtual audio driver has to be installed — but it requires
 * NSAudioCaptureUsageDescription in Info.plist, and there is no fallback if the
 * key is missing. That is declared in electron-builder.yml.
 */
export function registerDisplayMediaHandler(): void {
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer
        .getSources({ types: ['screen'] })
        .then((sources) => {
          if (sources.length === 0) {
            // Denying with an empty reply surfaces as a NotAllowedError in the
            // renderer, which the capture layer already explains to the user.
            callback({})
            return
          }
          callback({ video: sources[0], audio: 'loopback' })
        })
        .catch((err: unknown) => {
          console.error('[display-media] could not enumerate sources:', err)
          callback({})
        })
    },
    // The app supplies the source itself rather than showing the OS picker:
    // the user is choosing "record system audio", not choosing a window.
    { useSystemPicker: false }
  )
}
