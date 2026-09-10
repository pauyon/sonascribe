/**
 * Generic bookkeeping for a serial, cancellable, per-recording job queue.
 *
 * `jobs.ts` (transcription) and `speaker-jobs.ts` (speaker detection) are
 * deliberately separate pipelines — different binaries, different progress
 * and error shapes, different DB writes — and stay that way. What they
 * duplicated was never the pipeline logic, only the plumbing around it: a
 * FIFO of one-job-at-a-time work, an `AbortController` per recording, a
 * "latest known progress" map so a freshly (re)mounted page doesn't show a
 * blank bar, and cancel semantics where a job that hasn't started yet is
 * dropped from the queue outright rather than left to run and fail. This
 * module is that plumbing, factored out so each pipeline keeps its own
 * `run()` closure and just asks the queue to schedule it.
 */

export interface QueuedJob {
  recordingId: string
  controller: AbortController
  run: () => Promise<void>
}

export interface JobQueueOptions {
  /** Prefixes shutdown/error console logging, e.g. "[transcription]". */
  logLabel: string
  /**
   * Called when `cancel()` removes a job that had not started running yet —
   * the pipeline's chance to reset its own status column and publish the
   * recording, since the job's own `run()` never got a chance to.
   */
  onDropped: (recordingId: string) => void
}

export interface JobQueue {
  /**
   * Claims `recordingId` and schedules `job`, starting the drain loop if it
   * isn't already running. Callers are expected to have already checked
   * `isActive(recordingId)` — this does not guard against double-enqueueing
   * the same id.
   */
  enqueue(job: QueuedJob): void
  /** True when a job for this id is queued or in flight. */
  isActive(recordingId: string): boolean
  /** Latest known progress for a queued/running job; `undefined` if not active. */
  getProgress(recordingId: string): number | null | undefined
  /** Records progress for an in-flight job — call from within its `run()`. */
  setProgress(recordingId: string, fraction: number | null): void
  /**
   * Every job currently queued or running, with its latest known progress.
   * The source of truth a freshly (re)mounted page reads from — this lives
   * in the main process, so it survives the renderer navigating away and
   * back, unlike component-local progress state.
   */
  listActive(): Array<{ recordingId: string; fraction: number | null }>
  /**
   * Aborts one job. If it has not started yet, drops it from the queue so
   * it never runs (calling `onDropped`) — the job itself won't get a chance
   * to reset its status otherwise. Returns false if nothing was active for
   * this id.
   */
  cancel(recordingId: string): boolean
  /** Cancels every active job, e.g. on app shutdown. Returns the count cancelled. */
  cancelAll(): number
}

export function createJobQueue(options: JobQueueOptions): JobQueue {
  const queue: QueuedJob[] = []
  const controllers = new Map<string, AbortController>()
  const activeProgress = new Map<string, number | null>()
  let running = false

  function isActive(recordingId: string): boolean {
    return controllers.has(recordingId)
  }

  function getProgress(recordingId: string): number | null | undefined {
    return activeProgress.get(recordingId)
  }

  function setProgress(recordingId: string, fraction: number | null): void {
    activeProgress.set(recordingId, fraction)
  }

  function listActive(): Array<{ recordingId: string; fraction: number | null }> {
    return [...activeProgress.entries()].map(([recordingId, fraction]) => ({
      recordingId,
      fraction: fraction ?? null
    }))
  }

  function cancel(recordingId: string): boolean {
    const controller = controllers.get(recordingId)
    if (!controller) return false
    controller.abort()

    // If it has not started yet, drop it from the queue so it never runs —
    // the job itself won't get a chance to reset the status otherwise.
    const index = queue.findIndex((j) => j.recordingId === recordingId)
    if (index !== -1) {
      queue.splice(index, 1)
      controllers.delete(recordingId)
      activeProgress.delete(recordingId)
      options.onDropped(recordingId)
    }
    return true
  }

  function cancelAll(): number {
    const ids = [...controllers.keys()]
    for (const id of ids) cancel(id)
    if (ids.length > 0) console.log(`${options.logLabel} cancelled ${ids.length} job(s) on shutdown`)
    return ids.length
  }

  async function drain(): Promise<void> {
    if (running) return
    running = true
    try {
      while (queue.length > 0) {
        const job = queue.shift()
        if (!job) break
        try {
          await job.run()
        } catch (err) {
          console.error(`${options.logLabel} ${job.recordingId} failed:`, err)
        } finally {
          controllers.delete(job.recordingId)
          activeProgress.delete(job.recordingId)
        }
      }
    } finally {
      running = false
    }
  }

  function enqueue(job: QueuedJob): void {
    controllers.set(job.recordingId, job.controller)
    activeProgress.set(job.recordingId, null)
    queue.push(job)
    void drain()
  }

  return { enqueue, isActive, getProgress, setProgress, listActive, cancel, cancelAll }
}
