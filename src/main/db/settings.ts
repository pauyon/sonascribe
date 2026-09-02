import { SPEAKER_SPLITTING_VALUES, type SpeakerSplitting } from '@shared/types'
import { getDb } from './index'

/** Typed accessors over the settings key/value table. */

const KEYS = {
  modelId: 'transcription.modelId',
  language: 'transcription.language',
  diarize: 'diarization.enabled',
  speakerCount: 'diarization.speakerCount',
  speakerSplitting: 'diarization.splitting',
  noiseSuppression: 'recording.noiseSuppression',
  echoCancellation: 'recording.echoCancellation',
  micSoloSpeaker: 'recording.micSoloSpeaker',
  micDeviceId: 'recording.micDeviceId',
  captureSystemAudio: 'recording.captureSystemAudio',
  autoPopOutOnMinimize: 'recording.autoPopOutOnMinimize',
  screenshotDisplayIds: 'recording.screenshotDisplayIds',
  localSpeakerColor: 'diarization.localSpeakerColor'
} as const

function get(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as unknown as
    | { value: string }
    | undefined
  return row?.value ?? null
}

function set(key: string, value: string): void {
  getDb()
    .prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value'
    )
    .run(key, value)
}

/** Model chosen for transcription, or null until the user picks one. */
export function getSelectedModelId(): string | null {
  return get(KEYS.modelId)
}

export function setSelectedModelId(modelId: string): void {
  set(KEYS.modelId, modelId)
}

/**
 * Spoken language hint. 'auto' asks whisper to detect it, which costs an extra
 * pass but is right for mixed-language libraries.
 */
export function getLanguage(): string {
  return get(KEYS.language) ?? 'en'
}

export function setLanguage(language: string): void {
  set(KEYS.language, language)
}

/**
 * Whether to run speaker diarization after transcription.
 *
 * On by default: automatic speaker labelling is the reason the app exists, and
 * diarization is cheap next to transcription (real-time factor ~0.04).
 */
export function getDiarizationEnabled(): boolean {
  return get(KEYS.diarize) !== 'false'
}

export function setDiarizationEnabled(enabled: boolean): void {
  set(KEYS.diarize, enabled ? 'true' : 'false')
}

/**
 * Upper bound on the number of speakers, or null to cluster automatically.
 *
 * A known count is materially more accurate than threshold clustering, and most
 * meetings know their own headcount. The diarizer treats it as a ceiling, not a
 * quota: it will return fewer if the voices do not support that many.
 */
export function getSpeakerCount(): number | null {
  const raw = get(KEYS.speakerCount)
  if (!raw) return null
  const value = Number(raw)
  return Number.isInteger(value) && value > 0 ? value : null
}

export function setSpeakerCount(count: number | null): void {
  set(KEYS.speakerCount, count == null || count <= 0 ? '' : String(count))
}

/**
 * How eagerly to split voices when the speaker count is unknown.
 *
 * Defaults to 'balanced', which is the setting that matches the reference
 * recordings; see SPLITTING_PRESETS for the measurements. An unrecognised
 * stored value falls back to the default rather than reaching the CLI.
 */
export function getSpeakerSplitting(): SpeakerSplitting {
  const raw = get(KEYS.speakerSplitting)
  return SPEAKER_SPLITTING_VALUES.includes(raw as SpeakerSplitting)
    ? (raw as SpeakerSplitting)
    : 'balanced'
}

export function setSpeakerSplitting(splitting: SpeakerSplitting): void {
  set(KEYS.speakerSplitting, splitting)
}

/**
 * Whether to apply WebRTC noise suppression to the microphone.
 *
 * Off by default: on a decent microphone it still trades a little fidelity for
 * the noise floor. Unlike echo cancellation below, it does not carry an
 * "on a call" character, so it is safe to turn on generally.
 */
export function getNoiseSuppression(): boolean {
  return get(KEYS.noiseSuppression) === 'true'
}

export function setNoiseSuppression(enabled: boolean): void {
  set(KEYS.noiseSuppression, enabled ? 'true' : 'false')
}

/**
 * Whether to route the microphone through WebRTC echo cancellation.
 *
 * Off by default. It's the adaptive filtering here that gives processed
 * audio its "on a call" character; it earns its keep only when the mic can
 * hear the app's own speaker output.
 *
 * Automatic gain control is not a matching setting here — the renderer's
 * Record screen turns it on unconditionally. Unlike this, plain gain
 * adjustment carries no "on a call" character, and there's no real case for
 * wanting it off: going without it just leaves a quiet input device with
 * nothing compensating, which can lose a recording's audio outright rather
 * than merely costing a little fidelity.
 */
export function getEchoCancellation(): boolean {
  return get(KEYS.echoCancellation) === 'true'
}

export function setEchoCancellation(enabled: boolean): void {
  set(KEYS.echoCancellation, enabled ? 'true' : 'false')
}

/**
 * Whether the microphone track contains only the local user's voice.
 *
 * When true the mic track skips diarization and is labelled "You" outright,
 * which is right for a call: you are on the microphone, everyone else arrives
 * through system audio.
 *
 * Off by default, because the other common case — several people around one
 * microphone in a room — must still be split into separate speakers. Assuming
 * a solo mic there collapses the whole conversation onto one person.
 */
export function getMicSoloSpeaker(): boolean {
  return get(KEYS.micSoloSpeaker) === 'true'
}

export function setMicSoloSpeaker(enabled: boolean): void {
  set(KEYS.micSoloSpeaker, enabled ? 'true' : 'false')
}

/**
 * Device id of the last microphone picked on the Record screen, or null for
 * the system default.
 *
 * A device that has since been unplugged simply will not appear in the next
 * enumeration, so the caller falls back to the default rather than this
 * needing to validate the id itself.
 */
export function getMicDeviceId(): string | null {
  return get(KEYS.micDeviceId)
}

export function setMicDeviceId(deviceId: string | null): void {
  set(KEYS.micDeviceId, deviceId ?? '')
}

/**
 * Whether the last recording also captured system audio.
 *
 * Defaults to true — most recordings are of calls or meetings, where the
 * other side only arrives through system audio.
 */
export function getCaptureSystemAudio(): boolean {
  return get(KEYS.captureSystemAudio) !== 'false'
}

export function setCaptureSystemAudio(enabled: boolean): void {
  set(KEYS.captureSystemAudio, enabled ? 'true' : 'false')
}

/**
 * Whether minimizing the main window during a recording should open the mini
 * controls window on its own, rather than waiting for "Pop out controls" to
 * be clicked. Off by default — an app deciding to open a new window on its
 * own is the kind of thing that should be opted into, not sprung on someone.
 */
export function getAutoPopOutOnMinimize(): boolean {
  return get(KEYS.autoPopOutOnMinimize) === 'true'
}

export function setAutoPopOutOnMinimize(enabled: boolean): void {
  set(KEYS.autoPopOutOnMinimize, enabled ? 'true' : 'false')
}

/**
 * `desktopCapturer` source ids of the displays a screenshot snap should
 * capture, or an empty array for every connected display.
 *
 * Not validated here — an id from a monitor that's since been unplugged
 * simply won't match anything the next time sources are enumerated, and the
 * capture service falls back to every remaining display rather than this
 * needing to know that in advance. A malformed stored value (there is no
 * schema on this table) is treated the same as "none chosen" rather than
 * thrown, for the same reason.
 */
export function getScreenshotDisplayIds(): string[] {
  const raw = get(KEYS.screenshotDisplayIds)
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) && parsed.every((id) => typeof id === 'string') ? parsed : []
  } catch {
    return []
  }
}

export function setScreenshotDisplayIds(displayIds: string[]): void {
  set(KEYS.screenshotDisplayIds, JSON.stringify(displayIds))
}

/**
 * The color "You" was last given, so it carries over recording to recording
 * the same way a recognised voice's does — null until it's ever been set,
 * at which point a fresh one is picked the same way any other speaker's is.
 */
export function getLocalSpeakerColor(): string | null {
  return get(KEYS.localSpeakerColor)
}

export function setLocalSpeakerColor(color: string): void {
  set(KEYS.localSpeakerColor, color)
}
