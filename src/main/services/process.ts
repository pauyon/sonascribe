import { spawn } from 'node:child_process'
import { cpus } from 'node:os'

/**
 * Shared child-process plumbing for the sidecar-spawning services
 * (whisper.ts, parakeet.ts, diarize.ts).
 *
 * Each of those spawns a CLI, wires an abort signal to `child.kill()`,
 * guards against double-settling a promise once both `exit`/`close` and
 * `error` could fire, and keeps a rolling tail of stderr for error
 * reporting. That machinery is identical across all three and lives here;
 * each caller keeps its own stdout/stderr parsing (progress regexes, token
 * tables, line-buffered segment output), since that part is genuinely
 * different per engine.
 */

/**
 * Leave a couple of cores free.
 *
 * These CLIs saturate every thread they're given; handing them all of them
 * makes the UI stutter and the machine unusable for the length of a long
 * run.
 */
export function defaultThreads(): number {
  return Math.max(1, Math.min(8, cpus().length - 2))
}

/** Thrown by a sidecar runner; carries the tail of the child's stderr. */
export class SidecarProcessError extends Error {
  constructor(
    message: string,
    readonly stderrTail: string
  ) {
    super(message)
    this.name = 'SidecarProcessError'
  }
}

export interface ManagedProcessOptions {
  exe: string
  args: string[]
  /** Working directory for the child. Some sidecars load shared libraries relative to it. */
  cwd?: string
  signal?: AbortSignal
  /**
   * When true, the rolling stderr-tail buffer accumulates text from both
   * stdout and stderr — some builds route progress (or, for the diarizer,
   * its actual output) to either stream. When false (the default), only
   * real stderr feeds the tail.
   */
  combinedTail?: boolean
  /** Called once, synchronously, right after a successful spawn. */
  onStart?: () => void
  /** Called with each stdout chunk's decoded text, for caller-specific parsing. */
  onStdout?: (text: string) => void
  /** Called with each stderr chunk's decoded text, for caller-specific parsing. */
  onStderr?: (text: string) => void
}

export interface ManagedProcessResult {
  code: number | null
  signalName: NodeJS.Signals | null
  /** Rolling tail of stderr (or stdout+stderr — see combinedTail), capped at 6000 chars. */
  stderrTail: string
}

/**
 * Spawns `exe`, wires the abort signal to kill it, and resolves once the
 * child closes.
 *
 * Resolves with the exit code/signal on any close — including a non-zero
 * exit — so the caller decides what counts as failure and how to phrase the
 * resulting error (the three callers format their stderr tail differently).
 * Only an already-aborted signal, a synchronous spawn failure, the child's
 * own `error` event, or a close that happened because of an abort reject
 * directly.
 */
export function runManagedProcess(opts: ManagedProcessOptions): Promise<ManagedProcessResult> {
  return new Promise<ManagedProcessResult>((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new Error('Aborted'))
      return
    }

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(opts.exe, opts.args, { windowsHide: true, cwd: opts.cwd })
    } catch (err) {
      reject(err)
      return
    }

    opts.onStart?.()

    let stderrTail = ''
    let settled = false

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

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      if (opts.combinedTail) stderrTail = (stderrTail + text).slice(-6000)
      opts.onStdout?.(text)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stderrTail = (stderrTail + text).slice(-6000)
      opts.onStderr?.(text)
    })

    child.on('error', (err) => finish(() => reject(err)))

    child.on('close', (code, signalName) => {
      finish(() => {
        if (opts.signal?.aborted) {
          reject(new Error('Aborted'))
          return
        }
        resolve({ code, signalName, stderrTail })
      })
    })
  })
}
