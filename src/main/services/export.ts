import type { Screenshot, Speaker, TranscriptBundle, Utterance } from '@shared/types'
import type { ExportFormat } from '@shared/export'
import { screenshotFileName } from './screenshot-naming'

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

/**
 * Utterances and screenshots merged into one chronological list. Only built
 * when screenshots are actually being included — for every other case the
 * plain `bundle.utterances` list is enough, and building this for nothing
 * would just be a wasted sort.
 */
type TimelineItem =
  | { kind: 'utterance'; at: number; utterance: Utterance }
  | { kind: 'screenshot'; at: number; screenshot: Screenshot }

function timeline(bundle: TranscriptBundle): TimelineItem[] {
  const items: TimelineItem[] = [
    ...bundle.utterances.map((u) => ({ kind: 'utterance' as const, at: u.startMs, utterance: u })),
    ...bundle.screenshots.map((s) => ({ kind: 'screenshot' as const, at: s.timestampMs, screenshot: s }))
  ]
  return items.sort((a, b) => a.at - b.at)
}

/** `screenshots/screenshot-<id>.png` — relative, so the exported file stays portable. */
function screenshotLink(relativeDir: string, screenshot: Screenshot): string {
  return `${relativeDir}/${screenshotFileName(screenshot.id)}`
}

function toTxt(bundle: TranscriptBundle, screenshotsRelativeDir?: string): string {
  const withHours = (bundle.recording.durationMs ?? 0) >= 3_600_000

  if (!screenshotsRelativeDir) {
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

  return (
    timeline(bundle)
      .map((item) => {
        if (item.kind === 'screenshot') {
          const stamp = `[${plainTime(item.at, withHours)}]`
          return `${stamp} Screenshot — ${item.screenshot.displayLabel}: ${screenshotLink(screenshotsRelativeDir, item.screenshot)}`
        }
        const who = speakerName(bundle.speakers, item.utterance)
        const stamp = `[${plainTime(item.at, withHours)}]`
        return who ? `${stamp} ${who}: ${item.utterance.text}` : `${stamp} ${item.utterance.text}`
      })
      .join('\n') + '\n'
  )
}

function toMarkdown(bundle: TranscriptBundle, screenshotsRelativeDir?: string): string {
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

  const body = screenshotsRelativeDir
    ? timeline(bundle)
        .map((item) => {
          if (item.kind === 'screenshot') {
            const stamp = `\`${plainTime(item.at, withHours)}\``
            const alt = `Screenshot at ${plainTime(item.at, withHours)} — ${item.screenshot.displayLabel}`
            return `${stamp}\n\n![${alt}](${screenshotLink(screenshotsRelativeDir, item.screenshot)})\n`
          }
          const who = speakerName(bundle.speakers, item.utterance)
          const stamp = `\`${plainTime(item.at, withHours)}\``
          return who
            ? `**${who}** ${stamp}\n\n${item.utterance.text}\n`
            : `${stamp}\n\n${item.utterance.text}\n`
        })
        .join('\n')
    : bundle.utterances
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

function toJson(bundle: TranscriptBundle, screenshotsRelativeDir?: string): string {
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
      })),
      // Kept as its own array rather than interleaved — a JSON consumer can
      // already sort utterances and screenshots together itself given both
      // carry a timestamp, and two flat arrays are easier to consume than
      // one array of two differently-shaped item kinds.
      ...(screenshotsRelativeDir
        ? {
            screenshots: bundle.screenshots.map((s) => ({
              timestampMs: s.timestampMs,
              display: s.displayLabel,
              file: screenshotLink(screenshotsRelativeDir, s)
            }))
          }
        : {})
    },
    null,
    2
  )
}

export function renderTranscript(
  bundle: TranscriptBundle,
  format: ExportFormat,
  /**
   * Present (and non-empty) only when screenshots should be included, naming
   * the folder — relative to wherever the exported file ends up — that the
   * caller has copied the actual image files into. `srt`/`vtt` ignore this:
   * neither format has a sensible way to carry an inline image.
   */
  screenshotsRelativeDir?: string
): string {
  switch (format) {
    case 'txt':
      return toTxt(bundle, screenshotsRelativeDir)
    case 'md':
      return toMarkdown(bundle, screenshotsRelativeDir)
    case 'srt':
      return toSrt(bundle)
    case 'vtt':
      return toVtt(bundle)
    case 'json':
      return toJson(bundle, screenshotsRelativeDir)
  }
}
