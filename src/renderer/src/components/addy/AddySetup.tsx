import { useEffect, useState } from 'react'
import { AlertTriangle, Check, Copy, KeyRound, Loader2, Server } from 'lucide-react'
import { useApp } from '../../store/app'
import { clsx } from '../../lib/format'
import { toast } from '../../store/toast'
import { PairingPanel } from './PairingPanel'
import { useAddyStatus } from './addyStatus'

/**
 * Getting onto a relay for the first time.
 *
 * Three steps, and the middle one is the only irreversible thing in the
 * product: the recovery phrase is shown ONCE, by a sidecar that has no call to
 * show it again. So it gets its own screen, it cannot be skipped by clicking
 * past, and the button that dismisses it says what it means rather than "OK".
 */
/**
 * THE MOUNT GUARD LIVES HERE, and moving it here fixed a way to lose an
 * account for ever.
 *
 * It used to live at the call site: the panel rendered this only while the
 * journey's first step was not `done`, to avoid offering to mint a second
 * account next to an account that exists. Correct intent, fatal placement.
 *
 * `createAccount` logs in before it returns, logging in starts the sync
 * engine, and the engine's first act is to push a status saying `enrolled:
 * true`. That push crosses IPC while the renderer is still awaiting the very
 * call that will hand back the twelve words — so the slot unmounted, this
 * component's state went with it, and the phrase either never rendered or
 * vanished while somebody was copying it onto paper. Nothing else on the
 * machine keeps it. The account was unrecoverable from the moment it was made.
 *
 * So the guard is a prop and the decision is made in here, where the flow
 * knows whether it is finished. `enrolled` closes the door only when nothing
 * is in progress.
 */
export function AddySetup(): React.JSX.Element | null {
  // Read here rather than taken as a prop, so BOTH call sites — the panel and
  // the Security page in Settings — get the same guard without either having
  // to remember to pass it. The Settings one had no guard at all, which made
  // it a second door to minting an account on a machine that already has one,
  // and `createAccount` overwrites the enrolment, so that silently took the
  // device off the first account.
  const { status } = useAddyStatus()
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
  /**
   * WHICH OF THE THREE THINGS THIS MACHINE IS, and it starts as none of them.
   *
   * It used to start on `create`, which put an invite field on the screen of
   * every machine that had no account — including the second one, which must
   * never be given an invite. An invite does not add a device: it starts a
   * separate sync group with its own key that cannot see the first, and the
   * relay refuses a second one now anyway. Somebody who owns this product
   * asked how to mint an invite for their second machine, which is what a
   * default-selected invite field asks them to do.
   *
   * So nothing is selected until the fork has been read. A mode rather than
   * three screens, because the relay address is the same question in all
   * three and asking it in three places is how it gets answered differently.
   */
  const [mode, setMode] = useState<'create' | 'join' | 'recover' | null>(null)

  /**
   * A link the OS handed us, which is how a second machine learns the relay's
   * address without anybody reading it aloud.
   *
   * THE ADDRESS IS THE STEP THAT BLOCKS PEOPLE. This screen will not go on
   * until the relay is filled in, and nothing on a fresh machine knows it —
   * so the console can hand over a link carrying just that. It is not a
   * credential; it is in the browser's URL bar on the other machine.
   *
   * It FILLS FIELDS AND NOTHING ELSE. An invite in the link fills the invite
   * box; it is not spent. No mode is chosen for the reader either, because
   * which of the three things this machine is remains theirs to say — and
   * choosing `create` for somebody holding a second machine is the exact
   * mistake this fork exists to prevent.
   */
  useEffect(() => {
    const off = window.opsmaxx?.addy?.onLink?.((l) => {
      if (l.action !== 'sync') return
      setUrl(l.relay)
      if (l.invite !== undefined) setInvite(l.invite)
      toast(
        l.invite === undefined
          ? `Relay address filled in: ${l.relay}. Choose how this machine joins.`
          : `Invite and relay filled in from the link.`
      )
    })
    return () => off?.()
  }, [])
  const [mnemonic, setMnemonic] = useState('')

  /**
   * Where the operator console would be, if this relay serves one.
   *
   * Built from what the user typed rather than asked for, because the app
   * cannot know: a relay started without the provider flags has no console,
   * and asking would mean an unauthenticated probe on every keystroke. The
   * page itself says which of the two it is, which is the right place for
   * that answer.
   */
  const consoleURL = (() => {
    const typed = url.trim()
    if (!typed.startsWith('https://')) return ''
    try {
      return new URL('/admin', typed).toString()
    } catch {
      return ''
    }
  })()
  const [recovered, setRecovered] = useState<{ devices: number } | null>(null)

  /**
   * Nothing in flight, and this device is already on an account.
   *
   * THIS USED TO RETURN NULL, and returning null is how adding a second
   * machine became impossible. `AddySetup` is the only mount of
   * `PairingPanel` in the whole renderer, and it only reached it in the
   * `done` branch — the seconds between writing down a recovery phrase and
   * navigating away. Close that screen, or restart the app, and nothing
   * anywhere could show a pairing code again. The only thing the product
   * still offered was another invite, which is not a way to add a device: it
   * starts a second sync group with its own key that cannot see the first.
   *
   * So an enrolled machine gets the other half of pairing instead of an empty
   * space. No account is minted here, which was the whole point of the old
   * guard, and both doors — the panel and Settings — get it at once.
   *
   * Checked AFTER every hook, or this would be a conditional hook call. Every
   * clause of `midFlow` is state this component owns, which is the whole point
   * — no outside signal can close this screen while it is mid-flow.
   */
  const midFlow = busy || phrase !== null || recovered !== null
  if (status?.enrolled === true && !midFlow) {
    // The relay this device actually attached to, not what happens to be in
    // settings: a machine that joined by pairing was enrolled by the sidecar,
    // and the setting is the weaker of the two answers.
    const attached = status.relayURL ?? relayURL
    return (
      <div className="addy-setup">
        <h3>Add another device</h3>
        <div className="setting-desc">
          A second machine joins by <strong>pairing</strong> with this one. It needs no invite, and
          nothing from whoever runs the relay. Both machines have to be open at the same time:
          this one shows a code, the other types it, and you check that the same seven emoji
          appear on both.
        </div>
        {/* THE OTHER MACHINE CANNOT GUESS THE RELAY ADDRESS, and nothing else
            in the product tells it. Pairing frames go through the relay, so
            the joining device needs this before it needs anything else —
            which made "where does the address come from" the first wall a
            second machine hit, before it even got to the code. */}
        <div className="addy-handoff">
          <span>
            On the other machine, pick <strong>I already use OpsMaxx on another machine</strong>,
            and give it this relay address:
          </span>
          <div className="addy-handoff-row">
            <code>{attached || 'not recorded on this device'}</code>
            {attached && (
              <button
                className="btn"
                aria-label="Copy the relay address"
                onClick={() => {
                  void navigator.clipboard.writeText(attached)
                  toast('Relay address copied')
                }}
              >
                <Copy size={14} />
              </button>
            )}
          </div>
        </div>
        {/* Named, because the panel below offers both directions and only one
            of them is this machine's. The device holding the account is the
            one that hands the key over, so it is always the one that shows. */}
        {attached ? (
          <>
            {/* Named, because the panel below offers both directions and only
                one of them is this machine's. The device holding the account
                is the one that hands the key over, so it is always the one
                that shows. */}
            <div className="setting-desc">
              This machine is the one with the account, so it is the one that{' '}
              <strong>shows</strong> a code.
            </div>
            <PairingPanel baseURL={attached} />
          </>
        ) : (
          // Pairing frames go through the relay, so with no address there is
          // nothing to offer — and offering it anyway would start a pairing
          // against an empty URL and fail on a screen that had promised it
          // would work.
          <div className="setting-desc">
            This device is on an account but has no relay address recorded, so it cannot start a
            pairing. Open <strong>Sync now</strong> above, or set the address in Settings.
          </div>
        )}
      </div>
    )
  }

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
        <h3>Add another device</h3>
        {/* PairingPanel says the "both machines open" part itself, beside the
            two buttons it belongs to. What it cannot say is the relay
            address, which the other machine needs before it can be reached at
            all — and this is the last moment the address is certainly on
            screen. */}
        <div className="addy-handoff">
          <span>
            On the other machine, pick <strong>I already use OpsMaxx on another machine</strong>,
            and give it this relay address:
          </span>
          <div className="addy-handoff-row">
            <code>{url.trim()}</code>
            <button
              className="btn"
              aria-label="Copy the relay address"
              onClick={() => {
                void navigator.clipboard.writeText(url.trim())
                toast('Relay address copied')
              }}
            >
              <Copy size={14} />
            </button>
          </div>
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

      {/* THE FORK, FIRST AND BEFORE ANY FIELD.
          The question a person arrives with is "how do I get my stuff onto
          this machine", and the product used to answer it with a form whose
          first field was an invite. That is the right answer for exactly one
          machine — the first — and the wrong one for every machine after it,
          which is most of them. So the fork is the screen until it is
          answered, and joining an account you already have sits level with
          creating one rather than behind it. */}
      <div className="addy-fork" role="group" aria-labelledby="addy-fork-q">
        <div className="addy-fork-q" id="addy-fork-q">
          Which of these is this machine?
        </div>
        <button
          type="button"
          className={clsx('addy-choice', mode === 'create' && 'on')}
          aria-pressed={mode === 'create'}
          onClick={() => {
            setMode('create')
            setError(null)
          }}
        >
          <strong>This is my first device</strong>
          <small>
            Nothing of mine is on this relay yet. Creates the account — the only step in the whole
            product that needs an invite.
          </small>
        </button>
        <button
          type="button"
          className={clsx('addy-choice', mode === 'join' && 'on')}
          aria-pressed={mode === 'join'}
          onClick={() => {
            setMode('join')
            setError(null)
          }}
        >
          <strong>I already use OpsMaxx on another machine</strong>
          <small>
            Joins the account that machine already has, by pairing with it. No invite, and nothing
            to ask anybody for.
          </small>
        </button>
        <button
          type="button"
          className={clsx('addy-choice', mode === 'recover' && 'on')}
          aria-pressed={mode === 'recover'}
          onClick={() => {
            setMode('recover')
            setError(null)
          }}
        >
          <strong>My other devices are gone</strong>
          <small>
            Back in with the twelve words you wrote down. This is the only way in when there is no
            other machine left to pair with.
          </small>
        </button>
      </div>

      {mode !== null && (
        <label className="addy-field">
          <span>Relay address</span>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://relay.example"
            spellCheck={false}
          />
          {/* The second machine has no way to know this, and being asked for
              it cold — with no hint that it is written down somewhere — was
              the first wall it hit. */}
          {mode === 'join' && (
            <small>
              The same address the other machine uses. It is shown there, under{' '}
              <strong>Account → Add another device</strong>, with a button to copy it.
            </small>
          )}
        </label>
      )}

      {mode === 'join' && (
        <div className="addy-steps">
          {/* IT STARTS ON THE OTHER MACHINE, and saying so is most of the
              fix. Nothing this machine can press begins a pairing: the
              device holding the account is the one that hands the key over,
              so it is the one that shows a code, always. */}
          <strong>Start on the machine you already use.</strong>
          <ol>
            <li>
              Open <strong>Account</strong> in OpsMaxx there and find <strong>Add another
              device</strong>.
            </li>
            <li>
              Choose <strong>Show a code on this device</strong>. It shows a code and a pairing id
              and keeps them on screen while it waits.
            </li>
            <li>
              Type both of them in below, then compare the seven emoji. Leave both machines open —
              the code only works while that window is.
            </li>
          </ol>
          {url.trim() ? (
            // THIS MACHINE HAS NO ACCOUNT, so it cannot be the one that shows
            // the code — `beginPairing` loads the account's keys to mint a
            // rendezvous and answers "no account is loaded" without them. The
            // button was offered on the one screen where it could only fail.
            <PairingPanel baseURL={url.trim()} canShow={false} />
          ) : (
            <div className="setting-desc">Fill in the relay address above to go on.</div>
          )}
        </div>
      )}

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
          One invite creates one account, and only the first device needs one — every machine
          after that is added by pairing, which needs nothing from the relay's operator.
        </small>
        {/* THE ANSWER TO "where do I get one", which this said nothing about.
            It named a command without saying where to run it, so somebody who
            runs their own relay — which is everybody, that is the product —
            had to already know the answer to follow the instruction. */}
        <small>
          {consoleURL ? (
            <>
              If this relay is yours, open{' '}
              <a
                href={consoleURL}
                onClick={(e) => {
                  e.preventDefault()
                  // Through the window-open handler, which vets the scheme and
                  // opens it in the user's own browser rather than in a window
                  // carrying this preload.
                  window.open(consoleURL, '_blank', 'noopener')
                }}
              >
                {consoleURL.replace(/^https:\/\//, '')}
              </a>{' '}
              and sign in to create one. Otherwise ask whoever runs it.
            </>
          ) : (
            <>Ask whoever runs the relay for one, or open its address and sign in if it is yours.</>
          )}
        </small>
      </label>
      )}

      {/* Not on the joining path. Nothing on that path carries a label: the
          joining device's name is sealed into the roster entry by the machine
          that shows the code, from what the sidecar chose, and the pairing IPC
          has no argument for it. A field here would be a question whose answer
          is thrown away. */}
      {(mode === 'create' || mode === 'recover') && (
        <label className="addy-field">
          <span>What to call this device</span>
          <input value={label} onChange={(e) => setLabel(e.target.value)} spellCheck={false} />
          <small>Shown in the device list on every device of this account.</small>
        </label>
      )}

      {error && (
        <div className="addy-problem" role="alert">
          <AlertTriangle size={15} aria-hidden />
          <span>{error}</span>
        </div>
      )}

      {mode === 'create' && (
        <button
          className="btn"
          disabled={busy || !url.trim() || !invite.trim() || !label.trim()}
          onClick={() => void create()}
        >
          {busy ? <Loader2 size={14} className="spin" /> : <Server size={14} />}
          {busy ? ' Creating…' : ' Create an account on this relay'}
        </button>
      )}
      {/* The joining path has no button of its own: `PairingPanel` above owns
          the whole exchange, and the only thing that finishes it is comparing
          the emoji. */}
      {mode === 'recover' && (
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
