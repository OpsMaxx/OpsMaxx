import { Cpu, HardDrive, MemoryStick, Server as ServerIcon, CircleAlert, Unplug } from 'lucide-react'
import type { FleetHealth } from '../../../../shared/hostHealth'
import type { FleetTotals } from '../../store/fleet'
import { bytes, clsx } from '../../lib/format'

/**
 * The estate in one band, at the top of the overview.
 *
 * The overview used to open with per-host failure blocks, then a raw list of
 * every port open on this machine, and only then these numbers — so the
 * question a monitoring screen exists to answer, "is the estate all right",
 * was below two screens of detail, and the capacity figures a person actually
 * reads first were in the middle of the page.
 *
 * ── What makes this a dashboard rather than four numbers ───────────────────
 *
 * Every tile answers a question, and the ones that can be WRONG say so:
 *
 *  - Reporting is `n of m` whenever they differ, because "5 servers" beside a
 *    fleet of eight is a lie of omission.
 *  - Attention exists only when something needs it. A permanent "0 failed"
 *    tile trains people to stop reading the row.
 *  - The two capacity tiles carry a meter, because 32 GiB of 99 GiB means
 *    nothing until you see it against the bar — and the percentage is what an
 *    operator acts on, not the absolute.
 *
 * Semantic colour is kept for state (danger, warning) and never spent on
 * decoration, so the one red thing in the row is the thing that is wrong.
 */

interface FleetKpisProps {
  totals: FleetTotals
  health: FleetHealth
  serverCount: number
}

function pctOf(used: number, total: number): number {
  return total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0
}

/**
 * A tile whose value is a proportion.
 *
 * The meter is the point: an absolute pair of byte counts is a reading a
 * person has to do arithmetic on, and a bar is one they can act on at a
 * glance. Thresholds match the alert store's own idea of trouble so the
 * dashboard and the alerts cannot disagree about what "nearly full" means.
 */
function MeterTile({
  icon,
  label,
  used,
  total
}: {
  icon: React.ReactNode
  label: string
  used: number
  total: number
}): React.JSX.Element {
  const p = pctOf(used, total)
  const tone = p >= 90 ? 'danger' : p >= 75 ? 'warn' : 'ok'
  return (
    <div className="kpi">
      <div className="kpi-top">
        <span className="kpi-icon">{icon}</span>
        <span className="kpi-label">{label}</span>
      </div>
      <div className="kpi-value">
        {p}
        <span className="kpi-unit">%</span>
      </div>
      <div
        className="kpi-meter"
        role="meter"
        aria-valuenow={p}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${label} used`}
      >
        <span className={clsx('kpi-meter-fill', tone)} style={{ width: `${p}%` }} />
      </div>
      {/* The absolutes stay, below the proportion rather than instead of it:
          the percentage is for deciding, the bytes are for reporting. */}
      <div className="kpi-sub">
        {bytes(used)} of {bytes(total)}
      </div>
    </div>
  )
}

export function FleetKpis({ totals, health, serverCount }: FleetKpisProps): React.JSX.Element {
  const unreachable = health.unreachable.length
  const reportingLabel =
    totals.reporting === serverCount ? 'reporting' : `of ${serverCount} reporting`

  return (
    <section className="kpi-band" aria-label="Fleet summary">
      <div className="kpi">
        <div className="kpi-top">
          <span className="kpi-icon">
            <ServerIcon size={13} />
          </span>
          <span className="kpi-label">Servers</span>
        </div>
        <div className="kpi-value">{totals.reporting}</div>
        <div className="kpi-sub">{reportingLabel}</div>
      </div>

      {/* Only when there is something to say. A tile that reads "0 failed"
          every day is a tile people stop seeing, and then it reads "3 failed"
          on the one day it matters and nobody notices. */}
      {health.failedUnits > 0 && (
        <div className="kpi danger">
          <div className="kpi-top">
            <span className="kpi-icon">
              <CircleAlert size={13} />
            </span>
            <span className="kpi-label">Failed services</span>
          </div>
          <div className="kpi-value">{health.failedUnits}</div>
          <div className="kpi-sub">
            on {health.failingHosts} {health.failingHosts === 1 ? 'server' : 'servers'}
          </div>
        </div>
      )}

      {unreachable > 0 && (
        <div className="kpi warn">
          <div className="kpi-top">
            <span className="kpi-icon">
              <Unplug size={13} />
            </span>
            <span className="kpi-label">Unreachable</span>
          </div>
          <div className="kpi-value">{unreachable}</div>
          <div className="kpi-sub">
            {unreachable === 1 ? 'server did not answer' : 'servers did not answer'}
          </div>
        </div>
      )}

      <div className="kpi">
        <div className="kpi-top">
          <span className="kpi-icon">
            <Cpu size={13} />
          </span>
          <span className="kpi-label">vCPU</span>
        </div>
        <div className="kpi-value">{totals.cores}</div>
        <div className="kpi-sub">across the estate</div>
      </div>

      <MeterTile
        icon={<MemoryStick size={13} />}
        label="Memory"
        used={totals.memUsed}
        total={totals.memTotal}
      />
      <MeterTile
        icon={<HardDrive size={13} />}
        label="Disk"
        used={totals.diskUsed}
        total={totals.diskTotal}
      />
    </section>
  )
}
