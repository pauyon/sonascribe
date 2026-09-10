import { app } from 'electron'
import { copyFile, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type { Recording, Utterance } from '@shared/types'
import { EXPORT_FORMATS, type ExportFormat } from '@shared/export'
import { getRecording } from '../db/recordings'
import { getUtterances } from '../db/transcript'
import { showSaveDialog } from './dialogs'

/**
 * Transcript serialization, plus the export flows (transcript and raw audio)
 * built on top of it.
 *
 * The `to*` renderers below are pure functions over a recording + its
 * utterances — no filesystem, no Electron — so each format can be reasoned
 * about on its own. `exportTranscript`/`exportAudio` are the IPC-reachable
 * flows: validate, prompt for a destination, then write — the business logic
 * `ipc/index.ts` used to hold inline.
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

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0')
}

/** Splits milliseconds into clock parts, once, so every format shares the same rounding. */
function parts(ms: number): { h: number; m: number; s: number; msec: number } {
  const clamped = Math.max(0, Math.round(ms))
  return {
    h: Math.floor(clamped / 3_600_000),
    m: Math.floor((clamped % 3_600_000) / 60_000),
    s: Math.floor((clamped % 60_000) / 1000),
    msec: clamped % 1000
  }
}

/** `01:02:03,456` — SRT uses a comma before milliseconds. */
function srtTime(ms: number): string {
  const { h, m, s, msec } = parts(ms)
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(msec, 3)}`
}

/** `01:02:03.456` — WebVTT uses a period. */
function vttTime(ms: number): string {
  const { h, m, s, msec } = parts(ms)
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(msec, 3)}`
}

/** `1:02:03` or `02:03` — for human-readable formats. */
function plainTime(ms: number, withHours: boolean): string {
  const { h, m, s } = parts(ms)
  return withHours ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

function toTxt(recording: Recording, utterances: Utterance[]): string {
  const withHours = (recording.durationMs ?? 0) >= 3_600_000
  return (
    utterances
      .map((u) => {
        const stamp = `[${plainTime(u.startMs, withHours)}]`
        return u.speaker ? `${stamp} ${u.speaker.name}: ${u.text}` : `${stamp} ${u.text}`
      })
      .join('\n') + '\n'
  )
}

function toMarkdown(recording: Recording, utterances: Utterance[]): string {
  const withHours = (recording.durationMs ?? 0) >= 3_600_000

  const header = [
    `# ${recording.title}`,
    '',
    `- Recorded: ${new Date(recording.createdAt).toLocaleString()}`,
    recording.modelId ? `- Model: ${recording.modelId}` : null,
    recording.language ? `- Language: ${recording.language}` : null,
    '',
    '---',
    ''
  ]
    .filter((line) => line !== null)
    .join('\n')

  const body = utterances
    .map((u) => {
      const stamp = `\`${plainTime(u.startMs, withHours)}\``
      return u.speaker ? `**${u.speaker.name}** ${stamp}\n\n${u.text}\n` : `${stamp}\n\n${u.text}\n`
    })
    .join('\n')

  return `${header}\n${body}`
}

function toSrt(utterances: Utterance[]): string {
  return (
    utterances
      .map((u, i) => {
        const text = u.speaker ? `${u.speaker.name}: ${u.text}` : u.text
        return `${i + 1}\n${srtTime(u.startMs)} --> ${srtTime(u.endMs)}\n${text}\n`
      })
      .join('\n') + ''
  )
}

function toVtt(utterances: Utterance[]): string {
  const cues = utterances
    .map((u) => {
      // WebVTT's <v> voice tag is how players are told who is speaking.
      const text = u.speaker ? `<v ${u.speaker.name}>${u.text}` : u.text
      return `${vttTime(u.startMs)} --> ${vttTime(u.endMs)}\n${text}\n`
    })
    .join('\n')
  return `WEBVTT\n\n${cues}`
}

function toJson(recording: Recording, utterances: Utterance[]): string {
  return JSON.stringify(
    {
      title: recording.title,
      createdAt: recording.createdAt,
      durationMs: recording.durationMs,
      model: recording.modelId,
      language: recording.language,
      utterances: utterances.map((u) => ({
        startMs: u.startMs,
        endMs: u.endMs,
        speaker: u.speaker?.name ?? null,
        text: u.text,
        confidence: u.confidence
      }))
    },
    null,
    2
  )
}

export function renderTranscript(recording: Recording, utterances: Utterance[], format: ExportFormat): string {
  switch (format) {
    case 'txt':
      return toTxt(recording, utterances)
    case 'md':
      return toMarkdown(recording, utterances)
    case 'srt':
      return toSrt(utterances)
    case 'vtt':
      return toVtt(utterances)
    case 'json':
      return toJson(recording, utterances)
  }
}

/**
 * Prompts for a destination and writes a recording's transcript in the given
 * format. Returns the written path, or null if the user cancelled the dialog.
 */
export async function exportTranscript(recordingId: string, format: ExportFormat): Promise<string | null> {
  const recording = getRecording(recordingId)
  if (!recording) throw new Error('Recording not found')
  const utterances = getUtterances(recordingId)
  if (utterances.length === 0) throw new Error('There is no transcript to export yet')

  const spec = EXPORT_FORMATS.find((f) => f.id === format)
  if (!spec) throw new Error(`Unknown export format: ${format}`)

  const result = await showSaveDialog({
    title: 'Export transcript',
    defaultPath: join(app.getPath('documents'), `${safeFileName(recording.title)}.${spec.extension}`),
    filters: [{ name: spec.label, extensions: [spec.extension] }]
  })
  if (result.canceled || !result.filePath) return null

  await writeFile(result.filePath, renderTranscript(recording, utterances, format), 'utf8')
  return result.filePath
}

/**
 * Prompts for a destination and copies a recording's audio file there.
 * Returns the written path, or null if the user cancelled the dialog.
 */
export async function exportAudio(recordingId: string): Promise<string | null> {
  const recording = getRecording(recordingId)
  if (!recording?.sourcePath) throw new Error('This recording has no audio yet')

  const result = await showSaveDialog({
    title: 'Export audio',
    defaultPath: join(
      app.getPath('documents'),
      `${safeFileName(recording.title)}${extname(recording.sourcePath)}`
    )
  })
  if (result.canceled || !result.filePath) return null

  await copyFile(recording.sourcePath, result.filePath)
  return result.filePath
}
