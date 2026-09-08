import { useCallback, useState } from 'react'
import { Plus, RefreshCw, ServerCog } from 'lucide-react'
import { clsx } from '../../lib/format'
import { openSettings, openUnitInstall } from '../../store/nav'
import { summariseUserUnits, type UserUnitsReading } from '../../../../shared/userUnits'
import type { Server } from '../../types'
import { PanelShell } from './PanelShell'
import { PanelError } from '../common/PanelError'
import { withVaultUnlock, isVaultLocked } from '../../lib/withVaultUnlock'
import { sshTargetFor } from '../../lib/ssh'

// What each server supervises for this account, read from its own systemd.
//
// The panel's job is one sentence, and it is not the unit list: a `--user`
// service stops when the account's last session ends unless that account is
// lingering, so a list of `running` units read over SSH can be a list of things
// that are about to stop. summariseUserUnits() decides that; this renders it
// first and the units underneath.
//
// READ-ONLY, AND NOW ACTUALLY. This panel used to carry a New service form that
// wrote a unit file onto a host, under a subtitle that said "Read-only —
// nothing is started, stopped or written here". The form has moved to
// Operations › Jobs › Install a service (see UnitInstallPanel), which is what
// made the sentence above it true. `openUnitInstall` is what is left in its
// place: a pointer, because a control that simply vanishes teaches a person the
// feature broke rather than that it moved.

interface Row {
  serverId: string
  serverName: string
  reading: UserUnitsReading
}

export function ServicesPanel({ servers }: { servers: Server[] }): React.JSX.Element {
  // `null` until read, never `[]`. Rendering an empty list as "nothing is
  // supervised" before asking is the claim this app has been fixing all week.
  const [rows, setRows] = useState<Row[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const bridge = (): { collect?: (t: unknown[]) => Promise<Row[]> } | undefined =>
    (window.opsmaxx as { services?: { collect?: (t: unknown[]) => Promise<Row[]> } } | undefined)
      ?.services

  const read = useCallback(async (): Promise<void> => {
    const collect = bridge()?.collect
    if (typeof collect !== 'function') {
      setError('This build’s preload does not expose server services yet. Restart the app to rebuild it.')
      setRows([])
      return
    }
    setLoading(true)
    setError(null)
    try {
      // sshTargetFor, NOT the Server. Found by running this against a real
      // server with a vault credential: a Server carries its id as `id` and
      // its jump chain as `route`, while main reads `serverId` and `hops`. So
      // a raw Server crosses the bridge, resolves NOTHING, and the host is
      // dialled with no credential at all —
      //
      //   No private key is configured for root@<host>. Edit the server and
      //   select a key file, or switch it to password/agent authentication.
      //
      // on a server that has a perfectly good key in the vault. It is the same
      // defect the storage, kernel and cron reads each shipped and fixed; this
      // panel was simply never on that list. See the note on sshTargetFor.
      const targets = servers.map((s) => ({
        serverId: s.id,
        serverName: s.name,
        cfg: sshTargetFor(s)
      }))
      // A locked vault is the one failure with an answer that is not "read the
      // message and go elsewhere", so it gets the prompt and one retry rather
      // than a red note carrying an internal token.
      setRows(
        await withVaultUnlock('Reading what each server supervises needs its stored credential.', () =>
          collect(targets)
        )
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [servers])

  // WHY A DISABLED BUTTON NEEDS A SENTENCE.
  //
  // A tester reported "Read services appears unavailable" — he hovered, got the
  // not-allowed cursor, and had nothing telling him whether that was a
  // permission, an unsupported OS, or a broken build. It is neither: the read
  // opens a channel to every server in the workspace in one call, and on a
  // fifteen-host estate that takes long enough that the disabled-while-loading
  // state is most of what anyone sees. A cursor is not an explanation, so the
  // button now carries the reason and the label says the read is in progress.
  const disabledReason = (): string | null => {
    if (servers.length === 0) return 'This workspace has no servers to ask.'
    if (loading) {
      return `Reading ${servers.length} server${servers.length === 1 ? '' : 's'}. Each is asked over its own connection, so this takes longer on a large estate.`
    }
    return null
  }

  // The first host whose reading is a locked vault rather than a unit list.
  // One banner, not one per host: the vault is a single thing and unlocking it
  // fixes every row at once.
  const lockedDetail =
    rows?.map((r) => r.reading.detail).find((d) => isVaultLocked(d)) ?? null

  const readNow = (primary: boolean): React.JSX.Element => {
    const why = disabledReason()
    return (
      <button
        className={primary ? 'btn primary sm' : 'btn ghost sm'}
        disabled={loading || servers.length === 0}
        // Present whether or not the button is disabled: the enabled tooltip
        // says what pressing it does, and the disabled one says why it will
        // not — a control that goes silent exactly when it stops working is
        // the shape of this whole report.
        title={
          why ??
          'Asks each server in this workspace what its own systemd is supervising for your account. Read-only.'
        }
        onClick={() => void read()}
      >
        <RefreshCw size={13} className={clsx(loading && 'spin')} />{' '}
        {loading
          ? `Reading ${servers.length}…`
          : rows
            ? 'Refresh'
            : 'Read services'}
      </button>
    )
  }

  return (
    // This panel had the root cause of M11 in its markup twice over: the header
    // sat on `.panel-body`, a LAYOUT class with no card, and it was built from
    // `.panel-title` — which this stylesheet has never defined — over
    // `.panel-subtitle`, which is defined bold and full-strength. So the
    // heading drew as ordinary body text and the four-line description under it
    // drew heavier than the heading. Hierarchy exactly inverted, by absence.
    <PanelShell
      icon={<ServerCog size={14} />}
      title="Server services"
      about={
        <p>
          What each server&rsquo;s own systemd supervises for your account. Read-only — nothing is
          started, stopped or written here, because the server&rsquo;s supervisor is the one that
          is still there when OpsMaxx is not. Installing a unit writes a file onto a host, so
          it lives on the Operations rail.
        </p>
      }
      actions={readNow(rows === null)}
    >

      {/* Two places a locked vault can surface, because the handler reports
          BOTH ways. `services:collect` catches per target and pushes a reading
          per host, so most of the time the marker is down in a row's detail
          and nothing was ever thrown — the reason the first cut of this,
          which only handled the rejection, did nothing at all in practice. */}
      <PanelError
        error={error ?? lockedDetail}
        reason="Reading what each server supervises needs its stored credential."
        onRetry={() => void read()}
      />

      {loading && rows === null ? (
        // A progress state of its own. Previously the panel kept saying
        // "Nothing read yet. Press Read services" while the read it is
        // describing was already running behind a disabled button — an
        // instruction to press the thing you just pressed.
        <div className="panel-empty">
          <p className="panel-empty-title">
            Reading {servers.length} server{servers.length === 1 ? '' : 's'}…
          </p>
          <p className="panel-empty-body">
            Each is asked over its own connection, so a large estate takes a moment. Servers that
            are unreachable or have no systemd are reported rather than skipped.
          </p>
        </div>
      ) : rows === null ? (
        <div className="panel-empty">
          <p className="panel-empty-title">Nothing read yet.</p>
          <p className="panel-empty-body">
            Press <b>Read services</b> to ask each server what it is supervising for you.
          </p>
        </div>
      ) : rows.length === 0 ? (
        <div className="panel-empty">
          <p className="panel-empty-title">No servers to ask.</p>
          <p className="panel-empty-body">
            Add a server to this workspace, or <button className="btn ghost sm" onClick={() => openSettings('modules')}>open Settings</button> to
            check which are in it.
          </p>
        </div>
      ) : (
        rows.map((r) => {
          const s = summariseUserUnits(r.reading)
          const shown = r.reading.units.filter((u) => u.load !== 'not-found')
          // The banner above already says the vault is locked and offers the
          // unlock. Repeating the resolver's marker here — once in the summary
          // headline it was built from, and again as the detail line — is the
          // raw token back on screen three times over.
          const locked = isVaultLocked(r.reading.detail)
          return (
            <div key={r.serverId} className="list-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
              <div className="r-title">
                {r.serverName}{' '}
                <span className={clsx(s.level === 'ok' ? 'ok' : s.level === 'alarm' ? 'danger' : 'state-unknown')}>
                  · {s.level}
                </span>
              </div>
              {/* The headline first and the list second, deliberately: the list
                  is what people look at and the sentence is what they need. */}
              <div className={clsx('r-sub', s.level === 'alarm' && 'danger')}>
                {locked ? 'Not read — this server’s credential is in the locked vault.' : s.headline}
              </div>
              {!locked && r.reading.detail && (
                <div className="r-sub faint mono">{r.reading.detail}</div>
              )}
              {/* A POINTER, not the form it replaced. It lands on the installer
                  with this server already chosen, which is the one fact the
                  operator was looking at when they pressed it — and it lands
                  before the preview, the confirmation and the write, so
                  arriving with an intention skips no question. */}
              <div className="row-actions" style={{ marginTop: 6 }}>
                <button
                  className="btn sm"
                  data-testid={`install-on-${r.serverId}`}
                  title="Opens Operations › Jobs › Install a service, with this server chosen. Writing a unit file changes a server, so it lives on the rail where everything does."
                  onClick={() => openUnitInstall(r.serverId)}
                >
                  <Plus size={12} /> New service…
                </button>
              </div>
              {shown.length > 0 && (
                <table className="mini-table">
                  <tbody>
                    {shown.map((u) => (
                      <tr key={u.name}>
                        <td>{u.name}</td>
                        <td className={clsx(u.active === 'failed' && 'danger')}>{u.active}</td>
                        <td className="faint">{u.sub}</td>
                        <td className="faint">{u.description}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )
        })
      )}
    </PanelShell>
  )
}
