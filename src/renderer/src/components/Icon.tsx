/**
 * The app's icon set: inline SVG, 24x24, 2px rounded strokes — same recipe
 * `App.tsx`'s nav icons already use, extended to cover the library and
 * recording-detail surfaces rather than left as a package or as emoji
 * standing in for real icons. `filled` icons (play/pause/the "more" dots)
 * paint with `currentColor` instead of stroking an outline, matching how
 * those specific marks read everywhere else.
 */

const STROKE = {
  edit: (
    <>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </>
  ),
  transcribe: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
      <path d="M14 3v5h5" />
      <path d="M9 13h6M9 17h6" />
    </>
  ),
  speakers: (
    <>
      <circle cx="9" cy="8" r="3" />
      <path d="M3.5 20a5.5 5.5 0 0 1 11 0" />
      <path d="M16 4.6a3 3 0 0 1 0 6.8" />
      <path d="M15.5 14.2a5.5 5.5 0 0 1 5 5.8" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </>
  ),
  folder: <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />,
  open: (
    <>
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
    </>
  ),
  volume: (
    <>
      <path d="M4 9v6h4l5 5V4L8 9Z" />
      <path d="M16.5 8.5a5 5 0 0 1 0 7" />
    </>
  ),
  download: (
    <>
      <path d="M12 3v12" />
      <path d="M7 10l5 5 5-5" />
      <path d="M4 19h16" />
    </>
  ),
  trash: (
    <>
      <path d="M4 7h16" />
      <path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
      <path d="M6 7l1 12.5A2 2 0 0 0 9 21h6a2 2 0 0 0 2-1.5L18 7" />
      <path d="M10 11v6M14 11v6" />
    </>
  ),
  shuffle: (
    <>
      <path d="M3 6h4l6 12h5" />
      <path d="M14 6h5" />
      <path d="M17 3l3 3-3 3" />
      <path d="M3 18h4l3-5" />
      <path d="M17 15l3 3-3 3" />
    </>
  ),
  chevronRight: <path d="M9 5l7 7-7 7" />,
  arrowLeft: (
    <>
      <path d="M11 5 4 12l7 7" />
      <path d="M4 12h16" />
    </>
  ),
  flag: (
    <>
      <path d="M5 3v18" />
      <path d="M5 4h11l-2.5 4L16 12H5Z" />
    </>
  ),
  close: (
    <>
      <path d="M6 6l12 12" />
      <path d="M18 6 6 18" />
    </>
  ),
  plus: (
    <>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </>
  ),
  eye: (
    <>
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  split: (
    <>
      <rect x="3" y="4" width="8" height="16" rx="1" />
      <rect x="13" y="4" width="8" height="16" rx="1" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.35-4.35" />
    </>
  ),
  chat: (
    <path d="M4 4h16a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H9l-5 4v-4H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z" />
  ),
  send: (
    <>
      <path d="M22 2 11 13" />
      <path d="M22 2 15 22l-4-9-9-4Z" />
    </>
  ),
  refresh: (
    <>
      <path d="M3 12a9 9 0 0 1 15.4-6.4L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-15.4 6.4L3 16" />
      <path d="M3 21v-5h5" />
    </>
  ),
  check: <path d="M20 6 9 17l-5-5" />,
  /** Half-filled circle for the Appearance setting — the left path overrides
      the parent's fill="none" with its own fill, which SVG allows even
      though every other icon here is stroke-only. */
  contrast: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3a9 9 0 0 0 0 18Z" fill="currentColor" stroke="none" />
    </>
  )
} as const

const FILLED = {
  play: <path d="M6 4.5v15l13-7.5Z" />,
  pause: (
    <>
      <rect x="6" y="4" width="4" height="16" rx="1" />
      <rect x="14" y="4" width="4" height="16" rx="1" />
    </>
  ),
  more: (
    <>
      <circle cx="5" cy="12" r="1.7" />
      <circle cx="12" cy="12" r="1.7" />
      <circle cx="19" cy="12" r="1.7" />
    </>
  )
} as const

export type IconName = keyof typeof STROKE | keyof typeof FILLED

export default function Icon({
  name,
  className,
  style
}: {
  name: IconName
  className?: string
  /** For a one-off tint (e.g. a marker's own color) — most icons should just inherit currentColor from their button instead. */
  style?: React.CSSProperties
}): React.JSX.Element {
  const filled = (FILLED as Record<string, React.ReactNode>)[name]
  if (filled) {
    return (
      <svg className={className} style={style} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        {filled}
      </svg>
    )
  }
  return (
    <svg
      className={className}
      style={style}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {(STROKE as Record<string, React.ReactNode>)[name]}
    </svg>
  )
}
