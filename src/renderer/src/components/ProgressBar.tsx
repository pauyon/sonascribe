/**
 * A labeled progress bar — determinate when `fraction` is a number,
 * indeterminate (animated, no known end) when it's `null`. The same
 * `.progress`/`.progress__bar`/`.progress__label` markup was hand-built at
 * four call sites (speaker detection, transcription, ASR model downloads,
 * Ollama pulls), each recomputing `Math.round(fraction * 100)` inline.
 */
export default function ProgressBar({
  fraction,
  label,
  wide = true
}: {
  /** 0..1, or null while the underlying task can't report one yet. */
  fraction: number | null
  label: string
  wide?: boolean
}): React.JSX.Element {
  return (
    <div className={wide ? 'progress progress--wide' : 'progress'}>
      <div
        className={fraction == null ? 'progress__bar progress__bar--indeterminate' : 'progress__bar'}
        style={fraction == null ? undefined : { width: `${Math.round(fraction * 100)}%` }}
      />
      <span className="progress__label">{label}</span>
    </div>
  )
}
