import { useEffect } from 'react'
import { AlertTriangle } from 'lucide-react'
import { useApp, useWorkspaceVpns } from '../../store/app'
import { bridgeHas } from '../../lib/bridge'
import type { UUID, VpnKind } from '../../types'
import { HealthChip, vpnHealth } from './VpnStatusCard'
import { useT } from '../../lib/i18n'
import { Trans } from '../../lib/Trans'

// Which VPN profile a saved connection is dialled through. `null` is a direct
// connection and is what everything defaults to.
//
// Shared by the server form and the database form because the decision is the
// same one in both places, and because the two failure modes worth getting
// right — a profile that is stopped, and a profile that has been deleted — are
// easy to get right once and tedious to get right twice.

const KIND_LABEL: Record<VpnKind, string> = {
  wireguard: 'WireGuard',
  openvpn: 'OpenVPN',
  frp: 'frp',
  tailscale: 'Tailscale',
  ngrok: 'ngrok'
}

interface VpnTransportSelectProps {
  /** The saved profile id, or null for a direct connection. */
  value: UUID | null
  onChange: (value: UUID | null) => void
  /** One line under the field saying how this composes with whatever else the
   *  form already routes through. The ordering is not guessable, so each form
   *  spells out its own. */
  hint: React.ReactNode
}

export function VpnTransportSelect({
  value,
  onChange,
  hint
}: VpnTransportSelectProps): React.JSX.Element {
  const t = useT()
  const profiles = useWorkspaceVpns()
  const vpnStatuses = useApp((s) => s.vpnStatuses)
  const setVpnStatus = useApp((s) => s.setVpnStatus)

  /**
   * Inbound-exposure tools are not transports.
   *
   * frp and ngrok both publish a LOCAL port outward — frp to a remote frps,
   * ngrok to its edge. Nothing dials out through either, so listing one here,
   * even greyed, suggests a thing it cannot do.
   *
   * ngrok was missing from this filter, and the way it failed is worth
   * knowing because it is quieter than a broken connection: picking it set
   * `vpnProfileId`, `vpnDial` asked the driver for a forward, the driver has
   * none, and the `unsupported` branch dialled the server directly. So the
   * connection WORKED and the app said it was going via ngrok when it was
   * not — a false statement about where traffic goes, on the screen whose
   * whole job is saying where traffic goes.
   */
  const usable = profiles.filter((p) => p.spec.kind !== 'frp' && p.spec.kind !== 'ngrok')

  // The status map is only filled while the VPN pane is mounted, and this form
  // can be opened without ever going there. Without this reconcile the chip
  // would confidently say "Stopped" about a tunnel that is up.
  useEffect(() => {
    if (!bridgeHas(window.opsmaxx?.vpn as Record<string, unknown> | undefined, 'list')) return
    void window.opsmaxx?.vpn.list().then((list) => {
      list?.forEach((st) => setVpnStatus(st.id, st))
    })
  }, [setVpnStatus])

  const selected = value ? usable.find((p) => p.id === value) : undefined
  // A saved reference to a profile that is no longer here. Main resolves this
  // to "connect directly" rather than failing, so it is a stale pointer to tidy
  // up — not a broken connection, and the wording must not imply otherwise.
  const missing = !!value && !selected
  const health = vpnHealth(selected ? vpnStatuses[selected.id] : undefined)

  return (
    <div className="field">
      <label className="field-label">{t('vpn.transport.label')}</label>
      <div className="row" style={{ gap: 8 }}>
        <select
          className="input grow"
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value || null)}
        >
          <option value="">{t('vpn.transport.direct')}</option>
          {usable.map((p) => (
            <option key={p.id} value={p.id}>
              {t('vpn.transport.via', { name: p.name, kind: KIND_LABEL[p.spec.kind] })}
            </option>
          ))}
          {/* Kept selectable so the field shows what is actually stored. Picking
              "Direct" is how it is cleared. */}
          {missing && <option value={value ?? ''}>{t('vpn.transport.missingOption')}</option>}
        </select>
        {selected && <HealthChip health={health} />}
      </div>

      {missing ? (
        <div className="row" style={{ gap: 6, color: 'var(--warn)', fontSize: 11, marginTop: 6 }}>
          <AlertTriangle size={12} />
          <span>
            <Trans i18nKey="vpn.transport.missingWarning" components={{ em: <em /> }} />
          </span>
        </div>
      ) : selected && health === 'off' ? (
        // Not a warning: connecting starts the profile. Saying so beats leaving
        // the user to wonder whether they have to go and press Start first.
        <span className="field-hint">
          {t('vpn.transport.stoppedHint', { name: selected.name })}
        </span>
      ) : null}

      {usable.length === 0 && !missing ? (
        <span className="field-hint">
          {t('vpn.transport.noneHint')}
        </span>
      ) : (
        <span className="field-hint">{hint}</span>
      )}
    </div>
  )
}
