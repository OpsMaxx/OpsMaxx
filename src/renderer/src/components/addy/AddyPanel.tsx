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
        toast('This device is not connected to the relay right now, so nothing was synced.', 'error')
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
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
      // "Account", not the module's own name again. A promoted module already
      // gets a page header built from its registry label -- see the `promoted`
      // branch in FleetMonitor -- so a card titled "Sync & devices" under a page
      // titled "Sync & devices" is the same words twice and names nothing. The
      // convention is DockerPanel's: the page is the subject, the card is what
      // is in it.
      title="Account"
      about={
        <>
          Your own machines, and what has reached them. OpsMaxx carries servers, workspaces,
          tunnels and the vault between your devices through an addy relay you run yourself — every
          object is sealed before it leaves and the relay holds no key. Nothing here reads or
          changes a server.
        </>
      }
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
                {syncing ? ' Syncing…' : ' Sync now'}
              </button>
            )}
            <button className="btn ghost" onClick={refresh}>
              <RefreshCw size={14} /> Refresh
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
            <strong>Sync is not running on this build.</strong>
            <NoteWhy summary="What still works, and what does not">
              Creating an account and pairing a second device work — they talk to the relay
              directly. What is missing is the engine that carries data afterwards and the state it
              would report: how many devices are on the account, when each was last seen, and when
              anything last synced. Those tiles say so rather than showing a zero.
            </NoteWhy>
          </div>
        </div>
      )}

      {error !== null && (
        <div className="addy-problem" role="alert">
          <AlertTriangle size={15} aria-hidden />
          <span>Could not read the sync status: {error}</span>
        </div>
      )}

      <AddyKpis status={status} supported={supported} relay={relay} />

      <h3 className="ui-section-title addy-h">Where you are</h3>
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
        {steps[0].state !== 'done' && <h3 className="ui-section-title addy-h">Start here</h3>}
        <AddySetup />
      </div>

      <h3 className="ui-section-title addy-h">Devices</h3>
      <AddyDevices devices={status?.devices} supported={supported} onChanged={refresh} />

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
        toast(`Sent ${r.name}`, 'ok')
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
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
        <div className="s-title">Files</div>
        <div className="s-desc">
          Send a file to one of your other machines. It is sealed before it leaves and the relay
          cannot read it; it waits there if that machine is asleep. Anything sent here lands in a
          folder OpsMaxx keeps and is deleted after a week.
        </div>
        {arrived.length > 0 && (
          <ul className="addy-arrived">
            {arrived.map((f) => (
              <li key={f.id + f.name}>
                <FileDown size={13} aria-hidden />
                <span className="strong">{f.name}</span>
                <span className="fine">{Math.max(1, Math.round(f.size / 1024))} KB</span>
                <button
                  className="btn ghost size-24"
                  onClick={() => void window.opsmaxx?.addy.revealTransfer?.(f.path)}
                >
                  Show
                </button>
                <button
                  className="btn ghost size-24"
                  onClick={() => {
                    void window.opsmaxx?.addy.discardTransfer?.(f.id)?.then(() => {
                      setArrived((all) => all.filter((x) => x.id !== f.id))
                    })
                  }}
                >
                  Delete
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
            {busy ? <Loader2 size={13} className="spin" /> : <FileUp size={13} />} Send to {d.label}
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
  const [phrase, setPhrase] = useState('')
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const run = (): void => {
    setBusy(true)
    void window
      .opsmaxx!.addy.rotate('revocation', phrase.trim())
      .then(
        (r) => {
          // "epoch" and "collections" are both protocol words. What a person
          // needs to know is that it worked, how much moved, and that their
          // other machines are not broken by it.
          toast(
            `The account key was changed. ${r.resealed} ${r.resealed === 1 ? 'item was' : 'items were'} re-sealed under the new one — your other devices pick it up the next time they sync.`,
            'ok'
          )
          setPhrase('')
          setOpen(false)
        },
        (err: unknown) => toast(err instanceof Error ? err.message : String(err), 'error')
      )
      .finally(() => setBusy(false))
  }

  return (
    <div className="setting-row">
      <div className="s-info">
        <div className="s-title">Change the account key</div>
        <div className="s-desc">
          Removing a device stops it receiving anything new. It does not take back the key that
          device already has, so a machine that was <strong>stolen</strong> rather than retired can
          still read everything it had. This replaces that key and re-seals every collection under
          the new one.
          {open && (
            <>
              <br />
              It needs your recovery phrase. The key being replaced is the one the removed device is
              holding, so it cannot be the one that signs the replacement.
            </>
          )}
        </div>
        {open && (
          <textarea
            className="addy-phrase-input"
            value={phrase}
            onChange={(e) => setPhrase(e.target.value)}
            spellCheck={false}
            rows={2}
            placeholder="The twelve words, in order"
          />
        )}
      </div>
      {open ? (
        <span className="addy-revoke-confirm">
          <button className="btn ghost size-24" disabled={busy} onClick={() => setOpen(false)}>
            Cancel
          </button>
          <button
            className="btn size-24"
            disabled={busy || phrase.trim().split(/\s+/).length !== 12}
            onClick={run}
          >
            {busy ? <Loader2 size={13} className="spin" /> : null} Re-key the account
          </button>
        </span>
      ) : (
        <button className="btn ghost size-24" onClick={() => setOpen(true)}>
          Change it
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
              ? 'Sync paused. It starts again next time OpsMaxx opens.'
              : 'Sync running.'
            : ((r as { problem?: string }).problem ?? 'Could not start sync.'),
          okay ? 'ok' : 'error'
        )
      })
      .catch((err: unknown) => toast(err instanceof Error ? err.message : String(err), 'error'))
      .finally(() => setBusy(false))
  }
  return (
    <div className="setting-row">
      <div className="s-info">
        <div className="s-title">{running ? 'Pause sync' : 'Resume sync'}</div>
        <div className="s-desc">
          {running
            ? 'Stops carrying data between your devices without leaving the account. Your keys stay, the other devices are not told, and sync starts again the next time OpsMaxx opens.'
            : 'Nothing is being carried between your devices right now. Your account and keys are untouched.'}
        </div>
      </div>
      <button className="btn ghost size-24" disabled={busy} onClick={act}>
        {busy ? <Loader2 size={13} className="spin" /> : null} {running ? 'Pause' : 'Resume'}
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
          !r.left
            ? 'This device was not on an account.'
            : r.removedFromRoster === true
              ? 'This device has left the account and removed itself from your device list.'
              : 'This device has left the account. It could not reach the relay to remove itself, so your other devices still list it — remove it from one of them.',
          'ok'
        )
        setOpen(false)
      })
      .catch((err: unknown) => toast(err instanceof Error ? err.message : String(err), 'error'))
      .finally(() => setBusy(false))
  }

  return (
    <div className="setting-row">
      <div className="s-info">
        <div className="s-title">Leave this account</div>
        <div className="s-desc">
          Stops sync on this machine and forgets the keys it holds. Your servers, workspaces,
          tunnels and vault stay exactly as they are here — what goes is this device&apos;s ability
          to read anything further from {relay ?? 'the relay'}.
          {open && (
            <>
              <br />
              This does not remove the device from the account: the other machines are not told, and
              this one stays in their device list until somebody there removes it.
              <br />
              {alone ? (
                <strong>
                  This is the only device on the account. After this, the twelve-word recovery
                  phrase is the only way back into it — the relay holds no key and cannot help.
                </strong>
              ) : (
                <>Nothing changes for the other devices; they keep syncing with each other.</>
              )}
              <br />
              Joining again — this relay or a different one — starts from the setup screen.
            </>
          )}
        </div>
      </div>
      {open ? (
        <span className="addy-revoke-confirm">
          <button className="btn ghost size-24" disabled={busy} onClick={() => setOpen(false)}>
            Cancel
          </button>
          <button className="btn danger size-24" disabled={busy} onClick={run}>
            {busy ? <Loader2 size={13} className="spin" /> : null} Leave the account
          </button>
        </span>
      ) : (
        <button className="btn ghost size-24" onClick={() => setOpen(true)}>
          Leave
        </button>
      )}
    </div>
  )
}

function ClipboardShortcuts(): React.JSX.Element {
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
        <div className="s-title">Send and receive the clipboard with a keystroke</div>
        <div className="s-desc">
          <kbd>Cmd/Ctrl+Shift+C</kbd> sends what is on this clipboard to your other devices;{' '}
          <kbd>Cmd/Ctrl+Shift+V</kbd> puts the newest thing sent to this one onto the clipboard.
          Nothing is mirrored in the background — a clipboard that copied everything would send the
          password you just copied to every machine you own.
          <br />
          These are taken from <strong>every application</strong> while OpsMaxx is running, and{' '}
          <kbd>Cmd/Ctrl+Shift+C</kbd> is the developer tools in most browsers.
        </div>
      </div>
      <span
        className={clsx('switch', on && 'on')}
        role="switch"
        aria-checked={on ? 'true' : 'false'}
        aria-label="Send and receive the clipboard with a keystroke"
        onClick={() => setSettings({ addyClipboardShortcuts: !on })}
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
                <strong>Another application already holds {state.blocked.join(' and ')}.</strong>
                <div className="setting-desc">
                  Close it, or quit whatever has the combination, and switch this off and on again.
                </div>
              </>
            ) : !state.attached ? (
              <>
                <strong>Not active until this device reaches the relay.</strong>
                <div className="setting-desc">
                  There is nowhere to send a clipboard to until then.
                </div>
              </>
            ) : (
              <strong>The shortcuts could not be registered.</strong>
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
  const sync = status?.sync
  const devices = status?.devices
  const enrolled = status?.enrolled === true
  const conflicts = sync?.conflicts ?? 0
  const attention = conflicts > 0 || sync?.error !== undefined

  return (
    <section className="kpi-band" aria-label="Sync summary">
      <div className="kpi">
        <div className="kpi-top">
          <span className="kpi-icon">
            <Satellite size={13} />
          </span>
          <span className="kpi-label">Account</span>
        </div>
        <div className="kpi-value">{!supported ? '—' : enrolled ? 'On' : 'None'}</div>
        <div className="kpi-sub" title={relay ?? undefined}>
          {!supported
            ? relay
              ? `relay ${relay} — enrolment not reported`
              : 'not reported by this build'
            : enrolled
              ? (relay ?? 'relay not reported')
              : 'no account on this device'}
        </div>
      </div>

      <div className="kpi">
        <div className="kpi-top">
          <span className="kpi-icon">
            <MonitorSmartphone size={13} />
          </span>
          <span className="kpi-label">Devices</span>
        </div>
        <div className="kpi-value">{devices ? devices.filter((d) => !d.revoked).length : '—'}</div>
        <div className="kpi-sub">
          {devices
            ? devices.some((d) => d.self)
              ? 'including this one'
              : 'on this account'
            : 'not read yet'}
        </div>
      </div>

      <div className={clsx('kpi', sync?.running === true && !sync.connected && 'warn')}>
        <div className="kpi-top">
          <span className="kpi-icon">
            {sync?.connected === true ? <Wifi size={13} /> : <WifiOff size={13} />}
          </span>
          <span className="kpi-label">Sync</span>
        </div>
        <div className="kpi-value">
          {sync === undefined ? '—' : !sync.running ? 'Off' : sync.connected ? 'Live' : 'Idle'}
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
            <span className="fine">
              things carried, last {sync.history.length} passes
            </span>
          </div>
        )}
        <div className="kpi-sub">
          {sync === undefined
            ? 'not reported by this build'
            : !sync.running
              ? 'engine not running'
              : sync.connected
                ? 'connected to the relay'
                : 'not connected right now'}
        </div>
      </div>

      <div className="kpi">
        <div className="kpi-top">
          <span className="kpi-icon">
            <Clock size={13} />
          </span>
          <span className="kpi-label">Last sync</span>
        </div>
        <div className="kpi-value">
          {sync?.lastSyncAt ? ago(sync.lastSyncAt) : sync?.lastSyncAt === null ? 'Never' : '—'}
        </div>
        <div className="kpi-sub">
          {sync?.lastSyncAt
            ? 'ago'
            : sync?.lastSyncAt === null
              ? 'nothing has synced yet'
              : 'not reported by this build'}
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
            <span className="kpi-label">Attention</span>
          </div>
          <div className="kpi-value">{conflicts > 0 ? conflicts : 1}</div>
          <div className="kpi-sub">
            {conflicts > 0 ? 'waiting for a choice' : 'sync is failing'}
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
const STEP_WORD: Record<AddyStep['state'], string> = {
  done: 'Done',
  now: 'You are here',
  todo: 'Not yet',
  unknown: 'Not reported'
}

function JourneyStep({ step }: { step: AddyStep }): React.JSX.Element {
  return (
    <li className={clsx('addy-step', step.state)}>
      <span className="addy-step-mark" aria-hidden>
        {STEP_MARK[step.state]}
      </span>
      <div className="addy-step-body">
        <div className="addy-step-title">
          {step.title}
          <span className="chip addy-step-state">{STEP_WORD[step.state]}</span>
        </div>
        <div className="addy-step-detail ui-note">{step.detail}</div>
      </div>
    </li>
  )
}

/**
 * The roster.
 *
 * Three renderings, and the third is the one that matters: `undefined` means
 * main did not tell us, `[]` means the account really has no devices on it, and
 * those are different sentences. Collapsing them is how a screen comes to say
 * "0 devices" about an account with four.
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
  if (devices === undefined) {
    return (
      <EmptyState
        compact
        title="Not reported"
        message={
          supported
            ? 'Waiting for the device list from the relay. It arrives the next time this device reaches it — nothing is wrong with the account.'
            : 'This build cannot read the device list. Pairing still works; what is missing is the readout of what came of it.'
        }
      />
    )
  }
  if (devices.length === 0) {
    return (
      <EmptyState
        compact
        title="No devices"
        message="No device is on this account yet. Creating an account puts this one on it."
      />
    )
  }
  return (
    <table className="mini-table addy-devices">
      <thead>
        <tr>
          <th>Device</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {devices.map((d) => (
          <tr key={d.id} className={clsx(d.revoked === true && 'addy-device-revoked')}>
            <td className="strong">
              <Laptop size={13} aria-hidden /> {d.label}
              {d.self && <span className="chip info">This device</span>}
              {d.revoked === true && <span className="chip danger">Revoked</span>}
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
          `lastSeen` and `addedAt` are `null` because the relay reports
          neither — the shared contract says so in as many words — and the
          columns rendered that null as "never". So every device on every
          account, including the one being looked at, read "Last seen: never".
          That is the column a sysadmin scans to spot a machine that should not
          be there, and it was uniformly false. */}
      <caption className="fine addy-devices-note">
        The relay does not report when each device was last seen, so that is
        not shown. What is here comes from the signed device list, which this
        device verified itself.
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
  const [arming, setArming] = useState(false)
  const [busy, setBusy] = useState(false)

  if (!arming) {
    return (
      <button className="btn ghost danger size-24" onClick={() => setArming(true)}>
        Remove
      </button>
    )
  }
  return (
    <span className="addy-revoke-confirm">
      <span className="fine">
        Remove <strong>{label}</strong>? Everything OpsMaxx stores on it is deleted the next time it
        opens <strong>and reaches the relay</strong> — a machine kept offline never hears, which is
        why a stolen one also needs the account key changed. Adding it back means pairing it again.
      </span>
      <button className="btn ghost size-24" disabled={busy} onClick={() => setArming(false)}>
        Cancel
      </button>
      <button
        className="btn danger size-24"
        disabled={busy}
        onClick={() => {
          setBusy(true)
          void window.opsmaxx!.addy.revokeDevice(id).then(
            () => {
              toast(`${label} was removed from the account`, 'ok')
              setArming(false)
              setBusy(false)
              onDone()
            },
            (err: unknown) => {
              toast(err instanceof Error ? err.message : String(err), 'error')
              setBusy(false)
            }
          )
        }}
      >
        {busy ? <Loader2 size={13} className="spin" /> : null} Remove it
      </button>
    </span>
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
  const [busy, setBusy] = useState(false)
  return (
    <button
      className="btn ghost size-24"
      disabled={busy}
      onClick={() => {
        setBusy(true)
        void window.opsmaxx?.addy
          ?.reconnect()
          .then((r) => toast(r.ok ? 'Connected.' : (r.problem ?? 'Still not connected.'), r.ok ? 'ok' : 'error'))
          .catch((err: unknown) => toast(err instanceof Error ? err.message : String(err), 'error'))
          .finally(() => setBusy(false))
      }}
    >
      {busy ? <Loader2 size={13} className="spin" /> : null} Try again
    </button>
  )
}

function AddyProblems({ status }: { status: AddyStatus | null }): React.JSX.Element | null {
  const sync = status?.sync
  if (sync === undefined) return null
  const conflicts = sync.conflicts
  // THE REASON THIS DEVICE IS NOT ATTACHED BELONGS AT THE TOP OF THE PANEL.
  // It used to reach a console log and nowhere else, so a machine that was
  // enrolled and could not sign in showed ACCOUNT On, SYNC Off, and a line
  // telling the person to wait for something that was never coming.
  const problem = status?.problem
  if (sync.error === undefined && conflicts === 0 && problem === undefined) return null
  return (
    <div className="addy-problems">
      {problem !== undefined && (
        <div className="addy-problem" role="alert">
          <AlertTriangle size={15} aria-hidden />
          <span>{problem}</span>
          <ReconnectButton />
        </div>
      )}
      {sync.error !== undefined && (
        <div className="addy-problem" role="alert">
          <AlertTriangle size={15} aria-hidden />
          <span>
            Sync last failed {ago(sync.error.at)} ago: {sync.error.message}
            {sync.error.code !== undefined && ` (${sync.error.code})`}
          </span>
        </div>
      )}
      {conflicts > 0 && (
        <div className="addy-note" role="status">
          <AlertTriangle size={15} aria-hidden />
          <span>
            {conflicts} {conflicts === 1 ? 'change was' : 'changes were'} made on two devices at
            once. OpsMaxx opens both versions over the app and asks which to keep — it cannot do
            that in the background, because only you know which one is right.
          </span>
        </div>
      )}
    </div>
  )
}
