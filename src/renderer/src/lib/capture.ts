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
    case 'OverconstrainedError':
      return `The saved ${kind === 'mic' ? 'microphone' : 'audio device'} is no longer available. Pick a different one.`
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

/** Which rung of the fallback ladder in `requestMicStream` produced a usable track. */
export type MicAcquisitionAttempt = 'requested' | 'requested-raw' | 'default-raw'

export interface MicAcquisition {
  stream: MediaStream
  attempt: MicAcquisitionAttempt
}

function trackDiagnostics(track: MediaStreamTrack): string {
  return `label="${track.label}" readyState=${track.readyState} muted=${track.muted} settings=${JSON.stringify(track.getSettings())}`
}

type MicAttemptResult = { ok: true; stream: MediaStream } | { ok: false; error: unknown }

/**
 * A resolved stream's audio track is only rejected here for something
 * unambiguous: no track at all, or one that's already `ended`. `track.muted`
 * is deliberately NOT treated as failure — it's a metadata flag Chromium can
 * report transiently (or for longer than expected) even on a device that is
 * actually capturing fine, especially one shared with another app, and
 * gating acceptance on it previously caused a *working* stream to be thrown
 * away in favor of a fallback rung — including, on the last rung, silently
 * switching to a different physical device (the system default) that the
 * user was never actually speaking into. A track that resolves live but is
 * genuinely silent is instead caught later, from real measured audio over
 * real time (see `Record.tsx`'s silence-triggered recovery) — evidence, not
 * a flag.
 */
async function tryAcquireMic(
  constraints: MediaTrackConstraints,
  label: string
): Promise<MicAttemptResult> {
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: constraints, video: false })
  } catch (err) {
    console.info(`[capture] mic attempt "${label}" failed:`, err)
    return { ok: false, error: err }
  }

  const [track] = stream.getAudioTracks()
  if (!track || track.readyState !== 'live') {
    console.info(`[capture] mic attempt "${label}" returned no live track`)
    for (const t of stream.getTracks()) t.stop()
    return { ok: false, error: new Error('No live microphone track was returned.') }
  }

  console.info(`[capture] mic attempt "${label}" succeeded: ${trackDiagnostics(track)}`)
  return { ok: true, stream }
}

/**
 * Opens the microphone, falling back through progressively less-constrained
 * requests when the requested device is outright rejected — a saved device id
 * that's gone (`OverconstrainedError`) or a device another app has locked
 * exclusively (`NotReadableError`). A *resolved* stream is never second-
 * guessed here (see `tryAcquireMic`'s doc comment) — only a thrown error
 * advances to the next rung.
 */
export async function requestMicStream(
  deviceId?: string,
  processing: MicProcessing = CLEAN_MIC
): Promise<MicAcquisition> {
  const attempts: Array<{
    attempt: MicAcquisitionAttempt
    constraints: MediaTrackConstraints
    skip?: boolean
  }> = [
    {
      attempt: 'requested',
      constraints: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: processing.echoCancellation,
        noiseSuppression: processing.noiseSuppression,
        autoGainControl: true
      }
    },
    {
      attempt: 'requested-raw',
      skip: !deviceId,
      constraints: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    },
    {
      attempt: 'default-raw',
      constraints: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    }
  ]

  let lastError: unknown
  for (const { attempt, constraints, skip } of attempts) {
    if (skip) continue
    const result = await tryAcquireMic(constraints, attempt)
    if (result.ok) return { stream: result.stream, attempt }
    lastError = result.error
  }

  throw new CaptureError(describeMediaError(lastError, 'mic'), 'mic')
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
  /** Whether a source of this kind is currently wired into the combined node. */
  hasSource: (kind: CaptureSourceKind) => boolean
  /**
   * Detaches whatever source is currently live for `kind` (if any) and wires
   * `stream` into the same combined node in its place — used to recover a
   * source without tearing down the recording's AudioContext or losing more
   * than the reacquisition time. No-op-safe to call for a kind that isn't
   * attached yet.
   */
  replaceSource: (kind: CaptureSourceKind, stream: MediaStream) => void
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
 *
 * `sampleRate`, if given, pins the context to that rate instead of letting it
 * adopt the hardware default — needed when rebuilding the graph mid-recording
 * after the original context became unrecoverable, since the WAV header was
 * already written at the original rate and a mismatched rebuild would play
 * back at the wrong speed.
 */
export async function startCapture(
  sources: Array<{ kind: CaptureSourceKind; stream: MediaStream }>,
  onLevel: (kind: CaptureSourceKind, samples: Int16Array, peak: number) => void,
  onBlock: (samples: Int16Array, peak: number) => void,
  sampleRate?: number
): Promise<CaptureSession> {
  const context = sampleRate ? new AudioContext({ sampleRate }) : new AudioContext()
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

  const detachers = new Map<CaptureSourceKind, () => void>()

  function attachSource(kind: CaptureSourceKind, stream: MediaStream): void {
    const source = context.createMediaStreamSource(stream)
    source.connect(combined)

    const monitor = makeNode()
    monitor.port.onmessage = (event: MessageEvent<{ samples: Int16Array; peak: number }>) => {
      onLevel(kind, event.data.samples, event.data.peak)
    }
    source.connect(monitor)

    detachers.set(kind, () => {
      monitor.port.onmessage = null
      source.disconnect()
      monitor.disconnect()
      for (const track of stream.getTracks()) track.stop()
    })
  }

  for (const { kind, stream } of sources) attachSource(kind, stream)

  return {
    context,
    sampleRate: context.sampleRate,
    hasSource: (kind) => detachers.has(kind),
    replaceSource: (kind, stream) => {
      detachers.get(kind)?.()
      attachSource(kind, stream)
    },
    stop: async () => {
      combined.port.onmessage = null
      combined.disconnect()
      for (const detach of detachers.values()) detach()
      await context.close()
    }
  }
}
