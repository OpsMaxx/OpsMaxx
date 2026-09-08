import { useState } from 'react'
import { HeartPulse, RefreshCw, TriangleAlert } from 'lucide-react'
import { clsx } from '../../lib/format'
import {
  DOCKER_FAILURE_HELP,
  healthHeadline,
  sortUnhealthyFirst,
  type DockerHealthLog,
  type DockerHealthLogProbe
} from '../../../../shared/docker'

// Item 42's health log on screen.
//
// The list is sorted worst-first by `sortUnhealthyFirst`, and the reason that
// is not just "unhealthy at the top" is the measured `starting` case: a
// container inside a five-minute start period whose every check has failed
// reports the same hopeful word as one that genuinely has not finished
// starting. The sort puts the first directly behind the unhealthy and the
// second below them, and the headline says which it is.
//
// The output shown here has already been through main's redactor -- see
// `DockerReader.healthLogs`. This component never sees the raw form, which is
// the point of redacting where the reader is rather than where the parse is.

function tone(log: DockerHealthLog): string {
  if (log.status === 'unhealthy') return 'danger'
  if (log.status === 'starting') {
    return log.entries.length > 0 && log.entries.every((e) => e.exitCode !== 0) ? 'danger' : 'warn'
  }
  if (log.status === null) return 'state-unknown'
  return ''
}

function Entries({ log }: { log: DockerHealthLog }): React.JSX.Element | null {
  if (log.entries.length === 0) return null
  return (
    <table className="mini-table">
      <tbody>
        {[...log.entries].reverse().map((e) => (
          <tr key={`${e.start}-${e.end}`}>
            <td className="mono faint">{e.start.slice(11, 19)}</td>
            <td className={clsx('mono', e.exitCode !== 0 && 'danger')}>
              {e.exitCode === null ? 'exit ?' : `exit ${e.exitCode}`}
            </td>
            {/* Whatever the check printed. Empty is its own answer: a check
                that fails silently gives an operator nothing to go on, and
                saying so beats an empty cell that reads as a rendering bug. */}
            <td className="mono" style={{ whiteSpace: 'pre-wrap' }}>
              {e.output.trim() === '' ? 'printed nothing' : e.output.trim()}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export function HealthLogPanel({
  refs,
  read
}: {
  refs: string[]
  read: (refs: string[]) => Promise<DockerHealthLogProbe>
}): React.JSX.Element | null {
  const [probe, setProbe] = useState<DockerHealthLogProbe | null>(null)
  const [loading, setLoading] = useState(false)

  if (refs.length === 0) return null

  const load = async (): Promise<void> => {
    setLoading(true)
    try {
      setProbe(await read(refs))
    } catch (e) {
      setProbe({ ok: false, reason: 'unknown', detail: e instanceof Error ? e.message : String(e) })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ padding: '4px 0 10px 12px', fontSize: 11 }}>
      <div className="row" style={{ gap: 8, alignItems: 'center' }}>
        <button className="btn ghost sm" disabled={loading} onClick={() => void load()}>
          <HeartPulse size={12} /> {probe === null ? 'Read healthchecks' : 'Refresh'}
          {loading && <RefreshCw size={11} className="spin" />}
        </button>
      </div>

      {probe !== null && !probe.ok && (
        <div className="s-desc danger" style={{ marginTop: 6 }}>
          <TriangleAlert size={12} /> {DOCKER_FAILURE_HELP[probe.reason]}
          <div className="mono" style={{ marginTop: 4, opacity: 0.8 }}>
            {probe.detail}
          </div>
        </div>
      )}

      {probe?.ok === true &&
        sortUnhealthyFirst(probe.logs).map((log) => (
          <div key={log.container} className="list-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
            <div className="r-title">
              <span className="mono">{log.container}</span>{' '}
              <span className={clsx('chip', tone(log))}>{log.status ?? 'no healthcheck'}</span>
            </div>
            <div className={clsx('r-sub', tone(log) === 'danger' && 'danger')}>{healthHeadline(log)}</div>
            <Entries log={log} />
          </div>
        ))}
    </div>
  )
}
