import { useEffect, useState } from 'react'
import { Globe, X } from 'lucide-react'
import { useApp } from '../../store/app'
import { bridgeHas } from '../../lib/bridge'
import { withVaultUnlock } from '../../lib/withVaultUnlock'
import { toast } from '../../store/toast'
import type { DiscoveredVpnProfile, VpnProfile } from '../../../../shared/vpn'

/**
 * OpenVPN profiles this machine already has, offered on the VPN screen.
 *
 * WHY THIS IS NOT ONLY IN THE IMPORT DIALOG. It was, and that is a worse
 * answer than it sounds: a person who has OpenVPN set up already does not
 * think of themselves as importing anything, so the one place the offer
 * appeared was behind a button they had no reason to press. The complaint was
 * "if pre-installed it should automatically import everything" — the discovery
 * has to come to them.
 *
 * NOT AUTO-COMMITTED, deliberately, for two reasons that are not style:
 *
 *  - Importing writes key material to the vault, so it needs the vault open.
 *    A screen that raises a master-password prompt on its own, because of a
 *    file the user did not ask us to read, is not something to do quietly.
 *  - Every import carries a stripped-directive report, and this app's promise
 *    is that nothing is stored before that report has been seen. Committing a
 *    profile nobody looked at would break it.
 *
 * So it counts them, and the buttons do the rest.
 */

/** The same idiom as the vault's biometric offer: a one-time offer that must
 *  not come back every launch once it has been declined. */
const DISMISSED_KEY = 'opsmaxx.vpn.foundProfiles.dismissed'

const KIND_LABEL: Record<DiscoveredVpnProfile['kind'], string> = {
  openvpn: 'OpenVPN',
  wireguard: 'WireGuard'
}

/** "2 OpenVPN and 1 WireGuard." Named rather than counted as "VPN profiles",
 *  because which client left them is what tells the user where they came
 *  from. */
function summary(found: DiscoveredVpnProfile[]): string {
  const counts = new Map<DiscoveredVpnProfile['kind'], number>()
  for (const p of found) counts.set(p.kind, (counts.get(p.kind) ?? 0) + 1)
  const parts = [...counts].map(([kind, n]) => `${n} ${KIND_LABEL[kind]}`)
  return `Left by ${parts.join(' and ')} on this machine.`
}

export function FoundProfilesBanner({
  onReview
}: {
  onReview: () => void
}): React.JSX.Element | null {
  const workspaceId = useApp((s) => s.activeId())
  const profiles = useApp((s) => s.vpns)
  const upsertVpnProfile = useApp((s) => s.upsertVpnProfile)

  const [found, setFound] = useState<DiscoveredVpnProfile[]>([])
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISSED_KEY) === '1')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (dismissed) return
    // Older preload, newer renderer: degrade to showing nothing rather than
    // taking the screen down.
    if (!bridgeHas(window.opsmaxx?.vpn as Record<string, unknown> | undefined, 'discoverProfiles')) {
      return
    }
    let live = true
    const already = profiles
      .map((p) => (p.spec as { sourcePath?: string } | undefined)?.sourcePath)
      .filter((path): path is string => !!path)
    void window.opsmaxx.vpn
      // BOTH KINDS. WireGuard discovery exists in main — /etc/wireguard,
      // ~/.config/wireguard, the official Windows client's tunnel store — and
      // defaults off, so asking for OpenVPN alone left all of it unreachable.
      .discoverProfiles(already, ['openvpn', 'wireguard'])
      // A machine that has never had OpenVPN on it is the ordinary case, and
      // it has nothing to say about it.
      .then((list) => live && setFound(list.filter((p) => p.report.ok)))
      .catch(() => undefined)
    return () => {
      live = false
    }
    // Once per mount. `profiles` changes as these are imported, and re-running
    // would pull the list out from under the button being pressed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dismissed])

  if (dismissed || found.length === 0) return null

  const decline = (): void => {
    localStorage.setItem(DISMISSED_KEY, '1')
    setDismissed(true)
  }

  const importAll = async (): Promise<void> => {
    setBusy(true)
    let added = 0
    const failed: string[] = []
    try {
      for (const profile of found) {
        // Unlock is asked for ONCE, around the whole run: a prompt per profile
        // for a batch the user pressed one button for is how a person learns
        // to click through master-password dialogs.
        const res = await withVaultUnlock('Import the VPN profiles found on this machine', () =>
          window.opsmaxx.vpn.commitImportFile(
            profile.name,
            workspaceId,
            profile.kind,
            profile.sourcePath
          )
        )
        if (res.ok && res.spec) {
          upsertVpnProfile(res as unknown as VpnProfile)
          added += 1
        } else {
          failed.push(profile.name)
        }
      }
    } finally {
      setBusy(false)
      setFound([])
    }
    // Said out loud either way. A batch that half worked and reported nothing
    // is indistinguishable from one that worked.
    if (added > 0) {
      toast(`Imported ${added} OpenVPN ${added === 1 ? 'profile' : 'profiles'}.`, 'ok')
    }
    if (failed.length > 0) toast(`Could not import: ${failed.join(', ')}.`, 'error')
  }

  return (
    <div className="vpn-found-offer">
      <Globe size={18} style={{ color: 'var(--accent-ink)', flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="s-title">
          {/* "One OpenVPN profile" rather than "a/an OpenVPN profile": the
              article depends on the label, and the label is data. */}
          {found.length === 1
            ? `One ${KIND_LABEL[found[0].kind]} profile is already on this machine`
            : `${found.length} VPN profiles are already on this machine`}
        </div>
        <div className="s-desc">
          {summary(found)} Importing copies the keys into the vault; the files on disk are not
          moved or changed.
        </div>
      </div>
      <button className="btn secondary size-28" onClick={onReview} disabled={busy}>
        Review
      </button>
      <button className="btn primary size-28" onClick={() => void importAll()} disabled={busy}>
        {busy ? 'Importing…' : 'Import all'}
      </button>
      <button className="btn ghost size-28" onClick={decline} title="Not now" disabled={busy}>
        <X size={14} />
      </button>
    </div>
  )
}
