import { app, dialog } from 'electron'
import log from 'electron-log/main'

/**
 * Routes every `console.*` call to a rotating file under the userData
 * directory, in addition to the terminal.
 *
 * The ~45 console.log/warn/error calls already scattered through main/ (each
 * tagged with a `[module]` prefix) are deliberately left as-is rather than
 * rewritten to call `log` directly — `Object.assign(console, log.functions)`
 * is electron-log's own documented way to adopt an existing console-based
 * codebase, and it means every future `console.*` call is captured for free.
 *
 * This matters specifically because a packaged build has no terminal: without
 * this, a real user's crash or a failed transcription leaves no record
 * anywhere they — or we — could ever retrieve.
 */
export function initLogging(): void {
  log.initialize()
  Object.assign(console, log.functions)

  // Both of these previously crashed the process (Node's default for an
  // unhandled error in the main process). Logging first and then exiting
  // preserves that — the goal is a diagnosable crash, not a suppressed one
  // that leaves the app limping in a state nothing has been tested in.
  const crash = (label: string, err: unknown): void => {
    log.error(`[main] ${label}:`, err)
    // Best-effort: a packaged build has no terminal, so without this the
    // window just vanishes with nothing to tell a real user why. Wrapped
    // because a dialog can itself fail — e.g. a crash before the app is
    // ready — and exiting must never depend on it succeeding.
    try {
      dialog.showErrorBox(
        'SonaScribe hit an unexpected error',
        `The app has to close. Details were written to the log file.\n\n${
          err instanceof Error ? err.message : String(err)
        }`
      )
    } catch {
      // The log line above is the fallback record.
    }
    app.exit(1)
  }

  process.on('uncaughtException', (err) => crash('uncaught exception', err))
  process.on('unhandledRejection', (reason) => crash('unhandled rejection', reason))
}

/** Path to the current log file, for the "Open logs folder" affordance in Settings. */
export function logFilePath(): string {
  return log.transports.file.getFile().path
}
