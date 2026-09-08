import { Cpu, MemoryStick, HardDrive, ArrowDown, ArrowUp, Loader2, AlertTriangle } from 'lucide-react'
import { useServerMetrics } from '../../hooks/useServerMetrics'
import { Sparkline } from '../common/Sparkline'
import { rate, bytes, clsx } from '../../lib/format'
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

  // Worst first: the reason to look at this list is to find the full one.
  const mounts = [...(m.host?.mounts ?? [])].sort((a, b) => b.usedPercent - a.usedPercent)

  const info: [string, string][] = m.host
    ? [
        ['Hostname', m.host.hostname],
        ['OS', server.os],
        ['Kernel', m.host.kernel],
        ['Uptime', uptimeLabel(m.host.uptime)],
        ['CPU cores', `${m.host.cores} vCPU`],
        ['Memory', bytes(m.host.memTotal)],
        ['Disk', bytes(m.host.diskTotal)],
        // "not measured" rather than a percentage nobody took. memUsed is
        // still printed: it is what /proc/meminfo gave, and it is zero for the
        // same honest reason the percentage is absent.
        [
          'Used memory',
          `${bytes(m.host.memUsed)}${m.host.memPct === null ? '' : ` (${m.host.memPct.toFixed(0)}%)`}`
        ],
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
    history
  }: {
    label: string
    icon: React.ReactNode
    value: number
    history: number[]
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
    </div>
  )

  if (real && m.loading) {
    return (
      <div className="content">
        <div className="empty" style={{ height: 260 }}>
          <Loader2 size={22} className="spin" />
          <p>Collecting live metrics from {server.host}…</p>
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
      </div>
    )
  }

  return (
    <div className="content">
      {real && (
        <div className="row" style={{ marginBottom: 12 }}>
          <span className="chip ok">live</span>
          <span className="muted" style={{ fontSize: 12 }}>
            polling every 2s over SSH
          </span>
        </div>
      )}
      <div className="monitor" style={{ marginBottom: 16 }}>
        <Metric label="CPU" icon={<Cpu size={13} />} value={m.cpu} history={m.cpuHistory} />
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
