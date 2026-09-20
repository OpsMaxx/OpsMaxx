import { useState } from 'react'
import {
  AlertTriangle,
  Check,
  Circle,
  CircleDot,
  Clock,
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
      await window.opsmaxx?.addy.syncNow()
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
      {steps[0].state !== 'done' && (
        <div className="addy-setup-slot">
          <h3 className="ui-section-title addy-h">Start here</h3>
          <AddySetup />
        </div>
      )}

      <h3 className="ui-section-title addy-h">Devices</h3>
      <AddyDevices devices={status?.devices} supported={supported} onChanged={refresh} />

      {/* Offered only once there is somewhere to send to. On a one-device
          account the shortcuts would be taken from every application on the
          machine in exchange for nothing at all. */}
      {status?.enrolled && <RekeyRow />}
      {status?.enrolled && <ClipboardShortcuts />}

      <AddyProblems status={status} />
    </PanelShell>
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
          toast(`Re-keyed: epoch ${r.epoch}, ${r.resealed} collections re-sealed`, 'ok')
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
function ClipboardShortcuts(): React.JSX.Element {
  const on = useApp((s) => s.settings.addyClipboardShortcuts === true)
  const setSettings = useApp((s) => s.setSettings)

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
            : 'roster not reported'}
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
            ? 'This build did not return a device list. Nothing is wrong with the account — the roster is simply not being read yet.'
            : 'This build cannot read the device roster. Pairing still works; what is missing is the readout of what came of it.'
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
          <th>Last seen</th>
          <th>Added</th>
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
            {/* `null` is "the relay has never seen it", which is a real state
                for a device that paired and has not been opened since — and it
                is not "0s ago", which is what a zero would print. */}
            <td>{d.lastSeen === null ? 'never' : `${ago(d.lastSeen)} ago`}</td>
            <td>{d.addedAt === null ? '—' : `${ago(d.addedAt)} ago`}</td>
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
        opens, and adding it back means pairing it again.
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
function AddyProblems({ status }: { status: AddyStatus | null }): React.JSX.Element | null {
  const sync = status?.sync
  if (sync === undefined) return null
  const conflicts = sync.conflicts
  if (sync.error === undefined && conflicts === 0) return null
  return (
    <div className="addy-problems">
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
