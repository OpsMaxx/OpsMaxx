import { useState } from 'react'
import { AlertTriangle, Check, Copy, KeyRound, Loader2, Server } from 'lucide-react'
import { useApp } from '../../store/app'
import { clsx } from '../../lib/format'
import { toast } from '../../store/toast'
import { PairingPanel } from './PairingPanel'

/**
 * Getting onto a relay for the first time.
 *
 * Three steps, and the middle one is the only irreversible thing in the
 * product: the recovery phrase is shown ONCE, by a sidecar that has no call to
 * show it again. So it gets its own screen, it cannot be skipped by clicking
 * past, and the button that dismisses it says what it means rather than "OK".
 */
export function AddySetup(): React.JSX.Element {
  const relayURL = useApp((s) => s.settings.addyRelayURL ?? '')
  const setSettings = useApp((s) => s.setSettings)

  const [url, setUrl] = useState(relayURL)
  const [invite, setInvite] = useState('')
  const [label, setLabel] = useState(defaultLabel())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [phrase, setPhrase] = useState<string | null>(null)
  const [wroteItDown, setWroteItDown] = useState(false)
  const [done, setDone] = useState(false)
  /** Recovering rather than creating. A mode, not a second screen: the relay
   *  address and the device name are the same two questions either way, and
   *  asking them twice in two places is how they get answered differently. */
  const [mode, setMode] = useState<'create' | 'recover'>('create')
  const [mnemonic, setMnemonic] = useState('')
  const [recovered, setRecovered] = useState<{ devices: number } | null>(null)

  const create = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const result = await window.opsmaxx!.addy.createAccount(url.trim(), invite.trim(), label.trim())
      setSettings({ addyRelayURL: url.trim() })
      setPhrase(result.mnemonic)
      toast('Account created')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  /**
   * Back in with the twelve words.
   *
   * Ends on a REVIEW rather than on a success message, and that is the whole
   * difference between this and pairing. Whoever else has read the card is on
   * the roster too, and the moment a person is most able to notice a device
   * they do not recognise is the moment they have just listed them all. So the
   * last thing recovery says is a count and a question, not "done".
   */
  const recover = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const result = await window.opsmaxx!.addy.recover(url.trim(), mnemonic.trim(), label.trim())
      setSettings({ addyRelayURL: url.trim() })
      setRecovered({ devices: result.devices })
      toast('This device is back on the account', 'ok')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  if (recovered) {
    return (
      <div className="addy-setup">
        <h3>You are back in</h3>
        <div className="setting-desc">
          Your data is being brought back onto this machine now. It is on the account as{' '}
          <strong>{label.trim()}</strong>.
        </div>
        {/* THE REVIEW, and it is not a formality. Anyone who read the card can
            do exactly what was just done, so the device list is the only place
            that would show it — and this is the one moment a person has just
            been given a reason to read it. */}
        <div className="addy-note" role="status">
          <AlertTriangle size={15} aria-hidden />
          <div>
            <strong>
              Check the device list: {recovered.devices}{' '}
              {recovered.devices === 1 ? 'device is' : 'devices are'} on this account.
            </strong>
            <div className="setting-desc">
              Anyone who has read your recovery phrase could have added one the same way you just
              did. Remove anything you do not recognise — and if the phrase has been seen by
              somebody else, treat every device on the list as theirs too.
            </div>
          </div>
        </div>
      </div>
    )
  }

  // Step 2: the phrase. Nothing else is on screen, because anything else is
  // something to look at instead.
  if (phrase && !done) {
    return (
      <div className="addy-setup">
        <h3>Write this down before you go on</h3>
        <div className="setting-desc">
          These twelve words are the only way back into this account if you lose every device on
          it. OpsMaxx cannot show them to you again — not because it will not, but because nothing
          on this machine keeps a copy.
        </div>
        <ol className="addy-phrase">
          {phrase.split(/\s+/).map((word, i) => (
            <li key={i}>
              <span className="addy-phrase-n">{i + 1}</span>
              {word}
            </li>
          ))}
        </ol>
        <button
          className="btn"
          onClick={() => {
            void navigator.clipboard.writeText(phrase)
            toast('Copied — paste it somewhere safe, then clear your clipboard')
          }}
        >
          <Copy size={14} /> Copy
        </button>
        <label className="addy-confirm">
          <input
            type="checkbox"
            checked={wroteItDown}
            onChange={(e) => setWroteItDown(e.target.checked)}
          />
          <span>I have written these down somewhere that is not this computer</span>
        </label>
        {/* Disabled until they say so. Not a nag: this is the one screen in the
            product where clicking past it loses something that cannot be
            recovered. */}
        <button className="btn" disabled={!wroteItDown} onClick={() => setDone(true)}>
          <Check size={14} /> Done — I have them
        </button>
      </div>
    )
  }

  if (done) {
    return (
      <div className="addy-setup">
        <div className="setting-desc">
          This device is on the account. Add another by pairing them — both have to be open at the
          same time.
        </div>
        <PairingPanel baseURL={url.trim()} />
      </div>
    )
  }

  return (
    <div className="addy-setup">
      <div className="setting-desc">
        addy is a relay you run yourself. It carries your data between your devices and cannot read
        any of it — every object is sealed before it leaves, and the server holds no key.
      </div>

      <label className="addy-field">
        <span>Relay address</span>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://relay.example"
          spellCheck={false}
        />
      </label>

      {/* One control, two flows. A separate "recover" screen would ask the
          relay address and the device name a second time, in a second place,
          which is how the two get answered differently. */}
      <div className="addy-mode">
        <button
          className={clsx('btn ghost size-24', mode === 'create' && 'on')}
          aria-pressed={mode === 'create'}
          onClick={() => {
            setMode('create')
            setError(null)
          }}
        >
          Create an account
        </button>
        <button
          className={clsx('btn ghost size-24', mode === 'recover' && 'on')}
          aria-pressed={mode === 'recover'}
          onClick={() => {
            setMode('recover')
            setError(null)
          }}
        >
          I have a recovery phrase
        </button>
      </div>

      {mode === 'recover' && (
        <label className="addy-field">
          <span>Recovery phrase</span>
          <textarea
            className="addy-phrase-input"
            value={mnemonic}
            onChange={(e) => setMnemonic(e.target.value)}
            spellCheck={false}
            rows={3}
            placeholder="The twelve words, in order, separated by spaces"
          />
          <small>
            Case and extra spaces do not matter. This is the only way back into an account whose
            devices are all gone — it does not create a new one, and it does not need an invite.
          </small>
        </label>
      )}

      {mode === 'create' && (
      <label className="addy-field">
        <span>Invite</span>
        <input value={invite} onChange={(e) => setInvite(e.target.value)} spellCheck={false} />
        {/* Said plainly, because somebody reading this has no reason to know
            where an invite comes from. */}
        <small>
          The person running the relay mints one with <code>addy invite</code>. It works once.
        </small>
      </label>
      )}

      <label className="addy-field">
        <span>What to call this device</span>
        <input value={label} onChange={(e) => setLabel(e.target.value)} spellCheck={false} />
        <small>Shown in the device list on every device of this account.</small>
      </label>

      {error && (
        <div className="addy-problem" role="alert">
          <AlertTriangle size={15} aria-hidden />
          <span>{error}</span>
        </div>
      )}

      {mode === 'create' ? (
        <button
          className="btn"
          disabled={busy || !url.trim() || !invite.trim() || !label.trim()}
          onClick={() => void create()}
        >
          {busy ? <Loader2 size={14} className="spin" /> : <Server size={14} />}
          {busy ? ' Creating…' : ' Create an account on this relay'}
        </button>
      ) : (
        <button
          className="btn"
          // Twelve words, and the count is checked here rather than by the
          // sidecar refusing: somebody who pasted eleven should be told that,
          // not told their phrase is invalid.
          disabled={busy || !url.trim() || !label.trim() || mnemonic.trim().split(/\s+/).length !== 12}
          onClick={() => void recover()}
        >
          {busy ? <Loader2 size={14} className="spin" /> : <KeyRound size={14} />}
          {busy ? ' Getting you back in…' : ' Recover this account'}
        </button>
      )}
    </div>
  )
}

/** A first guess at the device name, so the field is not empty. The hostname
 *  is what the user already calls this machine. */
function defaultLabel(): string {
  const guess = (globalThis as { location?: Location }).location?.hostname
  return guess && guess !== 'localhost' ? guess : 'this device'
}
