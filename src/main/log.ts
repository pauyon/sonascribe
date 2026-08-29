import { app } from 'electron'
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
  process.on('uncaughtException', (err) => {
    log.error('[main] uncaught exception:', err)
    app.exit(1)
  })
  process.on('unhandledRejection', (reason) => {
    log.error('[main] unhandled rejection:', reason)
    app.exit(1)
  })
}

/** Path to the current log file, for the "Open logs folder" affordance in Settings. */
export function logFilePath(): string {
  return log.transports.file.getFile().path
}
