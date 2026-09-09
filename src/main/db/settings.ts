import type { AsrEngine } from '@shared/models'
import { DEFAULT_OLLAMA_SERVER_URL } from '@shared/ollama'
import { getDb } from './index'

/** Typed accessors over the settings key/value table. */

const KEYS = {
  noiseSuppression: 'recording.noiseSuppression',
  echoCancellation: 'recording.echoCancellation',
  micDeviceId: 'recording.micDeviceId',
  captureSystemAudio: 'recording.captureSystemAudio',
  autoPopOutOnMinimize: 'recording.autoPopOutOnMinimize',
  mediaRoot: 'recording.mediaRoot',
  transcriptionEngine: 'transcription.engine',
  transcriptionLanguage: 'transcription.language',
  modelIdForEngine: (engine: AsrEngine): string => `transcription.modelId.${engine}`,
  ragEmbeddingModel: 'rag.embeddingModel',
  ragChatModel: 'rag.chatModel',
  ragServerUrl: 'rag.serverUrl'
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
 * A user-chosen folder for recordings' audio files, or null to use the
 * default `<userData>/media`.
 *
 * This is only the persisted pointer — changing it does not move anything by
 * itself. `services/storage.ts::relocateMediaRoot` is the one place that both
 * moves the files and updates this value; nothing else should call
 * `setMediaRoot` directly.
 */
export function getMediaRoot(): string | null {
  return get(KEYS.mediaRoot) || null
}

export function setMediaRoot(path: string | null): void {
  set(KEYS.mediaRoot, path ?? '')
}

/** Which ASR engine is currently selected, or null if none has been chosen yet. */
export function getTranscriptionEngine(): AsrEngine | null {
  return get(KEYS.transcriptionEngine) as AsrEngine | null
}

export function setTranscriptionEngine(engine: AsrEngine): void {
  set(KEYS.transcriptionEngine, engine)
}

/** Last-picked model id for one engine, so switching engines remembers each one's own choice. */
export function getModelIdForEngine(engine: AsrEngine): string | null {
  return get(KEYS.modelIdForEngine(engine))
}

export function setModelIdForEngine(engine: AsrEngine, modelId: string): void {
  set(KEYS.modelIdForEngine(engine), modelId)
}

/** Language hint for Whisper. Defaults to auto-detect. Ignored by Parakeet. */
export function getTranscriptionLanguage(): string {
  return get(KEYS.transcriptionLanguage) || 'auto'
}

export function setTranscriptionLanguage(language: string): void {
  set(KEYS.transcriptionLanguage, language)
}

/** Ollama model used to embed transcript chunks, or null until the user picks one in Settings. */
export function getRagEmbeddingModel(): string | null {
  return get(KEYS.ragEmbeddingModel)
}

export function setRagEmbeddingModel(model: string): void {
  set(KEYS.ragEmbeddingModel, model)
}

/** Ollama model used to answer questions grounded in retrieved chunks. */
export function getRagChatModel(): string | null {
  return get(KEYS.ragChatModel)
}

export function setRagChatModel(model: string): void {
  set(KEYS.ragChatModel, model)
}

/** Base URL of the Ollama server. Editable so a Docker/LAN Ollama install works too, not just localhost. */
export function getRagServerUrl(): string {
  return get(KEYS.ragServerUrl) || DEFAULT_OLLAMA_SERVER_URL
}

export function setRagServerUrl(url: string): void {
  set(KEYS.ragServerUrl, url)
}
