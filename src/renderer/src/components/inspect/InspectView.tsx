import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Check, Copy, Play, Radar, ShieldCheck, Square, Trash2, X } from 'lucide-react'
import { EmptyState } from '../common/EmptyState'
import { clsx } from '../../lib/format'
import { useInspect } from './useInspect'
import { InspectFlowDetail } from './InspectFlowDetail'
import type { InspectFlow, InspectSourceKind } from '../../../../shared/inspect'
import { isSensitiveHeader } from '../../../../shared/inspect'

/**
 * The HTTPS traffic inspector.
 *
 * The panel is built around one claim: what you are looking at is the truth
 * about what this machine is saying. Everything that could make that claim
 * false is shown, not hidden — a host that could not be intercepted, a trust
 * store that does not accept our certificate, an upstream check that has been
 * turned off. A traffic inspector that silently omits what it could not see is
 * worse than no traffic inspector, because it is believed.
 */
export function InspectView(): React.JSX.Element {
  const { status, flows, selectedId, busy, error } = useInspect()
  const wire = useInspect((s) => s.wire)
  const refresh = useInspect((s) => s.refresh)
  const start = useInspect((s) => s.start)
  const stop = useInspect((s) => s.stop)
  const clear = useInspect((s) => s.clear)
  const select = useInspect((s) => s.select)
  const allowPinned = useInspect((s) => s.allowPinned)
  const installTrust = useInspect((s) => s.installTrust)

  const [filter, setFilter] = useState('')
  const [source, setSource] = useState<InspectSourceKind>('sessions')

  useEffect(() => {
    const off = wire()
    void refresh()
    return off
  }, [wire, refresh])

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return flows
    return flows.filter((f) => {
      const { method, host, path, query } = f.request
      return `${method} ${host}${path}${query ?? ''}`.toLowerCase().includes(q)
    })
  }, [flows, filter])

  const selected = flows.find((f) => f.id === selectedId) ?? null
  const running = status?.running === true
  const systemTrust = status?.trust.find((t) => t.id === 'system')

  return (
    <div className="content">
      <div className="content-header">
        <div>
          <h1>Traffic</h1>
          <div className="sub">
            {running && status?.listening
              ? `Capturing on ${status.listening.host}:${status.listening.port}`
              : 'Inspect the HTTP and HTTPS requests leaving this machine'}
          </div>
        </div>
        <div className="spacer" />

        {!running && (
          <select
            className="input size-28"
            value={source}
            onChange={(e) => setSource(e.target.value as InspectSourceKind)}
            aria-label="What to capture"
            style={{ maxWidth: 260 }}
          >
            <option value="sessions">Terminals OpsMaxx opens</option>
            <option value="system">This whole machine</option>
            <option value="manual">Nothing automatically</option>
          </select>
        )}

        {running ? (
          <button className="btn secondary size-28" onClick={() => void stop()} disabled={busy}>
            <Square size={14} /> Stop
          </button>
        ) : (
          <button className="btn primary size-28" onClick={() => void start({ source })} disabled={busy}>
            <Play size={14} /> Start capture
          </button>
        )}
        {running && <CopyEnvButton />}
        <button
          className="btn secondary size-28"
          onClick={() => void clear()}
          disabled={flows.length === 0}
        >
          <Trash2 size={14} /> Clear
        </button>
      </div>

      {error && (
        <div className="banner danger" role="alert">
          <AlertTriangle size={14} /> {error}
        </div>
      )}

      {/* The listener is bound to something other than loopback, which makes it
          an open proxy for anyone on the same network. Said plainly rather than
          as a subtle badge. */}
      {running && status?.lanExposed && (
        <div className="banner warn">
          <AlertTriangle size={14} /> This proxy is reachable from your local network, not just
          this machine.
        </div>
      )}

      {running && status?.insecureUpstream && (
        <div className="banner danger">
          <AlertTriangle size={14} /> Upstream certificates are not being verified. Every connection
          through this proxy is unauthenticated.
        </div>
      )}

      {status?.stoppedReason && !running && (
        <div className="banner warn">
          <AlertTriangle size={14} /> {status.stoppedReason}
        </div>
      )}

      {/* Trust comes before flows, because an untrusted certificate is the
          reason a first-time user sees nothing at all. */}
      {status?.ca && systemTrust && systemTrust.state !== 'trusted' && (
        <div className="banner">
          <ShieldCheck size={14} />
          <span>
            {systemTrust.hint ?? 'Install OpsMaxx’s certificate to read HTTPS traffic.'}
          </span>
          <div className="spacer" />
          {systemTrust.installable && (
            <button
              className="btn primary size-24"
              onClick={() => void installTrust('system')}
              disabled={busy}
            >
              Install certificate
            </button>
          )}
        </div>
      )}

      {/* A host that refused our certificate. The only remedy is to stop
          intercepting it, so that is the button. */}
      {status?.pinned.map((p) => (
        <div className="banner warn" key={p.host}>
          <AlertTriangle size={14} />
          <span>
            <strong>{p.host}</strong> checks its certificate and will not accept OpsMaxx’s. It
            cannot be inspected.
          </span>
          <div className="spacer" />
          <button className="btn secondary size-24" onClick={() => void allowPinned(p.host)}>
            Let it through untouched
          </button>
        </div>
      ))}

      {status?.ca && <CaCard />}

      <div className="row" style={{ gap: 'var(--sp-2)', padding: '8px 0' }}>
        <input
          className="input size-28"
          placeholder="Filter by method, host or path"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Filter flows"
        />
        <div className="sub">
          {shown.length === flows.length
            ? `${flows.length} ${flows.length === 1 ? 'request' : 'requests'}`
            : `${shown.length} of ${flows.length}`}
        </div>
      </div>

      {flows.length === 0 ? (
        <EmptyState
          icon={<Radar size={26} />}
          title={running ? 'Listening' : 'Nothing captured yet'}
          message={
            running
              ? 'Requests appear here as they happen. Local terminals you open now are routed through the inspector automatically.'
              : 'Start capture, then use a terminal or your browser. OpsMaxx decrypts HTTPS with a certificate authority it generates for this machine.'
          }
          action={
            running ? undefined : (
              <button className="btn primary" onClick={() => void start({ source })}>
                <Play size={15} /> Start capture
              </button>
            )
          }
        />
      ) : (
        <div className="row" style={{ alignItems: 'stretch', gap: 'var(--sp-2)', minHeight: 0 }}>
          <FlowTable flows={shown} selectedId={selectedId} onSelect={select} />
          {selected && <InspectFlowDetail flow={selected} onClose={() => select(null)} />}
        </div>
      )}
    </div>
  )
}

/**
 * The export lines for a shell OpsMaxx did not open.
 *
 * This is the whole answer for a remote session: `sshd` will not carry these
 * variables for us, so the honest thing is to hand the user the exact lines
 * and let them paste them. It is also what someone wants for a shell they
 * already had open before they pressed Start.
 */
function CopyEnvButton(): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  return (
    <button
      className="btn secondary size-28"
      onClick={() => {
        void window.opsmaxx?.inspect.env().then((env) => {
          const lines = Object.entries(env)
            .map(([k, v]) => `export ${k}=${v}`)
            .join('\n')
          void navigator.clipboard.writeText(lines)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
      title="Copy the export lines that point a shell at the inspector"
    >
      {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy shell setup'}
    </button>
  )
}

function FlowTable({
  flows,
  selectedId,
  onSelect
}: {
  flows: InspectFlow[]
  selectedId: string | null
  onSelect: (id: string | null) => void
}): React.JSX.Element {
  return (
    <div className="table-scroll" style={{ flex: 1, minWidth: 0, overflow: 'auto' }}>
      <table className="table">
        <thead>
          <tr>
            <th style={{ width: 64 }}>Status</th>
            <th style={{ width: 72 }}>Method</th>
            <th>Host</th>
            <th>Path</th>
            <th style={{ width: 90, textAlign: 'right' }}>Size</th>
            <th style={{ width: 80, textAlign: 'right' }}>Time</th>
          </tr>
        </thead>
        <tbody>
          {flows.map((f) => (
            <tr
              key={f.id}
              className={clsx('clickable', selectedId === f.id && 'selected')}
              onClick={() => onSelect(selectedId === f.id ? null : f.id)}
              // Rows are the primary control here, so they have to be reachable
              // and operable without a mouse like any other control.
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onSelect(selectedId === f.id ? null : f.id)
                }
              }}
            >
              <td>
                <StatusChip flow={f} />
              </td>
              <td className="mono">{f.request.method}</td>
              <td className="ellipsis" title={f.request.host}>
                {f.request.host}
              </td>
              <td className="ellipsis mono" title={f.request.path + (f.request.query ? `?${f.request.query}` : '')}>
                {f.request.path}
                {f.request.query ? <span className="sub">?{f.request.query}</span> : null}
              </td>
              <td style={{ textAlign: 'right' }} className="mono">
                {f.state === 'pending' ? '—' : formatBytes(f.responseBytes ?? 0)}
              </td>
              <td style={{ textAlign: 'right' }} className="mono sub">
                {f.endedAt ? `${f.endedAt - f.startedAt} ms` : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Status as a shape as well as a number, so what needs attention reads at a
 *  glance rather than being decoded from three digits. */
function StatusChip({ flow }: { flow: InspectFlow }): React.JSX.Element {
  if (flow.state === 'pending') return <span className="chip">···</span>
  if (flow.state === 'failed') return <span className="chip danger">fail</span>
  const s = flow.status ?? 0
  const tone = s >= 500 ? 'danger' : s >= 400 ? 'warn' : s >= 300 ? '' : 'ok'
  return <span className={clsx('chip', tone)}>{s}</span>
}

function CaCard(): React.JSX.Element {
  const status = useInspect((s) => s.status)
  const installTrust = useInspect((s) => s.installTrust)
  const removeTrust = useInspect((s) => s.removeTrust)
  const regenerateCa = useInspect((s) => s.regenerateCa)
  const busy = useInspect((s) => s.busy)
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const ca = status?.ca
  if (!ca) return <></>

  return (
    <div className="card" style={{ padding: 'var(--sp-3)' }}>
      <div className="row" style={{ gap: 'var(--sp-2)', alignItems: 'center' }}>
        <ShieldCheck size={15} />
        <div style={{ minWidth: 0 }}>
          <div>{ca.commonName}</div>
          <div className="sub mono ellipsis" title={ca.fingerprintDisplay}>
            {ca.fingerprintDisplay}
          </div>
        </div>
        <div className="spacer" />
        {/* The one number a person can check against Keychain Access or
            certmgr.msc without transcribing it by hand. */}
        <button
          className="btn secondary size-24"
          onClick={() => {
            void navigator.clipboard.writeText(ca.fingerprintDisplay)
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          }}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />} Fingerprint
        </button>
        <button className="btn secondary size-24" onClick={() => setOpen((v) => !v)}>
          {open ? 'Hide' : 'Trust stores'}
        </button>
      </div>

      {!ca.keyPersisted && (
        <div className="banner warn" style={{ marginTop: 8 }}>
          <AlertTriangle size={14} /> This machine’s keychain would not store the certificate’s
          key, so a new certificate is created each time OpsMaxx starts. You will have to
          install it again after a restart.
        </div>
      )}

      {open && (
        <div className="col" style={{ gap: 6, marginTop: 10 }}>
          {status?.trust.map((t) => (
            <div className="row" key={t.id} style={{ gap: 'var(--sp-2)', alignItems: 'center' }}>
              <span
                className={clsx(
                  'chip',
                  t.state === 'trusted' ? 'ok' : t.state === 'untrusted' ? 'warn' : ''
                )}
              >
                {t.state}
              </span>
              <div style={{ minWidth: 0 }}>
                <div>{t.label}</div>
                {t.hint && <div className="sub">{t.hint}</div>}
              </div>
              <div className="spacer" />
              {t.installable &&
                (t.state === 'trusted' ? (
                  <button
                    className="btn secondary size-24"
                    disabled={busy}
                    onClick={() => void removeTrust(t.id as 'system' | 'nss')}
                  >
                    <X size={13} /> Remove
                  </button>
                ) : (
                  <button
                    className="btn secondary size-24"
                    disabled={busy}
                    onClick={() => void installTrust(t.id as 'system' | 'nss')}
                  >
                    Install
                  </button>
                ))}
            </div>
          ))}
          <div className="row" style={{ gap: 'var(--sp-2)', marginTop: 4 }}>
            <div className="sub" style={{ flex: 1 }}>
              Certificate file: <span className="mono">{ca.certPath}</span>
            </div>
            <button className="btn secondary size-24" disabled={busy} onClick={() => void regenerateCa()}>
              Regenerate
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export function maskHeaderValue(name: string, value: string, revealed: boolean): string {
  if (revealed || !isSensitiveHeader(name)) return value
  // Enough to recognise which credential it is, not enough to use one that
  // ends up in a screenshot.
  return value.length <= 8 ? '••••••••' : `${value.slice(0, 4)}••••••••${value.slice(-2)}`
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}
