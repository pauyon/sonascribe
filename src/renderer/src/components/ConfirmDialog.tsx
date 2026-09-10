import { useId } from 'react'

/**
 * A destructive-action confirm modal — was bespoke inline JSX on the
 * recording-delete flow (Editor.tsx), with nothing stopping the next
 * destructive action (there will be one) from inventing a fourth different
 * pattern for the same `.modal-overlay`/`.modal--confirm` shape.
 */
export default function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel = 'Cancel',
  danger = true,
  onConfirm,
  onCancel
}: {
  title: string
  message: React.ReactNode
  confirmLabel: string
  cancelLabel?: string
  /** Red confirm button, for something irreversible — on by default, since that's every current use. */
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}): React.JSX.Element {
  const titleId = useId()

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div
        className="modal modal--confirm"
        onClick={(e) => e.stopPropagation()}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="modal__header">
          <h2 id={titleId}>{title}</h2>
        </div>
        <p>{message}</p>
        <div className="modal__footer">
          <button type="button" className="btn btn--ghost" autoFocus onClick={onCancel}>
            {cancelLabel}
          </button>
          <button type="button" className={danger ? 'btn btn--danger' : 'btn btn--primary'} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
