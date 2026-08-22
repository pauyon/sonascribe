import type { Speaker, TranscriptBundle, Utterance } from '@shared/types'
import type { ExportFormat } from '@shared/export'

/**
 * Transcript serialization.
 *
 * Pure functions over a TranscriptBundle — no filesystem, no Electron — so each
 * format can be reasoned about and tested on its own.
 */

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0')
}

/**
 * Splits milliseconds into clock parts.
 *
 * Subtitle formats differ only in their separators, so the arithmetic lives in
 * one place rather than being repeated per format with subtly different
 * rounding.
 */
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

function speakerName(speakers: Speaker[], utterance: Utterance): string | null {
  if (!utterance.speakerId) return null
  return speakers.find((s) => s.id === utterance.speakerId)?.displayName ?? null
}

function toTxt(bundle: TranscriptBundle): string {
  const withHours = (bundle.recording.durationMs ?? 0) >= 3_600_000
  return (
    bundle.utterances
      .map((u) => {
        const who = speakerName(bundle.speakers, u)
        const stamp = `[${plainTime(u.startMs, withHours)}]`
        return who ? `${stamp} ${who}: ${u.text}` : `${stamp} ${u.text}`
      })
      .join('\n') + '\n'
  )
}

function toMarkdown(bundle: TranscriptBundle): string {
  const { recording } = bundle
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

  const body = bundle.utterances
    .map((u) => {
      const who = speakerName(bundle.speakers, u)
      const stamp = `\`${plainTime(u.startMs, withHours)}\``
      return who ? `**${who}** ${stamp}\n\n${u.text}\n` : `${stamp}\n\n${u.text}\n`
    })
    .join('\n')

  return `${header}\n${body}`
}

function toSrt(bundle: TranscriptBundle): string {
  return (
    bundle.utterances
      .map((u, i) => {
        const who = speakerName(bundle.speakers, u)
        const text = who ? `${who}: ${u.text}` : u.text
        return `${i + 1}\n${srtTime(u.startMs)} --> ${srtTime(u.endMs)}\n${text}\n`
      })
      .join('\n') + ''
  )
}

function toVtt(bundle: TranscriptBundle): string {
  const cues = bundle.utterances
    .map((u) => {
      const who = speakerName(bundle.speakers, u)
      // WebVTT's <v> voice tag is how players are told who is speaking.
      const text = who ? `<v ${who}>${u.text}` : u.text
      return `${vttTime(u.startMs)} --> ${vttTime(u.endMs)}\n${text}\n`
    })
    .join('\n')
  return `WEBVTT\n\n${cues}`
}

function toJson(bundle: TranscriptBundle): string {
  return JSON.stringify(
    {
      title: bundle.recording.title,
      createdAt: bundle.recording.createdAt,
      durationMs: bundle.recording.durationMs,
      model: bundle.recording.modelId,
      language: bundle.recording.language,
      speakers: bundle.speakers.map((s) => ({ id: s.id, name: s.displayName })),
      utterances: bundle.utterances.map((u) => ({
        startMs: u.startMs,
        endMs: u.endMs,
        speaker: speakerName(bundle.speakers, u),
        text: u.text,
        confidence: u.confidence,
        edited: u.edited
      }))
    },
    null,
    2
  )
}

export function renderTranscript(bundle: TranscriptBundle, format: ExportFormat): string {
  switch (format) {
    case 'txt':
      return toTxt(bundle)
    case 'md':
      return toMarkdown(bundle)
    case 'srt':
      return toSrt(bundle)
    case 'vtt':
      return toVtt(bundle)
    case 'json':
      return toJson(bundle)
  }
}
