import { ReactNode, useRef } from 'react'
import { X } from 'lucide-react'
import { useClickOutside } from '../../hooks/useClickOutside'
import { clsx } from '../../lib/format'

/**
 * The one dialog primitive.
 *
 * It was already the container five of the seven add-flows used; what differed
 * between them was everything inside it. Two nested a bordered `.card` in the
 * body and put their own action row at the bottom of THAT, which is how the
 * confirm button ended up mid-left in one dialog and bottom-right in the next.
 * A third put its actions in the body, so on a long config both the button and
 * the sentence explaining why it was disabled started out below the fold.
 *
 * So the footer stops being something a caller composes. `confirm` and
 * `cancelLabel` describe the two buttons every one of these dialogs has, and
 * this decides where they go and what they look like: right-aligned under a
 * divider, primary 28px accent, secondary 28px bordered, no icons on either.
 * `footer` remains for the handful of dialogs that genuinely need a third
 * control, and it lands in the same right-aligned row.
 *
 * Icons are off the text CTAs on purpose. "＋ Create" and "Import profile" and
 * "Save" were the same act in three costumes; a glyph on one and not the next
 * makes two buttons that do the same thing look like two different things.
 */

interface ConfirmAction {
  label: string
  onClick: () => void
  /** Off until the form is valid. The sentence saying WHY belongs under the
   *  offending field — see `Field` — not in the button's tooltip. */
  disabled?: boolean
  /** Destructive and irreversible: a filled red button rather than an
   *  outlined one. Reversible destructive actions do not qualify. */
  destructive?: boolean
}

interface ModalProps {
  title: string
  subtitle?: string
  onClose: () => void
  children: ReactNode
  /** The commit. Rendered as the last thing in the footer, always. */
  confirm?: ConfirmAction
  /** Defaults to "Cancel". Pass `null` for a dialog that has no way back —
   *  there is currently none, and one should have to say so. */
  cancelLabel?: string | null
  /** A sentence at the left of the footer: what the dialog is waiting on, or
   *  what it found. Never the reason a field is wrong. */
  footerNote?: ReactNode
  /** Extra controls, to the left of Cancel. Use `confirm` for the commit. */
  footer?: ReactNode
  size?: 'md' | 'lg'
}

export function Modal({
  title,
  subtitle,
  onClose,
  children,
  confirm,
  cancelLabel = 'Cancel',
  footerNote,
  footer,
  size = 'md'
}: ModalProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useClickOutside(ref, onClose)
  const hasFooter = confirm !== undefined || footer !== undefined || footerNote !== undefined
  return (
    <div className="scrim">
      <div className={clsx('modal', size === 'lg' && 'lg')} ref={ref} role="dialog" aria-modal>
        <div className="modal-header">
          <div>
            <h2>{title}</h2>
            {subtitle && <div className="sub">{subtitle}</div>}
          </div>
          <button className="icon-btn close" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {hasFooter && (
          <div className="modal-footer">
            {footerNote !== undefined && <span className="footer-note">{footerNote}</span>}
            {footer}
            {cancelLabel !== null && (
              <button className="btn secondary size-28" onClick={onClose}>
                {cancelLabel}
              </button>
            )}
            {confirm && (
              <button
                className={clsx(
                  'btn size-28',
                  confirm.destructive ? 'danger fill' : 'primary'
                )}
                disabled={confirm.disabled}
                onClick={confirm.onClick}
              >
                {confirm.label}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

interface FieldProps {
  label: ReactNode
  /** Marked in the label, at rest. A required field discovered by pressing a
   *  disabled button and reading a banner is a field the form hid. */
  required?: boolean
  /** What is wrong with what is currently in the control. Rendered directly
   *  under it, and it puts the danger border on the control itself. */
  error?: string | null
  /** Shown when there is no error. Both would be two competing sentences in
   *  the same slot. */
  hint?: ReactNode
  children: ReactNode
}

/**
 * A labelled control with its validation attached to it.
 *
 * The frp publish dialog was the only one of the seven that said what was
 * wrong beside the thing that was wrong; the rest either said nothing, put a
 * banner at the top of the body, or waited for the submit to fail. The
 * difference was never conviction — it was that doing it the good way meant
 * threading a conditional class into the <input> and remembering the danger
 * colour. Here it is one prop.
 */
export function Field({ label, required, error, hint, children }: FieldProps): React.JSX.Element {
  return (
    <label className="field">
      <span className="field-label">
        {label}
        {required && <span className="field-req">Required</span>}
      </span>
      <span className={clsx('field-control', error && 'invalid')}>{children}</span>
      {error ? (
        <span className="field-error" role="alert">
          {error}
        </span>
      ) : (
        hint && <span className="field-hint">{hint}</span>
      )}
    </label>
  )
}
