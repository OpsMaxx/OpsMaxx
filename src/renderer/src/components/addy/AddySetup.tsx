import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Check, Copy, KeyRound, Loader2, Server, X } from 'lucide-react'
import { useApp } from '../../store/app'
import { clsx } from '../../lib/format'
import { toast } from '../../store/toast'
import { errorText } from '../../lib/connectionError'
import { clearLink, forgetPhrase, holdPhrase, useAddyUi } from '../../store/addy'
import { PairingPanel } from './PairingPanel'
import { useAddyStatus } from './addyStatus'
import type { AddyRecoveryReview } from '../../../../shared/addy'
import { t as tr, useT } from '../../lib/i18n'
import { Trans } from '../../lib/Trans'

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
  const t = useT()
  const { status, supported, error: statusError } = useAddyStatus()
  const relayURL = useApp((s) => s.settings.addyRelayURL ?? '')
  const setSettings = useApp((s) => s.setSettings)

  const [url, setUrl] = useState(relayURL)
  const [invite, setInvite] = useState('')
  // Empty until the hostname arrives, and left empty if it does not: the
  // Create button waits for a name, which is better than the constant "this
  // device" that every first device used to be called for ever.
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // In a store, not here: see store/addy.ts for how it used to be lost.
  const phrase = useAddyUi((s) => s.phrase)
  const checkWords = useAddyUi((s) => s.checkWords)
  /** On the phrase screen: false while the words are shown, true while the
   *  user types some of them back with the list hidden. */
  const [checking, setChecking] = useState(false)
  const [typedWords, setTypedWords] = useState<Record<number, string>>({})
  /** Words the user has moved on from, so a half-typed one is not called wrong. */
  const [leftWords, setLeftWords] = useState<number[]>([])
  /**
   * The join-mode pairing panel is mid-exchange, so this screen must not swap
   * it out.
   *
   * `finishJoin` enrols the device and the engine pushes `enrolled: true`
   * BEFORE the call returns — the same race the phrase had. The enrolled
   * branch below then replaced this screen, unmounting the panel, whose
   * cleanup cancelled the pairing and whose error, if the join failed after
   * that point, had nowhere left to appear. Held until the panel has settled
   * and the person has read the outcome.
   */
  const [joinHeld, setJoinHeld] = useState(false)
  /** A pairing code from a link, for the join panel to fill in. */
  const [linkTicket, setLinkTicket] = useState<string | undefined>(undefined)

  useEffect(() => {
    void window.opsmaxx?.hostname?.().then(
      (h) => {
        // macOS reports "Somebodys-MacBook-Pro.local"; the suffix is the
        // network's, not the machine's.
        const name = h.replace(/\.local$/i, '').trim()
        if (name) setLabel((l) => (l === '' ? name : l))
      },
      () => undefined
    )
  }, [])
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
   * box; it is not spent. A `sync` link chooses no mode for the reader,
   * because which of the three things this machine is remains theirs to say —
   * and choosing `create` for somebody holding a second machine is the exact
   * mistake this fork exists to prevent.
   *
   * A `pair` link is the exception, because it has already answered that
   * question: only a machine joining an existing account is sent a pairing
   * code. It used to be honoured only after the reader had picked "join" and
   * typed the relay, which on a fresh machine is everything the link was for.
   * Now it opens the join path with both filled in. It still never joins: the
   * person presses Join and compares the emoji.
   *
   * Taken from the store atomically, so one link fills one screen — and NOT
   * before this device's status is known. On first mount `status` is null,
   * which read as "not on an account": a pair link on an enrolled machine
   * filled the join form, said "press Join", and then the screen flipped to
   * the enrolled view underneath the person reading it.
   */
  const pendingLink = useAddyUi((s) => s.link)
  const statusKnown = !supported || status !== null || statusError !== null
  useEffect(() => {
    if (!statusKnown) return
    const l = useAddyUi.getState().link
    if (!l) return
    clearLink()
    if (status?.enrolled === true) {
      toast(
        l.action === 'pair'
          ? t('addy.setup.linkPairOnEnrolled')
          : t('addy.setup.linkSyncOnEnrolled'),
        'error'
      )
      return
    }
    if (l.action === 'sync') {
      setUrl(l.relay)
      if (l.invite !== undefined) setInvite(l.invite)
      toast(
        l.invite === undefined
          ? t('addy.setup.linkRelayFilled', { relay: l.relay })
          : t('addy.setup.linkInviteFilled')
      )
      return
    }
    if (l.code === undefined || l.pairingId === undefined) return
    setUrl(l.relay)
    setMode('join')
    setLinkTicket(`${l.code}.${l.pairingId}`)
    toast(t('addy.setup.linkPairFilled'))
  }, [pendingLink, statusKnown, status?.enrolled, t])
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
  /** What recovery found, held for the person to check before anything is
   *  written. Main is holding the keys meanwhile; leaving this screen any way
   *  other than the two buttons tells it to drop them. */
  const [review, setReview] = useState<AddyRecoveryReview | null>(null)
  const reviewing = useRef(false)
  useEffect(
    () => () => {
      if (reviewing.current) void window.opsmaxx?.addy.cancelRecovery()
    },
    []
  )

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
  const midFlow = busy || phrase !== null || recovered !== null || review !== null || joinHeld
  if (status?.enrolled === true && !midFlow) {
    // The relay this device actually attached to, not what happens to be in
    // settings: a machine that joined by pairing was enrolled by the sidecar,
    // and the setting is the weaker of the two answers.
    const attached = status.relayURL ?? relayURL
    return (
      <div className="addy-setup">
        <h3>{t('addy.setup.addAnother')}</h3>
        <div className="setting-desc">
          <Trans i18nKey="addy.setup.addAnotherDesc" components={{ strong: <strong /> }} />
        </div>
        {/* THE OTHER MACHINE CANNOT GUESS THE RELAY ADDRESS, and nothing else
            in the product tells it. Pairing frames go through the relay, so
            the joining device needs this before it needs anything else —
            which made "where does the address come from" the first wall a
            second machine hit, before it even got to the code. */}
        <div className="addy-handoff">
          <span>
            <Trans i18nKey="addy.setup.handoff" components={{ strong: <strong /> }} />
          </span>
          <div className="addy-handoff-row">
            <code>{attached || t('addy.setup.relayNotRecorded')}</code>
            {attached && (
              <button
                className="btn"
                aria-label={t('addy.setup.copyRelay')}
                onClick={() => {
                  void navigator.clipboard.writeText(attached)
                  toast(t('addy.setup.relayCopied'))
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
              <Trans i18nKey="addy.setup.thisShows" components={{ strong: <strong /> }} />
            </div>
            <PairingPanel baseURL={attached} />
          </>
        ) : (
          // Pairing frames go through the relay, so with no address there is
          // nothing to offer — and offering it anyway would start a pairing
          // against an empty URL and fail on a screen that had promised it
          // would work.
          // There is no setting that holds the address: it is recorded when
          // the device joins. So the honest remedy is the other devices, any
          // of which can show a code.
          <div className="setting-desc">{t('addy.setup.noRelay')}</div>
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
      holdPhrase(result.mnemonic)
      setChecking(false)
      setTypedWords({})
      toast(t('addy.setup.created'))
    } catch (err) {
      setError(errorText(err))
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
   *
   * AND THE FIRST REVIEW COMES BEFORE ANYTHING IS WRITTEN. A relay can serve
   * an old escrow and a device list cut back to before a removal, and
   * everything this machine can check passes. The words are the check it
   * cannot do: they come from the device list it was served, and another of
   * the person's devices shows the same words only if it has the same list.
   */
  const recover = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const found = await window.opsmaxx!.addy.recover(url.trim(), mnemonic.trim(), label.trim())
      reviewing.current = true
      setReview(found)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const confirmRecovery = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    // Spent either way: main drops what it held on a failure too, so a retry
    // starts from the phrase rather than from a half-written recovery.
    reviewing.current = false
    try {
      const result = await window.opsmaxx!.addy.confirmRecovery()
      setSettings({ addyRelayURL: url.trim() })
      setRecovered({ devices: result.devices })
      toast(t('addy.setup.backOn'), 'ok')
    } catch (err) {
      setError(errorText(err))
    } finally {
      setReview(null)
      setBusy(false)
    }
  }

  const stopRecovery = async (): Promise<void> => {
    reviewing.current = false
    setReview(null)
    await window.opsmaxx!.addy.cancelRecovery().catch(() => undefined)
    toast(t('addy.setup.recoveryStopped'))
  }

  if (review) {
    const n = review.devices.length
    const lastChange = new Date(review.lastEntryAt).toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'short',
      year: 'numeric'
    })
    return (
      <div className="addy-setup">
        <h3>{t('addy.setup.review.title')}</h3>
        <div className="setting-desc">{t('addy.setup.review.desc')}</div>
        <ol className="addy-phrase" aria-label={t('addy.fingerprint.title')}>
          {review.fingerprint.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ol>
        <div className="addy-note" role="status">
          <AlertTriangle size={15} aria-hidden />
          <div>
            <strong>{t('addy.setup.review.compare')}</strong>
            <div className="setting-desc">
              <Trans
                i18nKey="addy.setup.review.compareHow"
                components={{ strong: <strong />, em: <em /> }}
              />
            </div>
          </div>
        </div>
        <ul className="setting-desc">
          <li>
            {review.epoch === 1
              ? t('addy.setup.review.epochFirst', { epoch: review.epoch })
              : t('addy.setup.review.epoch', { epoch: review.epoch })}
          </li>
          <li>
            {n > 0 ? (
              <Trans
                i18nKey="addy.setup.review.devices"
                values={{ count: n, names: review.devices.map((d) => d.label).join(', '), label: label.trim() }}
                components={{ strong: <strong /> }}
              />
            ) : (
              <Trans
                i18nKey="addy.setup.review.devicesNone"
                values={{ n, label: label.trim() }}
                components={{ strong: <strong /> }}
              />
            )}
          </li>
          <li>{t('addy.setup.review.lastChange', { date: lastChange })}</li>
        </ul>
        <div className="setting-desc">{t('addy.setup.review.noOther')}</div>
        <button className="btn primary" disabled={busy} onClick={() => void confirmRecovery()}>
          {busy ? <Loader2 size={14} className="spin" /> : <Check size={14} />}{' '}
          {t('addy.setup.review.match')}
        </button>
        {/* NO "CONTINUE ANYWAY" anywhere on this path. Different words mean a
            different device list, and the one the relay served is the one
            this machine would join and seal everything under. */}
        <button className="btn" disabled={busy} onClick={() => void stopRecovery()}>
          <X size={14} /> {t('addy.setup.review.stop')}
        </button>
      </div>
    )
  }

  if (recovered) {
    return (
      <div className="addy-setup">
        <h3>{t('addy.setup.recovered.title')}</h3>
        <div className="setting-desc">
          <Trans
            i18nKey="addy.setup.recovered.desc"
            values={{ label: label.trim() }}
            components={{ strong: <strong /> }}
          />
        </div>
        {/* THE REVIEW, and it is not a formality. Anyone who read the card can
            do exactly what was just done, so the device list is the only place
            that would show it — and this is the one moment a person has just
            been given a reason to read it. */}
        <div className="addy-note" role="status">
          <AlertTriangle size={15} aria-hidden />
          <div>
            <strong>{t('addy.setup.recovered.check', { count: recovered.devices })}</strong>
            <div className="setting-desc">{t('addy.setup.recovered.why')}</div>
          </div>
        </div>
        {/* THE WAY OUT. `recovered` keeps this screen mid-flow on purpose, so
            the enrolment push cannot replace the review before it is read —
            and without this button nothing ever ended it. */}
        <button className="btn" onClick={() => setRecovered(null)}>
          <Check size={14} /> {t('common.done')}
        </button>
      </div>
    )
  }

  // Step 2: the phrase. The rest of the setup card gives way to it — the
  // panel around it is still there, but nothing else in this flow is, because
  // anything else is something to look at instead.
  //
  // PROVED, NOT TICKED. The confirmation was a checkbox, which is a question
  // everybody answers yes to on the way past. Typing three of the words back
  // with the list hidden is the cheapest check that they are actually written
  // down somewhere — and the only one that catches a word copied wrongly while
  // it can still be fixed.
  if (phrase && checking) {
    const words = phrase.trim().split(/\s+/)
    const matches = (i: number): boolean =>
      (typedWords[i] ?? '').trim().toLowerCase() === words[i]?.toLowerCase()
    const right = checkWords.every(matches)
    return (
      <div className="addy-setup">
        <h3>{t('addy.setup.check.title')}</h3>
        <div className="setting-desc">{t('addy.setup.check.desc')}</div>
        {checkWords.map((i, n) => {
          // Called wrong only once the person has moved on from it, so a word
          // half typed is not an error.
          const wrong = leftWords.includes(i) && (typedWords[i] ?? '').trim() !== '' && !matches(i)
          return (
            <label className="addy-field" key={i}>
              <span>{t('addy.setup.check.word', { n: i + 1 })}</span>
              <input
                value={typedWords[i] ?? ''}
                onChange={(e) => {
                  const v = e.target.value
                  setTypedWords((w) => ({ ...w, [i]: v }))
                }}
                onBlur={() => setLeftWords((l) => (l.includes(i) ? l : [...l, i]))}
                autoFocus={n === 0}
                aria-invalid={wrong}
                aria-describedby={wrong ? `addy-word-${i}-wrong` : undefined}
                spellCheck={false}
                autoComplete="off"
              />
              {wrong && (
                <small id={`addy-word-${i}-wrong`} role="alert">
                  {t('addy.setup.check.wrong', { n: i + 1 })}
                </small>
              )}
            </label>
          )
        })}
        <div className="pair-actions">
          <button className="btn" onClick={() => setChecking(false)}>
            {t('addy.setup.check.showAgain')}
          </button>
          {/* Disabled until they match. Not a nag: this is the one screen in
              the product where clicking past it loses something that cannot
              be recovered. */}
          <button
            className="btn"
            disabled={!right}
            aria-describedby={right ? undefined : 'addy-words-why'}
            onClick={() => forgetPhrase()}
          >
            <Check size={14} /> {t('addy.setup.check.done')}
          </button>
        </div>
        {!right && (
          <small className="fine" id="addy-words-why">
            {t('addy.setup.check.why')}
          </small>
        )}
      </div>
    )
  }

  if (phrase) {
    return (
      <div className="addy-setup">
        <h3>{t('addy.setup.phrase.title')}</h3>
        <div className="setting-desc">
          <Trans i18nKey="addy.setup.phrase.desc" components={{ strong: <strong /> }} />
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
          onClick={() => copyPhrase(phrase)}
        >
          <Copy size={14} /> {t('common.copy')}
        </button>
        {/* Once the words are typed back the phrase is forgotten, and the
            enrolled screen — the relay address and "Add another device" —
            takes over. That is the screen this one used to duplicate. */}
        <button
          className="btn"
          onClick={() => {
            setLeftWords([])
            setChecking(true)
          }}
        >
          <Check size={14} /> {t('addy.setup.phrase.written')}
        </button>
      </div>
    )
  }

  return (
    <div className="addy-setup">
      <div className="setting-desc">{t('addy.setup.intro')}</div>

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
          {t('addy.setup.fork.question')}
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
          <strong>{t('addy.setup.fork.first')}</strong>
          <small>{t('addy.setup.fork.firstDesc')}</small>
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
          <strong>{t('addy.setup.fork.join')}</strong>
          <small>{t('addy.setup.fork.joinDesc')}</small>
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
          <strong>{t('addy.setup.fork.recover')}</strong>
          <small>{t('addy.setup.fork.recoverDesc')}</small>
        </button>
      </div>

      {mode !== null && (
        <label className="addy-field">
          <span>{t('addy.setup.relay')}</span>
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
              <Trans i18nKey="addy.setup.relayJoinHint" components={{ strong: <strong /> }} />
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
          <strong>{t('addy.setup.join.start')}</strong>
          <ol>
            <li>
              <Trans i18nKey="addy.setup.join.step1" components={{ strong: <strong /> }} />
            </li>
            <li>
              <Trans i18nKey="addy.setup.join.step2" components={{ strong: <strong /> }} />
            </li>
            <li>{t('addy.setup.join.step3')}</li>
          </ol>
          {url.trim() ? (
            // THIS MACHINE HAS NO ACCOUNT, so it cannot be the one that shows
            // the code — `beginPairing` loads the account's keys to mint a
            // rendezvous and answers "no account is loaded" without them. The
            // button was offered on the one screen where it could only fail.
            <PairingPanel
              baseURL={url.trim()}
              canShow={false}
              ticket={linkTicket}
              onHold={setJoinHeld}
            />
          ) : (
            <div className="setting-desc">{t('addy.setup.join.needRelay')}</div>
          )}
        </div>
      )}

      {mode === 'recover' && (
        <label className="addy-field">
          <span>{t('addy.phrase.label')}</span>
          <textarea
            className="addy-phrase-input"
            value={mnemonic}
            onChange={(e) => setMnemonic(e.target.value)}
            spellCheck={false}
            rows={3}
            placeholder={t('addy.setup.recover.placeholder')}
          />
          <small>{t('addy.setup.recover.hint')}</small>
        </label>
      )}

      {mode === 'create' && (
      <label className="addy-field">
        <span>{t('addy.setup.invite')}</span>
        <input value={invite} onChange={(e) => setInvite(e.target.value)} spellCheck={false} />
        {/* Said plainly, because somebody reading this has no reason to know
            where an invite comes from. */}
        <small>{t('addy.setup.inviteHint')}</small>
        {/* THE ANSWER TO "where do I get one", which this said nothing about.
            It named a command without saying where to run it, so somebody who
            runs their own relay — which is everybody, that is the product —
            had to already know the answer to follow the instruction. */}
        <small>
          {consoleURL ? (
            <Trans
              i18nKey="addy.setup.inviteConsole"
              values={{ console: consoleURL.replace(/^https:\/\//, '') }}
              components={{
                a: (
                  <a
                    href={consoleURL}
                    onClick={(e) => {
                      e.preventDefault()
                      // Through the window-open handler, which vets the scheme and
                      // opens it in the user's own browser rather than in a window
                      // carrying this preload.
                      window.open(consoleURL, '_blank', 'noopener')
                    }}
                  />
                )
              }}
            />
          ) : (
            t('addy.setup.inviteAsk')
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
          <span>{t('addy.setup.label')}</span>
          <input value={label} onChange={(e) => setLabel(e.target.value)} spellCheck={false} />
          <small>{t('addy.setup.labelHint')}</small>
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
          {' '}
          {busy ? t('addy.setup.creating') : t('addy.setup.create')}
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
          {' '}
          {busy ? t('addy.setup.recovering') : t('addy.setup.recoverRun')}
        </button>
      )}
    </div>
  )
}

/** How long the phrase may sit on the clipboard. */
export const PHRASE_CLIPBOARD_MS = 60_000

/**
 * Copy the phrase, and take it back off the clipboard a minute later.
 *
 * Through main's clipboard, not `navigator.clipboard`: the clear has to run
 * whether or not this window is in front, and only main can read the
 * clipboard then. Cleared only if it still holds the phrase — whatever the
 * person copied since is theirs.
 */
export function copyPhrase(phrase: string): void {
  const clip = window.opsmaxx?.clipboard
  if (!clip) {
    void navigator.clipboard.writeText(phrase)
    toast(tr('addy.setup.phrase.copiedNoClear'))
    return
  }
  clip.write(phrase)
  toast(tr('addy.setup.phrase.copied'))
  setTimeout(() => {
    void clip.read().then(
      (now) => {
        if (now === phrase) clip.write('')
      },
      () => undefined
    )
  }, PHRASE_CLIPBOARD_MS)
}
