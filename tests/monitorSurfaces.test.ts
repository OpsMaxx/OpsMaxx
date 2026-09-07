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

  it('puts exactly broadcast and patch on the operate surface', () => {
    // If this fails because you added a module, that is the test doing its job.
    // Decide which side of the line it is on, put it there, and update this
    // list — do not widen the assertion.
    expect(modulesOnSurface('operate').map((m) => m.id)).toEqual(['patch', 'broadcast'])
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
    expect(modulesOnSurface('read').map((m) => m.id)).toEqual([
      'fleetSearch',
      'inventory',
      'access',
      'capacity',
      'changeLog',
      'rules',
      'drift',
      'posture',
      'logTail',
      'cron',
      'processes',
      'docker',
      'kubernetes'
    ])
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
      const narrowed: 'broadcast' | 'patch' = id
      expect(narrowed).toBe('patch')
    }
  })
})

// ---------------------------------------------------------------------------
// The contract's known exceptions, counted rather than waved away
// ---------------------------------------------------------------------------
//
// `surface: 'read'` asserts that nothing on that surface writes to a server.
// Two modules break it today — `access` can revoke an SSH key across hosts, and
// `cron` can write a crontab. They are named in READ_SURFACE_WRITE_EXCEPTIONS
// instead of being reclassified, because both are large read-only views with
// one mutating action attached, and moving the whole module would exile the
// inventory into a destination built for change.
//
// This block exists so the exception list cannot grow quietly. A contract with
// a silent exception is not a contract.
describe('the read surface writes in exactly two known places', () => {
  it('names them, so a third cannot be added without a deliberate edit', () => {
    expect([...READ_SURFACE_WRITE_EXCEPTIONS].sort()).toEqual(['access', 'cron'])
  })

  it('only exempts modules that are actually on the read surface', () => {
    for (const id of READ_SURFACE_WRITE_EXCEPTIONS) {
      const m = MODULES.find((x) => x.id === id)
      expect(m, `${id} is exempted but is not a module`).toBeDefined()
      expect(m!.surface, `${id} is exempted from a rule that does not apply to it`).toBe('read')
    }
  })

  // The copy was the worse half of the defect: both modules told the user
  // "Read-only." in the sentence that decides whether they enable it. A false
  // safety claim is worse than the write it was covering for, and the same
  // mistake is visible elsewhere in the product ("Read-only — nothing is
  // started, stopped or written here" sitting above four New service buttons).
  it('lets no module claim to be read-only while it is on this list', () => {
    for (const id of READ_SURFACE_WRITE_EXCEPTIONS) {
      const m = MODULES.find((x) => x.id === id)!
      expect(m.detail.toLowerCase(), `${id} still claims to be read-only`).not.toContain('read-only')
    }
  })

  // The claim is fine, and true, on a module that does not write.
  it('leaves the honest read-only claims alone', () => {
    const clean = MODULES.filter(
      (m) => m.surface === 'read' && !READ_SURFACE_WRITE_EXCEPTIONS.includes(m.id)
    )
    expect(clean.length).toBeGreaterThan(0)
  })
})
