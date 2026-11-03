import { useEffect, useState } from 'react'
import { Box, ChevronRight, Database } from 'lucide-react'
import { clsx } from '../../lib/format'
import { useT } from '../../lib/i18n'
import { KIND_COLOR } from './DatabaseSidebar'
import type { DbContainer } from '../../../../shared/dockerDb'

// A product name and a protocol name, which are not translated.
const APP = 'OpsMaxx'
const SSH = 'SSH'

/**
 * Databases running in Docker where this connection is reached from.
 *
 * Shown only when there is something to pick: a host with no database
 * containers, or no Docker at all, gets no section and no error -- that is
 * the ordinary case, not a fault. The one failure worth a sentence is a
 * Docker this account may not use, because that is something they can fix.
 */
export function DockerDbPicker({
  target,
  where,
  selected,
  onPick
}: {
  /** The SSH hop, or LOCAL_TARGET for this computer. */
  target: unknown
  /** "prod-1" or "this computer", for the copy. */
  where: string
  selected: string | null
  onPick: (c: DbContainer) => void
}): React.JSX.Element | null {
  const t = useT()
  const [found, setFound] = useState<DbContainer[] | null>(null)
  const [noAccess, setNoAccess] = useState(false)

  useEffect(() => {
    let live = true
    setFound(null)
    setNoAccess(false)
    const fn = window.opsmaxx?.docker?.dbContainers
    if (!fn) return
    void fn(target)
      .then((r) => {
        if (!live) return
        if (r.ok) setFound(r.containers)
        else setNoAccess(r.reason === 'permission-denied')
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
    // The target is rebuilt every render; what it points at is `where`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [where])

  if (noAccess) return <span className="field-hint">{t('databases.add.docker.noAccess', { where })}</span>
  if (!found || found.length === 0) return null

  return (
    <div className="field">
      <label className="field-label">{t('databases.add.docker.found', { where })}</label>
      <div className="col" style={{ gap: 6 }}>
        {found.map((c) => (
          <button
            key={c.name}
            type="button"
            className={clsx('radio-card', selected === c.name && 'active')}
            // A row, not .radio-card's stacked tile: these are list items.
            style={{ flexDirection: 'row', justifyContent: 'flex-start', gap: 10, padding: '8px 12px' }}
            onClick={() => onPick(c)}
          >
            <Database size={16} style={{ color: KIND_COLOR[c.kind] }} />
            <span style={{ fontWeight: 600 }}>{c.name}</span>
            <span className="grow" style={{ color: 'var(--text-muted)', textAlign: 'left' }}>
              {c.image} · {c.port}
            </span>
            {c.published ? (
              <span className="chip">{t('databases.add.docker.published')}</span>
            ) : (
              <span className="chip ok">{t('databases.add.docker.notExposed')}</span>
            )}
          </button>
        ))}
      </div>
      <span className="field-hint">{t('databases.add.docker.orType')}</span>
    </div>
  )
}

/** The host field's stand-in once a container is chosen. */
export function ContainerChip({ name, onClear }: { name: string; onClear: () => void }): React.JSX.Element {
  const t = useT()
  return (
    <div className="input row" style={{ gap: 8, alignItems: 'center' }}>
      <Box size={14} style={{ flex: 'none' }} />
      <span className="grow" style={{ minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {t('databases.add.docker.chip', { name })}
      </span>
      <button type="button" className="btn ghost size-28" style={{ flex: 'none' }} onClick={onClear}>
        {t('databases.add.docker.clear')}
      </button>
    </div>
  )
}

/**
 * "How this connects", folded away by default.
 *
 * For the reader who wants to know why a database with no published port is
 * reachable at all, and whether that opened anything. Everyone else never
 * opens it.
 */
export function ContainerExplainer({
  container,
  server
}: {
  container: string
  /** The SSH server's name, or null for this computer. */
  server: string | null
}): React.JSX.Element {
  const t = useT()
  const box = { fill: 'var(--bg-elevated)', stroke: 'var(--border-strong)', strokeWidth: 1 }
  const label = { fill: 'var(--text)', fontSize: 'var(--fs-sm)', fontWeight: 600 }
  const sub = { fill: 'var(--text-muted)', fontSize: 'var(--fs-xs)' }
  const host = server ?? t('databases.add.docker.thisComputer')
  return (
    // flex: none, or the modal body's column squeezes it to its border.
    <details className="disclosure" style={{ flex: 'none' }}>
      <summary className="disclosure-head">
        <ChevronRight size={14} className="chev" />
        {t('databases.add.docker.how')}
      </summary>
      <div className="disclosure-body">
        <svg width="100%" viewBox="0 0 560 120" role="img" aria-label={t('databases.add.docker.how')}>
          <defs>
            <marker id="cx-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
              <path d="M2 1L8 5L2 9" fill="none" stroke="var(--text-muted)" strokeWidth="1.5" />
            </marker>
          </defs>
          {server && (
            <>
              <rect x="4" y="34" width="120" height="48" rx="8" {...box} />
              <text x="64" y="54" textAnchor="middle" style={label}>{APP}</text>
              <text x="64" y="70" textAnchor="middle" style={sub}>{t('databases.add.docker.yourComputer')}</text>
              <line x1="126" y1="58" x2="166" y2="58" stroke="var(--text-muted)" markerEnd="url(#cx-arrow)" />
              <text x="146" y="50" textAnchor="middle" style={sub}>{SSH}</text>
            </>
          )}
          <rect x={server ? 170 : 4} y="6" width={server ? 386 : 552} height="108" rx="12" fill="none" stroke="var(--border-strong)" />
          <text x={server ? 184 : 18} y="26" style={label}>{host}</text>
          <rect x={server ? 184 : 18} y="40" width="130" height="48" rx="8" {...box} />
          <text x={server ? 249 : 83} y="60" textAnchor="middle" style={label}>
            {server ? t('databases.add.docker.server') : APP}
          </text>
          <text x={server ? 249 : 83} y="76" textAnchor="middle" style={sub}>{t('databases.add.docker.opensHop')}</text>
          <line x1={server ? 316 : 150} y1="64" x2={server ? 352 : 186} y2="64" stroke="var(--text-muted)" markerEnd="url(#cx-arrow)" />
          <rect x={server ? 356 : 190} y="34" width={server ? 190 : 356} height="60" rx="10" fill="var(--accent-soft)" stroke="var(--accent-border)" strokeDasharray="4 3" />
          <text x={server ? 451 : 368} y="58" textAnchor="middle" style={label}>{container}</text>
          <text x={server ? 451 : 368} y="76" textAnchor="middle" style={sub}>{t('databases.add.docker.privateNetwork')}</text>
        </svg>
        <p className="field-hint" style={{ marginTop: 8 }}>
          {server ? t('databases.add.docker.howSsh', { server }) : t('databases.add.docker.howLocal')}
        </p>
      </div>
    </details>
  )
}
