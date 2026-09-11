import { describe, expect, it } from 'vitest'
import {
  SETUP_QUESTIONS,
  applySetupAnswers,
  defaultSetupAnswers
} from '../src/renderer/src/components/onboarding/setupQuestions'
import { MODULES, defaultModuleState, moduleEnabled } from '../src/shared/modules'
import type { ModuleId } from '../src/shared/modules'

/**
 * The first-run questions.
 *
 * A new install used to arrive with fifteen of twenty modules off and nothing
 * anywhere that asked which ones the user wanted, so Docker and Kubernetes --
 * headline features -- were five clicks behind an unlabelled `+`. These tests
 * pin the two halves of the fix that can go wrong quietly: that pressing Enter
 * without reading produces a fuller app, and that it can never produce one
 * that writes to a server.
 */

/** Everything a question can turn on. */
const OFFERED = new Set<ModuleId>(SETUP_QUESTIONS.flatMap((q) => q.modules))

describe('what the card can switch on', () => {
  it('never offers the modules that are protected by living in Settings alone', () => {
    // `rules` is the only unattended execution path in the app; `keyRevoke`
    // removes people's SSH access; `access` reads other accounts' authorized_keys
    // with sudo on every host. Each is deliberately reachable from one place.
    // A first-run card that could tick any of them would undo that on day one.
    for (const id of ['rules', 'keyRevoke', 'access'] as ModuleId[]) {
      expect(OFFERED.has(id)).toBe(false)
    }
  })

  it('offers nothing that is not a real module', () => {
    const known = new Set(MODULES.map((m) => m.id))
    for (const id of OFFERED) expect(known.has(id)).toBe(true)
  })

  it('preselects only answers whose modules read', () => {
    const write = new Set(MODULES.filter((m) => m.surface === 'operate').map((m) => m.id))
    for (const q of SETUP_QUESTIONS) {
      if (!q.preselected) continue
      for (const id of q.modules) expect(write.has(id)).toBe(false)
    }
  })
})

describe('pressing Enter without reading', () => {
  const state = applySetupAnswers(defaultModuleState(), defaultSetupAnswers())

  it('leaves the user with the container panels on', () => {
    expect(moduleEnabled(state, 'docker')).toBe(true)
    expect(moduleEnabled(state, 'kubernetes')).toBe(true)
  })

  it('turns on nothing that writes to a server', () => {
    for (const m of MODULES) {
      if (m.surface === 'operate') expect(moduleEnabled(state, m.id)).toBe(false)
    }
  })

  it('turns on nothing that reads every host on a schedule', () => {
    // Running a package manager hourly across the estate is a thing somebody
    // should ask for, and the default answer to the fleet question is no.
    expect(moduleEnabled(state, 'inventory')).toBe(false)
    expect(moduleEnabled(state, 'posture')).toBe(false)
  })
})

describe('answering', () => {
  it('turns an answer off as well as on', () => {
    // The card shows what each answer controls, so unticking containers has to
    // mean something -- honouring only the ticks would make it a one-way switch
    // that disagrees with what it displayed.
    const on = applySetupAnswers(defaultModuleState(), { containers: true })
    const off = applySetupAnswers(on, { containers: false })
    expect(moduleEnabled(off, 'docker')).toBe(false)
    expect(moduleEnabled(off, 'kubernetes')).toBe(false)
  })

  it('leaves modules no question names alone', () => {
    const before = defaultModuleState()
    const after = applySetupAnswers(before, { containers: false, fleet: true, operate: true })
    for (const m of MODULES) {
      if (OFFERED.has(m.id)) continue
      expect(moduleEnabled(after, m.id)).toBe(moduleEnabled(before, m.id))
    }
  })
})
