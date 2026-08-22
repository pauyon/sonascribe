import { useEffect, useState } from 'react'
import type { JobProgress as JobProgressPayload, JobStage } from '@shared/types'
import { formatDuration } from '../lib/format'

/**
 * Progress for an in-flight transcription job.
 *
 * Two things matter here. The stage has to be named — "Preparing…" for minutes
 * tells the user nothing and reads like a hang. And when the engine reports no
 * percentage at all (Parakeet's CLI prints none), an elapsed timer is what
 * distinguishes "working" from "frozen", so it is always shown rather than only
 * as a fallback.
 */

const STAGE_LABEL: Record<JobStage, string> = {
  transcribing: 'Transcribing',
  diarizing: 'Identifying speakers',
  merging: 'Matching speakers to words'
}

export default function JobProgress({
  job,
  startedAt
}: {
  /** Null before the first progress event arrives for a job that has started. */
  job: JobProgressPayload | null
  /** Epoch ms the job was started, for the elapsed counter. */
  startedAt: number
}): React.JSX.Element {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(timer)
  }, [])

  const elapsedMs = Math.max(0, now - startedAt)
  const stage = job ? STAGE_LABEL[job.stage] : 'Starting'
  const percent = job?.fraction != null ? Math.round(job.fraction * 100) : null

  return (
    <div className="job">
      <div className="job__bar">
        <div
          className={percent == null ? 'job__fill job__fill--indeterminate' : 'job__fill'}
          style={percent == null ? undefined : { width: `${percent}%` }}
        />
      </div>
      <div className="job__meta">
        <span className="job__stage">
          {stage}
          {percent != null && <span className="job__percent"> {percent}%</span>}
        </span>
        <span className="job__elapsed">{formatDuration(elapsedMs)}</span>
      </div>
      {percent == null && (
        <p className="job__hint">
          This engine does not report progress. The timer shows it is still running.
        </p>
      )}
    </div>
  )
}
