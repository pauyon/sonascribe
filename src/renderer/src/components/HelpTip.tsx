/**
 * A small "?" that reveals an explanation on hover or keyboard focus.
 *
 * Custom-drawn rather than the native `title` attribute, for the same reason
 * Select.tsx draws its own dropdown instead of using <select>: a paragraph of
 * explanation deserves the app's own surface/radius/shadow treatment, not
 * whatever the OS renders for a title tooltip.
 */
export default function HelpTip({ text }: { text: string }): React.JSX.Element {
  return (
    <span className="help-tip">
      <button type="button" className="help-tip__icon" aria-label="More info">
        ?
      </button>
      <span className="help-tip__bubble" role="tooltip">
        {text}
      </span>
    </span>
  )
}
