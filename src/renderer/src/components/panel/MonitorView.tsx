import { Cpu, MemoryStick, HardDrive, ArrowDown, ArrowUp, Loader2, AlertTriangle } from 'lucide-react'
import { useServerMetrics } from '../../hooks/useServerMetrics'
import { Sparkline } from '../common/Sparkline'
import { rate, bytes, clsx } from '../../lib/format'
import { useEffect, useState } from 'react'
import { useFleet } from '../../store/fleet'
import { sshTargetFor } from '../../lib/ssh'
import { isStubResolver, type NetworkInfo } from '../../../../shared/network'
import {
  filterByProto,
  protoCounts,
  type ListeningPortsInfo,
  type ProtoFilter
} from '../../../../shared/listeningPorts'
import { LOCAL_ID, LOCAL_TARGET } from '../../../../shared/execTarget'
import type { Server } from '../../types'

function level(v: number): string {
  return v > 85 ? 'danger' : v > 65 ? 'warn' : 'ok'
}

function uptimeLabel(sec: number): string {
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  return `${d}d ${h}h ${m}m`
}

/**
 * Where these reads should run.
 *
 * The same distinction `useServerMetrics` makes, and it has to be made here
 * too: the network and listening-socket reads take a connection config, and
 * this machine is not reached by connecting to it. `isLocalTarget` in main is
 * deliberately exact, so the marker is sent as itself rather than mixed into
 * an SSH target that would otherwise name a host called `localhost`.
 */
const execTargetFor = (server: Server): ReturnType<typeof sshTargetFor> =>
  server.id === LOCAL_ID
    ? (LOCAL_TARGET as unknown as ReturnType<typeof sshTargetFor>)
    : sshTargetFor(server)

export function MonitorView({
  server,
  visible = true
}: {
  server: Server
  // The pane stays mounted once opened, so polling must follow visibility or
  // it keeps sampling over the shell's SSH connection in the background.
  visible?: boolean
}): React.JSX.Element {
  const m = useServerMetrics(server, visible && server.status !== 'offline')
  const real = server.demo === false
  const local = server.id === LOCAL_ID

  /**
   * Interfaces and resolvers, asked for once when the panel becomes visible.
   *
   * Not on the metrics poll: an address changes when somebody changes it, and
   * that poll shares the connection the terminal types over.
   */
  const [net, setNet] = useState<NetworkInfo | { error: string } | null>(null)
  useEffect(() => {
    if (!visible || !real) return
    let live = true
    void window.opsmaxx?.fleet
      ?.network?.(execTargetFor(server))
      .then((r) => {
        if (live) setNet(r)
      })
      .catch((e: unknown) => {
        if (live) setNet({ error: e instanceof Error ? e.message : String(e) })
      })
    return () => {
      live = false
    }
  }, [server, visible, real])

  /**
   * What is listening. Same on-demand shape as the network read above and for
   * the same reason: a listening socket changes when somebody deploys, and the
   * two-second metrics poll shares the connection the terminal types over.
   */
  const [ports, setPorts] = useState<ListeningPortsInfo | { error: string } | null>(null)
  /**
   * TCP by default, matching what a terminal shows.
   *
   * `ss -tlpn` and `lsof -i -P | grep LISTEN` are both TCP, so a panel that
   * listed UDP alongside it showed roughly twice the rows and read as wrong on
   * a host where it was right. UDP is one click away, never removed.
   */
  const [proto, setProto] = useState<ProtoFilter>('tcp')
  useEffect(() => {
    if (!visible || !real) return
    let live = true
    void window.opsmaxx?.fleet
      ?.listeningPorts?.(execTargetFor(server))
      .then((r) => {
        if (live) setPorts(r)
      })
      .catch((e: unknown) => {
        if (live) setPorts({ error: e instanceof Error ? e.message : String(e) })
      })
    return () => {
      live = false
    }
  }, [server, visible, real])

  // The distribution the host reported about itself, from the hourly facts
  // sweep. Absent until that has run at least once, which is why it falls back
  // to the stored `os` rather than blanking the row.
  const facts = useFleet((st) => st.facts[server.id]?.facts ?? null)
  const distro =
    facts?.prettyName ??
    (facts?.distroId
      ? `${facts.distroId}${facts.distroVersion ? ` ${facts.distroVersion}` : ''}`
      : null)

  // Worst first: the reason to look at this list is to find the full one.
  const mounts = [...(m.host?.mounts ?? [])].sort((a, b) => b.usedPercent - a.usedPercent)

  const info: [string, string][] = m.host
    ? [
        ['Hostname', m.host.hostname],
        // The DETECTED distribution, not the `os` field somebody typed when
        // they added the server. hostFacts has parsed /etc/os-release into
        // prettyName/distroId/distroVersion since it existed, and the
        // inventory panel already shows it — this panel was the one still
        // saying "Linux" at a person who wanted "Ubuntu 24.04".
        ['OS', distro ?? server.os],
        ['Kernel', m.host.kernel],
        ['Uptime', uptimeLabel(m.host.uptime)],
        ['CPU cores', `${m.host.cores} vCPU`],
        ['Memory', bytes(m.host.memTotal)],
        ['Disk', bytes(m.host.diskTotal)],
        // "not measured" rather than a percentage nobody took. memUsed is
        // still printed: it is what /proc/meminfo gave, and it is zero for the
        // same honest reason the percentage is absent.
        [
          // `MemTotal - MemAvailable`, which is what modern `free` calls used.
          'Used memory',
          `${bytes(m.host.memUsed)}${m.host.memPct === null ? '' : ` (${m.host.memPct.toFixed(0)}%)`}`
        ],
        // The columns beside it, so the headline is attributable. htop's Mem
        // bar excludes reclaimable cache and `free` counts it as available, so
        // the two differ by roughly the page cache — a difference nobody can
        // account for unless the parts are on screen.
        ...(m.host.memAvailable === null
          ? []
          : ([['Available memory', bytes(m.host.memAvailable)]] as [string, string][])),
        ...(m.host.memCache === null
          ? []
          : ([['Buffers / cache', bytes(m.host.memCache)]] as [string, string][])),
        [
          // Says WHICH filesystem. The headline has always been the root one —
          // every stored sample means that — and on a host whose data volume
          // is the full one, an unlabelled "57%" reads as the whole machine.
          'Used disk (/)',
          `${bytes(m.host.diskUsed)}${m.host.diskPct === null ? '' : ` (${m.host.diskPct.toFixed(0)}%)`}`
        ],
        ['Server / IP', server.host]
      ]
    : [
        ['Hostname', server.name.toLowerCase().replace(/\s+/g, '-')],
        ['OS', server.os],
        ['Kernel', '6.5.0-generic'],
        ['Uptime', '—'],
        ['CPU cores', '8 vCPU'],
        ['Memory', '16 GB'],
        ['Disk', '320 GB SSD'],
        ['Public IP', server.host],
        ['Private IP', '—'],
        ['Latency', '—']
      ]

  const Metric = ({
    label,
    icon,
    value,
    history,
    cores
  }: {
    label: string
    icon: React.ReactNode
    value: number
    history: number[]
    /** Per-core percentages, for the CPU card only. */
    cores?: number[] | null
  }): React.JSX.Element => (
    <div className="metric-card">
      <div className="m-head">
        <span className="row">
          {icon} {label}
        </span>
      </div>
      <div className="m-value">
        {value.toFixed(0)}
        <small>%</small>
      </div>
      <div className={clsx('bar', level(value))}>
        <span style={{ width: `${value}%` }} />
      </div>
      <Sparkline data={history} max={100} height={40} color={`var(--${level(value)})`} />
      {/* Per core, under the aggregate that names the card.
          One core pinned at 88% on an eight-core box is 11% of the machine.
          The headline says 11 and is right; without these ticks a person
          watching htop sees the 88 and concludes the headline is broken. Both
          numbers are true and they answer different questions. */}
      {cores !== undefined && cores !== null && cores.length > 1 && (
        <div className="row" style={{ gap: 2, marginTop: 6 }} title={cores.map((c, i) => `cpu${i}: ${c.toFixed(0)}%`).join('\n')}>
          {cores.map((c, i) => (
            <span
              key={i}
              className={clsx('core-tick', level(c))}
              style={{ height: `${Math.max(2, Math.round(c / 8) + 2)}px` }}
            />
          ))}
        </div>
      )}
    </div>
  )

  /**
   * What was read ABOUT the host rather than sampled from it.
   *
   * Held in a variable because it is rendered from two places. These reads do
   * not come from the metrics poll and do not fail with it, so hiding them
   * behind a metrics error would throw away an answer that arrived — and on
   * this machine, where the fleet overview's local card used to show exactly
   * these two things unconditionally, it would be a straight loss.
   */
  const hostReads = (
    <>
      {/* Interfaces, their addresses and the resolvers. The panel is a quick
          server overview, and "which address is this box on, and who resolves
          its names" is the part an administrator otherwise opens a shell for. */}
      {net !== null && 'error' in net && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="sidebar-title" style={{ marginBottom: 8 }}>
            Network
          </div>
          <span className="faint" style={{ fontSize: 11 }}>
            Could not be read: {net.error}
          </span>
        </div>
      )}

      {net !== null && 'interfaces' in net && (net.interfaces.length > 0 || net.dns.length > 0) && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="sidebar-title" style={{ marginBottom: 12 }}>
            Network
          </div>
          <div className="col" style={{ gap: 8 }}>
            {net.interfaces.map((iface) => (
              <div className="row" key={iface.name} style={{ alignItems: 'baseline', gap: 'var(--sp-3)' }}>
                <span className="mono" style={{ minWidth: 96 }}>
                  {iface.name}
                </span>
                <span className="col" style={{ gap: 2 }}>
                  {iface.addresses.map((a) => (
                    <span key={`${a.family}-${a.address}`} className="row" style={{ gap: 6 }}>
                      <span className="faint" style={{ fontSize: 11, minWidth: 34 }}>
                        {a.family === 'ipv4' ? 'IPv4' : 'IPv6'}
                      </span>
                      <span className="mono selectable">
                        {a.address}
                        {a.prefix === null ? '' : `/${a.prefix}`}
                      </span>
                    </span>
                  ))}
                </span>
              </div>
            ))}
            {net.dns.length > 0 && (
              <div className="row" style={{ alignItems: 'baseline', gap: 'var(--sp-3)' }}>
                <span className="mono" style={{ minWidth: 96 }}>
                  DNS
                </span>
                <span className="col" style={{ gap: 2 }}>
                  <span className="mono selectable">{net.dns.join('  ')}</span>
                  {/* Worth saying: "your DNS server is 127.0.0.53" sends people
                      looking for a problem that is not there. */}
                  {isStubResolver(net) && (
                    <span className="faint" style={{ fontSize: 11 }}>
                      systemd-resolved stub — the upstream resolvers are not in
                      /etc/resolv.conf
                    </span>
                  )}
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* What is listening, and who owns it. The other half of "which address
          is this box on": an administrator otherwise opens a shell and runs
          `ss -tulpn` as the first thing they do. */}
      {/* A failed read is SAID, not hidden. A card that silently vanishes when
          the probe fails is indistinguishable from a host with nothing
          listening, and those are opposite facts. */}
      {ports !== null && 'error' in ports && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="sidebar-title" style={{ marginBottom: 8 }}>
            Listening ports
          </div>
          <span className="faint" style={{ fontSize: 11 }}>
            Could not be read: {ports.error}
          </span>
        </div>
      )}

      {ports !== null && 'ports' in ports && ports.ports.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="row" style={{ marginBottom: 12, alignItems: 'baseline', gap: 'var(--sp-3)' }}>
            <span className="sidebar-title">Listening ports</span>
            {/* Every count on screen, so the filter says what it is hiding
                rather than implying there is nothing there. */}
            <div className="segment" style={{ marginLeft: 'auto' }}>
              {(['tcp', 'udp', 'all'] as const).map((f) => (
                <button
                  key={f}
                  className={clsx('seg-btn', proto === f && 'active')}
                  onClick={() => setProto(f)}
                >
                  {f === 'all' ? 'All' : f.toUpperCase()}{' '}
                  <span className="count">{protoCounts(ports.ports)[f]}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="col" style={{ gap: 4 }}>
            {filterByProto(ports.ports, proto).length === 0 && (
              <span className="faint" style={{ fontSize: 11 }}>
                Nothing is listening on {proto === 'all' ? 'this host' : proto.toUpperCase()}.
              </span>
            )}
            {filterByProto(ports.ports, proto).map((p) => (
              <div
                className="row"
                key={`${p.proto}-${p.address}-${p.port}`}
                style={{ alignItems: 'baseline', gap: 'var(--sp-3)' }}
              >
                <span className="mono selectable" style={{ minWidth: 62 }}>
                  {p.port}
                </span>
                <span className="faint" style={{ fontSize: 11, minWidth: 30 }}>
                  {p.proto}
                </span>
                <span className="mono selectable faint" style={{ fontSize: 11, minWidth: 120 }}>
                  {p.address}
                </span>
                {/* An em dash rather than a blank: "we could not see the owner"
                    and "nothing owns this socket" are different claims, and the
                    note below says which one this is. */}
                <span className="mono">{p.process ?? '\u2014'}</span>
                {p.pid !== undefined && (
                  <span className="faint" style={{ fontSize: 11 }}>
                    {p.pid}
                  </span>
                )}
              </div>
            ))}
            {/* Said plainly, because the alternative is a table that looks
                complete and is not. Unprivileged lsof on macOS cannot see other
                users' sockets at all, so the list is joined with netstat to stay
                complete — which leaves the OWNERS partial rather than the list
                short. That distinction is the whole point of saying this. */}
            {ports.partialOwners && (
              <span className="faint" style={{ fontSize: 11, marginTop: 4 }}>
                Some owning processes are not visible without elevated privileges. Every listening
                socket is listed.
              </span>
            )}
          </div>
        </div>
      )}
    </>
  )

  if (real && m.loading) {
    return (
      <div className="content">
        <div className="empty" style={{ height: 260 }}>
          <Loader2 size={22} className="spin" />
          <p>Collecting live metrics from {local ? 'this machine' : server.host}…</p>
        </div>
      </div>
    )
  }

  if (real && m.error) {
    return (
      <div className="content">
        <div className="empty" style={{ height: 260 }}>
          <div className="empty-icon" style={{ color: 'var(--danger)' }}>
            <AlertTriangle size={22} />
          </div>
          <h3>Metrics unavailable</h3>
          <p className="mono">{m.error}</p>
        </div>
        {hostReads}
      </div>
    )
  }

  return (
    <div className="content">
      {real && (
        <div className="row" style={{ marginBottom: 12 }}>
          <span className="chip ok">live</span>
          <span className="muted" style={{ fontSize: 12 }}>
            {/* This machine is not reached over SSH, and saying so would be a
                small lie in the one place the panel explains itself. */}
            {local ? 'polling every 2s on this machine' : 'polling every 2s over SSH'}
          </span>
        </div>
      )}
      <div className="monitor" style={{ marginBottom: 16 }}>
        <Metric
            label="CPU"
            icon={<Cpu size={13} />}
            value={m.cpu}
            history={m.cpuHistory}
            cores={m.host?.cpuCores ?? null}
          />
        <Metric label="Memory" icon={<MemoryStick size={13} />} value={m.ram} history={m.ramHistory} />
        <Metric label="Disk" icon={<HardDrive size={13} />} value={m.disk} history={m.diskHistory} />
        <div className="metric-card">
          <div className="m-head">
            <span>Network</span>
          </div>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div className="col" style={{ gap: 2 }}>
              <span className="muted" style={{ fontSize: 11 }}>
                <ArrowDown size={11} /> Download
              </span>
              <b className="mono">{rate(m.rx)}</b>
            </div>
            <div className="col" style={{ gap: 2 }}>
              <span className="muted" style={{ fontSize: 11 }}>
                <ArrowUp size={11} /> Upload
              </span>
              <b className="mono">{rate(m.tx)}</b>
            </div>
          </div>
          <Sparkline data={m.rxHistory} color="var(--info)" height={40} />
        </div>
      </div>

      {/* Every other filesystem, because the cards above are the root one and
          a server's full disk is very often not root. A media box with `/` at
          57% and `/data` at 95% showed nothing but the 57 — the number that
          says everything is fine. Percentages are df's own, taken from its
          Capacity column rather than recomputed. */}
      {mounts.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="sidebar-title" style={{ marginBottom: 12 }}>
            Filesystems
          </div>
          <div className="col" style={{ gap: 6 }}>
            {mounts.map((mt) => (
              <div className="row" key={mt.mount} style={{ alignItems: 'center', gap: 'var(--sp-3)' }}>
                <span className="mono ellipsis" style={{ flex: 1, minWidth: 0 }} title={mt.device}>
                  {mt.mount}
                </span>
                <span className="faint" style={{ fontSize: 11 }}>
                  {bytes(mt.usedKb * 1024)} of {bytes(mt.totalKb * 1024)}
                </span>
                <span className={clsx('chip', mt.usedPercent >= 90 && 'danger', mt.usedPercent >= 75 && mt.usedPercent < 90 && 'warn')}>
                  {mt.usedPercent}%
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {hostReads}

      <div className="card">
        <div className="sidebar-title" style={{ marginBottom: 12 }}>
          System information
        </div>
        <div className="info-grid">
          {info.map(([k, v]) => (
            <div className="info-item" key={k}>
              <span className="k">{k}</span>
              <span className="v selectable">{v}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
