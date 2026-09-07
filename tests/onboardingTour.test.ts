import { describe, it, expect } from 'vitest'

import { FEATURE_TIPS, FULL_WALKTHROUGH, TOUR_STEPS } from '../src/renderer/src/components/onboarding/tourSteps'

// The tour was eight panels shown before the user had done anything. Its only
// actionable step was third; step four parked them in front of a live "Master
// password (min 12 characters)" field 60 seconds into a first launch, for the
// single most irreversible commitment in the product — one that, by the app's
// own words, "is never stored anywhere, so if you lose it the contents cannot
// be recovered".

describe('first run asks for one thing', () => {
  it('is two steps, not eight', () => {
    expect(TOUR_STEPS).toHaveLength(2)
  })

  // The whole point of the reorder. A first-run user needs a server; everything
  // else is a thing to learn when they get there.
  it('opens on the only step a new user can act on', () => {
    expect(TOUR_STEPS[0].view).toBe('connections')
    expect(TOUR_STEPS[0].action).toMatch(/add a server|import/i)
  })

  // THE assertion. A password chosen to get past a tour panel is chosen
  // carelessly, and it cannot be recovered.
  it('never asks for a master password before the user has done anything', () => {
    const text = TOUR_STEPS.map((s) => `${s.title} ${s.body} ${s.action ?? ''}`).join(' ')
    expect(text.toLowerCase()).not.toContain('master password')
    expect(TOUR_STEPS.some((s) => s.view === 'vault')).toBe(false)
  })

  it('ends on the shortcut that reaches everything else', () => {
    expect(TOUR_STEPS[1].body).toMatch(/Cmd\/Ctrl\+K/)
  })
})

describe('the six deferred steps are deferred, not deleted', () => {
  it('keeps every one of them', () => {
    for (const id of ['tip-workspaces', 'tip-vault', 'tip-monitor', 'tip-tunnels', 'tip-ai']) {
      expect(FEATURE_TIPS.some((t) => t.id === id), id).toBe(true)
    }
  })

  // A tip is triggered BY opening its view, which is what makes it land: the
  // reader went there, so they have a reason to want it.
  it('anchors every tip to a view', () => {
    for (const t of FEATURE_TIPS) {
      expect(t.view, t.id).toBeTruthy()
      expect(t.body.length, t.id).toBeGreaterThan(40)
    }
  })

  // Two of the old steps were narrated over screens that contradicted them:
  // "live CPU, memory, disk" over the Fleet keys tab, "tunnels and databases"
  // over an empty frp panel. A tip anchored to its own view cannot be staged
  // over the wrong one — but only if each view has at most one.
  it('gives no view two competing tips', () => {
    const views = FEATURE_TIPS.map((t) => t.view)
    expect(new Set(views).size).toBe(views.length)
  })

  it('has no duplicate ids, so "seen" cannot mark the wrong one', () => {
    const ids = [...FEATURE_TIPS, ...TOUR_STEPS].map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('replaying from Settings gives the whole thing', () => {
  // Somebody who reopens the walkthrough asked for it. Handing them the two
  // first-run panels — because the other six trigger on views they have long
  // since visited — would be a worse answer than the eight-panel tour was.
  it('contains every step and every tip', () => {
    expect(FULL_WALKTHROUGH).toHaveLength(TOUR_STEPS.length + FEATURE_TIPS.length)
    for (const s of [...TOUR_STEPS, ...FEATURE_TIPS]) {
      expect(FULL_WALKTHROUGH.some((x) => x.id === s.id), s.id).toBe(true)
    }
  })

  it('still opens on connections and ends on the shortcut', () => {
    expect(FULL_WALKTHROUGH[0].id).toBe(TOUR_STEPS[0].id)
    expect(FULL_WALKTHROUGH[FULL_WALKTHROUGH.length - 1].id).toBe(TOUR_STEPS[1].id)
  })
})
