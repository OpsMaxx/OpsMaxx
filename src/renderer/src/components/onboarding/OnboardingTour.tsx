import { useEffect, useMemo } from 'react'
import { ArrowLeft, ArrowRight, Check, Compass } from 'lucide-react'
import { useOnboarding } from '../../store/onboarding'
import { useApp } from '../../store/app'
import { clsx } from '../../lib/format'
import { TOUR_STEPS, walkthroughFor } from './tourSteps'
import { approvalShowing } from '../../hooks/useClickOutside'

// A first-run walkthrough, mounted once at the app root.
//
// Deliberately not a modal over a dimmed screen: each step switches to the
// view it describes and the card sits in a corner, so the feature is visible
// while it is explained. A tour that hides the app while describing it teaches
// nothing you can act on.
export function OnboardingTour(): React.JSX.Element | null {
  const open = useOnboarding((s) => s.open)
  const step = useOnboarding((s) => s.step)
  const next = useOnboarding((s) => s.next)
  const back = useOnboarding((s) => s.back)
  const goTo = useOnboarding((s) => s.goTo)
  const finish = useOnboarding((s) => s.finish)
  const openIfFirstRun = useOnboarding((s) => s.openIfFirstRun)
  const full = useOnboarding((s) => s.full)
  const setActivity = useApp((s) => s.setActivity)

  // A first run gets the two steps that matter; the rest arrive as tips when the
  // user opens the view each describes. Somebody who reopens this from Settings
  // asked for the walkthrough, so they get all of it — deferring the tips to
  // triggers they have already passed would hand them two panels and nothing else.
  //
  // ADAPTED TO WHAT THIS INSTALL HAS. "All of it" cannot honestly include panels
  // about modules the user switched off during setup: the walkthrough would be
  // describing screens they cannot reach, which spends its credibility on features
  // that are not there and teaches the reader that the rest may not be either.
  // `walkthroughFor` drops those; the first and last steps are never about a
  // module, so it still opens on adding a server and still ends on the palette.
  const modules = useApp((s) => s.settings.modules)
  const steps = useMemo(
    () => (full ? walkthroughFor(modules) : TOUR_STEPS),
    [full, modules]
  )

  useEffect(() => {
    openIfFirstRun()
  }, [openIfFirstRun])

  const current = steps[step]

  // Move the app to whatever this step is about.
  useEffect(() => {
    if (open && current?.view) setActivity(current.view)
  }, [open, current?.view, setActivity])

  // Escape closes it, the same as Skip — a tour you cannot dismiss with the
  // obvious key is a trap.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      // The approval layer is above the tour, so its keys are not the tour's.
      if (approvalShowing()) return
      if (e.key === 'Escape') finish()
      if (e.key === 'ArrowRight') {
        if (step < steps.length - 1) next()
        else finish()
      }
      if (e.key === 'ArrowLeft') back()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, step, steps.length, next, back, finish])

  if (!open || !current) return null
  const last = step === steps.length - 1

  return (
    <div className="tour-card" role="dialog" aria-label="OpsMaxx walkthrough">
      <div className="row" style={{ gap: 8, alignItems: 'center' }}>
        <Compass size={16} style={{ color: 'var(--accent-ink)' }} />
        <b>{current.title}</b>
        <span className="spacer" />
        <span className="server-meta">
          {step + 1} / {steps.length}
        </span>
      </div>

      <div className="s-desc" style={{ marginTop: 8 }}>
        {current.body}
      </div>

      {current.action && (
        <div className="tour-action">
          <Check size={12} /> {current.action}
        </div>
      )}

      <div className="tour-dots">
        {steps.map((s, i) => (
          <button
            key={s.id}
            className={clsx('tour-dot', i === step && 'active')}
            aria-label={s.title}
            onClick={() => goTo(i)}
          />
        ))}
      </div>

      <div className="row" style={{ gap: 8, marginTop: 10 }}>
        <button className="btn sm" disabled={step === 0} onClick={back}>
          <ArrowLeft size={13} /> Back
        </button>
        <button className="btn sm primary" onClick={() => (last ? finish() : next())}>
          {last ? (
            <>
              <Check size={13} /> Done
            </>
          ) : (
            <>
              Next <ArrowRight size={13} />
            </>
          )}
        </button>
        <span className="spacer" />
        {!last && (
          <button className="btn sm ghost" onClick={finish}>
            Skip
          </button>
        )}
      </div>
    </div>
  )
}
