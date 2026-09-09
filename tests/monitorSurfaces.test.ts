import { describe, expect, it } from 'vitest'
import {
  MODULES,
  OPERATE_MODULE_IDS,
  READ_SURFACE_WRITE_EXCEPTIONS,
  isOperateModule,
  modulesOnSurface,
  type ModuleId
} from '../src/shared/modules'

// The line between "reads the estate" and "changes the estate".
//
// Monitoring used to hold every module, and put a teal primary button in the
// same top-right slot on all of them. Thirteen of those buttons re-read
// something. Two of them installed packages and rebooted hosts, or ran an
// arbitrary shell command across the fleet. `ModuleSurface` is what stops those
// two sharing a slot with the thirteen, and this file is what stops the field
// rotting into a decoration nobody sets.
//
// Two properties, and the second is the one that earns the file:
//
//  1. TOTAL. Every module has a surface. A module without one has no
//     destination at all, which at runtime means a tab that exists in the
//     registry and nowhere on screen.
//  2. EXACT. The operate set is pinned to a literal list rather than counted.
//     A test that only asserted "at least one operate module" would pass while
//     somebody quietly added a third — and the whole value of the split is that
//     the dangerous side is small enough to hold in your head. Adding a module
//     here should be a decision somebody made, recorded in a diff, not a
//     default they inherited by forgetting the field.

describe('the read/operate split', () => {
  it('gives every module a surface, so none can arrive without a destination', () => {
    const missing = MODULES.filter((m) => m.surface !== 'read' && m.surface !== 'operate')
    expect(missing.map((m) => m.id)).toEqual([])
  })

  it('puts exactly broadcast, patch, jobs and keyRevoke on the operate surface', () => {
    // If this fails because you added a module, that is the test doing its job.
    // Decide which side of the line it is on, put it there, and update this
    // list — do not widen the assertion.
    //
    // `keyRevoke` is the fourth, and it arrived by SPLITTING rather than by
    // being invented: revoking a key was already happening, on the read surface,
    // inside the Access panel. Moving it here did not add a way to change a
    // server; it stopped one being reachable from a destination that promises
    // it cannot.
    expect(modulesOnSurface('operate').map((m) => m.id).sort()).toEqual([
      'broadcast',
      'jobs',
      'keyRevoke',
      'patch'
    ])
  })

  it('keeps the OperateModuleId union in step with the surface field', () => {
    // The union in modules.ts is written by hand because a nav tab type cannot
    // be derived from a runtime filter without an `as` cast. This is what
    // notices when the two drift.
    const fromSurface = modulesOnSurface('operate')
      .map((m) => m.id)
      .sort()
    expect(fromSurface).toEqual([...OPERATE_MODULE_IDS].sort())
  })

  it('leaves every remaining module on the read surface', () => {
    expect(modulesOnSurface('read').map((m) => m.id).sort()).toEqual(
      [
        'fleetSearch',
        'inventory',
        'access',
        'capacity',
        'changeLog',
        'rules',
        'drift',
        'posture',
        'logTail',
        'httpChecks',
        'netTools',
        'cron',
        'services',
        'processes',
        'docker',
        'kubernetes'
      ].sort()
    )
  })

  it('accounts for every module exactly once across the two surfaces', () => {
    const both = [...modulesOnSurface('read'), ...modulesOnSurface('operate')].map((m) => m.id)
    expect(both.slice().sort()).toEqual(
      MODULES.map((m) => m.id)
        .slice()
        .sort()
    )
    expect(new Set(both).size).toBe(MODULES.length)
  })
})

describe('isOperateModule', () => {
  it('is true for the two modules that change servers', () => {
    expect(isOperateModule('patch')).toBe(true)
    expect(isOperateModule('broadcast')).toBe(true)
  })

  it('is false for read modules, including the ones that look active', () => {
    // Rules ACTS on hosts — it runs a job when an alert fires — and still reads
    // as `read` here, which is not a contradiction: the rule's panel configures
    // and the runner executes elsewhere under its own approval record. Docker's
    // container shell is the sharper case and is called out in the report; if
    // this line ever has to change, the panel is what should change instead.
    expect(isOperateModule('rules')).toBe(false)
    expect(isOperateModule('docker')).toBe(false)
    expect(isOperateModule('inventory')).toBe(false)
  })

  it('narrows the type, so a nav pointer cannot name a tab its rail lacks', () => {
    const id: ModuleId = 'patch'
    if (isOperateModule(id)) {
      // Compiles only because the guard narrowed `id` to OperateModuleId.
      const narrowed: 'broadcast' | 'patch' | 'jobs' | 'keyRevoke' = id
      expect(narrowed).toBe('patch')
    }
  })
})

// ---------------------------------------------------------------------------
// The contract has no exceptions left, and this is what keeps it that way
// ---------------------------------------------------------------------------
//
// `surface: 'read'` asserts that nothing on that surface writes to a server.
// Three modules used to break it: `access` could revoke an SSH key across the
// estate, `cron` could write a crontab, `services` could install a `systemd
// --user` unit. Each was a large read-only view with one mutating control
// bolted on, so none of them was reclassified — reclassifying would have exiled
// the authorized_keys inventory, the crontab listing and the unit listing into a
// destination built for change. They were SPLIT: the read stayed, the write
// moved to Operations (`keyRevoke` as a module, the other two as sub-tabs of
// `jobs`), and each read panel keeps a pointer at where its write went.
//
// The list is empty and the assertions stay, which is the point. A contract
// whose exception list is checked is one where the fourth exception has to be
// written down by somebody who can be asked why.
describe('the read surface no longer writes anywhere', () => {
  it('has an empty exception list, and fails loudly if one comes back', () => {
    // If this fails, read what was added and why. The answer is almost never
    // "add it to the list" — it is to split the panel, which has now been done
    // three times and is a day's work, not a redesign.
    expect(READ_SURFACE_WRITE_EXCEPTIONS).toEqual([])
  })

  it('still only tolerates an exception for a module that is actually on the read surface', () => {
    // Vacuous today, deliberately kept: it is the assertion that stops a future
    // exception being parked on the list for a module that has since moved,
    // where it would look handled and enforce nothing.
    for (const id of READ_SURFACE_WRITE_EXCEPTIONS) {
      const m = MODULES.find((x) => x.id === id)
      expect(m, `${id} is exempted but is not a module`).toBeDefined()
      expect(m!.surface, `${id} is exempted from a rule that does not apply to it`).toBe('read')
    }
  })

  it('lets no module claim to be read-only while it is on this list', () => {
    // The copy was the worse half of the original defect: all three modules told
    // the user "Read-only." in the sentence that decides whether they enable it.
    // A false safety claim is worse than the write it was covering for.
    for (const id of READ_SURFACE_WRITE_EXCEPTIONS) {
      const m = MODULES.find((x) => x.id === id)!
      expect(m.detail.toLowerCase(), `${id} still claims to be read-only`).not.toContain('read-only')
    }
  })

  // The claim is fine, and true, on a module that does not write — which, now,
  // is every module on this surface.
  it('leaves the honest read-only claims alone', () => {
    const clean = MODULES.filter(
      (m) => m.surface === 'read' && !READ_SURFACE_WRITE_EXCEPTIONS.includes(m.id)
    )
    expect(clean.length).toBe(modulesOnSurface('read').length)
  })

  it('keeps the three split modules on the read surface, where their reading belongs', () => {
    // The other half of the fix, and the half a careless follow-up would undo:
    // "make it operate" would have been one line and would have moved a large
    // read into a destination whose banner says everything in it changes
    // servers. If this ever fails, the question to ask is whether the READ moved
    // — not whether the list should grow.
    for (const id of ['access', 'cron', 'services'] as const) {
      expect(MODULES.find((m) => m.id === id)!.surface, id).toBe('read')
    }
  })
})
