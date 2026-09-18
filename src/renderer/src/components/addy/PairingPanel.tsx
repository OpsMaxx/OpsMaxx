import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Check, Copy, Loader2, Smartphone, X } from 'lucide-react'
import { toast } from '../../store/toast'
import type { AddyPairingConfirmation } from '../../../../shared/addy'

/**
 * Adding a device to an account.
 *
 * TWO SCREENS AND ONE COMPARISON. The device that starts shows a code; the
 * device that joins types it; both then show seven emoji, and a person checks
 * they match. That check is the whole security of pairing -- everything else is
 * plumbing -- so it gets the whole screen when it arrives, and the answer is
 * two buttons rather than a dismissible notice.
 *
 * The emoji appear only after each device has proved to the other that it knows
 * the code. A list shown before that would be a list an attacker can influence,
 * and two matching lists would then be confirming the attacker's session.
 */

type Stage = 'choose' | 'showing' | 'joining' | 'compare' | 'done' | 'failed'

export function PairingPanel({ baseURL }: { baseURL: string }): React.JSX.Element {
  const [stage, setStage] = useState<Stage>('choose')
  const [code, setCode] = useState('')
  const [pairingId, setPairingId] = useState('')
  const [typedCode, setTypedCode] = useState('')
  const [typedId, setTypedId] = useState('')
  const [confirmation, setConfirmation] = useState<AddyPairingConfirmation | null>(null)
  const [error, setError] = useState<string | null>(null)
  const active = useRef(false)

  // Cancelling on unmount is not tidiness: a pairing left in the sidecar is a
  // session an attacker can still send frames to, and the sidecar's map is the
  // only thing holding the shared secret.
  useEffect(() => {
    return () => {
      if (active.current) void window.opsmaxx?.addy.cancelPairing()
    }
  }, [])

  const fail = (err: unknown): void => {
    active.current = false
    setError(err instanceof Error ? err.message : String(err))
    setStage('failed')
  }

  const start = async (): Promise<void> => {
    setError(null)
    try {
      const handle = await window.opsmaxx!.addy.beginPairing(baseURL)
      active.current = true
      setCode(handle.code)
      setPairingId(handle.pairingId)
      setStage('showing')

      // Resolves when the other device answers, which may be a minute away.
      // The code is already on screen by then, which is the point of the
      // split.
      const confirmed = await window.opsmaxx!.addy.awaitPairing()
      setConfirmation(confirmed)
      setStage('compare')
    } catch (err) {
      fail(err)
    }
  }

  const join = async (): Promise<void> => {
    setError(null)
    setStage('joining')
    try {
      active.current = true
      const confirmed = await window.opsmaxx!.addy.joinPairing(baseURL, typedCode, typedId)
      setConfirmation(confirmed)
      setStage('compare')
    } catch (err) {
      fail(err)
    }
  }

  const accept = (): void => {
    active.current = false
    void window.opsmaxx?.addy.cancelPairing()
    setStage('done')
    toast('Device added')
  }

  const reject = (): void => {
    active.current = false
    // The same call as an ordinary completion: forgetting the session IS the
    // remedy, because the session is what holds the shared secret.
    void window.opsmaxx?.addy.cancelPairing()
    setError(
      'Pairing stopped. If the emoji did not match, something was between the two devices — try ' +
        'again on a network you trust, and compare them in person if you can.'
    )
    setStage('failed')
  }

  if (stage === 'compare' && confirmation) {
    return (
      <div className="pair-compare">
        <h3>Do these match on both devices?</h3>
        <div className="pair-emoji" aria-label={confirmation.sasWords}>
          {confirmation.sas.map((e, i) => (
            <span key={i}>{e}</span>
          ))}
        </div>
        {/* The words, because a phone call works as well as a photograph and
            some of these emoji render differently on different platforms. */}
        <p className="pair-words">{confirmation.sasWords}</p>
        <p className="fine">
          Compare them with the other device before answering. If they differ, something is between
          you.
        </p>
        <div className="pair-actions">
          {/* Refuse first and focused: the expensive mistake is confirming a
              pairing that is not the one you think it is, and it is not
              reversible. */}
          <button className="btn" autoFocus onClick={reject}>
            <X size={14} /> They do not match
          </button>
          <button className="btn" onClick={accept}>
            <Check size={14} /> They match
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="pair-panel">
      {stage === 'choose' && (
        <>
          <div className="setting-desc">
            Adding a device needs both devices open at the same time. One shows a code, the other
            types it, and you compare seven emoji.
          </div>
          <div className="pair-actions">
            <button className="btn" onClick={() => void start()}>
              <Smartphone size={14} /> Show a code on this device
            </button>
            <button className="btn" onClick={() => setStage('joining')}>
              Type a code from another device
            </button>
          </div>
        </>
      )}

      {stage === 'showing' && (
        <>
          <div className="setting-label">Type this on the other device</div>
          <div className="pair-code">
            <code>{code}</code>
            <button
              className="btn"
              aria-label="Copy"
              onClick={() => {
                void navigator.clipboard.writeText(`${code}\n${pairingId}`)
                toast('Copied')
              }}
            >
              <Copy size={14} />
            </button>
          </div>
          <div className="setting-label">and this pairing id</div>
          <div className="pair-code">
            <code>{pairingId}</code>
          </div>
          {/* Both halves, because the id is what addresses the mailbox the
              code's first frame is waiting in. A code on its own is useless,
              which is also why one overheard this morning cannot be redeemed
              this afternoon. */}
          <p className="fine">
            <Loader2 size={13} className="spin" /> Waiting for the other device. This code only works
            while this window is open.
          </p>
        </>
      )}

      {stage === 'joining' && (
        <>
          <label className="pair-field">
            <span>Code</span>
            <input value={typedCode} onChange={(e) => setTypedCode(e.target.value)} spellCheck={false} />
          </label>
          <label className="pair-field">
            <span>Pairing id</span>
            <input value={typedId} onChange={(e) => setTypedId(e.target.value)} spellCheck={false} />
          </label>
          <button className="btn" disabled={!typedCode || !typedId} onClick={() => void join()}>
            Join
          </button>
        </>
      )}

      {stage === 'done' && <div className="setting-desc">This device is now on the account.</div>}

      {stage === 'failed' && error && (
        <div className="pair-problem" role="alert">
          <AlertTriangle size={15} aria-hidden />
          <div>
            <span>{error}</span>
            <button className="btn" onClick={() => setStage('choose')}>
              Start again
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
