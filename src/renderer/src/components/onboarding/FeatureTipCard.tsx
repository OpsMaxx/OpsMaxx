import { useEffect, useState } from 'react'
import { Compass, X } from 'lucide-react'
import { useOnboarding } from '../../store/onboarding'
import { useNav } from '../../store/nav'
import { useApp } from '../../store/app'
import { tipsFor } from './tourSteps'

// The six tour steps that used to be shown before the user had done anything,
// arriving instead the first time they open the view each one is about.
//
// The trigger is the point. A panel four of eight is read by somebody working
// through a queue; a card that appears because they just opened the vault is
// read by somebody already thinking about a credential. Same sentences, and
// they land differently.
//
// It also fixes a staging bug for free. Two of the old steps were narrated over
// screens that contradicted them — "live CPU, memory, disk" over the Fleet keys
// tab, which shows a disabled-feature notice; "tunnels and databases" over an
// empty frp panel, for a technology the Add Server dialog says "is never a
// transport". A tip anchored to its own view cannot be staged over the wrong
// one.
//
// Deliberately NOT a modal. It does not block, it does not dim the screen, and
// it does not take focus: the user came here to do something and the tip is a
// note beside it, not a gate in front of it. Dismissing is the only interaction
// and it is permanent.
export function FeatureTipCard(): React.JSX.Element | null {
  const activity = useApp((s) => s.activity)
  // Monitoring and Operations are two rail destinations sharing ONE
  // ActivityView — deliberately, because they are one mounted tree and a split
  // that unmounted either would kill a running log tail or strand a live
  // fan-out. The cost is that `activity` alone cannot tell them apart, and a
  // tip keyed on it fired the monitoring card while the user was standing in
  // Operations, explaining a screen they were not looking at.
  const fleetRail = useNav((s) => s.fleetRail)
  // Which Monitoring tab is showing. Needed for the same reason `fleetRail` is,
  // one level further down: the four promoted modules (Docker, Kubernetes, CI/CD,
  // local processes) have their own activity-bar buttons but still share
  // `activity === 'monitor'`, so a tip keyed on the view alone would fire the
  // Docker card at somebody standing in Kubernetes.
  const monitorTab = useNav((s) => s.monitorTab)
  const tourOpen = useOnboarding((s) => s.open)
  const setupOpen = useOnboarding((s) => s.setupOpen)
  // Every tip describes something you do WITH a server: isolating clients into
  // workspaces, keeping their credentials in the vault, watching their metrics,
  // tunnelling to them. An install with none has nothing any of them is about,
  // and the workspaces card -- multi-client isolation, shared vault entries --
  // fired the instant the walkthrough ended, to an empty app. Staging a tip
  // behind the view it explains is not enough when the view itself is empty.
  const hasServer = useApp((s) => s.servers.length > 0)
  const seenTips = useOnboarding((s) => s.seenTips)
  // A tip about a module the user switched off describes a screen they cannot
  // reach. `tipsFor` drops those rather than showing them with an apology.
  const modules = useApp((s) => s.settings.modules)
  const markTipSeen = useOnboarding((s) => s.markTipSeen)

  // Held locally as well as in the store so the card can be shown for the view
  // the user is ON, and stay put while they read it, rather than vanishing the
  // instant `markTipSeen` runs.
  const [shownId, setShownId] = useState<string | null>(null)

  useEffect(() => {
    // Never while the walkthrough itself is open: two cards explaining the same
    // screen at once is worse than either alone.
    if (tourOpen || setupOpen || !hasServer) {
      setShownId(null)
      return
    }
    // The monitor tip belongs to the Monitoring rail only. Written as "the
    // view matches AND, where the view is shared, the rail matches too" rather
    // than as a special case for one id, so a second tip on either rail cannot
    // reintroduce this.
    //
    // The third clause is the same rule one level further down. Six tips now share
    // `view: 'monitor'` — one for the Monitoring rail generally and one for each
    // promoted module — so matching the view and the rail is no longer enough to
    // identify a destination. A tip WITH a `tab` fires only on that tab; a tip
    // WITHOUT one fires only when the visible tab is not some other tip's, so the
    // general Monitoring card does not appear over the Docker panel.
    const onSharedView = activity === 'monitor'
    const seen = new Set(seenTips)
    const eligible = tipsFor(modules)
    const claimedTabs = new Set(eligible.map((t) => t.tab).filter(Boolean))
    const tip = eligible.find(
      (t) =>
        t.view === activity &&
        !seen.has(t.id) &&
        (!onSharedView || fleetRail === 'monitor') &&
        (!onSharedView || (t.tab ? t.tab === monitorTab : !claimedTabs.has(monitorTab as never)))
    )
    setShownId(tip?.id ?? null)
  }, [activity, fleetRail, monitorTab, modules, seenTips, tourOpen, setupOpen, hasServer])

  if (!shownId) return null
  const tip = tipsFor(modules).find((t) => t.id === shownId)
  if (!tip) return null

  const dismiss = (): void => {
    setShownId(null)
    markTipSeen(tip.id)
  }

  return (
    <div className="tip-card" role="note" aria-label={tip.title}>
      <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
        <Compass size={15} style={{ color: 'var(--accent-ink)', flex: 'none', marginTop: 1 }} />
        <div style={{ minWidth: 0 }}>
          <b>{tip.title}</b>
          <p className="s-desc" style={{ margin: '6px 0 0' }}>
            {tip.body}
          </p>
          {tip.action && (
            <p className="s-desc" style={{ margin: '6px 0 0', color: 'var(--accent-ink)' }}>
              {tip.action}
            </p>
          )}
        </div>
        {/* Labelled, because an unlabelled x never says whether it defers or
            decides. This one decides: the tip does not come back. */}
        <button
          className="icon-btn"
          style={{ flex: 'none' }}
          title="Got it — do not show this again"
          aria-label="Dismiss tip"
          onClick={dismiss}
        >
          <X size={14} />
        </button>
      </div>
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
        <button className="btn sm" onClick={dismiss}>
          Got it
        </button>
      </div>
    </div>
  )
}
