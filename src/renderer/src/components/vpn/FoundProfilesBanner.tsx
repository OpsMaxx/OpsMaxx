import { useEffect, useState } from 'react'
import { Globe, X } from 'lucide-react'
import { useApp } from '../../store/app'
import { bridgeHas } from '../../lib/bridge'
import { withVaultUnlock } from '../../lib/withVaultUnlock'
import { toast } from '../../store/toast'
import type { DiscoveredVpnProfile } from '../../../../shared/vpn'

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
 * So it counts them, and the buttons do the rest. "Import all" keeps the second
 * promise the only way it can be kept in one press: it imports the profiles
 * whose report is EMPTY — nothing was stripped, so there is nothing to have
 * seen — and hands the rest to Review, which shows each report before anything
 * is written. It used to commit the lot, report unread, three lines under a
 * comment saying it must not.
 */

/**
 * What has already been offered and turned down — the source paths, not a flag.
 *
 * A bare flag was permanent and had nothing that cleared it: decline once and
 * the banner never came back, on any machine, for any profile, including ones
 * added afterwards. "Not now" is about the profiles on offer at the time, so
 * that is what is remembered, and a profile this machine did not have yet
 * brings the offer back on its own.
 */
const DISMISSED_KEY = 'opsmaxx.vpn.foundProfiles.dismissed'

function dismissedPaths(): Set<string> {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY)
    // '1' is what the old flag wrote. Read as "nothing specific was declined",
    // so an upgrade re-offers rather than staying silent forever.
    if (!raw || raw === '1') return new Set()
    const parsed: unknown = JSON.parse(raw)
    return new Set(Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : [])
  } catch {
    return new Set()
  }
}

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
  /** Opens the import dialog FOR A KIND. It shows one kind at a time, so a
   *  review that always opened the OpenVPN one could not show a WireGuard
   *  find at all. */
  onReview: (kind: DiscoveredVpnProfile['kind']) => void
}): React.JSX.Element | null {
  const workspaceId = useApp((s) => s.activeId())
  const profiles = useApp((s) => s.vpns)
  const upsertVpnProfile = useApp((s) => s.upsertVpnProfile)

  const [found, setFound] = useState<DiscoveredVpnProfile[]>([])
  const [declined, setDeclined] = useState(dismissedPaths)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
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
  }, [])

  // The scan still runs after a decline: it is what tells us whether anything
  // NEW has turned up since.
  const offer = found.filter((p) => !declined.has(p.sourcePath))
  if (offer.length === 0) return null

  const decline = (): void => {
    const next = new Set([...declined, ...offer.map((p) => p.sourcePath)])
    localStorage.setItem(DISMISSED_KEY, JSON.stringify([...next]))
    setDeclined(next)
  }

  /** The kinds on offer, in the order they were found. One Review button each:
   *  the import dialog shows one kind at a time, so a single button could only
   *  ever reach half of a mixed find. */
  const kinds = [...new Set(offer.map((p) => p.kind))]

  const importAll = async (): Promise<void> => {
    // Only the ones with nothing to report. A profile that had directives
    // stripped out of it goes to Review, where the report is shown before
    // anything is stored — which is what the comment at the top of this file
    // has always said and what this function used not to do.
    const clean = offer.filter((p) => (p.report.stripped?.length ?? 0) === 0)
    const toReview = offer.filter((p) => (p.report.stripped?.length ?? 0) > 0)
    setBusy(true)
    let added = 0
    const failed: string[] = []
    try {
      for (const profile of clean) {
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
          // A COMMIT RESULT IS NOT A PROFILE.
          //
          // This used to hand the store `res` — `{ ok, spec, vaultEntryId }` —
          // cast straight to VpnProfile. The cast went through `as unknown as`,
          // so the compiler said nothing, and the store took an object with no
          // id, no name and no workspaceId. The import genuinely succeeded,
          // the keys went into the vault, and the list showed nothing: the
          // profile the user had just imported had vanished.
          //
          // The import dialog a few files away builds this properly; this is
          // the same construction.
          const spec = res.spec
          // The stripped-directive report travels ON the profile. Six months
          // from now "why does this profile not set my DNS" is answerable from
          // the profile rather than from a dialog nobody kept open.
          if (!spec.strippedDirectives && profile.report.stripped?.length) {
            spec.strippedDirectives = profile.report.stripped
          }
          upsertVpnProfile({
            id: `vpn-${crypto.randomUUID()}`,
            workspaceId,
            name: profile.name,
            autoStart: false,
            spec
          })
          added += 1
        } else {
          failed.push(profile.name)
        }
      }
    } finally {
      setBusy(false)
      setFound((list) => list.filter((p) => !clean.includes(p)))
    }
    // Said out loud either way. A batch that half worked and reported nothing
    // is indistinguishable from one that worked.
    if (added > 0) {
      toast(`Imported ${added} VPN ${added === 1 ? 'profile' : 'profiles'}.`, 'ok')
    }
    if (failed.length > 0) toast(`Could not import: ${failed.join(', ')}.`, 'error')
    if (toReview.length > 0) {
      toast(
        `${toReview.length} ${toReview.length === 1 ? 'profile has' : 'profiles have'} directives OpsMaxx cannot carry over — read what was stripped before importing.`,
        'ok'
      )
      onReview(toReview[0].kind)
    }
  }

  return (
    <div className="vpn-found-offer">
      <Globe size={18} style={{ color: 'var(--accent-ink)', flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="s-title">
          {/* "One OpenVPN profile" rather than "a/an OpenVPN profile": the
              article depends on the label, and the label is data. */}
          {offer.length === 1
            ? `One ${KIND_LABEL[offer[0].kind]} profile is already on this machine`
            : `${offer.length} VPN profiles are already on this machine`}
        </div>
        <div className="s-desc">
          {summary(offer)} Importing copies the keys into the vault; the files on disk are not
          moved or changed.
        </div>
      </div>
      {kinds.map((kind) => (
        <button
          key={kind}
          className="btn secondary size-28"
          onClick={() => onReview(kind)}
          disabled={busy}
        >
          {kinds.length === 1 ? 'Review' : `Review ${KIND_LABEL[kind]}`}
        </button>
      ))}
      <button className="btn primary size-28" onClick={() => void importAll()} disabled={busy}>
        {busy ? 'Importing…' : 'Import all'}
      </button>
      <button className="btn ghost size-28" onClick={decline} title="Not now" disabled={busy}>
        <X size={14} />
      </button>
    </div>
  )
}
