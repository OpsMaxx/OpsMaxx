import { useEffect, useRef, useState } from 'react'
import { addyPairLink } from '../../../../shared/addyLink'
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

/**
 * `canShow` — whether this machine is able to BE the one holding the code.
 *
 * `beginPairing` loads the account's keys to mint a rendezvous, so a machine
 * with no account cannot do it and answers "no account is loaded". The button
 * was offered anyway, on the one screen where it is guaranteed to fail: the
 * setup screen of a machine that has nothing. Both halves of the exchange were
 * on offer and only one of them could ever work.
 */
/**
 * The two halves of a pairing, as one thing a person carries.
 *
 * The id addresses the mailbox and the code proves who may open it, so both
 * have to cross — but that is the protocol's concern. Two labelled fields meant
 * two chances to transpose a character and a decision about which box each went
 * in, on a screen where the other machine is waiting and the code expires with
 * the window.
 *
 * Joined by a dot, which appears in neither half: both are base64url, whose
 * alphabet is A-Z a-z 0-9 - _ and nothing else. Split on the LAST dot so a
 * future code containing one still parses.
 *
 * Tolerant on the way in, because this arrives via a chat window, a phone
 * camera or a person reading it aloud: surrounding whitespace, a wrapped
 * newline in the middle, and the old two-line form all resolve to the same
 * pair.
 */
export function splitTicket(raw: string): { code: string; pairingId: string } | null {
  const cleaned = raw.trim().replace(/\s+/g, cleanedSeparator)
  const at = cleaned.lastIndexOf('.')
  if (at <= 0 || at === cleaned.length - 1) return null
  const code = cleaned.slice(0, at)
  const pairingId = cleaned.slice(at + 1)
  if (!/^[A-Za-z0-9_-]{4,}$/.test(code) || !/^[A-Za-z0-9_-]{4,}$/.test(pairingId)) return null
  return { code, pairingId }
}

// A newline between the halves is the shape the previous version copied, and
// the shape a chat client produces when it wraps. It means the same thing.
const cleanedSeparator = '.'

export function PairingPanel({
  baseURL,
  canShow = true
}: {
  baseURL: string
  canShow?: boolean
}): React.JSX.Element {
  const [stage, setStage] = useState<Stage>('choose')
  const [code, setCode] = useState('')
  const [pairingId, setPairingId] = useState('')
  const [typedTicket, setTypedTicket] = useState('')
  // What the machine being added will be called, permanently.
  const [newLabel, setNewLabel] = useState('')
  // One string, split again by `splitTicket` on the other machine.
  const ticket = `${code}.${pairingId}`
  const pairLink = addyPairLink(baseURL, code, pairingId)
  const [confirmation, setConfirmation] = useState<AddyPairingConfirmation | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The handoff is a round trip to the relay, so "They match" is not instant.
  // Without this the obvious thing to do while nothing happens is press it
  // again, and a second handoff against a session the first one consumed is a
  // failure on a pairing that actually worked.
  const [busy, setBusy] = useState(false)
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

  /** Back to the start, with nothing left over from the last exchange. A
   *  stale code in a field is a code somebody will try to use. */
  const reset = (): void => {
    setTypedTicket('')
    setNewLabel('')
    setConfirmation(null)
    setError(null)
    setStage('choose')
  }

  /**
   * A pairing link that arrived from the OS.
   *
   * THE HANDLER WAS WIRED FROM THE SCHEME TO THE RENDERER AND NO FURTHER.
   * `opsmaxx://` was registered, parsed, bounds-checked and tested, and
   * nothing on this side ever subscribed — so a person who clicked a link
   * watched the app come to the front and do nothing, which is worse than
   * having no link at all.
   *
   * It FILLS THE FIELD. It does not join. The person still presses Join and
   * still compares the seven emoji, because a link that joined on arrival
   * would be a link anybody could send you.
   */
  useEffect(() => {
    const off = window.opsmaxx?.addy?.onLink?.((l) => {
      if (l.action !== 'pair' || l.code === undefined || l.pairingId === undefined) return
      setTypedTicket(`${l.code}.${l.pairingId}`)
      setError(null)
      setStage('joining')
      toast('Pairing code filled in from the link. Check the emoji before you confirm.')
    })
    const offBad = window.opsmaxx?.addy?.onLinkRefused?.((reason) => {
      setError(reason)
      setStage('failed')
    })
    return () => {
      off?.()
      offBad?.()
    }
  }, [])

  const join = async (): Promise<void> => {
    setError(null)
    setStage('joining')
    try {
      active.current = true
      const parts = splitTicket(typedTicket)
      if (parts === null) {
        setError('That does not look like a pairing code. Copy the whole thing from the other device.')
        setStage('failed')
        return
      }
      const confirmed = await window.opsmaxx!.addy.joinPairing(baseURL, parts.code, parts.pairingId)
      setConfirmation(confirmed)
      setStage('compare')
    } catch (err) {
      fail(err)
    }
  }

  /**
   * "They match" — and it now does what it says.
   *
   * This used to call `cancelPairing()` and toast "Device added". Nothing was
   * added: no account key crossed, no roster entry was written, and the
   * account went on containing exactly one device. The emoji matched and the
   * app asserted something untrue about the user's data, which is worse than
   * any missing feature.
   *
   * `active.current` is cleared only once the work is done, not before it —
   * the pairing session holds the shared secret the handoff is bound to, and
   * forgetting it first would leave nothing to bind to.
   */
  const accept = async (): Promise<void> => {
    if (!confirmation) return
    setBusy(true)
    try {
      const joining = !!confirmation.self
      if (joining) {
        // This device typed the code: take the key, store it, attach.
        await window.opsmaxx!.addy.finishJoin()
      } else {
        // This device showed the code: hand the key over, add them to the
        // roster.
        await window.opsmaxx!.addy.completePairing(confirmation, newLabel)
      }
      active.current = false
      setStage('done')
      toast(joining ? 'This device joined the account' : 'Device added to your account', 'ok')
    } catch (err) {
      // Said plainly and left on this screen. A failure here means the two
      // devices agreed and the account does not know it, which is exactly the
      // state the old toast concealed.
      fail(err)
    } finally {
      setBusy(false)
    }
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
        {/* NAMED HERE BECAUSE IT CANNOT BE NAMED LATER. The label is sealed
            into the roster entry that adds the device, and roster entries are
            immutable — this instant is the only chance. Shown only to the
            machine doing the adding: the joiner does not write the entry.

            Empty is allowed. The fallback is the first bytes of that device's
            own signing key, which is unique; what it must never be again is a
            constant, because two rows reading "a paired device" is two rows
            with the same name and one of them has a button that wipes a
            laptop. */}
        {!confirmation.self && (
          <label className="pair-field">
            <span>What is the other machine called?</span>
            <input
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              spellCheck={false}
              maxLength={60}
              placeholder="Work laptop"
            />
          </label>
        )}
        <div className="pair-actions">
          {/* Refuse first and focused: the expensive mistake is confirming a
              pairing that is not the one you think it is, and it is not
              reversible. */}
          <button className="btn" autoFocus disabled={busy} onClick={reject}>
            <X size={14} /> They do not match
          </button>
          <button className="btn" disabled={busy} onClick={() => void accept()}>
            {busy ? <Loader2 size={14} className="spin" /> : <Check size={14} />}
            {busy ? ' Adding the device…' : ' They match'}
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
            {canShow
              ? 'Adding a device needs both devices open at the same time. One shows a code, the other types it, and you compare seven emoji.'
              : 'This machine has no account yet, so it is the one that TYPES the code. Start on the machine you already use: open Account there, choose Add another device, and it will show you a code and a pairing id.'}
          </div>
          <div className="pair-actions">
            {canShow && (
              <button className="btn" onClick={() => void start()}>
                <Smartphone size={14} /> Show a code on this device
              </button>
            )}
            <button className={canShow ? 'btn' : 'btn primary'} onClick={() => setStage('joining')}>
              Type a code from another device
            </button>
          </div>
        </>
      )}

      {stage === 'showing' && (
        <>
          <div className="setting-label">Type this on the other device</div>
          {/* ONE THING TO CARRY, NOT TWO.
              The id addresses the mailbox and the code proves who may open it,
              so both have to cross — but that is the protocol's business, not
              the reader's. Two fields meant two chances to transpose a
              character and a person checking which box each one went in. They
              travel as one ticket and are split on arrival. */}
          <div className="pair-code">
            <code>{ticket}</code>
            <button
              className="btn"
              aria-label="Copy the pairing code"
              onClick={() => {
                void navigator.clipboard.writeText(ticket)
                toast('Pairing code copied')
              }}
            >
              <Copy size={14} />
            </button>
          </div>
          {/* THE LINK NOBODY WAS EMITTING. `opsmaxx://` was registered, parsed
              and tested, and the only thing that ever produced one was the
              relay console's invite — so a person told "use the link" while
              PAIRING had nothing to use. It carries the relay address too,
              which is the other thing the second machine does not know.
              It fills the form on arrival; it never joins by itself. */}
          <p className="fine">
            Or send this link to the other machine — it fills both in:
          </p>
          <div className="pair-code">
            <code className="pair-link">{pairLink}</code>
            <button
              className="btn"
              aria-label="Copy the pairing link"
              onClick={() => {
                void navigator.clipboard.writeText(pairLink)
                toast('Pairing link copied')
              }}
            >
              <Copy size={14} />
            </button>
          </div>
          <p className="fine">
            <Loader2 size={13} className="spin" /> Waiting for the other device. This code only works
            while this window is open.
          </p>
        </>
      )}

      {stage === 'joining' && (
        <>
          <label className="pair-field">
            <span>Pairing code from the other device</span>
            <input
              value={typedTicket}
              onChange={(e) => setTypedTicket(e.target.value)}
              spellCheck={false}
              autoFocus
              placeholder="Paste it here"
            />
          </label>
          <button className="btn" disabled={splitTicket(typedTicket) === null} onClick={() => void join()}>
            Join
          </button>
        </>
      )}

      {stage === 'done' && (
        <>
          <div className="setting-desc">This device is now on the account.</div>
          {/* A TERMINAL STATE WITH NO WAY BACK MEANT NO THIRD DEVICE. After a
              successful pairing the panel sat here, and the only route to
              another one was restarting the app — on the very screen whose job
              is adding machines. Pairing is not a thing you do once. */}
          <button className="btn" onClick={() => reset()}>
            Pair another device
          </button>
        </>
      )}

      {stage === 'failed' && error && (
        <div className="pair-problem" role="alert">
          <AlertTriangle size={15} aria-hidden />
          <div>
            <span>{error}</span>
            <button className="btn" onClick={() => reset()}>
              Start again
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
