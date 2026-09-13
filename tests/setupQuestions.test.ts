import { describe, expect, it } from 'vitest'
import {
  SETUP_QUESTIONS,
  PERSONAS,
  PREF_GROUPS,
  DEFAULT_PERSONA_ID,
  applySetupAnswers,
  defaultSetupAnswers,
  personaAnswers,
  prefAvailable,
  prefSummary,
  setupPatch
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
    // with sudo on every host. `cicdTrigger` starts a build on infrastructure
    // OpsMaxx does not administer and cannot stop once it has begun — and the
    // question that WOULD have carried it ("do your servers get changed by a
    // pipeline?") asks what you have, not what you want to be able to do, so
    // ticking it must not also hand over a deploy button. Each is deliberately
    // reachable from one place.
    // A first-run card that could tick any of them would undo that on day one.
    for (const id of ['rules', 'keyRevoke', 'access', 'cicdTrigger'] as ModuleId[]) {
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

// ---------------------------------------------------------------------------
// PERSONAS AND PREFERENCES
// ---------------------------------------------------------------------------
//
// The card gained a persona row and four groups of preferences. Both are presets
// over the answers this file already pins, and both have one way of going quietly
// wrong that the assertions above do not cover.

describe('personas', () => {
  it('reaches modules only through the questions', () => {
    // The protection that makes the rest of this cheap. A persona has no `modules`
    // array of its own, so it cannot name `rules`, `keyRevoke`, `access` or
    // `cicdTrigger` — not because a rule forbids it, but because there is no field
    // to write it in. If a `modules` key ever appears on Persona, every guarantee
    // in "what the card can switch on" above stops applying to personas.
    for (const p of PERSONAS) {
      expect(Object.keys(p), p.id).not.toContain('modules')
      for (const id of Object.keys(p.answers)) {
        expect(SETUP_QUESTIONS.map((q) => q.id), `${p.id} answers an unknown question`).toContain(id)
      }
    }
  })

  it('preselects no persona, so Enter without reading still writes to nothing', () => {
    // THE assertion, and the reason DEFAULT_PERSONA_ID is null. The DevOps preset
    // answers `operate` true, which turns on broadcast, patch and jobs. Had the
    // card opened with it chosen, a first launch answered with one keystroke would
    // have enabled all three.
    expect(DEFAULT_PERSONA_ID).toBeNull()
  })

  it('turns answers off as well as on, so switching persona is not cumulative', () => {
    // Picking infra after devops must give infra, not the union: the card shows
    // what each answer controls, and a preset that only added would leave somebody
    // who changed their mind with both.
    const infra = PERSONAS.find((p) => p.id === 'infra')!
    const answers = personaAnswers(infra)
    for (const q of SETUP_QUESTIONS) expect(Object.keys(answers), q.id).toContain(q.id)
    expect(answers.containers).toBe(false)
  })

  it('gives every persona a label and a readable line', () => {
    for (const p of PERSONAS) {
      expect(p.label.length, p.id).toBeGreaterThan(0)
      expect(p.detail.length, p.id).toBeGreaterThan(20)
    }
  })

  it('has unique ids', () => {
    expect(new Set(PERSONAS.map((p) => p.id)).size).toBe(PERSONAS.length)
  })

  it('sets no preference a job title does not imply', () => {
    // Deliberately timid, for the reason in the preferences header: a value written
    // by this card is frozen for that install forever, so a later release cannot
    // change the default for anyone who has onboarded. `fleetSampling` is the only
    // preference whose answer genuinely follows from the job.
    const allowed = new Set(['fleetSamplingEnabled'])
    for (const p of PERSONAS) {
      for (const k of Object.keys(p.prefs)) {
        expect(allowed.has(k), `${p.id} presets ${k}`).toBe(true)
      }
    }
  })
})

describe('the preference patch', () => {
  it('is empty when nothing was touched', () => {
    // The whole reason PrefAnswers holds undefined rather than values. AppSettings
    // is persisted wholesale and merged saved-over-default, so anything this writes
    // is frozen for that install and outranks every later default change. A card
    // that helpfully wrote all ten on every first run would freeze all ten, for
    // every user, and it would look like it worked.
    const patch = setupPatch({})
    expect(patch.settings).toEqual({})
    expect(patch.update).toEqual({})
    expect(patch.theme).toBeNull()
  })

  it('carries only the keys that were touched', () => {
    const patch = setupPatch({ compactDensity: true, updateChannel: 'beta' })
    expect(patch.settings).toEqual({ compactDensity: true })
    expect(patch.update).toEqual({ channel: 'beta' })
    expect(patch.theme).toBeNull()
  })

  it('routes each answer to the store that owns it', () => {
    // Three destinations, and they are genuinely three: theme is top-level store
    // state, the settings keys go through setSettings, and the update preferences
    // are owned by MAIN in its own file because the launch check runs before a
    // window exists. A patch that put them in one bag would be taken apart again.
    const patch = setupPatch({
      theme: 'light',
      fleetSamplingEnabled: true,
      resourceAlertThreshold: 90,
      updateAutoDownload: false
    })
    expect(patch.theme).toBe('light')
    expect(patch.settings).toEqual({ fleetSamplingEnabled: true, resourceAlertThreshold: 90 })
    expect(patch.update).toEqual({ autoDownload: false })
  })

  it('never puts an update preference into the settings blob', () => {
    // They would be silently dropped: AppSettings has no such keys, and main would
    // never hear about them. The failure is invisible -- the card appears to work
    // and the preference does nothing.
    const patch = setupPatch({
      updateChannel: 'beta',
      updateAutoCheck: false,
      updateCheckIntervalHours: 24,
      updateAutoDownload: false
    })
    expect(patch.settings).toEqual({})
    for (const k of Object.keys(patch.update)) {
      expect(k.startsWith('update'), k).toBe(false)
    }
  })
})

describe('the preference controls', () => {
  it('offers every control a value it can actually take', () => {
    for (const g of PREF_GROUPS) {
      for (const c of g.controls) {
        expect(c.options.length, c.key).toBeGreaterThan(1)
        const values = c.options.map((o) => o.value)
        // The fallback has to be one of the offered values, or the card opens
        // showing a state the user cannot choose and cannot get back to.
        expect(values, `${c.key} fallback is not offered`).toContain(c.fallback)
      }
    }
  })

  it('names a real PrefAnswers key exactly once across all groups', () => {
    const keys = PREF_GROUPS.flatMap((g) => g.controls.map((c) => c.key))
    expect(new Set(keys).size, 'a key is asked about twice').toBe(keys.length)
  })

  it('only gates a control on a key that is asked about', () => {
    const keys = new Set(PREF_GROUPS.flatMap((g) => g.controls.map((c) => c.key)))
    for (const g of PREF_GROUPS) {
      for (const c of g.controls) {
        if (!c.requires) continue
        expect(keys.has(c.requires.key), `${c.key} requires an unasked key`).toBe(true)
      }
    }
  })

  it('hides a dependent control when its parent is switched off', () => {
    const interval = PREF_GROUPS.find((g) => g.id === 'fleet')!.controls.find(
      (c) => c.key === 'fleetSamplingIntervalMs'
    )!
    expect(prefAvailable(interval, { fleetSamplingEnabled: false })).toBe(false)
    expect(prefAvailable(interval, { fleetSamplingEnabled: true })).toBe(true)
    // Untouched falls back to the parent's own default, which is off.
    expect(prefAvailable(interval, {})).toBe(false)
  })

  it('summarises a group from what is actually showing', () => {
    const look = PREF_GROUPS.find((g) => g.id === 'look')!
    expect(prefSummary(look, {})).toContain('Dark')
    expect(prefSummary(look, { theme: 'light' })).toContain('Light')
  })

  it('never summarises a group as a bare yes or no', () => {
    // A collapsed header has no labels in it, so an option that reads "Yes" there
    // is a word with no subject: "Stable only · Yes · Every 6 hours · Yes" says
    // nothing about what was agreed to. Every option either carries self-contained
    // wording or opts out of the summary.
    for (const g of PREF_GROUPS) {
      const text = prefSummary(g, {})
      for (const part of text.split(' · ')) {
        expect(['Yes', 'No'], `${g.id}: "${text}"`).not.toContain(part)
      }
    }
  })

  it('drops an option that opted out of the summary', () => {
    // `short: ''` means "leave me out", used where a neighbour already carries the
    // meaning -- "checked every 6 hours" makes "Yes" to auto-check redundant.
    const updates = PREF_GROUPS.find((g) => g.id === 'updates')!
    expect(prefSummary(updates, {})).toBe('Stable · checked every 6 hours · downloaded automatically')
    // Turning auto-check off removes the two dependent controls and says so.
    expect(prefSummary(updates, { updateAutoCheck: false })).toBe('Stable · manual checks only')
  })
})
