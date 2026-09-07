import { create } from 'zustand'
import { FEATURE_TIPS } from '../components/onboarding/tourSteps'

// Whether the walkthrough has been seen. A UI preference, so it lives with the
// UI rather than in the workspace data file — it is about this installation,
// not about the servers in it, and it should not travel in an encrypted backup.
const SEEN_KEY = 'shellpilot.onboarding.seen'
// Which deferred tips have been shown. Same reasoning as SEEN_KEY: a UI
// preference about this installation, not data about the servers in it.
const TIPS_KEY = 'shellpilot.onboarding.tips'

function readTips(): string[] {
  try {
    const raw = localStorage.getItem(TIPS_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    // A wiped profile or private mode: worst case a tip is offered once more,
    // which is the harmless direction to fail in.
    return []
  }
}

interface OnboardingState {
  open: boolean
  step: number
  /**
   * Whether this run is a replay from Settings.
   *
   * Somebody who asks for the walkthrough explicitly wants the whole thing;
   * a first run wants the two steps that matter and gets the rest as it goes.
   * The tour reads this to decide which list to render.
   */
  full: boolean
  /** Tip ids already shown, so a first visit happens exactly once. */
  seenTips: string[]
  /** True when this view has a tip nobody has seen yet. */
  tipFor: (view: string) => string | null
  markTipSeen: (id: string) => void
  start: () => void
  next: () => void
  back: () => void
  goTo: (i: number) => void
  finish: () => void
  // Opens on a first run and never again on its own; Settings can always
  // reopen it.
  openIfFirstRun: () => void
}

export const useOnboarding = create<OnboardingState>((set, get) => ({
  open: false,
  step: 0,
  full: false,
  seenTips: readTips(),

  tipFor: (view) => {
    // Imported lazily to keep this store free of a component dependency; the
    // list is a plain data module, so there is no cycle.
    const seen = new Set(get().seenTips)
    const tip = FEATURE_TIPS.find((t) => t.view === view && !seen.has(t.id))
    return tip ? tip.id : null
  },

  markTipSeen: (id) => {
    if (get().seenTips.includes(id)) return
    const next = [...get().seenTips, id]
    try {
      localStorage.setItem(TIPS_KEY, JSON.stringify(next))
    } catch {
      /* see readTips */
    }
    set({ seenTips: next })
  },

  // From Settings: the whole walkthrough, because that is what was asked for.
  start: () => set({ open: true, step: 0, full: true }),
  next: () => set({ step: get().step + 1 }),
  back: () => set({ step: Math.max(0, get().step - 1) }),
  goTo: (i) => set({ step: Math.max(0, i) }),

  finish: () => {
    // Written on finish AND on skip: someone who dismissed it has decided, and
    // showing it again on next launch would be nagging.
    try {
      localStorage.setItem(SEEN_KEY, '1')
    } catch {
      /* private mode or a wiped profile: worst case it offers once more */
    }
    set({ open: false, step: 0, full: false })
  },

  openIfFirstRun: () => {
    let seen = false
    try {
      seen = localStorage.getItem(SEEN_KEY) === '1'
    } catch {
      seen = false
    }
    // First run gets the short version; the rest arrives as tips.
    if (!seen) set({ open: true, step: 0, full: false })
  }
}))
