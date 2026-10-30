import { Trash2 } from 'lucide-react'
import type { FrpProxy, FrpProxyType } from '../../types'
import { BindWarning } from './VpnStatusCard'
import { Switch } from '../common/Switch'
import { useT } from '../../lib/i18n'

const TYPES: FrpProxyType[] = ['tcp', 'udp', 'http', 'https', 'stcp', 'sudp', 'xtcp', 'tcpmux']

// http/https are addressed by hostname on the frp server; the rest take a port.
const BY_DOMAIN: FrpProxyType[] = ['http', 'https']
// stcp/sudp/xtcp are only reachable by a visitor holding the shared secret, so
// they are not "published" the way a plain tcp proxy is.
const SECRET_TYPES: FrpProxyType[] = ['stcp', 'sudp', 'xtcp']

interface FrpProxyEditorProps {
  proxy: FrpProxy
  serverAddr: string
  /** Validation messages for this proxy, keyed by the field name inside it. */
  issues: Record<string, string>
  onChange: (next: FrpProxy) => void
  onRemove: () => void
}

export function FrpProxyEditor({
  proxy,
  serverAddr,
  issues,
  onChange,
  onRemove
}: FrpProxyEditorProps): React.JSX.Element {
  const t = useT()
  const set = (patch: Partial<FrpProxy>): void => onChange({ ...proxy, ...patch })

  const byDomain = BY_DOMAIN.includes(proxy.type)
  const secret = SECRET_TYPES.includes(proxy.type)
  const where = byDomain
    ? proxy.customDomains?.[0] || (proxy.subdomain ? `${proxy.subdomain}.${serverAddr}` : serverAddr)
    : serverAddr

  // The whole value of this gate is that it names what actually becomes
  // reachable. Before the port and the server are filled in it would read
  // "Make 127.0.0.1:0 reachable from your frp server", which states nothing —
  // so say what is missing instead, and refuse to be ticked until it is real.
  // `where` is used rather than the bare server address because for an
  // http/https proxy the reachable name is the domain, not the frp host.
  const missing = !proxy.localPort
    ? t('vpn.frp.proxy.setLocalPortFirst')
    : !where.trim()
      ? t('vpn.frp.proxy.setServerFirst')
      : null
  const exposureSentence =
    missing ??
    t('vpn.frp.proxy.exposure', {
      local: `${proxy.localIp || '127.0.0.1'}:${proxy.localPort}`,
      where: where.trim()
    })
  const toggleExposure = (): void => {
    if (missing) return
    set({ acknowledgedExposure: !proxy.acknowledgedExposure })
  }

  return (
    <div className="hop-card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="row" style={{ gap: 6 }}>
        <input
          className="input"
          style={{ flex: 1, minWidth: 110 }}
          placeholder={t('vpn.frp.proxy.namePlaceholder')}
          value={proxy.name}
          onChange={(e) => set({ name: e.target.value })}
        />
        <select
          className="input"
          style={{ width: 96 }}
          value={proxy.type}
          onChange={(e) => set({ type: e.target.value as FrpProxyType })}
        >
          {TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <button className="icon-btn sm" title={t('vpn.frp.proxy.remove')} onClick={onRemove}>
          <Trash2 size={14} />
        </button>
      </div>
      {issues.name && <FieldError message={issues.name} />}

      <div className="input-group">
        <input
          className="input"
          placeholder="127.0.0.1"
          value={proxy.localIp}
          onChange={(e) => set({ localIp: e.target.value })}
        />
        <input
          className="input"
          type="number"
          placeholder={t('vpn.frp.proxy.localPortPlaceholder')}
          value={proxy.localPort || ''}
          onChange={(e) => set({ localPort: Number(e.target.value) })}
        />
        {!byDomain && !secret && (
          <input
            className="input"
            type="number"
            placeholder={t('vpn.frp.proxy.remotePortPlaceholder')}
            value={proxy.remotePort ?? ''}
            onChange={(e) => set({ remotePort: e.target.value ? Number(e.target.value) : undefined })}
          />
        )}
      </div>
      {issues.localIp && <FieldError message={issues.localIp} />}
      {issues.localPort && <FieldError message={issues.localPort} />}
      {issues.remotePort && <FieldError message={issues.remotePort} />}
      <BindWarning host={proxy.localIp} what="proxy" />

      {byDomain && (
        <div className="input-group">
          <input
            className="input"
            placeholder={t('vpn.frp.proxy.customDomainPlaceholder')}
            value={proxy.customDomains?.join(', ') ?? ''}
            onChange={(e) =>
              set({
                customDomains: e.target.value
                  .split(',')
                  .map((d) => d.trim())
                  .filter(Boolean)
              })
            }
          />
          <input
            className="input"
            placeholder={t('vpn.frp.proxy.subdomainPlaceholder')}
            value={proxy.subdomain ?? ''}
            onChange={(e) => set({ subdomain: e.target.value || undefined })}
          />
        </div>
      )}

      {secret && (
        <span className="field-hint">
          {t('vpn.frp.proxy.secretNote')}
        </span>
      )}

      {/* The gate. Written out in full, with the real host and the real port,
          because "expose this proxy" is a sentence that tells the user nothing
          they had not already assumed. start() refuses without this ticked. */}
      <label className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
        <Switch
          checked={!!proxy.acknowledgedExposure}
          label={exposureSentence}
          // Nothing to confirm yet; the sentence beside it says what to set
          // first.
          disabled={!!missing}
          style={{ marginTop: 1 }}
          onChange={toggleExposure}
        />
        <span
          style={{
            fontSize: 12,
            color: proxy.acknowledgedExposure ? 'var(--text-muted)' : 'var(--warn)'
          }}
        >
          {exposureSentence}
        </span>
      </label>
    </div>
  )
}

function FieldError({ message }: { message: string }): React.JSX.Element {
  return (
    <span className="field-hint" style={{ color: 'var(--danger)' }}>
      {message}
    </span>
  )
}
