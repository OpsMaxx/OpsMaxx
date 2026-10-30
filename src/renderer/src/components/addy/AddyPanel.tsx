import { useEffect, useState } from 'react'
import {
  AlertTriangle,
  Check,
  Circle,
  CircleDot,
  Clock,
  FileDown,
  FileUp,
  HelpCircle,
  Laptop,
  Loader2,
  MonitorSmartphone,
  RefreshCw,
  Satellite,
  Wifi,
  WifiOff
} from 'lucide-react'
import { PanelShell, NoteWhy } from '../monitor/PanelShell'
import { EmptyState } from '../common/EmptyState'
import { Sparkline } from '../common/Sparkline'
import { useApp } from '../../store/app'
import { toast } from '../../store/toast'
import { clsx } from '../../lib/format'
import { errorText } from '../../lib/connectionError'
import { confirmHeldRecord, heldSentence, refreshHeld, undeferConflicts, useAddyUi } from '../../store/addy'
import { syncErrorText } from './collectionNames'
import type { ArrivedTransfer, ClipboardShortcutState } from '../../../../shared/addy'
import { AddySetup } from './AddySetup'
import {
  addyJourney,
  ago,
  relayHost,
  useAddyStatus,
  type AddyDevice,
  type AddyStatus,
  type AddyStep
} from './addyStatus'
import { Switch } from '../common/Switch'
import { useT } from '../../lib/i18n'
import { Trans } from '../../lib/Trans'
import type { MessageKey } from '../../../../shared/i18n'

/**
 * Sync & devices — the account, the machines on it, and whether anything moved.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT THIS EXISTS AGAINST
 * ---------------------------------------------------------------------------
 *
 * addy shipped with no nav entry at all. Its only door was `<AddySetup />`,
 * three headings down the Security page of Settings, below the credential
 * proxy — so the feature was reachable only by somebody who already knew it was
 * there, and once they had used it nothing in the app ever said what had come
 * of it. "It is very incomprehensible" is the report, and the two halves of it
 * are that there is no way in and no readout.
 *
 * ---------------------------------------------------------------------------
 * THE RULE THIS PANEL IS BUILT ON
 * ---------------------------------------------------------------------------
 *
 * A PANEL THAT LIES IS WORSE THAN THE ONE WE HAD. Sync, login and persistence
 * are being written in parallel with this screen; today the bridge answers
 * pairing, conflicts and revocation and nothing about state. So every pane here
 * has a fourth rendering beside good, bad and empty: NOT REPORTED. It is not a
 * placeholder and it is not a spinner — it is a sentence saying which question
 * this build cannot answer, sitting in the same tile that will hold the answer.
 *
 * The consequence is that this screen is correct today and gains meaning rather
 * than changing shape. See `addyStatus.ts` for the contract it is asking main
 * for, and note what it does NOT do: it never infers a number, never counts
 * absence as zero, and never paints a green tile off a field nobody set.
 *
 * The setup flow is EMBEDDED rather than copied. `AddySetup` owns the one
 * irreversible screen in the product — the recovery phrase, shown once by a
 * sidecar that has no call to show it again — and a second implementation of
 * that is how a user ends up with an account nobody can recover.
 */
export function AddyPanel(): React.JSX.Element {
  const t = useT()
  const { status, supported, error, refresh } = useAddyStatus()
  const [syncing, setSyncing] = useState(false)

  /**
   * A pass, now, rather than at the next tick.
   *
   * The engine runs on its own every five minutes, so this button is not how
   * sync works — it is how somebody finds out whether it does. "I changed
   * something on the other machine, is it here yet" is the question this
   * screen exists to answer, and a five-minute wait is not an answer.
   *
   * `refresh()` afterwards even on failure: a pass that failed changed the
   * status too, and it is the error band rather than this button that has to
   * say so.
   */
  const syncNow = async (): Promise<void> => {
    setSyncing(true)
    try {
      const result = await window.opsmaxx?.addy.syncNow()
      // NULL IS A REAL ANSWER AND IT WAS SWALLOWED. Main returns it when this
      // device is enrolled but not logged in — offline, an expired token, a
      // sidecar that did not start — and the button then blinked and changed
      // nothing at all. The comment on the button claims it is withheld
      // wherever its only outcome is an error; it is gated on `enrolled`,
      // which does not cover this.
      if (result === null) {
        toast(t('addy.panel.notConnectedToast'), 'error')
      }
    } catch (err) {
      toast(errorText(err), 'error')
    } finally {
      setSyncing(false)
      refresh()
    }
  }
  const relaySetting = useApp((s) => s.settings.addyRelayURL)
  const steps = addyJourney(status, supported, relaySetting)
  const relay = relayHost(status?.relayURL ?? relaySetting)

  return (
    <PanelShell
      icon={<Satellite size={16} />}
      // THE FEATURE'S ONE NAME. This card said "Account" so as not to repeat
      // the page header, and that made four names for one feature — Sync on the
      // rail, Sync & devices on the page, Account here, addy in Settings — while
      // every instruction elsewhere told people to "open Account", which is
      // nothing they could find. Saying the same words twice is the cheaper
      // mistake.
      title={t('modules.addy.label')}
      about={t('addy.panel.about')}
      actions={
        supported ? (
          <>
            {/* Only once this device is on an account. A "Sync now" on a
                machine with no account is a button whose only possible outcome
                is an error, and the journey below already says what to do
                instead. */}
            {status?.enrolled && (
              <button className="btn ghost" disabled={syncing} onClick={() => void syncNow()}>
                {syncing ? (
                  <Loader2 size={14} className="spin" />
                ) : (
                  <RefreshCw size={14} />
                )}
                {' '}
                {syncing ? t('addy.panel.syncing') : t('addy.panel.syncNow')}
              </button>
            )}
            <button className="btn ghost" onClick={refresh}>
              <RefreshCw size={14} /> {t('common.refresh')}
            </button>
          </>
        ) : undefined
      }
      className="addy-panel"
      testId="addy-panel"
    >
      {/* First, and unconditionally, when the build cannot answer. It is the
          frame every number below it has to be read through, so it cannot be
          folded away behind the ⓘ — see PanelShell on where a caveat lives. */}
      {!supported && (
        <div className="addy-note" role="status">
          <AlertTriangle size={15} aria-hidden />
          <div>
            <strong>{t('addy.panel.notSupported')}</strong>
            <NoteWhy summary={t('addy.panel.notSupportedWhy')}>{t('addy.panel.notSupportedDetail')}</NoteWhy>
          </div>
        </div>
      )}

      {error !== null && (
        <div className="addy-problem" role="alert">
          <AlertTriangle size={15} aria-hidden />
          <span>{t('addy.panel.statusError', { error })}</span>
        </div>
      )}

      {/* THE REASON THIS DEVICE IS NOT ATTACHED, AT THE TOP. It used to reach
          a console log and nowhere else, and then the bottom of the panel,
          under six rows — so a machine that was enrolled and could not sign in
          showed ACCOUNT On and SYNC Off first, and the reason last. */}
      {status?.problem !== undefined && (
        <div className="addy-problem" role="alert">
          <AlertTriangle size={15} aria-hidden />
          <span>{status.problem}</span>
          <ReconnectButton />
        </div>
      )}

      <AddyKpis status={status} supported={supported} relay={relay} />
      <HeldRecords lastSyncAt={status?.sync?.lastSyncAt ?? null} />

      <h3 className="ui-section-title addy-h">{t('addy.panel.whereYouAre')}</h3>
      <ol className="addy-journey">
        {steps.map((s) => (
          <JourneyStep key={s.key} step={s} />
        ))}
      </ol>

      {/* The setup flow itself, at the point in the journey it belongs to. Shown
          only while step one is where the reader is: once a device is enrolled,
          a "create an account" form on the same screen as the account is an
          invitation to mint a second one by accident. */}
      {/* ALWAYS MOUNTED, and the guard is a prop rather than this condition.
          It used to be `steps[0].state !== 'done'`, which unmounted this the
          instant the account existed — and `createAccount` logs in, which
          starts the engine, which pushes `enrolled: true` BEFORE it returns
          the recovery phrase. The slot went away while the renderer was still
          awaiting the words, and they were never shown or vanished while
          somebody was writing them down. See AddySetup for the rest of it.

          `AddySetup` reads the status itself and renders null when this device
          is enrolled and nothing is in flight, so the "do not offer to mint a
          second account" intent is intact — just decided by the component that
          knows, and applied at the Settings door too, which had no guard at
          all. */}
      <div className="addy-setup-slot">
        {steps[0].state !== 'done' && <h3 className="ui-section-title addy-h">{t('addy.panel.startHere')}</h3>}
        <AddySetup />
      </div>

      <h3 className="ui-section-title addy-h">{t('addy.panel.devicesHeading')}</h3>
      <AddyDevices devices={status?.devices} supported={supported} onChanged={refresh} />
      {status?.fingerprint && <AccountFingerprint words={status.fingerprint} />}

      {/* Offered only once there is somewhere to send to. On a one-device
          account the shortcuts would be taken from every application on the
          machine in exchange for nothing at all. */}
      {status?.enrolled && <Transfers devices={status.devices} />}
      {status?.enrolled && <RekeyRow />}
      {status?.enrolled && <PauseRow running={status.sync?.running === true} />}
      {status?.enrolled && <LeaveRow relay={relay} devices={status.devices?.length ?? null} />}
      {status?.enrolled && <ClipboardShortcuts />}

      <AddyProblems status={status} />
    </PanelShell>
  )
}

/**
 * Sending a file to one of your own machines, and what has arrived here.
 *
 * ONE RECIPIENT, CHOSEN. Not "send to all my devices": a file has a reason and
 * the reason is usually one machine, and a transfer that fans out is one that
 * puts a copy of whatever it was on every laptop the user owns, including the
 * one in an office they are not sitting in.
 *
 * Arrived files are LISTED, never opened. They were written by another
 * machine, and "another of my own devices" is exactly the belief that makes an
 * automatic open dangerous — a device on the roster is a device somebody could
 * have paired, which is why recovery ends by asking the user to read that
 * list. So this offers the folder, and the sweep takes anything left after a
 * week.
 */
function Transfers({ devices }: { devices?: AddyDevice[] }): React.JSX.Element | null {
  const t = useT()
  const [arrived, setArrived] = useState<ArrivedTransfer[]>([])
  const [busy, setBusy] = useState(false)
  const others = (devices ?? []).filter((d) => !d.self && d.revoked !== true)

  useEffect(() => {
    // Optional call, like every other bridge read on this screen. A window
    // whose preload predates this method — a dev server that was not
    // restarted, or a window that outlived an update — must render the panel
    // without it rather than take the whole screen down.
    void window.opsmaxx?.addy.pendingFiles?.().then(setArrived, () => undefined)
  }, [])

  const send = async (to: string): Promise<void> => {
    const picked = await window.opsmaxx?.dialog?.openUpload?.()
    if (!picked || picked.length === 0) return
    setBusy(true)
    try {
      // One at a time, and reported per file. A batch that half-succeeded and
      // said "sent" would be the worst of both.
      for (const path of picked) {
        const r = await window.opsmaxx!.addy.sendFile(path, to)
        toast(t('addy.transfers.sent', { name: r.name }), 'ok')
      }
    } catch (err) {
      toast(errorText(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  // Nothing to send to and nothing received: the row would be a control with
  // no possible outcome.
  if (others.length === 0 && arrived.length === 0) return null

  return (
    <div className="setting-row addy-transfers">
      <div className="s-info">
        <div className="s-title">{t('addy.transfers.title')}</div>
        <div className="s-desc">{t('addy.transfers.desc')}</div>
        {arrived.length > 0 && (
          <ul className="addy-arrived">
            {arrived.map((f) => (
              <li key={f.id + f.name}>
                <FileDown size={13} aria-hidden />
                <span className="strong">{f.name}</span>
                <span className="fine">
                  {t('addy.transfers.size', { size: Math.max(1, Math.round(f.size / 1024)) })}
                </span>
                <button
                  className="btn ghost size-24"
                  onClick={() => void window.opsmaxx?.addy.revealTransfer?.(f.path)}
                >
                  {t('common.show')}
                </button>
                <button
                  className="btn ghost size-24"
                  onClick={() => {
                    void window.opsmaxx?.addy.discardTransfer?.(f.id)?.then(() => {
                      setArrived((all) => all.filter((x) => x.id !== f.id))
                    })
                  }}
                >
                  {t('common.delete')}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <span className="addy-revoke-confirm">
        {others.map((d) => (
          <button
            key={d.id}
            className="btn ghost size-24"
            disabled={busy}
            onClick={() => void send(d.id)}
          >
            {/* The key as well, for the same reason the device table shows it:
                two of these buttons can otherwise read identically, and the
                file goes to whichever machine the user did not mean. */}
            {busy ? <Loader2 size={13} className="spin" /> : <FileUp size={13} />}{' '}
            {t('addy.transfers.sendTo', { label: d.label, fingerprint: fingerprint(d.id) })}
          </button>
        ))}
      </span>
    </div>
  )
}

/**
 * Changing the key the account's data is sealed under.
 *
 * THE OTHER HALF OF REMOVING A DEVICE, and the panel says so rather than
 * leaving somebody to work it out. Taking a machine off the roster stops it
 * receiving anything new; it does NOT take back the key it already has, so a
 * laptop that was stolen rather than retired can still read everything it
 * captured before it went. A re-key is what changes that.
 *
 * It asks for the recovery phrase, and that is not friction for its own sake:
 * the key being replaced is the one the removed device is holding, so signing
 * the replacement with it would let that device follow the rotation straight
 * through. The root key is the only thing it does not have.
 */
function RekeyRow(): React.JSX.Element {
  const t = useT()
  const [phrase, setPhrase] = useState('')
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  // Copies set aside and not decided yet. A re-key drops every one of them
  // (OpsMaxx offers only the current key's, and the relay deletes the rest),
  // and one of them may be the only place a set-aside vault exists — so the
  // number is said before the button, not discovered after.
  const [waiting, setWaiting] = useState(0)
  useEffect(() => {
    if (!open) return
    let live = true
    void window.opsmaxx?.addy
      ?.conflicts?.()
      ?.then((list) => live && setWaiting(list.length))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [open])

  const run = (): void => {
    setBusy(true)
    void window
      .opsmaxx!.addy.rotate('revocation', phrase.trim())
      .then(
        (r) => {
          // "epoch" and "collections" are both protocol words. What a person
          // needs to know is that it worked, how much moved, and that their
          // other machines are not broken by it.
          toast(t('addy.rekey.done', { count: r.resealed }), 'ok')
          setPhrase('')
          setOpen(false)
        },
        (err: unknown) => toast(errorText(err), 'error')
      )
      .finally(() => setBusy(false))
  }

  return (
    <div className="setting-row">
      <div className="s-info">
        <div className="s-title">{t('addy.rekey.title')}</div>
        <div className="s-desc">
          <Trans i18nKey="addy.rekey.desc" components={{ strong: <strong /> }} />
          {open && (
            <>
              <br />
              {t('addy.rekey.needsPhrase')}
              {waiting > 0 && (
                <>
                  <br />
                  <Trans
                    i18nKey="addy.rekey.waiting"
                    values={{ count: waiting }}
                    components={{ strong: <strong /> }}
                  />
                </>
              )}
            </>
          )}
        </div>
        {open && (
          <textarea
            className="addy-phrase-input"
            aria-label={t('addy.phrase.label')}
            value={phrase}
            onChange={(e) => setPhrase(e.target.value)}
            spellCheck={false}
            rows={2}
            placeholder={t('addy.rekey.placeholder')}
          />
        )}
      </div>
      {open ? (
        <span className="addy-revoke-confirm">
          <button className="btn ghost size-24" disabled={busy} onClick={() => setOpen(false)}>
            {t('common.cancel')}
          </button>
          <button
            className="btn size-24"
            disabled={busy || phrase.trim().split(/\s+/).length !== 12}
            onClick={run}
          >
            {busy ? <Loader2 size={13} className="spin" /> : null} {t('addy.rekey.run')}
          </button>
        </span>
      ) : (
        <button className="btn ghost size-24" onClick={() => setOpen(true)}>
          {t('addy.rekey.open')}
        </button>
      )}
    </div>
  )
}

/**
 * The clipboard shortcuts, and the honest cost of them at the switch.
 *
 * OFF until asked for. These are GLOBAL shortcuts — taken from every
 * application on the machine, not just this one — and `Cmd/Ctrl+Shift+C` is
 * DevTools in every browser. Turning that on for somebody who has never heard
 * of the feature, on an upgrade, is how an app gets uninstalled.
 *
 * So the switch names what it takes, rather than saying "enable clipboard
 * sync" and letting the user find out the next time they press the
 * combination somewhere else.
 */
/**
 * Take this device off the account.
 *
 * LEAVING IS NOT REVOKING, and saying so is most of this control's job.
 * Revoking is signed, tells the other devices, and wipes the machine it names.
 * Leaving is local: this device forgets its own keys and stops syncing, the
 * other devices carry on without noticing, and this one stays in their roster
 * until somebody there removes it. A person who leaves believing they have
 * removed themselves has the wrong model of what just happened.
 *
 * Two presses, and the second one is where the irreversible part is named. The
 * same shape as RevokeButton, for the same reason: the sentence has to be in
 * front of somebody before they act, not after.
 */
/**
 * Stop carrying data, without leaving the account.
 *
 * THE PRODUCT ONLY HAD THE LOUD OPTION. Pausing is for a metered connection, a
 * machine about to be lent to somebody, or a person who wants to look at a
 * conflict before more arrives. Leaving destroys this device's keys and cannot
 * be undone without pairing again. Offering only the second means somebody who
 * wanted the first takes it — so this sits ABOVE Leave, where the quieter
 * answer is read first.
 *
 * It lasts this run. A pause that survived a restart would be a switch people
 * forget they flipped, and its symptom is silence.
 */
function PauseRow({ running }: { running: boolean }): React.JSX.Element {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const act = (): void => {
    setBusy(true)
    const api = window.opsmaxx?.addy
    const p = running ? api?.pauseSync() : api?.resumeSync()
    void Promise.resolve(p)
      .then((r) => {
        const okay = r === undefined || r.ok
        toast(
          okay
            ? running
              ? t('addy.pause.paused')
              : t('addy.pause.resumed')
            : ((r as { problem?: string }).problem ?? t('addy.pause.couldNotStart')),
          okay ? 'ok' : 'error'
        )
      })
      .catch((err: unknown) => toast(errorText(err), 'error'))
      .finally(() => setBusy(false))
  }
  return (
    <div className="setting-row">
      <div className="s-info">
        <div className="s-title">
          {running ? t('addy.pause.pauseTitle') : t('addy.pause.resumeTitle')}
        </div>
        <div className="s-desc">
          {running ? t('addy.pause.pauseDesc') : t('addy.pause.resumeDesc')}
        </div>
      </div>
      <button className="btn ghost size-24" disabled={busy} onClick={act}>
        {busy ? <Loader2 size={13} className="spin" /> : null}{' '}
        {running ? t('addy.pause.pause') : t('addy.pause.resume')}
      </button>
    </div>
  )
}

function LeaveRow({
  relay,
  devices
}: {
  relay: string | null
  devices: number | null
}): React.JSX.Element {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  // THE LAST DEVICE IS THE DANGEROUS CASE. With another device on the account
  // the data is still reachable from it; with only this one, the recovery
  // phrase is the only way back and the relay cannot help — it holds no key.
  const alone = devices !== null && devices <= 1

  const run = (): void => {
    setBusy(true)
    void window.opsmaxx?.addy
      ?.leave()
      .then((r) => {
        // WHICH OF THE TWO HAPPENED MATTERS. Removing itself from the device
        // list needs the relay, and leaving deliberately works without it — so
        // a person who left offline is still listed on their other machines
        // and should hear that from here rather than discover it there.
        toast(
          !r?.left
            ? t('addy.leave.notOnAccount')
            : r.removedFromRoster === true
              ? t('addy.leave.leftAndRemoved')
              : r.rosterProblem
                ? t('addy.leave.leftNotRemovedBecause', { problem: r.rosterProblem })
                : t('addy.leave.leftNotRemoved'),
          // Not a success colour on a sentence that asks for something to be
          // done on another machine.
          r?.left && r.removedFromRoster !== true ? 'error' : 'ok'
        )
        setOpen(false)
      })
      .catch((err: unknown) => toast(errorText(err), 'error'))
      .finally(() => setBusy(false))
  }

  return (
    <div className="setting-row">
      <div className="s-info">
        <div className="s-title">{t('addy.leave.title')}</div>
        <div className="s-desc">
          {relay !== null ? t('addy.leave.descAt', { relay }) : t('addy.leave.desc')}
          {open && (
            <>
              <br />
              {t('addy.leave.roster')}
              <br />
              {alone ? <strong>{t('addy.leave.alone')}</strong> : t('addy.leave.notAlone')}
              <br />
              {t('addy.leave.rejoin')}
            </>
          )}
        </div>
      </div>
      {open ? (
        <span className="addy-revoke-confirm">
          <button className="btn ghost size-24" disabled={busy} onClick={() => setOpen(false)}>
            {t('common.cancel')}
          </button>
          <button className="btn danger size-24" disabled={busy} onClick={run}>
            {busy ? <Loader2 size={13} className="spin" /> : null} {t('addy.leave.run')}
          </button>
        </span>
      ) : (
        <button className="btn ghost size-24" onClick={() => setOpen(true)}>
          {t('addy.leave.open')}
        </button>
      )}
    </div>
  )
}

function ClipboardShortcuts(): React.JSX.Element {
  const t = useT()
  const on = useApp((s) => s.settings.addyClipboardShortcuts === true)
  const setSettings = useApp((s) => s.setSettings)
  const [state, setState] = useState<ClipboardShortcutState | null>(null)

  // ASKED, because the setting is a request and not an outcome. `register`
  // returns false when another application already holds a combination, and
  // both callers used to throw that answer away — so a switch reading "on"
  // over two shortcuts nothing held looked exactly like one that worked.
  useEffect(() => {
    void window.opsmaxx?.addy.clipboardShortcutState?.().then(setState, () => undefined)
  }, [on])

  // The app's own switch row, same as the credential proxy's. A second
  // grammar for "a setting with a title and a consequence" is how a screen
  // starts reading as assembled out of parts.
  return (
    <div className="setting-row">
      <div className="s-info">
        <div className="s-title">{t('addy.clipboard.title')}</div>
        <div className="s-desc">
          <Trans
            i18nKey="addy.clipboard.desc"
            components={{ kbd: <kbd />, strong: <strong />, br: <br /> }}
          />
        </div>
      </div>
      <Switch
        checked={on}
        label={t('addy.clipboard.title')}
        onChange={(v) => setSettings({ addyClipboardShortcuts: v })}
      />
      {/* `held` is true when EITHER combination registered, because the
          release path has to unregister whatever did — so a blocked one is
          exactly the case to warn about and `!held` alone would miss it. */}
      {on && state && (state.blocked.length > 0 || !state.held) && (
        <div className="addy-note" role="status">
          <AlertTriangle size={15} aria-hidden />
          <div>
            {state.blocked.length > 0 ? (
              <>
                <strong>
                  {state.blocked.length === 1
                    ? t('addy.clipboard.blockedOne', { combo: state.blocked[0] })
                    : t('addy.clipboard.blockedBoth', {
                        first: state.blocked[0],
                        second: state.blocked.slice(1).join(', ')
                      })}
                </strong>
                <div className="setting-desc">{t('addy.clipboard.blockedHelp')}</div>
              </>
            ) : !state.attached ? (
              <>
                <strong>{t('addy.clipboard.notAttached')}</strong>
                <div className="setting-desc">{t('addy.clipboard.notAttachedHelp')}</div>
              </>
            ) : (
              <strong>{t('addy.clipboard.notRegistered')}</strong>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * The band, in the shape the fleet overview uses.
 *
 * Same classes as FleetKpis on purpose: this is one product, and a second
 * grammar for "a number with a label" is how a screen starts reading as
 * assembled. The difference is what an unknown looks like — the fleet band
 * never has one, because a host either answered or is listed as unreachable.
 * Here a tile can be genuinely unanswered, and it prints an em dash with the
 * reason underneath rather than a zero.
 */
function AddyKpis({
  status,
  supported,
  relay
}: {
  status: AddyStatus | null
  supported: boolean
  relay: string | null
}): React.JSX.Element {
  const t = useT()
  const sync = status?.sync
  const devices = status?.devices
  const enrolled = status?.enrolled === true
  const conflicts = sync?.conflicts ?? 0
  const held = useAddyUi((s) => s.held.length)
  const attention = conflicts > 0 || held > 0 || sync?.error !== undefined

  return (
    <section className="kpi-band" aria-label={t('addy.kpi.summary')}>
      <div className="kpi">
        <div className="kpi-top">
          <span className="kpi-icon">
            <Satellite size={13} />
          </span>
          <span className="kpi-label">{t('addy.kpi.account')}</span>
        </div>
        <div className="kpi-value">{!supported ? '—' : enrolled ? t('common.on') : t('common.none')}</div>
        <div className="kpi-sub" title={relay ?? undefined}>
          {!supported
            ? relay
              ? t('addy.kpi.relayEnrolmentNotReported', { relay })
              : t('addy.kpi.notReported')
            : enrolled
              ? (relay ?? t('addy.kpi.relayNotReported'))
              : t('addy.kpi.noAccount')}
        </div>
      </div>

      <div className="kpi">
        <div className="kpi-top">
          <span className="kpi-icon">
            <MonitorSmartphone size={13} />
          </span>
          <span className="kpi-label">{t('addy.kpi.devices')}</span>
        </div>
        <div className="kpi-value">{devices ? devices.filter((d) => !d.revoked).length : '—'}</div>
        <div className="kpi-sub">
          {devices
            ? devices.some((d) => d.self)
              ? t('addy.kpi.includingThis')
              : t('addy.kpi.onThisAccount')
            : t('addy.kpi.notReadYet')}
        </div>
      </div>

      <div className={clsx('kpi', sync?.running === true && !sync.connected && 'warn')}>
        <div className="kpi-top">
          <span className="kpi-icon">
            {sync?.connected === true ? <Wifi size={13} /> : <WifiOff size={13} />}
          </span>
          <span className="kpi-label">{t('addy.kpi.sync')}</span>
        </div>
        <div className="kpi-value">
          {sync === undefined
            ? '—'
            : !sync.running
              ? t('common.off')
              : sync.connected
                ? t('addy.kpi.live')
                : t('addy.kpi.idle')}
        </div>
        {/* The trend, only where there is one. A flat line drawn from a missing
            history is a claim that nothing synced, which is a different thing
            from not knowing. */}
        {sync?.history !== undefined && sync.history.length > 1 && (
          <div className="kpi-spark">
            <Sparkline data={sync.history} height={18} />
            {/* LABELLED. An unlabelled chart with no units is decoration on a
                panel whose whole argument is that it does not show numbers
                nobody measured. */}
            <span className="fine">{t('addy.kpi.history', { n: sync.history.length })}</span>
          </div>
        )}
        <div className="kpi-sub">
          {sync === undefined
            ? t('addy.kpi.notReported')
            : !sync.running
              ? t('addy.kpi.engineNotRunning')
              : sync.connected
                ? t('addy.kpi.connected')
                : t('addy.kpi.notConnected')}
        </div>
      </div>

      <div className="kpi">
        <div className="kpi-top">
          <span className="kpi-icon">
            <Clock size={13} />
          </span>
          <span className="kpi-label">{t('addy.kpi.lastSync')}</span>
        </div>
        <div className="kpi-value">
          {sync?.lastSyncAt ? ago(sync.lastSyncAt) : sync?.lastSyncAt === null ? t('common.never') : '—'}
        </div>
        <div className="kpi-sub">
          {sync?.lastSyncAt
            ? t('addy.kpi.ago')
            : sync?.lastSyncAt === null
              ? t('addy.kpi.nothingSynced')
              : t('addy.kpi.notReported')}
        </div>
      </div>

      {/* Present only when it is real. A permanent "0 problems" tile is how a
          row stops being read — FleetKpis makes the same argument about its
          attention tile. */}
      {attention && (
        <div className="kpi danger">
          <div className="kpi-top">
            <span className="kpi-icon">
              <AlertTriangle size={13} />
            </span>
            <span className="kpi-label">{t('addy.kpi.attention')}</span>
          </div>
          <div className="kpi-value">{conflicts + held > 0 ? conflicts + held : 1}</div>
          <div className="kpi-sub">
            {conflicts + held > 0 ? t('addy.kpi.waitingForChoice') : t('addy.kpi.failing')}
          </div>
        </div>
      )}
    </section>
  )
}

const STEP_MARK: Record<AddyStep['state'], React.ReactNode> = {
  done: <Check size={13} />,
  now: <CircleDot size={13} />,
  todo: <Circle size={13} />,
  unknown: <HelpCircle size={13} />
}

/** What each state is called, for the people who cannot see the glyph. The
 *  shape carries it for everyone else, which is why the word is not printed. */
const STEP_WORD: Record<AddyStep['state'], MessageKey> = {
  done: 'common.done',
  now: 'addy.journey.state.now',
  todo: 'addy.journey.state.todo',
  unknown: 'addy.journey.state.unknown'
}

function JourneyStep({ step }: { step: AddyStep }): React.JSX.Element {
  const t = useT()
  return (
    <li className={clsx('addy-step', step.state)}>
      <span className="addy-step-mark" aria-hidden>
        {STEP_MARK[step.state]}
      </span>
      <div className="addy-step-body">
        <div className="addy-step-title">
          {step.title}
          <span className="chip addy-step-state">{t(STEP_WORD[step.state])}</span>
        </div>
        <div className="addy-step-detail ui-note">{step.detail}</div>
      </div>
    </li>
  )
}

/**
 * The start of a device's `pub_sign`, which is the only thing on its row that
 * is certainly different from every other row.
 *
 * THE NAME IS NOT, AND THAT IS NOT AN ENCRYPTION FAILURE. A device's label is
 * sealed into its roster entry when it is paired and roster entries are
 * immutable, so the name is fixed at that moment — and the moment writes a
 * constant. `completePairing` seals `confirmation.self?.label ?? 'a paired
 * device'`; `self` is declared optional on `PairingConfirmation` and is set by
 * nothing, in either process. So every device this build pairs is called the
 * same three words, the sidecar opens that label perfectly, and a third
 * machine puts two identical rows on this table — one of which carries a
 * button that wipes a laptop.
 *
 * Eight hex characters, the same slice main falls back to when the sidecar
 * genuinely cannot open a label, so the two agree instead of offering a person
 * two different short forms of one key. It is stable for the life of the
 * device and the same characters appear beside "This device" on the machine
 * itself, which is what makes it usable as a name: you can go and look.
 */
function fingerprint(id: string): string {
  return id.slice(0, 8)
}

/** The roster entry that added it was signed with the recovery-phrase key.
 *  Read loosely: main fills the field from the verified chain, and a build
 *  that does not send it has no phrase-added devices to show. */
function addedWithPhrase(d: AddyDevice): boolean {
  return (d as { addedWithPhrase?: boolean }).addedWithPhrase === true
}

/** The date in the signed add entry. A date, not a time: it is for spotting a
 *  machine that turned up recently, not for an audit trail. */
function addedOn(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

/**
 * The roster.
 *
 * Three renderings, and the third is the one that matters: `undefined` means
 * main did not tell us, `[]` means the account really has no devices on it, and
 * those are different sentences. Collapsing them is how a screen comes to say
 * "0 devices" about an account with four.
 *
 * WHAT THE ORDER MEANS, since the table has no other axis: `devices` is the
 * verified chain's live set in append order — `VerifyChain` walks the entries
 * and splices out revoked ones — so it is the order the machines joined, and
 * the last row is the one added most recently. That is a fact this device
 * checked itself, unlike anything about when a device was last used, which
 * the relay does not record at all.
 */
function AddyDevices({
  devices,
  supported,
  onChanged
}: {
  devices: AddyDevice[] | undefined
  supported: boolean
  /** Re-read the status once the roster has changed under us. */
  onChanged: () => void
}): React.JSX.Element {
  const t = useT()
  if (devices === undefined) {
    return (
      <EmptyState
        compact
        title={t('addy.devices.notReported')}
        message={supported ? t('addy.devices.waiting') : t('addy.devices.cannotRead')}
      />
    )
  }
  if (devices.length === 0) {
    return (
      <EmptyState
        compact
        title={t('addy.devices.none')}
        message={t('addy.devices.noneMessage')}
      />
    )
  }
  const phraseAddedWhy = t('addy.devices.phraseAddedWhy')
  return (
    <table className="mini-table addy-devices">
      <thead>
        <tr>
          <th>{t('addy.devices.device')}</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {devices.map((d) => (
          <tr key={d.id} className={clsx(d.revoked === true && 'addy-device-revoked')}>
            <td className="strong">
              <Laptop size={13} aria-hidden />{' '}
              <span className="addy-device-name">{d.label}</span>
              {d.self && <span className="chip info">{t('addy.devices.thisDevice')}</span>}
              {d.revoked === true && <span className="chip danger">{t('addy.devices.revoked')}</span>}
              {/* NOT EVERY ADD IS A PAIRING. The recovery phrase can add a
                  device with no other machine present and nobody comparing
                  emoji, so a row added that way is the one to look at twice.
                  The chip says it in words; the explanation is the hover text
                  and the screen-reader description. */}
              {addedWithPhrase(d) && (
                <span className="chip warn" title={phraseAddedWhy} aria-description={phraseAddedWhy}>
                  {t('addy.devices.addedWithPhrase')}
                </span>
              )}
              {/* Under the name rather than beside it: it is what you read
                  when the name did not settle it, and a row that leads with
                  a key is a row nobody scans. */}
              <div className="addy-device-fp">{fingerprint(d.id)}</div>
              {d.addedAt !== null && (
                <div className="fine">{t('addy.devices.addedOn', { date: addedOn(d.addedAt) })}</div>
              )}
            </td>
            <td className="right">
              {/* Never on this device's own row. A device that revoked itself
                  would wipe on its next launch, and that is not undoable — on
                  a list where one row is "this device", it is a misclick
                  waiting to happen rather than a choice anyone makes. */}
              {!d.self && d.revoked !== true && (
                <RevokeButton id={d.id} label={d.label} onDone={onChanged} />
              )}
            </td>
          </tr>
        ))}
      </tbody>
      {/* SAID ONCE, rather than printed as a falsehood on every row.
          `lastSeen` is `null` because the relay does not report it — the
          shared contract says so in as many words — and the column rendered
          that null as "never". (`addedAt` comes from the signed add entry and
          is shown on the row when present.) So every device on every
          account, including the one being looked at, read "Last seen: never".
          That is the column a sysadmin scans to spot a machine that should not
          be there, and it was uniformly false. */}
      <caption className="fine addy-devices-note">
        <p>{t('addy.devices.order')}</p>
        {/* THE ONLY THING ON A ROW THAT IS RELIABLY UNIQUE, and the sentence
            that turns it into a name: you can walk to the other machine and
            read the same characters there. Without this the fingerprint is
            noise, and two devices called the same thing stay that way. */}
        <p>
          <Trans i18nKey="addy.devices.fingerprintNote" components={{ em: <em /> }} />
        </p>
        {/* ASKED FOR AS "pick a primary device", AND THE ANSWER IS THAT THERE
            IS NOTHING TO PICK. Every device holds the same account key and any
            of them can show a pairing code; a primary would be a single point
            of failure that the recovery phrase already replaces. Said here
            because this list is where somebody goes looking for the setting. */}
        <p>
          <Trans i18nKey="addy.devices.noPrimary" components={{ em: <em /> }} />
        </p>
      </caption>
    </table>
  )
}

/**
 * Removing a device, with the consequence said before it happens.
 *
 * TWO PRESSES, and the second one names the machine. This is not reversible —
 * the chain is append-only, so re-adding means pairing that device again from
 * scratch — and it takes effect on the far machine by WIPING it: everything
 * this app stores there is deleted on its next launch. A single button on a
 * row is not enough consent for that.
 *
 * What it does not claim: the epoch key. A revoked device keeps AK_n and can
 * still open anything it already holds. For a retired machine that is fine;
 * for a stolen one the honest answer is a re-key, and saying so here is better
 * than a confirmation that implies more than it does.
 */
function RevokeButton({
  id,
  label,
  onDone
}: {
  id: string
  label: string
  onDone: () => void
}): React.JSX.Element {
  const t = useT()
  const [arming, setArming] = useState(false)
  const [busy, setBusy] = useState(false)

  if (!arming) {
    return (
      <button className="btn ghost danger size-24" onClick={() => setArming(true)}>
        {t('common.remove')}
      </button>
    )
  }
  return (
    <span className="addy-revoke-confirm">
      <span className="fine">
        {/* THE KEY, NOT ONLY THE NAME. Two devices can carry the same name —
            see `fingerprint` — and this sentence is the last thing shown
            before a laptop is wiped. Naming a thing two rows share is not
            naming it. */}
        <Trans
          i18nKey="addy.revoke.confirm"
          values={{ label, fingerprint: fingerprint(id) }}
          components={{ strong: <strong />, code: <code className="addy-device-fp" /> }}
        />
      </span>
      <button className="btn ghost size-24" disabled={busy} onClick={() => setArming(false)}>
        {t('common.cancel')}
      </button>
      <button
        className="btn danger size-24"
        disabled={busy}
        onClick={() => {
          setBusy(true)
          void window.opsmaxx!.addy.revokeDevice(id).then(
            () => {
              toast(t('addy.revoke.removed', { label }), 'ok')
              setArming(false)
              setBusy(false)
              onDone()
            },
            (err: unknown) => {
              toast(errorText(err), 'error')
              setBusy(false)
            }
          )
        }}
      >
        {busy ? <Loader2 size={13} className="spin" /> : null} {t('addy.revoke.run')}
      </button>
    </span>
  )
}

/**
 * The device list this machine verified, as five words.
 *
 * WHAT A RECOVERING MACHINE IS TOLD TO COMPARE WITH. Recovery shows the same
 * words for the list the relay served it, before it adds itself, and a relay
 * serving an old list — from before a device was removed — gives it words this
 * screen does not show. Read only: it changes whenever a device is added or
 * removed, which is also why it is not something to write down.
 */
function AccountFingerprint({ words }: { words: string[] }): React.JSX.Element {
  const t = useT()
  return (
    <div className="setting-row">
      <div className="s-info">
        <div className="s-title">{t('addy.fingerprint.title')}</div>
        <div className="s-desc">{t('addy.fingerprint.desc')}</div>
        <ol className="addy-phrase" aria-label={t('addy.fingerprint.title')}>
          {words.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ol>
      </div>
    </div>
  )
}

/** Whatever is wrong, said once, below the thing it is wrong about. */
/**
 * Try again, without quitting.
 *
 * Every failure to attach had exactly one remedy — restart OpsMaxx — and
 * nothing on the screen said so. A relay down for a minute, or a laptop woken
 * on a different network, cost a restart.
 */
function ReconnectButton(): React.JSX.Element {
  const t = useT()
  const [busy, setBusy] = useState(false)
  return (
    <button
      className="btn ghost size-24"
      disabled={busy}
      onClick={() => {
        setBusy(true)
        void window.opsmaxx?.addy
          ?.reconnect()
          .then((r) =>
            toast(
              r.ok ? t('addy.panel.reconnected') : (r.problem ?? t('addy.panel.stillNotConnected')),
              r.ok ? 'ok' : 'error'
            )
          )
          .catch((err: unknown) => toast(errorText(err), 'error'))
          .finally(() => setBusy(false))
      }}
    >
      {busy ? <Loader2 size={13} className="spin" /> : null} {t('addy.panel.tryAgain')}
    </button>
  )
}

function AddyProblems({ status }: { status: AddyStatus | null }): React.JSX.Element | null {
  const t = useT()
  const sync = status?.sync
  if (sync === undefined) return null
  const conflicts = sync.conflicts
  if (sync.error === undefined && conflicts === 0) return null
  return (
    <div className="addy-problems">
      {sync.error !== undefined && (
        <div className="addy-problem" role="alert">
          <AlertTriangle size={15} aria-hidden />
          {/* The code is for a bug report, not for reading: on hover, not in
              the sentence. */}
          <span title={sync.error.code}>
            {t('addy.panel.syncFailed', {
              ago: ago(sync.error.at),
              reason: syncErrorText(sync.error.message)
            })}
          </span>
        </div>
      )}
      {conflicts > 0 && <ConflictsNote conflicts={conflicts} />}
    </div>
  )
}

/**
 * Synced records this device will not use until somebody here says so.
 *
 * Another device on the account can change where a credential goes — a CI
 * connection's URL, the vault entry it sends, a server's address — and this
 * device holds any such change until it is confirmed here (see
 * services/syncTrust.ts in main). Listed at the top rather than with the
 * problems, because until each is confirmed something the person relies on
 * has quietly stopped: CI polling, monitoring, a VPN that starts at login.
 */
function HeldRecords({ lastSyncAt }: { lastSyncAt: number | null }): React.JSX.Element | null {
  const t = useT()
  const held = useAddyUi((s) => s.held)
  // Asked again whenever a sync lands; the badges elsewhere read the same list.
  useEffect(() => refreshHeld(), [lastSyncAt])
  if (held.length === 0) return null
  return (
    <div className="addy-note addy-held" role="status">
      <AlertTriangle size={15} aria-hidden />
      <div>
        <p>{held.length === 1 ? t('addy.held.one') : t('addy.held.many', { n: held.length })}</p>
        <ul>
          {held.map((r) => (
            <li key={`${r.kind}:${r.id}`}>
              <span>
                <Trans
                  i18nKey="addy.held.item"
                  values={{ name: r.name, why: heldSentence(r), destination: r.destination }}
                  components={{ strong: <strong />, code: <code /> }}
                />
              </span>
              <button className="btn ghost size-24" onClick={() => void confirmHeldRecord(r)}>
                {t('addy.held.review')}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

/**
 * Conflicts waiting, and the way back to them.
 *
 * "Decide later" used to last until the next launch with no way to change your
 * mind in between, while this line went on saying the app "opens both versions
 * and asks" — which it had just been told not to do.
 */
function ConflictsNote({ conflicts }: { conflicts: number }): React.JSX.Element {
  const t = useT()
  const deferred = useAddyUi((s) => s.deferredConflicts.length)
  return (
    <div className="addy-note" role="status">
      <AlertTriangle size={15} aria-hidden />
      <span>
        {t('addy.conflictsNote.text', { count: conflicts })}
        {deferred > 0 && ` ${t('addy.conflictsNote.deferred')}`}
      </span>
      {deferred > 0 && (
        <button className="btn ghost size-24" onClick={undeferConflicts}>
          {t('addy.conflictsNote.reviewNow')}
        </button>
      )}
    </div>
  )
}
