import Icon, { type IconName } from './Icon'

/**
 * A button holding one centered icon and nothing else — the shape
 * `search-bar__close`, `kb-refresh-btn`, `ask__copy`, and
 * `mini__icon-btn`/`.icon-btn` each redeclared independently at slightly
 * different pixel sizes. Two sizes cover every current use: `md` (34px,
 * the original `.icon-btn` — page-header actions, trim toolbar) and `sm`
 * (26px — everything smaller: a close button inside an already-compact
 * bar, a refresh/copy button next to a line of text).
 *
 * Deliberately not used for `SpeakerChips.tsx`'s `.chip__action` — those
 * buttons tint from the chip's own `--speaker` color via `color-mix`,
 * which is real per-consumer theming, not incidental duplication.
 */
export default function IconButton({
  icon,
  size = 'md',
  variant = 'ghost',
  active = false,
  iconStyle,
  className,
  ...rest
}: {
  icon: IconName
  size?: 'sm' | 'md'
  /** `plain` for the default `.btn` look (e.g. MiniRecorder's Pause button), `primary` for a filled accent button (e.g. Stop). */
  variant?: 'plain' | 'ghost' | 'primary'
  active?: boolean
  /** For a one-off icon tint (e.g. a marker's own color) — passed straight through to `Icon`. */
  iconStyle?: React.CSSProperties
  className?: string
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'className'>): React.JSX.Element {
  const variantClass = variant === 'ghost' ? 'btn--ghost' : variant === 'primary' ? 'btn--primary' : ''
  const sizeClass = size === 'sm' ? 'icon-btn-sm' : 'icon-btn'

  return (
    <button
      type="button"
      className={['btn', variantClass, sizeClass, active ? 'icon-btn--active' : null, className]
        .filter(Boolean)
        .join(' ')}
      aria-pressed={rest['aria-pressed'] ?? (active || undefined)}
      {...rest}
    >
      <Icon name={icon} style={iconStyle} />
    </button>
  )
}
