import { spawn } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { cpus, tmpdir } from 'node:os'
import { mkdtemp } from 'node:fs/promises'
import { resolveSidecar } from './sidecars'
import {
  TranscriptionError,
  type TranscribeOptions,
  type TranscriptionResult,
  type TranscriptSegment,
  type TranscriptWord
} from './transcription'

/**
 * Runs the whisper.cpp CLI and returns its structured output.
 *
 * The CLI writes JSON to a file rather than stdout, so a temporary directory is
 * used per run and cleaned up afterwards. Progress is parsed from stderr.
 */

/** Shape of the `-ojf` (output-json-full) file, narrowed to what we consume. */
interface WhisperJson {
  result?: { language?: string }
  transcription?: Array<{
    offsets: { from: number; to: number }
    text: string
    tokens?: Array<{
      text: string
      offsets: { from: number; to: number }
      /** Token probability, 0..1. */
      p?: number
      id?: number
    }>
  }>
}


/** `whisper_print_progress_callback: progress =  42%` */
const PROGRESS_RE = /progress\s*=\s*(\d+)%/

/**
 * Whisper emits sub-word tokens (" fell", "ow"), plus bracketed control tokens
 * such as `[_BEG_]`. A new word starts at a token beginning with whitespace;
 * everything else attaches to the token before it, which is what keeps
 * contractions and trailing punctuation intact.
 */
function tokensToWords(
  tokens: NonNullable<NonNullable<WhisperJson['transcription']>[number]['tokens']>
): TranscriptWord[] {
  const words: TranscriptWord[] = []

  for (const token of tokens) {
    const raw = token.text ?? ''
    // Control tokens carry no transcript text. They come in two shapes —
    // [_BEG_], [_EOT_], [_SOT_] and the like, but also timestamp tokens such as
    // [_TT_480], which have no trailing underscore. Matching only the first
    // shape leaks timestamps into the transcript wherever text is rebuilt from
    // words rather than taken from whisper's own segment text.
    if (/^\[_.*\]$/.test(raw)) continue
    if (raw.trim() === '') continue

    const startsWord = raw.startsWith(' ')
    const text = raw.trim()
    const probability = typeof token.p === 'number' ? token.p : 1

    if (startsWord || words.length === 0) {
      words.push({
        text,
        startMs: token.offsets.from,
        endMs: token.offsets.to,
        probability
      })
      continue
    }

    // Continuation: extend the current word.
    const current = words[words.length - 1]
    current.text += text
    current.endMs = token.offsets.to
    // Keep the weakest token's probability — a word is only as trustworthy as
    // its least certain piece.
    current.probability = Math.min(current.probability, probability)
  }

  return words
}

function parseWhisperJson(json: WhisperJson): TranscriptionResult {
  const segments: TranscriptSegment[] = []

  for (const raw of json.transcription ?? []) {
    const words = raw.tokens ? tokensToWords(raw.tokens) : []
    const text = raw.text.trim()
    if (!text) continue
    // Whisper annotates non-speech as a bracketed placeholder — [BLANK_AUDIO],
    // [ Silence ], (upbeat music). These are not things anyone said, and they
    // read as a real utterance once rendered in the transcript.
    if (/^[[(][^)]]*[)]]$/.test(text)) continue

    const confidence =
      words.length > 0
        ? words.reduce((sum, w) => sum + w.probability, 0) / words.length
        : null

    segments.push({
      startMs: raw.offsets.from,
      endMs: raw.offsets.to,
      text,
      words,
      confidence
    })
  }

  return { language: json.result?.language ?? null, segments }
}

export async function transcribeWithWhisper(
  options: TranscribeOptions
): Promise<TranscriptionResult> {
  const { wavPath, modelPath, language, onProgress, signal } = options
  const threads = options.threads ?? defaultThreads()

  const workDir = await mkdtemp(join(tmpdir(), 'scribe-whisper-'))
  const outputBase = join(workDir, 'result')

  try {
    await runCli({ wavPath, modelPath, language, threads, outputBase, onProgress, signal })
    const raw = await readFile(`${outputBase}.json`, 'utf8')
    return parseWhisperJson(JSON.parse(raw) as WhisperJson)
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}

/**
 * Leave a couple of cores free.
 *
 * whisper saturates every thread it is given; handing it all of them makes the
 * UI stutter and the machine unusable for the length of a long transcription.
 */
function defaultThreads(): number {
  return Math.max(1, Math.min(8, cpus().length - 2))
}

function runCli(opts: {
  wavPath: string
  modelPath: string
  language: string
  threads: number
  outputBase: string
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
}): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new Error('Aborted'))
      return
    }

    const args = [
      '-m', opts.modelPath,
      '-f', opts.wavPath,
      '-l', opts.language,
      '-t', String(opts.threads),
      // Full JSON carries per-token offsets and probabilities, which segment
      // level output does not — and word timings are what Phase 5 aligns
      // speaker turns against.
      '-ojf',
      '-of', opts.outputBase,
      '-pp',
      // Split segments at word boundaries so a segment never ends mid-word.
      '-sow'
    ]

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(resolveSidecar('whisper-cli'), args, { windowsHide: true })
    } catch (err) {
      reject(err)
      return
    }

    let stderrTail = ''
    let settled = false
    let lastPercent = -1

    const onAbort = (): void => {
      child.kill()
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      opts.signal?.removeEventListener('abort', onAbort)
      fn()
    }

    const readStream = (chunk: Buffer): void => {
      const text = chunk.toString()
      stderrTail = (stderrTail + text).slice(-6000)

      const match = PROGRESS_RE.exec(text)
      if (match) {
        const percent = Number(match[1])
        // The CLI repeats the same percentage many times; only forward changes.
        if (percent !== lastPercent) {
          lastPercent = percent
          opts.onProgress?.(Math.min(1, percent / 100))
        }
      }
    }

    // Progress goes to stderr, but the transcript preview goes to stdout; watch
    // both so a build that routes them differently still reports progress.
    child.stderr?.on('data', readStream)
    child.stdout?.on('data', readStream)

    child.on('error', (err) => finish(() => reject(err)))

    child.on('close', (code, signalName) => {
      finish(() => {
        if (opts.signal?.aborted) {
          reject(new Error('Aborted'))
        } else if (code === 0) {
          opts.onProgress?.(1)
          resolve()
        } else {
          reject(
            new TranscriptionError(
              `whisper-cli exited with ${signalName ? `signal ${signalName}` : `code ${code}`}`,
              stderrTail.trim().split('\n').slice(-8).join('\n')
            )
          )
        }
      })
    })
  })
}
