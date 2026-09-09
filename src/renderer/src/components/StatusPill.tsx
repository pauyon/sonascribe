import type { RecordingStatus } from '@shared/types'

const LABELS: Record<RecordingStatus, string> = {
  new: 'New',
  normalizing: 'Preparing',
  ready: 'Ready',
  failed: 'Failed'
}

export default function StatusPill({
  status
}: {
  status: RecordingStatus
}): React.JSX.Element {
  return <span className={`pill pill--${status}`}>{LABELS[status]}</span>
}
