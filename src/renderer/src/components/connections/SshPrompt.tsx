import { useEffect, useRef, useState } from 'react'
import { KeyRound } from 'lucide-react'
import { Modal } from '../common/Modal'
import { clsx } from '../../lib/format'
import type { SshPromptRequest } from '../../../../preload/index'
import { bridgeOn } from '../../lib/bridge'

// Answers keyboard-interactive challenges: the second factor on servers with
// AuthenticationMethods publickey,keyboard-interactive, or the password on
// servers that only offer keyboard-interactive.
export function SshPrompt(): React.JSX.Element | null {
  /**
   * A QUEUE, not a slot.
   *
   * This held one request and replaced it whenever another arrived. Nothing
   * answered the one that was dropped, so main's own 120-second fallback
   * answered it instead -- with `[]`, an empty and therefore WRONG second
   * factor -- and the connection behind it died with "the challenge was not
   * answered in time". Two challenges at once is ordinary: restoring a
   * session set opens several servers together, and a jump chain asks once
   * per hop.
   */
  const [queue, setQueue] = useState<SshPromptRequest[]>([])
  const [answers, setAnswers] = useState<string[]>([])
  const [remember, setRemember] = useState(false)
  const firstField = useRef<HTMLInputElement>(null)
  const request = queue[0] ?? null

  useEffect(() => {
    return bridgeOn('ssh.onPrompt', window.opsmaxx?.ssh?.onPrompt, (req) => {
      setQueue((q) => [...q, req])
    })
  }, [])

  // Fresh fields whenever a different challenge reaches the front. Appending
  // to the queue leaves the head's identity alone, so this does not fire while
  // the user is typing into the one already shown.
  useEffect(() => {
    if (!request) return
    setAnswers(request.prompts.map(() => ''))
    setRemember(false)
    firstField.current?.focus()
  }, [request])

  if (!request) return null

  const waiting = queue.length - 1

  /**
   * ALLOW-LIST, not deny-list, and the direction is the fix.
   *
   * A remembered answer is replayed with no dialog at all, so remembering a
   * one-time code makes the server stop asking and start refusing, invisibly.
   * This used to offer the switch for anything a list of known wordings failed
   * to recognise, which is the wrong default for a guess: a PAM module that
   * simply prompts `Password:` for a TOTP is not on any such list, and the
   * user is then offered a switch that breaks their logins.
   *
   * So the question is now "does this say it is a static secret", and anything
   * that does not say so is not offered. `looksOneTime` is kept as a second
   * gate rather than replaced, because "One-time password:" satisfies both.
   */
  const text = `${request.name} ${request.instructions} ${request.prompts.map((p) => p.prompt).join(' ')}`
  const looksOneTime = /\b(otp|one[- ]?time|verification code|token|2fa|totp|duo|authenticator)\b/i.test(text)
  const looksStatic = /\b(password|passphrase|passcode)\b/i.test(text)
  const canRemember = looksStatic && !looksOneTime && request.prompts.length === 1 && !!request.serverId

  const next = (): void => setQueue((q) => q.slice(1))

  const submit = (): void => {
    window.opsmaxx?.ssh.replyPrompt(request.id, answers, remember && canRemember, request.serverId)
    next()
  }

  /**
   * Answers the server, it does not merely close a window.
   *
   * An empty answer set makes the server reject the attempt cleanly -- which
   * is the right thing when the user means it, and a wrong second factor when
   * they did not. Spending one costs the host a MaxAuthTries slot, and enough
   * of them trip fail2ban or lock the account. That is why the dialog is
   * `dismissible={false}` below: reaching this has to be a deliberate press of
   * Cancel or the close button, never a stray Escape or a click that landed
   * outside.
   */
  const cancel = (): void => {
    window.opsmaxx?.ssh.replyPrompt(request.id, [])
    next()
  }

  return (
    <Modal
      title={request.name?.trim() || 'Additional authentication required'}
      subtitle={`${request.username}@${request.host}`}
      onClose={cancel}
      // In front of anything else that is open. A connection is WAITING on
      // this one, on a deadline; the vault dialog, which used to cover it, is
      // not waiting on anything.
      priority={10}
      dismissible={false}
    >
      <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div className="row" style={{ gap: 8 }}>
          <KeyRound size={16} className="faint" />
          <span className="muted" style={{ fontSize: 12 }}>
            {request.instructions?.trim() || 'The server is requesting a second authentication factor.'}
          </span>
        </div>

        {request.prompts.map((p, i) => (
          <label className="field" key={i}>
            <span className="field-label">{p.prompt.replace(/:\s*$/, '')}</span>
            <input
              ref={i === 0 ? firstField : undefined}
              className="input"
              // echo=false means the server wants it hidden (password, OTP).
              type={p.echo ? 'text' : 'password'}
              value={answers[i] ?? ''}
              onChange={(e) =>
                setAnswers((a) => {
                  const next = [...a]
                  next[i] = e.target.value
                  return next
                })
              }
              onKeyDown={(e) => {
                if (e.key === 'Enter' && i === request.prompts.length - 1) submit()
              }}
            />
          </label>
        ))}

        {canRemember && (
          <label className="row" style={{ gap: 8 }}>
            <span className={clsx('switch', remember && 'on')} onClick={() => setRemember((v) => !v)} />
            <span className="muted" style={{ fontSize: 12 }}>
              Remember this answer for {request.host} (stored in OS secure storage)
            </span>
          </label>
        )}
        {looksOneTime && (
          <span className="faint" style={{ fontSize: 11 }}>
            One-time codes change each login and are never stored.
          </span>
        )}
        {waiting > 0 && (
          <span className="field-hint">
            {waiting === 1
              ? 'One more server is waiting to be authenticated after this one.'
              : `${waiting} more servers are waiting to be authenticated after this one.`}
          </span>
        )}

        <div className="row" style={{ gap: 8 }}>
          <span className="spacer" />
          <button className="btn sm" onClick={cancel}>
            Cancel
          </button>
          <button className="btn primary sm" onClick={submit}>
            Continue
          </button>
        </div>
      </div>
    </Modal>
  )
}
