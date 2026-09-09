import { Globe, Plus } from 'lucide-react'
import { EmptyState } from '../common/EmptyState'
import { useApp, useWorkspaceVpns } from '../../store/app'
import { useVpnProfiles } from './useVpnProfiles'
import { isReverseProxyKind } from '../../../../shared/vpn'
import { toast } from '../../store/toast'
import type { VpnProfile } from '../../types'

/** WireGuard and OpenVPN profiles. frp lives next door in `FrpManager`: it is
 *  the same subsystem but the opposite direction of travel, and the two lists
 *  stacked in one scrolling column were how frp ended up below the fold. */
export function VpnManager(): React.JSX.Element {
  // Everything that is not a reverse proxy. See isReverseProxyKind for why the
  // two panels share one predicate rather than each spelling it out.
  const profiles = useWorkspaceVpns().filter((p) => !isReverseProxyKind(p.spec.kind))
  const { row, dialogs, importProfile } = useVpnProfiles()
  const upsertVpnProfile = useApp((s) => s.upsertVpnProfile)
  const activeId = useApp((s) => s.activeId)
  const hasTailscale = profiles.some((p) => p.spec.kind === 'tailscale')

  /**
   * Tailscale is ADDED, not imported.
   *
   * There is no file and nothing to fill in: the daemon on this machine holds
   * its own state and its own login, and this profile is only the app's view of
   * it. So the whole creation flow is one button — a form would be a form with
   * no fields.
   *
   * One per workspace, because a second profile would poll the same daemon and
   * report the same state twice.
   */
  const addTailscale = (): void => {
    if (hasTailscale) {
      toast('This workspace already has a Tailscale profile.', 'ok')
      return
    }
    const profile: VpnProfile = {
      id: `vpn-${crypto.randomUUID()}`,
      workspaceId: activeId(),
      name: 'Tailscale',
      // Never on by default: starting it only reads status, but a profile that
      // starts itself is a profile that reports errors before the user has
      // looked at it.
      autoStart: false,
      spec: { kind: 'tailscale' }
    }
    upsertVpnProfile(profile)
    toast('Tailscale added — it uses the client already installed on this machine.', 'ok')
  }

  return (
    <div className="content">
      <div className="content-header">
        <div>
          <h1>VPN</h1>
          <div className="sub">WireGuard and OpenVPN tunnels</div>
        </div>
        <div className="spacer" />
        <button className="btn secondary size-28" onClick={() => importProfile('wireguard')}>
          <Plus size={14} /> Import WireGuard
        </button>
        <button className="btn secondary size-28" onClick={() => importProfile('openvpn')}>
          <Plus size={14} /> Import OpenVPN
        </button>
        {/* Not "Import": there is no file. See addTailscale. */}
        <button className="btn secondary size-28" disabled={hasTailscale} onClick={addTailscale}>
          <Plus size={14} /> Add Tailscale
        </button>
      </div>

      {profiles.length === 0 ? (
        <EmptyState
          icon={<Globe size={26} />}
          title="No VPN profiles"
          message="Import a WireGuard .conf or an OpenVPN .ovpn to carry servers, databases and tunnels over a VPN. Tailscale needs no file — it uses the client already on this machine."
          // Both, because the header offers both and the sentence above names
          // both. A single "Import WireGuard" button here was the only thing on
          // an OpenVPN user's first screen that looked like the way in, and it
          // was the wrong one — the header's second button is easy to miss when
          // there is a filled button in the middle of the pane.
          action={
            <div className="row" style={{ gap: 'var(--sp-2)' }}>
              <button className="btn primary" onClick={() => importProfile('wireguard')}>
                <Plus size={15} /> Import WireGuard
              </button>
              <button className="btn secondary size-32" onClick={() => importProfile('openvpn')}>
                <Plus size={15} /> Import OpenVPN
              </button>
              <button className="btn secondary size-32" onClick={addTailscale}>
                <Plus size={15} /> Add Tailscale
              </button>
            </div>
          }
        />
      ) : (
        <div className="col" style={{ gap: 8, paddingBottom: 16 }}>
          {profiles.map(row)}
        </div>
      )}

      {dialogs}
    </div>
  )
}
