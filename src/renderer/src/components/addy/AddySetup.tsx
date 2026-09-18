import { useState } from 'react'
import { AlertTriangle, Check, Copy, Loader2, Server } from 'lucide-react'
import { useApp } from '../../store/app'
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

      <label className="addy-field">
        <span>Invite</span>
        <input value={invite} onChange={(e) => setInvite(e.target.value)} spellCheck={false} />
        {/* Said plainly, because somebody reading this has no reason to know
            where an invite comes from. */}
        <small>
          The person running the relay mints one with <code>addy invite</code>. It works once.
        </small>
      </label>

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

      <button
        className="btn"
        disabled={busy || !url.trim() || !invite.trim() || !label.trim()}
        onClick={() => void create()}
      >
        {busy ? <Loader2 size={14} className="spin" /> : <Server size={14} />}
        {busy ? ' Creating…' : ' Create an account on this relay'}
      </button>
    </div>
  )
}

/** A first guess at the device name, so the field is not empty. The hostname
 *  is what the user already calls this machine. */
function defaultLabel(): string {
  const guess = (globalThis as { location?: Location }).location?.hostname
  return guess && guess !== 'localhost' ? guess : 'this device'
}
