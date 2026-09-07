import { Globe, Plus } from 'lucide-react'
import { EmptyState } from '../common/EmptyState'
import { useWorkspaceVpns } from '../../store/app'
import { useVpnProfiles } from './useVpnProfiles'

/** WireGuard and OpenVPN profiles. frp lives next door in `FrpManager`: it is
 *  the same subsystem but the opposite direction of travel, and the two lists
 *  stacked in one scrolling column were how frp ended up below the fold. */
export function VpnManager(): React.JSX.Element {
  const profiles = useWorkspaceVpns().filter((p) => p.spec.kind !== 'frp')
  const { row, dialogs, importProfile } = useVpnProfiles()

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
      </div>

      {profiles.length === 0 ? (
        <EmptyState
          icon={<Globe size={26} />}
          title="No VPN profiles"
          message="Import a WireGuard .conf or an OpenVPN .ovpn to carry servers, databases and tunnels over a VPN."
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
