import { Globe, Plus } from 'lucide-react'
import { EmptyState } from '../common/EmptyState'
import { FoundProfilesBanner } from './FoundProfilesBanner'
import { useApp, useWorkspaceVpns } from '../../store/app'
import { useVpnProfiles } from './useVpnProfiles'
import { isReverseProxyKind } from '../../../../shared/vpn'
import { toast } from '../../store/toast'
import type { VpnProfile } from '../../types'
import { useT } from '../../lib/i18n'

/** WireGuard and OpenVPN profiles. frp lives next door in `FrpManager`: it is
 *  the same subsystem but the opposite direction of travel, and the two lists
 *  stacked in one scrolling column were how frp ended up below the fold. */
export function VpnManager(): React.JSX.Element {
  const t = useT()
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
   * There is no file and nothing to fill in: the embedded node holds its own
   * state and its own login, and there is nothing for a form to carry. So the
   * whole creation flow is one button — a form would be a form with no fields.
   *
   * One per workspace, because the spec is `{ kind: 'tailscale' }` and carries
   * nothing to tell two of them apart — a second would describe the same thing
   * twice.
   */
  const addTailscale = (): void => {
    if (hasTailscale) {
      toast(t('vpn.manager.tailscaleExists'), 'ok')
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
    toast(t('vpn.manager.tailscaleAdded'), 'ok')
  }

  return (
    <div className="content">
      <div className="content-header">
        <div>
          <h1>{t('vpn.manager.title')}</h1>
          <div className="sub">{t('vpn.manager.subtitle')}</div>
        </div>
        <div className="spacer" />
        <button className="btn secondary size-28" onClick={() => importProfile('wireguard')}>
          <Plus size={14} /> {t('vpn.manager.importWireguard')}
        </button>
        <button className="btn secondary size-28" onClick={() => importProfile('openvpn')}>
          <Plus size={14} /> {t('vpn.manager.importOpenvpn')}
        </button>
        {/* Not "Import": there is no file. See addTailscale. */}
        <button className="btn secondary size-28" disabled={hasTailscale} onClick={addTailscale}>
          <Plus size={14} /> {t('vpn.manager.addTailscale')}
        </button>
      </div>

      {/* Above both the empty state and the list. A machine that already has
          OpenVPN set up is the case where the empty state is most wrong: it
          says "No VPN profiles" to somebody who has several, a few
          directories away. */}
      {/* The kind comes from the banner: it knows what it found, and the
          dialog shows one kind at a time, so opening the OpenVPN one for a
          WireGuard find showed an empty list. */}
      <FoundProfilesBanner onReview={(kind) => importProfile(kind)} />

      {profiles.length === 0 ? (
        <EmptyState
          icon={<Globe size={26} />}
          title={t('vpn.manager.emptyTitle')}
          message={t('vpn.manager.emptyMessage')}
          // Both, because the header offers both and the sentence above names
          // both. A single "Import WireGuard" button here was the only thing on
          // an OpenVPN user's first screen that looked like the way in, and it
          // was the wrong one — the header's second button is easy to miss when
          // there is a filled button in the middle of the pane.
          action={
            <div className="row" style={{ gap: 'var(--sp-2)' }}>
              <button className="btn primary" onClick={() => importProfile('wireguard')}>
                <Plus size={15} /> {t('vpn.manager.importWireguard')}
              </button>
              <button className="btn secondary size-32" onClick={() => importProfile('openvpn')}>
                <Plus size={15} /> {t('vpn.manager.importOpenvpn')}
              </button>
              <button className="btn secondary size-32" onClick={addTailscale}>
                <Plus size={15} /> {t('vpn.manager.addTailscale')}
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
