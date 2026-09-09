import type { Utterance } from '@shared/types'
import { formatDuration } from './format'

/**
 * Plain-text renderings for the clipboard — cheap enough (utterances are
 * already loaded for the page) that these skip an IPC round-trip entirely,
 * unlike `transcript:export`'s file-writing formats.
 */

export function copyPlainText(utterances: Utterance[]): string {
  return utterances.map((u) => u.text).join('\n\n')
}

export function copyWithTimestamps(utterances: Utterance[]): string {
  return utterances.map((u) => `[${formatDuration(u.startMs)}] ${u.text}`).join('\n')
}

export function copyWithSpeakers(utterances: Utterance[]): string {
  return utterances.map((u) => (u.speaker ? `${u.speaker.name}: ${u.text}` : u.text)).join('\n\n')
}
