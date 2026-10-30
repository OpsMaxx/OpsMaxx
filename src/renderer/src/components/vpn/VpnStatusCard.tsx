import { useState } from 'react'
import { AlertTriangle, Check, Copy, ExternalLink } from 'lucide-react'
import { WG_HANDSHAKE_STALE_SEC } from '../../../../shared/vpn'
import type {
  FrpProxyStatus,
  NgrokEndpoint,
  TailnetPeer,
  FrpSpec,
  VpnBoundListener,
  VpnKind,
  VpnProfile,
  VpnStatus
} from '../../types'
import { bytes, clsx } from '../../lib/format'
import { VpnDiagnose } from './VpnDiagnose'
import { t as tr, useT } from '../../lib/i18n'
import type { MessageKey } from '../../../../shared/i18n'

// How healthy a profile is, as the UI cares about it. Deliberately coarser than
// VpnState in one place and finer in another: `reconnecting` and `degraded`
// both mean "up, not carrying traffic", and `connected` splits in two because a
// WireGuard peer can be connected with a handshake that stopped happening.
export type VpnHealth = 'off' | 'connecting' | 'ok' | 'degraded' | 'error'

// E63: the sidecar reports an age, but a system clock jump (sleep/wake, an NTP
// step) can still produce a negative one. An age is never negative, and
// "handshake -4s ago" reads as a bug in the client rather than a clock event.
function clampAge(sec: number): number {
  return Math.max(0, Math.round(sec))
}

/** True while the handshake is fresh enough that traffic is actually moving. */
export function isHandshakeFresh(lastHandshakeSec: number | undefined): boolean {
  if (lastHandshakeSec === undefined) return false
  return clampAge(lastHandshakeSec) < WG_HANDSHAKE_STALE_SEC
}

/** "handshake 12s ago" — relative, never a wall-clock timestamp. A timestamp
 *  makes the reader do the subtraction, and the subtraction is the whole
 *  question being asked. */
export function handshakeLabel(lastHandshakeSec: number | undefined): string {
  if (lastHandshakeSec === undefined) return tr('vpn.status.noHandshake')
  const age = clampAge(lastHandshakeSec)
  if (age < 60) return tr('vpn.status.handshakeSeconds', { s: age })
  if (age < 3600) return tr('vpn.status.handshakeMinutes', { m: Math.floor(age / 60), s: age % 60 })
  return tr('vpn.status.handshakeHours', {
    h: Math.floor(age / 3600),
    m: Math.floor((age % 3600) / 60)
  })
}

/** "1 proxy", "3 proxies". Lives here because the pane and the sidebar both
 *  say it, and the sidebar used to say "1 proxies". */
export function proxyCount(n: number): string {
  return tr('vpn.status.proxyCount', { count: n })
}

/** The one-line description of an frp client: where it dials and how much it
 *  carries. A profile with no server address yet says so — ":7000 · 0 proxies"
 *  reads as a field the app failed to load rather than one nobody has filled
 *  in. */
export function frpSummary(spec: FrpSpec): string {
  const server = spec.serverAddr ? `${spec.serverAddr}:${spec.serverPort}` : tr('vpn.status.noServer')
  return `${server} · ${proxyCount(spec.proxies.length)}`
}

/** Why a profile is amber, in a sentence. Every degraded state had one except
 *  the two frp ones, which showed a chip and left the user to guess. */
export function degradedReason(kind: VpnKind, status: VpnStatus | undefined): string {
  if (status?.state === 'reconnecting') return tr('vpn.status.reconnecting')
  if (status?.state === 'degraded') {
    if (kind === 'frp') {
      return tr('vpn.status.frpDegraded')
    }
    return tr('vpn.status.noTraffic')
  }
  // Connected, with a WireGuard handshake old enough that nothing is crossing.
  return tr('vpn.status.staleHandshake', { seconds: WG_HANDSHAKE_STALE_SEC })
}

export function vpnHealth(status: VpnStatus | undefined): VpnHealth {
  if (!status || status.state === 'stopped') return 'off'
  if (status.state === 'error') return 'error'
  if (status.state === 'degraded' || status.state === 'reconnecting') return 'degraded'
  if (status.state === 'starting' || status.state === 'authenticating') return 'connecting'
  // Connected, which for WireGuard is not the same as working: the interface is
  // up and the peer is configured, but if the handshake has gone stale nothing
  // is crossing it. Amber, not red — down and up-but-silent call for different
  // reactions, and almost no WireGuard UI tells them apart.
  if (status.kind === 'wireguard' && !isHandshakeFresh(status.stats?.lastHandshakeSec)) {
    return 'degraded'
  }
  return 'ok'
}

const HEALTH_LABEL: Record<VpnHealth, MessageKey> = {
  off: 'vpn.status.healthOff',
  connecting: 'vpn.status.healthConnecting',
  ok: 'vpn.status.healthOk',
  degraded: 'vpn.status.healthDegraded',
  error: 'vpn.status.healthError'
}

const HEALTH_CHIP: Record<VpnHealth, string> = {
  off: '',
  connecting: 'info',
  ok: 'ok',
  degraded: 'warn',
  error: 'danger'
}

// `.status-dot`'s states, each with its own shape as well as its colour. Amber
// is `idle`, which is exactly the shade `degraded` wants; `error` is the red
// square. It used to be `offline` repainted red inline, which covered the
// offline ring with a filled disc — the same shape as `ok`, told apart by
// colour alone.
const HEALTH_DOT: Record<VpnHealth, string> = {
  off: 'offline',
  connecting: 'connecting',
  ok: 'online',
  degraded: 'idle',
  error: 'error'
}

export function HealthDot({ health }: { health: VpnHealth }): React.JSX.Element {
  return <span className={clsx('status-dot', HEALTH_DOT[health])} />
}

export function HealthChip({ health }: { health: VpnHealth }): React.JSX.Element {
  const t = useT()
  return <span className={clsx('chip', HEALTH_CHIP[health])}>{t(HEALTH_LABEL[health])}</span>
}

/** E25. A listener on anything but the loopback is reachable by every other
 *  machine on the network, which is a different product than the one the user
 *  thinks they configured. */
export function isLoopbackBind(host: string): boolean {
  const h = host.trim().toLowerCase()
  return h === '' || h === '127.0.0.1' || h === '::1' || h === '[::1]' || h === 'localhost'
}

const BIND_WARNING: Record<'listener' | 'visitor' | 'proxy', MessageKey> = {
  listener: 'vpn.status.bindWarningListener',
  visitor: 'vpn.status.bindWarningVisitor',
  proxy: 'vpn.status.bindWarningProxy'
}

/** `what` names the thing bound, and picks the whole sentence rather than a
 *  phrase dropped into one, so a translation can put it where it belongs. */
export function BindWarning({
  host,
  what
}: {
  host: string
  what: keyof typeof BIND_WARNING
}): React.JSX.Element | null {
  const t = useT()
  if (isLoopbackBind(host)) return null
  return (
    <div className="row" style={{ gap: 6, color: 'var(--warn)', fontSize: 11 }}>
      <AlertTriangle size={12} />
      <span>{t(BIND_WARNING[what], { host })}</span>
    </div>
  )
}

function listenerLabel(l: VpnBoundListener): string {
  if (l.kind === 'forward' && l.targetHost) {
    return `${l.bindHost}:${l.bindPort} → ${l.targetHost}:${l.targetPort}`
  }
  return `${l.bindHost}:${l.bindPort}`
}

function Item({ k, v }: { k: string; v: string }): React.JSX.Element {
  return (
    <div className="info-item">
      <span className="k">{k}</span>
      <span className="v">{v}</span>
    </div>
  )
}

interface VpnStatusCardProps {
  profile: VpnProfile
  status: VpnStatus | undefined
}

export function VpnStatusCard({ profile, status }: VpnStatusCardProps): React.JSX.Element {
  const t = useT()
  const health = vpnHealth(status)
  const stats = status?.stats
  const listeners = status?.listeners ?? []
  const proxies: FrpProxyStatus[] = stats?.proxies ?? []
  const endpoints: NgrokEndpoint[] = stats?.endpoints ?? []
  const peers: TailnetPeer[] = stats?.tailnetPeers ?? []

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/**
       * The authorisation link, as controls.
       *
       * A tsnet node is OpsMaxx's OWN device on the tailnet — not a view of a
       * Tailscale client the user may also be running — so it has to be
       * authorised once, in a browser, the first time it starts. That link
       * reached the user only as engine log output: wrapped across two lines
       * by the log viewer, in text that could not be selected, inside a
       * message the engine reprints every five seconds. So the one action the
       * screen was asking for could not actually be taken from it.
       */}
      {status?.authUrl && <AuthoriseNode url={status.authUrl} />}

      {status?.error && (
        // The code is for a bug report, not for reading: it was the only
        // machine token on an otherwise written-out card. It stays reachable on
        // hover, and the log drawer has it in full.
        <div
          className="conn-error"
          style={{ borderRadius: 'var(--r-sm)', border: 'none' }}
          title={status.errorCode ? t('vpn.status.errorCode', { code: status.errorCode }) : undefined}
        >
          <AlertTriangle size={13} />
          <span>{status.error}</span>
        </div>
      )}

      <div className="info-grid">
        <Item k={t('vpn.status.state')} v={t(HEALTH_LABEL[health])} />
        {profile.spec.kind === 'wireguard' && (
          <Item k={t('vpn.status.handshake')} v={handshakeLabel(stats?.lastHandshakeSec)} />
        )}
        {/* Not for ngrok: it reports per-endpoint counters that cannot honestly
            be collapsed into one pair, so the driver sends zeroes and two rows
            reading "0 B" would be a claim about traffic rather than an absence
            of one. */}
        {stats && profile.spec.kind !== 'ngrok' && <Item k={t('vpn.status.received')} v={bytes(stats.rxBytes)} />}
        {stats && profile.spec.kind !== 'ngrok' && <Item k={t('vpn.status.sent')} v={bytes(stats.txBytes)} />}
        {stats?.assignedIp && <Item k={t('vpn.status.assignedIp')} v={stats.assignedIp} />}
        {stats?.remoteEndpoint && <Item k={t('vpn.status.endpoint')} v={stats.remoteEndpoint} />}
        {stats?.latencyMs !== undefined && (
          <Item
            k={t('vpn.status.latency')}
            v={t('vpn.status.latencyValue', { ms: Math.round(stats.latencyMs) })}
          />
        )}
        {status && status.restarts > 0 && <Item k={t('vpn.status.restarts')} v={String(status.restarts)} />}
      </div>

      {/* The public URLs. This is the entire point of an ngrok tunnel: the
          address is assigned by the server, it changes on every run unless a
          domain is reserved, and it exists nowhere else in the app — so a card
          that showed state and not the URL would be showing everything except
          the thing the user came for. Selectable, because it gets pasted. */}
      {endpoints.length > 0 && (
        <div className="col" style={{ gap: 4 }}>
          {endpoints.map((e) => (
            <div key={e.name} className="row" style={{ gap: 8, alignItems: 'baseline' }}>
              <span className="faint" style={{ fontSize: 11, minWidth: 90 }}>
                {e.name}
              </span>
              <span className="mono selectable">{e.publicUrl}</span>
              {e.localAddr && (
                <span className="faint" style={{ fontSize: 11 }}>
                  → {e.localAddr}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* The tailnet's other devices, which are what a user joins a tailnet to
          reach — and the answer to "is the machine I want actually up". Shown
          only when the profile asked for them, so a profile that just wants a
          connection is not handed a device inventory it did not request. */}
      {peers.length > 0 && (
        <div className="col" style={{ gap: 4 }}>
          {peers.map((p) => (
            <div key={p.host} className="row" style={{ gap: 8, alignItems: 'baseline' }}>
              <span
                aria-hidden
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  // Colour is not the only carrier: the title says it in words.
                  background: p.online ? 'var(--ok)' : 'var(--muted)'
                }}
              />
              <span style={{ minWidth: 90 }} title={p.online ? t('vpn.status.online') : t('vpn.status.offline')}>
                {p.name}
              </span>
              <span className="mono selectable faint" style={{ fontSize: 11 }}>
                {p.host}
              </span>
              {p.os && (
                <span className="faint" style={{ fontSize: 11 }}>
                  {p.os}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {health === 'degraded' && (
        // Every kind, not just WireGuard: an frp client whose proxies failed
        // used to get the amber chip and no sentence at all.
        <div className="row" style={{ gap: 6, color: 'var(--warn)', fontSize: 12 }}>
          <AlertTriangle size={13} />
          <span>{degradedReason(profile.spec.kind, status)}</span>
        </div>
      )}

      {/* One row per peer. The aggregate above is the SUM: a site-to-site link
          with one dead peer and one busy one shows the busy peer's traffic and
          the busy peer's handshake, and looks healthy. Only rendered when the
          sidecar sent rows -- an older one sends none, and an empty table would
          say this tunnel has no peers. */}
      {profile.spec.kind === 'wireguard' && (stats?.peers?.length ?? 0) > 0 && (
        <div className="col" style={{ gap: 6 }}>
          <span className="field-label">{t('vpn.status.peers')}</span>
          <table className="mini-table">
            <thead>
              <tr>
                <th>{t('vpn.status.peer')}</th>
                <th>{t('vpn.status.handshake')}</th>
                <th>{t('vpn.status.received')}</th>
                <th>{t('vpn.status.sent')}</th>
              </tr>
            </thead>
            <tbody>
              {(stats?.peers ?? []).map((p) => (
                <tr key={p.publicKey}>
                  {/* Truncated because a base64 key is 44 characters of noise
                      and the first few identify it among a handful of peers.
                      The whole key is on hover for anyone matching it against
                      a server config. */}
                  <td className="mono" title={p.publicKey}>
                    {p.publicKey.slice(0, 10)}…
                  </td>
                  <td>{handshakeLabel(p.lastHandshakeSec)}</td>
                  <td>{bytes(p.rxBytes)}</td>
                  <td>{bytes(p.txBytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Userspace WireGuard only: it is the one engine whose network stack
          runs in this process, so it is the one that can be probed without
          leaving the tunnel and measuring a different route. The manager says
          so in words for every other kind; this card does not offer a button
          that can only refuse. */}
      {profile.spec.kind === 'wireguard' && status?.state === 'connected' && (
        <VpnDiagnose id={profile.id} />
      )}

      {/* Offered whether or not it is up, which is the difference that matters:
          the question "can this machine reach the server" is the one somebody
          has when the profile will NOT connect, and a button that only appears
          once it has connected would never be there when it was wanted. The
          target fields are hidden because that probe may only be pointed at the
          addresses already on the profile. */}
      {profile.spec.kind === 'openvpn' && <VpnDiagnose id={profile.id} showTarget={false} />}

      {listeners.length > 0 && (
        <div className="col" style={{ gap: 6 }}>
          <span className="field-label">{t('vpn.status.localListeners')}</span>
          {listeners.map((l, i) => (
            <div key={`${l.bindHost}:${l.bindPort}-${i}`} className="col" style={{ gap: 4 }}>
              <div className="row" style={{ gap: 8 }}>
                <span className="chip">{l.kind}</span>
                <span className="mono" style={{ fontSize: 12 }}>
                  {listenerLabel(l)}
                </span>
              </div>
              <BindWarning host={l.bindHost} what="listener" />
            </div>
          ))}
        </div>
      )}

      {profile.spec.kind === 'frp' && (
        <div className="col" style={{ gap: 6 }}>
          <span className="field-label">{t('vpn.status.proxies')}</span>
          {proxies.length === 0 ? (
            // frp publishes no client-side byte counters, so this table is the
            // telemetry. Saying so beats showing invented rx/tx numbers.
            <span className="faint" style={{ fontSize: 11 }}>
              {t('vpn.status.noProxyStatus')}
            </span>
          ) : (
            <table className="mini-table">
              <thead>
                <tr>
                  <th>{t('vpn.status.proxy')}</th>
                  <th>{t('vpn.status.type')}</th>
                  <th>{t('vpn.status.status')}</th>
                  <th>{t('vpn.status.local')}</th>
                  <th>{t('vpn.status.remote')}</th>
                </tr>
              </thead>
              <tbody>
                {proxies.map((p) => (
                  <tr key={p.name}>
                    <td className="strong">{p.name}</td>
                    <td>{p.type}</td>
                    <td style={p.err ? { color: 'var(--danger)' } : undefined}>
                      {p.err ? `${p.status} — ${p.err}` : p.status}
                    </td>
                    <td className="mono">{p.localAddr ?? '—'}</td>
                    <td className="mono">{p.remoteAddr ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * "Authorise this node", with the link itself in reach.
 *
 * Both halves are here on purpose. The button covers the ordinary case, and
 * Copy covers the one that made this worth building: the browser that has to
 * complete the login is not always the one on this machine — a headless box, a
 * VM, a machine being set up over a remote session — and for those the link has
 * to be movable. It was previously neither clickable nor selectable.
 */
function AuthoriseNode({ url }: { url: string }): React.JSX.Element {
  const t = useT()
  const [copied, setCopied] = useState(false)

  const copy = (): void => {
    window.opsmaxx?.clipboard?.write(url)
    setCopied(true)
    // Long enough to read, short enough that the button is not stuck saying
    // "Copied" over a link somebody has since changed their mind about.
    setTimeout(() => setCopied(false), 1600)
  }

  return (
    <div className="vpn-authorise">
      <div className="vpn-authorise-say">
        <AlertTriangle size={13} />
        <span>
          {t('vpn.status.authoriseNote')}
        </span>
      </div>
      {/* Selectable, and on one line that scrolls rather than wrapping: a URL
          broken across two lines is one nobody can copy by hand either. */}
      <code className="vpn-authorise-url mono selectable">{url}</code>
      <div className="vpn-authorise-actions">
        <button
          className="btn primary sm"
          onClick={() => window.open(url, '_blank', 'noopener,noreferrer')}
        >
          <ExternalLink size={13} /> {t('vpn.status.authorise')}
        </button>
        <button className="btn ghost sm" onClick={copy}>
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? t('common.copied') : t('vpn.status.copyLink')}
        </button>
      </div>
    </div>
  )
}
