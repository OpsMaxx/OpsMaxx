import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useOnboarding } from '../src/renderer/src/store/onboarding'
import { FULL_WALKTHROUGH, TOUR_STEPS } from '../src/renderer/src/components/onboarding/tourSteps'

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
    // done anything is a tour people skip. Two is the whole first run.
    expect(TOUR_STEPS.length).toBeLessThanOrEqual(2)
    expect(FULL_WALKTHROUGH.length).toBeLessThanOrEqual(9)
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
