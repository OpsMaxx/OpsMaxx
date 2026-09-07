import { useEffect, useState } from 'react'
import { Compass, X } from 'lucide-react'
import { useOnboarding } from '../../store/onboarding'
import { useApp } from '../../store/app'
import { FEATURE_TIPS } from './tourSteps'

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
  const tourOpen = useOnboarding((s) => s.open)
  const seenTips = useOnboarding((s) => s.seenTips)
  const markTipSeen = useOnboarding((s) => s.markTipSeen)

  // Held locally as well as in the store so the card can be shown for the view
  // the user is ON, and stay put while they read it, rather than vanishing the
  // instant `markTipSeen` runs.
  const [shownId, setShownId] = useState<string | null>(null)

  useEffect(() => {
    // Never while the walkthrough itself is open: two cards explaining the same
    // screen at once is worse than either alone.
    if (tourOpen) {
      setShownId(null)
      return
    }
    const seen = new Set(seenTips)
    const tip = FEATURE_TIPS.find((t) => t.view === activity && !seen.has(t.id))
    setShownId(tip?.id ?? null)
  }, [activity, seenTips, tourOpen])

  if (!shownId) return null
  const tip = FEATURE_TIPS.find((t) => t.id === shownId)
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
