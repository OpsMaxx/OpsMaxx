import { useCallback, useState } from 'react'
import { Plus, RefreshCw, ServerCog } from 'lucide-react'
import { clsx } from '../../lib/format'
import { openSettings, openUnitInstall } from '../../store/nav'
import { summariseUserUnits, type UserUnitsReading } from '../../../../shared/userUnits'
import type { Server } from '../../types'
import { PanelShell } from './PanelShell'

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
      const targets = servers.map((s) => ({ serverId: s.id, serverName: s.name, cfg: s }))
      setRows(await collect(targets))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [servers])

  const readNow = (primary: boolean): React.JSX.Element => (
    <button
      className={primary ? 'btn primary sm' : 'btn ghost sm'}
      disabled={loading || servers.length === 0}
      onClick={() => void read()}
    >
      <RefreshCw size={13} className={clsx(loading && 'spin')} /> {rows ? 'Refresh' : 'Read services'}
    </button>
  )

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

      {error && <div className="panel-note is-alarm">{error}</div>}

      {rows === null ? (
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
              <div className={clsx('r-sub', s.level === 'alarm' && 'danger')}>{s.headline}</div>
              {r.reading.detail && <div className="r-sub faint mono">{r.reading.detail}</div>}
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
