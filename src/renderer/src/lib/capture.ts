import type { TrackKind } from '@shared/types'

/**
 * Microphone and system-audio capture.
 *
 * Only the renderer can reach getUserMedia and getDisplayMedia, so capture lives
 * here; the PCM is streamed to the main process, which owns the files.
 *
 * Capture runs at the hardware's own sample rate — typically 48 kHz — and the
 * 16 kHz mono copy the ML sidecars need is derived afterwards with ffmpeg, the
 * same way imported files are handled. Recording straight to 16 kHz would cap
 * the archive at 8 kHz of bandwidth, which is telephone quality: a good
 * microphone would be thrown away at the door.
 *
 * There is no MediaRecorder anywhere in this path — encoding to WebM/Opus only
 * to decode it again would lose quality for nothing.
 */

export interface CaptureTrack {
  kind: TrackKind
  stream: MediaStream
  node: AudioWorkletNode
  source: MediaStreamAudioSourceNode
}

export interface CaptureSession {
  context: AudioContext
  tracks: CaptureTrack[]
  stop: () => Promise<void>
}

export class CaptureError extends Error {
  constructor(
    message: string,
    readonly kind: TrackKind
  ) {
    super(message)
    this.name = 'CaptureError'
  }
}

/** Human-readable reason for a getUserMedia/getDisplayMedia rejection. */
function describeMediaError(err: unknown, kind: TrackKind): string {
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
 * processing module — the conferencing pipeline. It applies echo cancellation,
 * spectral noise gating and automatic gain, which is why processed audio has
 * that unmistakable "on a call" character. On a decent microphone it only
 * removes quality, so it is off unless the user asks for it.
 *
 * It genuinely helps in one case: a laptop's built-in mic with sound coming out
 * of the speakers, where echo cancellation stops the far end being recorded
 * twice.
 */
export interface MicProcessing {
  echoCancellation: boolean
  noiseSuppression: boolean
  autoGainControl: boolean
}

export const CLEAN_MIC: MicProcessing = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false
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
        autoGainControl: processing.autoGainControl
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

/**
 * Wires the given streams into a shared 16 kHz graph and starts delivering PCM.
 *
 * One AudioContext drives every track so both share a clock — the two tracks
 * must stay on a common timeline for the transcripts to interleave correctly.
 */
export async function startCapture(
  streams: Array<{ kind: TrackKind; stream: MediaStream }>,
  onBlock: (kind: TrackKind, samples: Int16Array, peak: number) => void
): Promise<CaptureSession> {
  // No sampleRate override: the context adopts the hardware rate, so the mic
  // stream reaches the worklet without an extra resample.
  const context = new AudioContext()
  await context.audioWorklet.addModule('recorder-worklet.js')

  const tracks: CaptureTrack[] = streams.map(({ kind, stream }) => {
    const source = context.createMediaStreamSource(stream)
    const node = new AudioWorkletNode(context, 'recorder-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
      // Mix any multichannel source down to mono rather than silently taking
      // only the left channel.
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers'
    })

    node.port.onmessage = (event: MessageEvent<{ samples: Int16Array; peak: number }>) => {
      onBlock(kind, event.data.samples, event.data.peak)
    }

    source.connect(node)
    return { kind, stream, node, source }
  })

  return {
    context,
    tracks,
    stop: async () => {
      for (const track of tracks) {
        track.node.port.onmessage = null
        track.source.disconnect()
        track.node.disconnect()
        for (const mediaTrack of track.stream.getTracks()) mediaTrack.stop()
      }
      await context.close()
    }
  }
}
