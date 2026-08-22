import type { RecordingStatus } from '@shared/types'

const LABELS: Record<RecordingStatus, string> = {
  new: 'New',
  normalizing: 'Normalizing',
  queued: 'Ready to transcribe',
  transcribing: 'Transcribing',
  diarizing: 'Identifying speakers',
  merging: 'Merging',
  ready: 'Transcribed',
  failed: 'Failed'
}

export default function StatusPill({
  status
}: {
  status: RecordingStatus
}): React.JSX.Element {
  return <span className={`pill pill--${status}`}>{LABELS[status]}</span>
}
