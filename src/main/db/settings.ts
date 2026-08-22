import { SPEAKER_SPLITTING_VALUES, type SpeakerSplitting } from '@shared/types'
import { getDb } from './index'

/** Typed accessors over the settings key/value table. */

const KEYS = {
  modelId: 'transcription.modelId',
  language: 'transcription.language',
  diarize: 'diarization.enabled',
  speakerCount: 'diarization.speakerCount',
  speakerSplitting: 'diarization.splitting',
  micProcessing: 'recording.micProcessing',
  micSoloSpeaker: 'recording.micSoloSpeaker'
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
 * Whether to route the microphone through the browser's conferencing DSP.
 *
 * Off by default. Echo cancellation, noise suppression and automatic gain are
 * what give processed audio its "on a call" character, and on a decent
 * microphone they only remove quality.
 */
export function getMicProcessing(): boolean {
  return get(KEYS.micProcessing) === 'true'
}

export function setMicProcessing(enabled: boolean): void {
  set(KEYS.micProcessing, enabled ? 'true' : 'false')
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
