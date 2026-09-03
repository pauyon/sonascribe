import { spawn } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { cpus, freemem, tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { resolveSidecar } from './sidecars'
import { runFfmpegCapture, baseArgs } from './ffmpeg'
import { measurePeak, SILENCE_PEAK_THRESHOLD } from './peaks'
import { readWavInfo } from './wav'
import {
  groupWordsIntoSegments,
  TranscriptionError,
  type TranscribeOptions,
  type TranscriptionResult,
  type TranscriptWord
} from './transcription'
import { parseTokenTable } from './parakeet-parse'
import { discardChunks, splitAudio } from './audio-chunks'

/**
 * Runs NVIDIA Parakeet (TDT) via whisper.cpp's parakeet-cli.
 *
 * Unlike whisper-cli there is no JSON output, so the token table printed by
 * `--print-segments` is parsed instead. That table is in some ways better
 * suited to this pipeline: it marks word boundaries explicitly rather than
 * leaving them to be inferred from leading whitespace.
 *
 * The CLI reports no progress and takes no language flag — Parakeet TDT v3 is
 * multilingual and always auto-detects.
 */

/**
 * Drops the engine's timing report, which is several lines of noise that
 * crowd out whatever actually went wrong.
 */
function usefulStderr(stderr: string): string {
  return stderr
    .split('\n')
    .filter((line) => !/^(parakeet|whisper)_print_timings:/.test(line.trim()))
    .filter((line) => line.trim() !== '')
    .slice(-6)
    .join('\n')
}

function defaultThreads(): number {
  return Math.max(1, Math.min(8, cpus().length - 2))
}

/**
 * How many windows to run at once, and how many threads to give each.
 *
 * Measured on 20 minutes of audio in four 5-minute windows, 8-core Core Ultra 7,
 * CPU backend: 273 s serially at 6 threads, 234 s with four workers at 2 threads,
 * 221 s with two workers at 4 threads. Token counts were identical in all three,
 * so the parallelism costs nothing in accuracy — but two workers is only 19%
 * faster than serial and four is slower than two.
 *
 * That shape says the work is bound by memory bandwidth rather than by cores:
 * more workers mostly buy more contention for the same bus. Worth taking, and
 * worth being honest that a large speedup lives in a GPU backend instead.
 *
 * The count is also capped by free memory, since each worker holds a whole
 * window's activations — roughly 800 MB per minute of audio plus the model.
 *
 * `coreBudget` defaults to every core on the machine, which is correct for a
 * standalone transcription — but the pipeline now runs a second track's ASR
 * concurrently with this one (see transcription-pipeline.ts), and passes its
 * own, already-halved share through `options.threads` when it does. Without
 * that, this would keep dividing the *whole* machine between its own workers
 * with no idea a sibling process is doing the same thing next to it — an
 * 8-core machine running two 2-worker-of-4-threads plans at once is 16
 * threads competing for 8 cores, not the 8 either plan alone assumed.
 */
function planWorkers(chunkMs: number, coreBudget: number): { workers: number; threads: number } {
  const perWorkerGb = (chunkMs / 60_000) * 0.8 + 1.5
  // Only part of what is free, so a transcription cannot squeeze everything else
  // on the machine into swap the way the unsplit file did.
  const budgetGb = (freemem() / 2 ** 30) * 0.6
  const byMemory = Math.max(1, Math.floor(budgetGb / perWorkerGb))
  const workers = Math.max(1, Math.min(2, byMemory, Math.floor(coreBudget / 2)))
  // Every core in the budget divided between the workers, which is the
  // arrangement that was measured fastest for a standalone run. Holding one
  // back sounds prudent and is not: the app has nothing to do while this
  // runs but forward progress events.
  return { workers, threads: Math.max(1, Math.floor(coreBudget / workers)) }
}

/**
 * Transcribes with Parakeet, splitting long audio first.
 *
 * The engine holds an entire file in memory at once and its appetite grows with
 * the length of that file: a 2 h 25 m recording reached 20.8 GB resident and
 * 66 GB of commit, which nothing short of a server can satisfy. It does not
 * report that failure — it exits 0 having printed no tokens, which reads
 * downstream as "this audio has no speech in it". A recording full of
 * conversation was therefore reported as silent.
 *
 * Splitting also buys real progress. A single call reports none at all, so the
 * UI could only show indeterminate work for however long a long file took;
 * finished windows are a genuine fraction.
 */
export async function transcribeWithParakeet(
  options: TranscribeOptions
): Promise<TranscriptionResult> {
  const chunks = await splitAudio(options.wavPath, { signal: options.signal })

  if (chunks.length === 1) {
    return sweepTail(options, await transcribeOneFile(options))
  }

  console.log(
    `[parakeet] ${Math.round(chunks[chunks.length - 1].endMs / 60000)} minutes of audio split into ${chunks.length} windows`
  )

  const coreBudget = options.threads ?? Math.max(1, cpus().length)
  const { workers, threads } = planWorkers(chunks[0].endMs - chunks[0].startMs, coreBudget)
  console.log(`[parakeet] ${workers} worker(s) at ${threads} thread(s) each`)

  try {
    // Results are held by index rather than appended, so the order of the
    // transcript never depends on which worker happened to finish first.
    const results: Array<TranscriptionResult | null> = new Array(chunks.length).fill(null)
    let nextChunk = 0
    let finished = 0
    let failure: unknown = null

    const worker = async (): Promise<void> => {
      for (;;) {
        if (failure != null || options.signal?.aborted) return
        const index = nextChunk++
        if (index >= chunks.length) return

        try {
          // A chunk with nothing in it costs the same as one full of speech —
          // the engine charges for the file handed to it, not for what's
          // actually said. System audio is silent for most of a call, so this
          // check (already used on the tail sweep below) applies just as well
          // to a whole 5-minute window that turned out to hold no signal.
          const peak = await measurePeak(chunks[index].path)
          if (peak < SILENCE_PEAK_THRESHOLD) {
            console.log(`[parakeet] window ${index} silent (peak ${peak.toFixed(5)}); skipping the engine`)
          }
          results[index] =
            peak < SILENCE_PEAK_THRESHOLD
              ? { language: null, segments: [] }
              : await transcribeOneFile({
                  ...options,
                  wavPath: chunks[index].path,
                  threads,
                  // A single run reports nothing usable, so progress is counted in
                  // completed windows instead.
                  onProgress: () => undefined
                })
        } catch (err) {
          // Remember the first failure and stop drawing work; the windows still
          // running will finish on their own and be discarded.
          failure ??= err
          return
        }

        finished++
        options.onProgress?.(finished / chunks.length)
      }
    }

    await Promise.all(Array.from({ length: workers }, () => worker()))
    if (failure != null) throw failure
    if (options.signal?.aborted) throw new Error('Aborted')

    // Each window was transcribed as if it began at zero, so its timings have to
    // be moved back onto the recording's timeline before they are merged.
    const words: TranscriptWord[] = []
    for (const [index, chunk] of chunks.entries()) {
      for (const segment of results[index]?.segments ?? []) {
        for (const word of segment.words) {
          words.push({
            ...word,
            startMs: word.startMs + chunk.startMs,
            endMs: word.endMs + chunk.startMs
          })
        }
      }
    }

    options.onProgress?.(1)
    return sweepTail(options, { language: null, segments: groupWordsIntoSegments(words) })
  } finally {
    await discardChunks(chunks, options.wavPath)
  }
}

/**
 * Audio left untranscribed at the end before it is worth a second look.
 *
 * Shorter than this and the gap is just the pause after the last word.
 */
const TAIL_GAP_MS = 1_200

/**
 * Shortest clip the engine is handed, with silence making up any shortfall.
 *
 * A 1.97-second slice carrying five clearly spoken words came back empty; the
 * same slice padded to 2.5 s returned all five, and padded to 4 or 5 s returned
 * them again. Padded to 3 s it returned two, so this is not a clean threshold —
 * the decoder is simply unreliable on very short input, and every padded length
 * tried beat the unpadded original. Silence at the end costs a fraction of a
 * second of compute and cannot add words that were not spoken.
 */
const MIN_ENGINE_INPUT_MS = 5_000

/**
 * How many times the end is re-checked.
 *
 * Each pass can itself stop early, so one sweep is not always enough. Three
 * bounds the cost at three short runs on a file that keeps giving up.
 */
const MAX_TAIL_PASSES = 3

/**
 * Transcribes the audio after `fromMs`, or null if there is nothing to add.
 *
 * The slice is padded up to MIN_ENGINE_INPUT_MS, and anything the engine claims
 * to hear inside that padding is dropped — silence cannot contain words, so a
 * word timed past the real end of the slice is the decoder inventing one.
 */
async function transcribeTail(
  options: TranscribeOptions,
  fromMs: number,
  durationMs: number
): Promise<TranscriptWord[] | null> {
  const dir = join(tmpdir(), `sonascribe-tail-${randomUUID()}`)
  const tailPath = join(dir, 'tail.wav')
  const realMs = durationMs - fromMs

  try {
    await mkdir(dir, { recursive: true })
    await runFfmpegCapture([
      ...baseArgs(),
      '-ss',
      (fromMs / 1000).toFixed(3),
      '-i',
      options.wavPath,
      // apad only ever extends, so a tail already this long passes through.
      '-af',
      `apad=whole_dur=${(MIN_ENGINE_INPUT_MS / 1000).toFixed(3)}`,
      '-ac',
      '1',
      '-ar',
      '16000',
      '-c:a',
      'pcm_s16le',
      '-y',
      tailPath
    ])

    // Silence at the end is the ordinary case — someone stops talking before
    // they stop recording — and is not worth a pass over.
    if ((await measurePeak(tailPath)) < SILENCE_PEAK_THRESHOLD) return null

    const tail = await transcribeOneFile({ ...options, wavPath: tailPath })
    return tail.segments
      .flatMap((segment) => segment.words)
      .filter((word) => word.startMs < realMs)
      .map((word) => ({
        ...word,
        startMs: word.startMs + fromMs,
        endMs: Math.min(durationMs, word.endMs + fromMs)
      }))
  } catch (err) {
    // The transcript that already exists is worth more than this addition.
    console.warn('[parakeet] tail sweep failed; keeping the first pass:', err)
    return null
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

/**
 * Transcribes anything the engine left at the end of the file.
 *
 * The decoder can stop emitting before the audio runs out. Measured on a
 * 7.34-second recording: the last word ended at 5.04 s, yet the region from
 * 5.3 s carried speech at -21 dB that the same engine transcribed as "Test."
 * when handed that slice on its own. On a 4.61-second recording it stopped at
 * 2.64 s and left five spoken words behind.
 *
 * So the end is checked rather than trusted: while the transcript stops well
 * short of the audio and what remains is not silence, that remainder is
 * transcribed on its own and appended. It loops because a sweep can stop early
 * for the same reason the first pass did.
 */
async function sweepTail(
  options: TranscribeOptions,
  result: TranscriptionResult
): Promise<TranscriptionResult> {
  let durationMs: number
  try {
    durationMs = (await readWavInfo(options.wavPath)).durationMs
  } catch {
    return result
  }

  let words = result.segments.flatMap((segment) => segment.words)
  let recovered = 0

  for (let pass = 0; pass < MAX_TAIL_PASSES; pass++) {
    const lastEnd = words.length > 0 ? words.reduce((max, w) => Math.max(max, w.endMs), 0) : 0
    if (durationMs - lastEnd < TAIL_GAP_MS) break

    const extra = await transcribeTail(options, lastEnd, durationMs)
    if (extra == null || extra.length === 0) break

    console.log(
      `[parakeet] recovered ${extra.length} word(s) from the last ${
        Math.round((durationMs - lastEnd) / 100) / 10
      }s, which the previous pass left out`
    )
    words = [...words, ...extra]
    recovered += extra.length
  }

  if (recovered === 0) return result
  return { language: result.language, segments: groupWordsIntoSegments(words) }
}

function transcribeOneFile(

  options: TranscribeOptions
): Promise<TranscriptionResult> {
  const { wavPath, modelPath, onProgress, signal } = options

  const threads = options.threads ?? defaultThreads()

  return new Promise<TranscriptionResult>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Aborted'))
      return
    }

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(
        resolveSidecar('parakeet-cli'),
        [
          '-m', modelPath,
          '-f', wavPath,
          '-t', String(threads),
          // The token table is the only place word timings are exposed.
          '-ps'
        ],
        { windowsHide: true }
      )
    } catch (err) {
      reject(err)
      return
    }

    // No progress is reported, so signal indeterminate work rather than leaving
    // the UI showing nothing at all.
    onProgress?.(null)

    let output = ''
    let stderrTail = ''
    let settled = false

    const onAbort = (): void => {
      child.kill()
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      fn()
    }

    // The table goes to stdout on some builds and stderr on others; collect both
    // and let the line parser pick out what it recognises.
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      output += text
      stderrTail = (stderrTail + text).slice(-6000)
    })

    child.on('error', (err) => finish(() => reject(err)))

    child.on('close', (code, signalName) => {
      finish(() => {
        if (signal?.aborted) {
          reject(new Error('Aborted'))
          return
        }
        if (code !== 0) {
          reject(
            new TranscriptionError(
              `parakeet-cli exited with ${signalName ? `signal ${signalName}` : `code ${code}`}`,
              usefulStderr(stderrTail)
            )
          )
          return
        }

        // An empty result is reported as an empty result, not raised as an
        // error. Silence on one track of a multi-track recording is ordinary —
        // system audio with nothing playing, for instance — and only the caller
        // can see whether every track came back empty.
        const words = parseTokenTable(output)

        onProgress?.(1)
        resolve({
          // Parakeet auto-detects and does not report which language it chose.
          language: null,
          segments: groupWordsIntoSegments(words)
        })
      })
    })
  })
}
