import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useOnboarding } from '../src/renderer/src/store/onboarding'
import {
  FEATURE_TIPS,
  FULL_WALKTHROUGH,
  TOUR_STEPS,
  walkthroughFor
} from '../src/renderer/src/components/onboarding/tourSteps'
import { defaultModuleState } from '../src/shared/modules'

const store = new Map<string, string>()

beforeEach(() => {
  store.clear()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k)
  })
  useOnboarding.setState({ open: false, step: 0, setupOpen: false })
})

describe('when the walkthrough appears', () => {
  it('opens on a first run, behind the setup questions', () => {
    // A first run asks which modules the user wants BEFORE walking them
    // through the app, because the walkthrough of an install with fifteen of
    // twenty modules off is a walkthrough of an empty app. The card opens
    // first and hands over.
    useOnboarding.getState().openIfFirstRun()
    expect(useOnboarding.getState().setupOpen).toBe(true)
    expect(useOnboarding.getState().open).toBe(false)

    useOnboarding.getState().finishSetup()
    expect(useOnboarding.getState().setupOpen).toBe(false)
    expect(useOnboarding.getState().open).toBe(true)
  })

  it('does not replay the walkthrough at an install that has already seen it', () => {
    // An existing install upgrading into the setup card has never been asked
    // the questions but has long since been walked through the app. Answering
    // them must not read as a regression to the tour.
    useOnboarding.getState().openIfFirstRun()
    useOnboarding.getState().finishSetup()
    useOnboarding.getState().finish()

    store.delete('opsmaxx.onboarding.setup')
    useOnboarding.getState().openIfFirstRun()
    expect(useOnboarding.getState().setupOpen).toBe(true)

    useOnboarding.getState().finishSetup()
    expect(useOnboarding.getState().open).toBe(false)
  })

  it('does not ask the setup questions twice', () => {
    useOnboarding.getState().openIfFirstRun()
    useOnboarding.getState().finishSetup()
    useOnboarding.setState({ open: false, setupOpen: false })

    useOnboarding.getState().openIfFirstRun()
    expect(useOnboarding.getState().setupOpen).toBe(false)
  })

  it('does not reappear once it has been finished', () => {
    useOnboarding.getState().openIfFirstRun()
    useOnboarding.getState().finish()
    useOnboarding.setState({ open: false })

    useOnboarding.getState().openIfFirstRun()
    expect(useOnboarding.getState().open).toBe(false)
  })

  it('does not reappear after being skipped either', () => {
    // Skip goes through finish(): someone who dismissed it has decided, and
    // showing it again next launch would be nagging.
    useOnboarding.getState().start()
    useOnboarding.getState().finish()
    useOnboarding.getState().openIfFirstRun()
    expect(useOnboarding.getState().open).toBe(false)
  })

  it('can always be reopened deliberately, even after being dismissed', () => {
    useOnboarding.getState().finish()
    useOnboarding.getState().start()
    expect(useOnboarding.getState().open).toBe(true)
    expect(useOnboarding.getState().step).toBe(0)
  })

  it('still opens when localStorage is unavailable rather than throwing', () => {
    // A wiped profile or a locked-down environment must not crash the app on
    // launch; offering the tour once more is the harmless failure.
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      }
    })
    expect(() => useOnboarding.getState().openIfFirstRun()).not.toThrow()
    // The setup card, which is what a first run opens now. Unreadable storage
    // reads as "never asked", so the harmless direction is preserved.
    expect(useOnboarding.getState().setupOpen).toBe(true)
    expect(() => useOnboarding.getState().finishSetup()).not.toThrow()
    expect(useOnboarding.getState().open).toBe(true)
    expect(() => useOnboarding.getState().finish()).not.toThrow()
  })
})

describe('moving through it', () => {
  it('advances and goes back', () => {
    const s = useOnboarding.getState()
    s.start()
    s.next()
    expect(useOnboarding.getState().step).toBe(1)
    useOnboarding.getState().back()
    expect(useOnboarding.getState().step).toBe(0)
  })

  it('cannot go back past the first step', () => {
    useOnboarding.getState().start()
    useOnboarding.getState().back()
    expect(useOnboarding.getState().step).toBe(0)
  })

  it('resets to the start when reopened', () => {
    useOnboarding.getState().start()
    useOnboarding.getState().goTo(4)
    useOnboarding.getState().finish()
    useOnboarding.getState().start()
    expect(useOnboarding.getState().step).toBe(0)
  })
})

describe('the steps themselves', () => {
  // The guarantee is unchanged — a new user is told these things exist — but it
  // is no longer all delivered up front. Five of the six now arrive the first
  // time the user opens the view each describes, so the assertion moved to the
  // union rather than being weakened: nothing was dropped, it was deferred.
  it('covers the features a new user would otherwise find by accident', () => {
    const ids = FULL_WALKTHROUGH.map((s) => s.id)
    for (const required of [
      'connections',
      'tip-workspaces',
      'tip-vault',
      'tip-monitor',
      'tip-tunnels',
      'tip-ai'
    ]) {
      expect(ids, required).toContain(required)
    }
  })

  it('stays short enough that people finish it', () => {
    // A tour people skip teaches nothing, and eight panels before the user has
    // done anything is a tour people skip. Two is the whole first run, and THIS is
    // the assertion that ratchet was really about — it is unchanged and must stay.
    expect(TOUR_STEPS.length).toBeLessThanOrEqual(2)
  })

  // The replay's ceiling, restated.
  //
  // It used to be `FULL_WALKTHROUGH.length <= 9`, written when the replay and the
  // catalogue were the same list. They are not any more: `FULL_WALKTHROUGH` is the
  // complete set — pinned as such by tests/onboardingTour.test.ts, because a replay
  // from Settings is somebody asking for everything — while what a person actually
  // SEES is `walkthroughFor(modules)`, filtered to the modules that install has.
  //
  // So a bare count over the catalogue had stopped measuring the thing the ratchet
  // cared about. Four panels were added for Docker, Kubernetes, CI/CD and local
  // processes, and on a default install two of those four are switched off and
  // never shown. Asserting the catalogue would have counted panels nobody is
  // offered; asserting the adapted list counts panels somebody has to click
  // through, which is what "short enough that people finish it" meant.
  //
  // The second assertion is the one that keeps this honest as the product grows: a
  // panel may only be added to the replay by being EARNED — every step past the
  // original eight has to name a module, so it can be filtered out again for
  // somebody who does not have it. A step with no module is a step shown to
  // everybody forever, and those are capped at the eight that were already there.
  it('shows no more of the replay than the install has earned', () => {
    const seen = walkthroughFor(defaultModuleState())
    expect(seen.length, seen.map((x) => x.id).join(', ')).toBeLessThanOrEqual(10)

    const unconditional = FULL_WALKTHROUGH.filter(
      (step) => !FEATURE_TIPS.some((t) => t.id === step.id && t.module)
    )
    expect(unconditional.length, unconditional.map((x) => x.id).join(', ')).toBeLessThanOrEqual(8)
  })

  it('never walks somebody through a module they switched off', () => {
    // The point of adapting it at all. A panel about a disabled module describes a
    // screen the reader cannot reach, which spends the walkthrough's credibility on
    // a feature that is not there.
    const off = walkthroughFor({})
    for (const id of ['tip-docker', 'tip-kubernetes', 'tip-cicd', 'tip-processes']) {
      expect(off.map((x) => x.id), id).not.toContain(id)
    }
    // And it still has its shape: opens on adding a server, ends on the palette.
    expect(off[0].id).toBe(TOUR_STEPS[0].id)
    expect(off[off.length - 1].id).toBe(TOUR_STEPS[1].id)
  })

  it('has unique ids, since they key the progress dots', () => {
    expect(new Set(TOUR_STEPS.map((s) => s.id)).size).toBe(TOUR_STEPS.length)
  })

  it('gives every step something to read', () => {
    for (const s of TOUR_STEPS) {
      expect(s.title.length, s.id).toBeGreaterThan(0)
      expect(s.body.length, s.id).toBeGreaterThan(40)
    }
  })

  it('only points at views that exist', () => {
    const views = ['connections', 'databases', 'tunnels', 'monitor', 'vault', 'ai']
    for (const s of TOUR_STEPS) {
      if (s.view) expect(views, s.id).toContain(s.view)
    }
  })
})
