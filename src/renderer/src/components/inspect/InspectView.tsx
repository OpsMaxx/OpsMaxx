import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Check, Copy, Play, Radar, ShieldCheck, Square, Trash2, X } from 'lucide-react'
import { EmptyState } from '../common/EmptyState'
import { clsx } from '../../lib/format'
import { t as translate, useT } from '../../lib/i18n'
import { Trans } from '../../lib/Trans'
import type { MessageKey } from '../../../../shared/i18n'
import { useInspect } from './useInspect'
import { InspectFlowDetail } from './InspectFlowDetail'
import type { InspectFlow, InspectSourceKind, InspectTrustStore } from '../../../../shared/inspect'
import { INSPECT_CA_EXPIRY_WARN_SEC, isSensitiveHeader } from '../../../../shared/inspect'

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
  const t = useT()
  const { status, flows, selectedId, busy, error, manualTrustCommand } = useInspect()
  const wire = useInspect((s) => s.wire)
  const refresh = useInspect((s) => s.refresh)
  const start = useInspect((s) => s.start)
  const stop = useInspect((s) => s.stop)
  const clear = useInspect((s) => s.clear)
  const select = useInspect((s) => s.select)
  const allowPinned = useInspect((s) => s.allowPinned)
  const installTrust = useInspect((s) => s.installTrust)
  const regenerate = useInspect((s) => s.regenerateCa)

  const [filter, setFilter] = useState('')
  const [source, setSource] = useState<InspectSourceKind>('sessions')
  const [commandCopied, setCommandCopied] = useState(false)

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
          <h1>{t('inspect.title')}</h1>
          <div className="sub">
            {running && status?.listening
              ? t('inspect.capturingOn', { host: status.listening.host, port: status.listening.port })
              : t('inspect.sub')}
          </div>
        </div>
        <div className="spacer" />

        {!running && (
          <select
            className="input size-28"
            value={source}
            onChange={(e) => setSource(e.target.value as InspectSourceKind)}
            aria-label={t('inspect.sourceLabel')}
            style={{ maxWidth: 260 }}
          >
            <option value="sessions">{t('inspect.source.sessions')}</option>
            <option value="system">{t('inspect.source.system')}</option>
            <option value="manual">{t('inspect.source.manual')}</option>
          </select>
        )}

        {running ? (
          <button className="btn secondary size-28" onClick={() => void stop()} disabled={busy}>
            <Square size={14} /> {t('inspect.stop')}
          </button>
        ) : (
          <button className="btn primary size-28" onClick={() => void start({ source })} disabled={busy}>
            <Play size={14} /> {t('inspect.startCapture')}
          </button>
        )}
        {running && <CopyEnvButton />}
        <button
          className="btn secondary size-28"
          onClick={() => void clear()}
          disabled={flows.length === 0}
        >
          <Trash2 size={14} /> {t('inspect.clear')}
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
          <AlertTriangle size={14} /> {t('inspect.lanExposed')}
        </div>
      )}

      {/* Something else moved the machine's proxy settings while we were
          running — a Group Policy refresh, a VPN client, another proxy tool,
          or the user in Settings. OpsMaxx puts them back by itself wherever
          that needs no password, so seeing this means it could not: macOS,
          where `networksetup` requires administrator rights and a status poll
          must not raise an authentication dialog on its own. Said out loud
          because the alternative is a panel that says "capturing" over an
          empty flow list. */}
      {running && status?.systemProxyDrifted && (
        <div className="banner warn">
          <AlertTriangle size={14} /> {t('inspect.proxyDrifted')}
        </div>
      )}

      {running && status?.insecureUpstream && (
        <div className="banner danger">
          <AlertTriangle size={14} /> {t('inspect.insecureUpstream')}
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
          <span>{systemTrust.hint ?? t('inspect.installHint')}</span>
          <div className="spacer" />
          {systemTrust.installable && (
            <button
              className="btn primary size-24"
              onClick={() => void installTrust('system')}
              disabled={busy}
            >
              {t('inspect.installCert')}
            </button>
          )}
        </div>
      )}

      {/* Every automatic route has been refused, so the button above is no
          longer an answer — pressing it again is the loop this replaced. The
          exact command is shown instead, because on the machine that produced
          this failure it is the thing that works: a terminal keeps the login
          session that the elevated process OpsMaxx starts does not have. */}
      {manualTrustCommand && (
        <div className="banner warn col" style={{ gap: 6, alignItems: 'stretch' }}>
          <div className="row" style={{ gap: 'var(--sp-2)' }}>
            <AlertTriangle size={14} />
            <span>{t('inspect.manualTrust')}</span>
          </div>
          <div className="row" style={{ gap: 'var(--sp-2)', alignItems: 'center' }}>
            <code className="mono" style={{ flex: 1, minWidth: 0, overflowX: 'auto', userSelect: 'text' }}>
              {manualTrustCommand}
            </code>
            <button
              className="btn secondary size-24"
              onClick={() => {
                void navigator.clipboard.writeText(manualTrustCommand)
                setCommandCopied(true)
                setTimeout(() => setCommandCopied(false), 1500)
              }}
            >
              {commandCopied ? <Check size={13} /> : <Copy size={13} />} {t('common.copy')}
            </button>
          </div>
        </div>
      )}

      {/* A host that refused our certificate. The only remedy is to stop
          intercepting it, so that is the button. */}
      {status?.pinned.map((p) => (
        <div className="banner warn" key={p.host}>
          <AlertTriangle size={14} />
          <span>
            <Trans
              i18nKey="inspect.pinned"
              values={{ host: p.host }}
              components={{ strong: <strong /> }}
            />
          </span>
          <div className="spacer" />
          <button className="btn secondary size-24" onClick={() => void allowPinned(p.host)}>
            {t('inspect.letThrough')}
          </button>
        </div>
      ))}

      {/* A tunnel carrying something that is not HTTP at all. Interception
          breaks these, so this is a report of damage already done, not a
          missing capability — and it gets the same prominence as pinning. */}
      {status?.opaque.map((o) => (
        <div className="banner warn" key={o.host}>
          <AlertTriangle size={14} />
          <span>
            <Trans
              i18nKey="inspect.opaque"
              values={{ host: o.host }}
              components={{ strong: <strong /> }}
            />
          </span>
          <div className="spacer" />
          <button className="btn secondary size-24" onClick={() => void allowPinned(o.host)}>
            {t('inspect.letThrough')}
          </button>
        </div>
      ))}

      {/* An expired authority makes every request fail with a certificate
          error that says nothing about OpsMaxx. Said before it happens,
          and unmissably once it has. */}
      {status?.ca && status.ca.expiresInSec <= 0 && (
        <div className="banner danger">
          <AlertTriangle size={14} />
          <span>{t('inspect.caExpired')}</span>
          <div className="spacer" />
          <button className="btn primary size-24" onClick={() => void regenerate()} disabled={busy}>
            {t('inspect.newCert')}
          </button>
        </div>
      )}
      {status?.ca &&
        status.ca.expiresInSec > 0 &&
        status.ca.expiresInSec < INSPECT_CA_EXPIRY_WARN_SEC && (
          <div className="banner warn">
            <AlertTriangle size={14} />
            <span>
              {t('inspect.caExpiring', { count: Math.ceil(status.ca.expiresInSec / 86400) })}
            </span>
          </div>
        )}

      {/* The listener needs a password, so the environment the panel hands out
          carries one. Said plainly, because a proxy that silently rejects
          everything looks broken. */}
      {running && status?.requiresCredentials && (
        <div className="banner">
          <ShieldCheck size={14} />
          <span>{t('inspect.requiresCredentials')}</span>
        </div>
      )}

      {status?.ca && <CaCard />}

      <div className="row" style={{ gap: 'var(--sp-2)', padding: '8px 0' }}>
        <input
          className="input size-28"
          placeholder={t('inspect.filterPlaceholder')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label={t('inspect.filterLabel')}
        />
        <div className="sub">
          {shown.length === flows.length
            ? t('inspect.count', { count: flows.length })
            : t('inspect.filteredCount', { shown: shown.length, total: flows.length })}
        </div>
      </div>

      {flows.length === 0 ? (
        <EmptyState
          icon={<Radar size={26} />}
          title={running ? t('inspect.listeningTitle') : t('inspect.nothingYet')}
          message={
            running
              ? listeningMessage(status?.source ?? 'manual')
              : t('inspect.idleMessage')
          }
          action={
            running ? undefined : (
              <button className="btn primary" onClick={() => void start({ source })}>
                <Play size={15} /> {t('inspect.startCapture')}
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
 * What the empty flow list says while capture is running.
 *
 * Keyed on the source, because the three sources put traffic here in three
 * completely different ways and only one of them involves terminals at all.
 * This used to promise, for every source, that "local terminals you open now
 * are routed through the inspector automatically" — which is true only for
 * `sessions`, and is the single most misleading sentence the panel could show
 * somebody staring at a request count of zero.
 *
 * The `sessions` line names the exclusion out loud. A shell inherits its
 * environment once, at spawn, so a terminal that was already open when capture
 * started is not routed and cannot be made routed from outside it.
 */
export function listeningMessage(source: InspectSourceKind): string {
  if (source === 'sessions') return translate('inspect.listening.sessions')
  if (source === 'system') return translate('inspect.listening.system')
  return translate('inspect.listening.manual')
}

/**
 * The environment lines for a shell OpsMaxx did not open.
 *
 * This is the whole answer for a remote session: `sshd` will not carry these
 * variables for us, so the honest thing is to hand the user the exact lines
 * and let them paste them. It is also what someone wants for a shell they
 * already had open before they pressed Start.
 *
 * The syntax has to match the shell it is going to be pasted into, and on
 * Windows that is not a POSIX shell. `export HTTP_PROXY=…` in PowerShell — the
 * shell OpsMaxx itself offers as the default on Windows — is not a syntax
 * error that tells you what to fix; `export` is simply an unrecognised command
 * name, so the person gets "not recognized as the name of a cmdlet" ten times
 * and a shell that is still not pointed at anything.
 */
export function envLines(env: Record<string, string>, platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    // PowerShell, since that is what this app's own Windows shell list makes
    // the default. Quoted because a proxy URL carrying credentials can contain
    // characters PowerShell would otherwise treat as its own.
    return Object.entries(env)
      .map(([k, v]) => `$env:${k} = "${v}"`)
      .join('\n')
  }
  return Object.entries(env)
    .map(([k, v]) => `export ${k}=${v}`)
    .join('\n')
}

function CopyEnvButton(): React.JSX.Element {
  const t = useT()
  const [copied, setCopied] = useState(false)
  // Resolved once, from main. `navigator.platform` is deprecated, lies under
  // Electron's user-agent handling, and would be the wrong question anyway:
  // what matters is the OS the shells being pasted into are running on.
  const [platform, setPlatform] = useState<NodeJS.Platform>('linux')
  useEffect(() => {
    void window.opsmaxx?.platform?.().then(setPlatform)
  }, [])
  return (
    <button
      className="btn secondary size-28"
      onClick={() => {
        void window.opsmaxx?.inspect.env().then((env) => {
          void navigator.clipboard.writeText(envLines(env, platform))
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
      title={
        platform === 'win32'
          ? t('inspect.copyEnvTitleWin')
          : t('inspect.copyEnvTitle')
      }
    >
      {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? t('common.copied') : t('inspect.copyShellSetup')}
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
  const t = useT()
  return (
    <div className="table-scroll" style={{ flex: 1, minWidth: 0, overflow: 'auto' }}>
      <table className="table">
        <thead>
          <tr>
            <th style={{ width: 64 }}>{t('inspect.col.status')}</th>
            <th style={{ width: 72 }}>{t('inspect.col.method')}</th>
            <th>{t('inspect.col.host')}</th>
            <th>{t('inspect.col.path')}</th>
            <th style={{ width: 90, textAlign: 'right' }}>{t('inspect.col.size')}</th>
            <th style={{ width: 80, textAlign: 'right' }}>{t('inspect.col.time')}</th>
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
  const t = useT()
  if (flow.state === 'pending') return <span className="chip">···</span>
  if (flow.state === 'failed') return <span className="chip danger">{t('inspect.fail')}</span>
  const s = flow.status ?? 0
  const tone = s >= 500 ? 'danger' : s >= 400 ? 'warn' : s >= 300 ? '' : 'ok'
  return <span className={clsx('chip', tone)}>{s}</span>
}

const TRUST_STATE: Record<InspectTrustStore['state'], MessageKey> = {
  trusted: 'inspect.trustState.trusted',
  untrusted: 'inspect.trustState.untrusted',
  unknown: 'inspect.trustState.unknown',
  unsupported: 'inspect.trustState.unsupported'
}

function CaCard(): React.JSX.Element {
  const t = useT()
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
          {copied ? <Check size={13} /> : <Copy size={13} />} {t('inspect.ca.fingerprint')}
        </button>
        <button className="btn secondary size-24" onClick={() => setOpen((v) => !v)}>
          {open ? t('common.hide') : t('inspect.ca.trustStores')}
        </button>
      </div>

      {!ca.keyPersisted && (
        <div className="banner warn" style={{ marginTop: 8 }}>
          <AlertTriangle size={14} /> {t('inspect.ca.keyNotPersisted')}
        </div>
      )}

      {open && (
        <div className="col" style={{ gap: 6, marginTop: 10 }}>
          {status?.trust.map((ts) => (
            <div className="row" key={ts.id} style={{ gap: 'var(--sp-2)', alignItems: 'center' }}>
              <span
                className={clsx(
                  'chip',
                  ts.state === 'trusted' ? 'ok' : ts.state === 'untrusted' ? 'warn' : ''
                )}
              >
                {t(TRUST_STATE[ts.state])}
              </span>
              <div style={{ minWidth: 0 }}>
                <div>{ts.label}</div>
                {ts.hint && <div className="sub">{ts.hint}</div>}
              </div>
              <div className="spacer" />
              {ts.installable &&
                (ts.state === 'trusted' ? (
                  <button
                    className="btn secondary size-24"
                    disabled={busy}
                    onClick={() => void removeTrust(ts.id as 'system' | 'nss')}
                  >
                    <X size={13} /> {t('common.remove')}
                  </button>
                ) : (
                  <button
                    className="btn secondary size-24"
                    disabled={busy}
                    onClick={() => void installTrust(ts.id as 'system' | 'nss')}
                  >
                    {t('inspect.ca.install')}
                  </button>
                ))}
            </div>
          ))}
          <div className="row" style={{ gap: 'var(--sp-2)', marginTop: 4 }}>
            <div className="sub" style={{ flex: 1 }}>
              <Trans
                i18nKey="inspect.ca.certFile"
                values={{ path: ca.certPath }}
                components={{ path: <span className="mono" /> }}
              />
            </div>
            <button className="btn secondary size-24" disabled={busy} onClick={() => void regenerateCa()}>
              {t('inspect.ca.regenerate')}
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
