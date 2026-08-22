/** Transcript export formats, shared so the picker and the writer agree. */

export type ExportFormat = 'txt' | 'md' | 'srt' | 'vtt' | 'json'

export interface ExportFormatSpec {
  id: ExportFormat
  label: string
  extension: string
  description: string
}

export const EXPORT_FORMATS: ExportFormatSpec[] = [
  {
    id: 'txt',
    label: 'Plain text',
    extension: 'txt',
    description: 'Timestamped lines. Paste anywhere.'
  },
  {
    id: 'md',
    label: 'Markdown',
    extension: 'md',
    description: 'Headed document with speakers in bold.'
  },
  {
    id: 'srt',
    label: 'Subtitles (SRT)',
    extension: 'srt',
    description: 'For video editors and players.'
  },
  {
    id: 'vtt',
    label: 'Subtitles (WebVTT)',
    extension: 'vtt',
    description: 'For the web, with speaker voice tags.'
  },
  {
    id: 'json',
    label: 'JSON',
    extension: 'json',
    description: 'Full structure including timings and confidence.'
  }
]
