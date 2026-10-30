import { useEffect } from 'react'
import { Modal } from '../common/Modal'
import { ClipboardPaste, AlertTriangle } from 'lucide-react'
import { useApp } from '../../store/app'
import { bytes } from '../../lib/format'
import { t as tr, useT } from '../../lib/i18n'
import type { ClipboardImage } from '../../../../shared/ssh'

/**
 * Make this pane a paste target while its session is live, and hand it any
 * `pasteRequest` addressed to it.
 *
 * Registering is what lets the palette offer "Run in this terminal" only where
 * something will take the text: a demo pane never calls this, and a dead or
 * dormant one withdraws. `requestTerminalPaste` refuses a pane that is not
 * registered, so a request never sits in the store waiting for a pane that
 * will not come. A request is cleared on the way through, and one that arrives
 * after the session died is dropped rather than confirmed into nothing.
 *
 * `open` only puts the text in front of the confirmation below -- nothing
 * reaches the shell until its button is pressed.
 */
export function useTerminalPasteRequest(
  paneId: string | undefined,
  live: boolean,
  open: (text: string) => void
): void {
  useEffect(() => {
    if (!paneId || !live) return
    useApp.setState((s) => ({ pasteTargets: { ...s.pasteTargets, [paneId]: true as const } }))
    // Withdrawing also clears a request addressed to this pane, so one that
    // the pane never got to -- it died, went dormant, or was closed or swapped
    // out first -- cannot wait in the store for the next pane with this id.
    return () =>
      useApp.setState((s) => {
        const rest = { ...s.pasteTargets }
        delete rest[paneId]
        return {
          pasteTargets: rest,
          ...(s.pasteRequest?.paneId === paneId ? { pasteRequest: null } : {})
        }
      })
  }, [paneId, live])

  const request = useApp((s) => s.pasteRequest)
  useEffect(() => {
    if (!request || !paneId || request.paneId !== paneId) return
    useApp.setState({ pasteRequest: null })
    if (live) open(request.text)
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
  if (bracketed) return tr('terminal.paste.effectBracketed')
  if (/[\r\n]$/.test(text)) return tr('terminal.paste.effectEveryLine')
  return /[\r\n]/.test(text) ? tr('terminal.paste.effectAllButLast') : tr('terminal.paste.effectWaits')
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
  const t = useT()
  // Split on every break xterm will send as Enter, a lone \r included, so the
  // preview shows one row per command that will run.
  const rows = text.split(/\r\n|\r|\n/)
  const preview = rows.slice(0, full ? undefined : 12)
  const hidden = Math.max(0, rows.length - preview.length)

  return (
    <Modal
      title={t('terminal.paste.title', { count: lines, server })}
      subtitle={pasteEffect(text, bracketed)}
      onClose={onCancel}
    >
      <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div className="row" style={{ gap: 8, color: 'var(--warn)' }}>
          <AlertTriangle size={16} />
          <span style={{ fontSize: 12 }}>
            {local ? t('terminal.paste.warnLocal') : t('terminal.paste.warnRemote')}
          </span>
        </div>
        <pre className="paste-preview selectable">
          {preview.join('\n')}
          {hidden > 0 ? `\n${t('terminal.paste.moreLines', { count: hidden })}` : ''}
        </pre>
        <div className="row" style={{ gap: 8 }}>
          <span className="spacer" />
          {/* A template arrives from the palette on an Enter keydown, and the
              focused button of a dialog that mounts under that key would take
              the next Enter -- a key repeat or a second tap -- as consent to a
              text nobody has read yet. So there, Cancel holds the focus. */}
          <button className="btn sm" onClick={onCancel} autoFocus={full}>
            {t('common.cancel')}
          </button>
          <button className="btn primary sm" onClick={onConfirm} autoFocus={!full}>
            <ClipboardPaste size={14} />{' '}
            {full || bracketed ? t('terminal.paste.paste') : t('terminal.paste.pasteAndRun')}
          </button>
        </div>
      </div>
    </Modal>
  )
}

/**
 * An image is about to leave this computer for a server, so it is shown first.
 *
 * Pasting it copies the file to the server and pastes its path: Claude Code
 * picks that up as the image, and anything else sees a path. Asked every time,
 * because a screenshot left on the clipboard is easy to forget about and this
 * would otherwise put it on a machine somebody else may administer.
 */
export function ImagePasteConfirm({
  image,
  server,
  onConfirm,
  onCancel
}: {
  image: ClipboardImage
  server: string
  onConfirm: () => void
  onCancel: () => void
}): React.JSX.Element {
  const t = useT()
  return (
    <Modal
      title={t('terminal.imagePaste.title', { server })}
      subtitle={t('terminal.imagePaste.subtitle')}
      onClose={onCancel}
    >
      <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <img
          src={image.preview}
          alt={t('terminal.imagePaste.alt')}
          style={{ maxWidth: '100%', maxHeight: 240, objectFit: 'contain', alignSelf: 'center' }}
        />
        <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
          {t('terminal.imagePaste.detail', {
            width: image.width,
            height: image.height,
            size: bytes(image.png.byteLength),
            server
          })}
        </span>
        <div className="row" style={{ gap: 8 }}>
          <span className="spacer" />
          {/* Cancel holds the focus. Ctrl+V then a reflexive Enter would
              otherwise send a screenshot nobody looked at to the server. */}
          <button className="btn sm" onClick={onCancel} autoFocus>
            {t('common.cancel')}
          </button>
          <button className="btn primary sm" onClick={onConfirm}>
            <ClipboardPaste size={14} /> {t('terminal.imagePaste.confirm')}
          </button>
        </div>
      </div>
    </Modal>
  )
}
