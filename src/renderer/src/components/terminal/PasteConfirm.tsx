import { useEffect } from 'react'
import { Modal } from '../common/Modal'
import { ClipboardPaste, AlertTriangle } from 'lucide-react'
import { useApp } from '../../store/app'

/**
 * Hand a pending `pasteRequest` for this pane to `open`, and clear it.
 *
 * Cleared on the way through so a pane that remounts does not ask again for
 * text it was already asked about. `open` only puts the text in front of the
 * confirmation below -- nothing reaches the shell until its button is pressed.
 */
export function useTerminalPasteRequest(
  paneId: string | undefined,
  open: (text: string) => void
): void {
  const request = useApp((s) => s.pasteRequest)
  useEffect(() => {
    if (!request || !paneId || request.paneId !== paneId) return
    useApp.setState({ pasteRequest: null })
    open(request.text)
    // `open` is a fresh closure every render; the request is the event.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request, paneId])
}

/**
 * What pasting this will actually do, in the sentence the dialog leads with.
 *
 * xterm's paste() turns each newline into a carriage return and, when the
 * shell has asked for bracketed paste, wraps the whole text so the shell
 * inserts it without executing any of it. So the answer depends on the shell's
 * mode and on whether the text ends with a newline, and "every line runs as
 * soon as it is pasted" is only one of the three. It used to be the only thing
 * this said, which was wrong for most modern bash and zsh prompts.
 */
export function pasteEffect(text: string, bracketed: boolean): string {
  if (bracketed) return 'Nothing runs until you press Enter'
  if (/\r?\n$/.test(text)) return 'Every line runs as soon as it is pasted'
  return /\r?\n/.test(text)
    ? 'All but the last line run now; the last waits for Enter'
    : 'It waits for you to press Enter'
}

// Confirming shows exactly what is about to be pasted, and what that will do.
export function PasteConfirm({
  text,
  lines,
  server,
  full,
  bracketed = false,
  local = false,
  onConfirm,
  onCancel
}: {
  text: string
  lines: number
  server: string
  /** Show every line rather than the first twelve. A saved template is run
   *  because someone chose it, not because it landed, so all of it is shown. */
  full?: boolean
  /** The shell has bracketed paste on. Unknown is passed as false, which is
   *  the reading that warns more. */
  bracketed?: boolean
  /** A shell on this machine rather than on a server. */
  local?: boolean
  onConfirm: () => void
  onCancel: () => void
}): React.JSX.Element {
  const preview = text.split(/\r?\n/).slice(0, full ? undefined : 12)
  const hidden = Math.max(0, text.split(/\r?\n/).length - preview.length)

  return (
    <Modal
      title={`Paste ${lines} line${lines === 1 ? '' : 's'} into ${server}?`}
      subtitle={pasteEffect(text, bracketed)}
      onClose={onCancel}
    >
      <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div className="row" style={{ gap: 8, color: 'var(--warn)' }}>
          <AlertTriangle size={16} />
          <span style={{ fontSize: 12 }}>
            {local ? 'This is a shell on this computer.' : 'This is a remote shell.'} Check the
            commands before continuing.
          </span>
        </div>
        <pre className="paste-preview selectable">
          {preview.join('\n')}
          {hidden > 0 ? `\n… ${hidden} more line${hidden === 1 ? '' : 's'}` : ''}
        </pre>
        <div className="row" style={{ gap: 8 }}>
          <span className="spacer" />
          {/* A template arrives from the palette on an Enter keydown, and the
              focused button of a dialog that mounts under that key would take
              the next Enter -- a key repeat or a second tap -- as consent to a
              text nobody has read yet. So there, Cancel holds the focus. */}
          <button className="btn sm" onClick={onCancel} autoFocus={full}>
            Cancel
          </button>
          <button className="btn primary sm" onClick={onConfirm} autoFocus={!full}>
            <ClipboardPaste size={14} /> {full || bracketed ? 'Paste' : 'Paste and run'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
