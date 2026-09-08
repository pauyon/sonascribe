/**
 * Microphone and system-audio capture.
 *
 * Only the renderer can reach getUserMedia and getDisplayMedia, so capture lives
 * here; the PCM is streamed to the main process, which owns the file.
 *
 * Capture runs at the hardware's own sample rate — typically 48 kHz — straight
 * to disk. There is no MediaRecorder anywhere in this path — encoding to
 * WebM/Opus only to decode it again would lose quality for nothing.
 *
 * Mic and system audio are mixed into the single recorded file by Web Audio
 * graph fan-in: connecting both `MediaStreamAudioSourceNode`s to the same
 * `AudioWorkletNode` input sums them, so no separate mixdown step is needed.
 * Two more monitoring-only nodes — one per source — sit alongside the combined
 * one purely so the level meters and "test your mic" feature can keep telling
 * a silent microphone apart from silent system audio even though the file on
 * disk is already mixed. Only the combined node's output is ever written.
 */

export type CaptureSourceKind = 'mic' | 'system'

export class CaptureError extends Error {
  constructor(
    message: string,
    readonly kind: CaptureSourceKind
  ) {
    super(message)
    this.name = 'CaptureError'
  }
}

/** Human-readable reason for a getUserMedia/getDisplayMedia rejection. */
function describeMediaError(err: unknown, kind: CaptureSourceKind): string {
  const name = err instanceof Error ? err.name : ''
  const what = kind === 'mic' ? 'Microphone' : 'System audio'

  switch (name) {
    case 'NotAllowedError':
      return `${what} permission was denied. Grant it in your system settings and try again.`
    case 'NotFoundError':
      return `No ${kind === 'mic' ? 'microphone' : 'system audio device'} was found.`
    case 'NotReadableError':
      return `${what} is in use by another application.`
    default:
      return `${what} could not be started${err instanceof Error && err.message ? `: ${err.message}` : '.'}`
  }
}

/**
 * Browser audio-processing constraints.
 *
 * Enabling any of these routes the stream through Chromium's WebRTC audio
 * processing module — the conferencing pipeline. Echo cancellation and
 * spectral noise gating are why processed audio has that unmistakable "on a
 * call" character, so both are off unless the user asks for them.
 *
 * Automatic gain control is not among these: it's applied unconditionally
 * (see `requestMicStream`), because unlike the other two, going without it
 * just leaves a quiet input device with nothing compensating — which can
 * lose a recording's audio outright rather than merely costing fidelity.
 */
export interface MicProcessing {
  echoCancellation: boolean
  noiseSuppression: boolean
}

export const CLEAN_MIC: MicProcessing = {
  echoCancellation: false,
  noiseSuppression: false
}

export async function requestMicStream(
  deviceId?: string,
  processing: MicProcessing = CLEAN_MIC
): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: processing.echoCancellation,
        noiseSuppression: processing.noiseSuppression,
        autoGainControl: true
      },
      video: false
    })
  } catch (err) {
    throw new CaptureError(describeMediaError(err, 'mic'), 'mic')
  }
}

/**
 * Opens the system audio loopback stream.
 *
 * getDisplayMedia must be asked for video even though only audio is wanted —
 * Chromium rejects an audio-only display capture request. The main process's
 * display-media handler answers with `audio: 'loopback'`, and the video track is
 * discarded immediately below.
 */
export async function requestSystemStream(): Promise<MediaStream> {
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
  } catch (err) {
    throw new CaptureError(describeMediaError(err, 'system'), 'system')
  }

  for (const track of stream.getVideoTracks()) {
    track.stop()
    stream.removeTrack(track)
  }

  if (stream.getAudioTracks().length === 0) {
    throw new CaptureError(
      'No system audio was returned. On macOS this needs Screen & System Audio Recording permission.',
      'system'
    )
  }

  return stream
}

export interface CaptureSession {
  context: AudioContext
  /** Hardware sample rate the context (and so the recorded file) runs at. */
  sampleRate: number
  stop: () => Promise<void>
}

/**
 * Wires the given source streams into one combined recording node plus one
 * monitoring-only node per source, and starts delivering PCM.
 *
 * `onLevel` fires for every source on every block, with that source's own
 * (pre-mix) samples — used for the meters, and for tapping the clean mic
 * signal for "test your mic" playback. `onBlock` fires only for the
 * combined, mixed signal — the one that gets written to disk.
 */
export async function startCapture(
  sources: Array<{ kind: CaptureSourceKind; stream: MediaStream }>,
  onLevel: (kind: CaptureSourceKind, samples: Int16Array, peak: number) => void,
  onBlock: (samples: Int16Array, peak: number) => void
): Promise<CaptureSession> {
  // No sampleRate override: the context adopts the hardware rate.
  const context = new AudioContext()
  await context.audioWorklet.addModule('recorder-worklet.js')

  function makeNode(): AudioWorkletNode {
    return new AudioWorkletNode(context, 'recorder-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
      // Mix any multichannel source down to mono rather than silently taking
      // only the left channel.
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers'
    })
  }

  const combined = makeNode()
  combined.port.onmessage = (event: MessageEvent<{ samples: Int16Array; peak: number }>) => {
    onBlock(event.data.samples, event.data.peak)
  }

  const cleanups: Array<() => void> = []

  for (const { kind, stream } of sources) {
    const source = context.createMediaStreamSource(stream)
    source.connect(combined)

    const monitor = makeNode()
    monitor.port.onmessage = (event: MessageEvent<{ samples: Int16Array; peak: number }>) => {
      onLevel(kind, event.data.samples, event.data.peak)
    }
    source.connect(monitor)

    cleanups.push(() => {
      monitor.port.onmessage = null
      source.disconnect()
      monitor.disconnect()
      for (const track of stream.getTracks()) track.stop()
    })
  }

  return {
    context,
    sampleRate: context.sampleRate,
    stop: async () => {
      combined.port.onmessage = null
      combined.disconnect()
      for (const cleanup of cleanups) cleanup()
      await context.close()
    }
  }
}
