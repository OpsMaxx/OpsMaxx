import { describe, it, expect } from 'vitest'
import { alertFloor, ruleWarnings } from '../src/renderer/src/lib/ruleReach'
import { DISK_DANGER } from '../src/shared/hostHealth'

// The rule a tester wrote, and why nothing happened:
//
//   When Disk raised, on one server, at or above 20 → post to the webhook
//
// His disk sat around 60%. The number is a FILTER on an alert the engine has
// already raised, and the disk alert is fixed at DISK_DANGER and raises
// strictly above it — so at 60% there is no alert for the filter to admit, and
// the rule reads "has not acted yet" forever. The engine is right; the form
// never said what it would do with the number.

const base = {
  kind: 'disk' as const,
  minValue: '',
  event: 'raised' as const,
  action: 'job' as const,
  resourceThreshold: 80,
  webhookEnabled: true
}

describe('alertFloor', () => {
  it('reports disk as fixed and strict at the shared constant', () => {
    // Read from shared/hostHealth rather than restated: this sentence and the
    // bar every other screen colours must not be able to drift apart.
    expect(alertFloor('disk', 80)).toEqual({
      value: DISK_DANGER,
      strict: true,
      fixed: true,
      unit: '%'
    })
  })

  it('follows the configured threshold for CPU, which is movable and not strict', () => {
    expect(alertFloor('cpu', 55)).toEqual({ value: 55, strict: false, fixed: false, unit: '%' })
  })

  it('reports load per core, not as a percentage', () => {
    expect(alertFloor('load', 80)).toMatchObject({ value: 2, unit: ' per core' })
  })

  it('has no floor for kinds that carry no reading', () => {
    // A failed unit is an event, not a measurement. A minValue there is
    // meaningless rather than merely unreachable, so there is nothing to warn.
    expect(alertFloor('job-failed', 80)).toBeNull()
    expect(alertFloor('host-unreachable', 80)).toBeNull()
  })
})

describe('ruleWarnings — the reported rule', () => {
  it('warns that a disk filter of 20 cannot bring the rule forward', () => {
    const w = ruleWarnings({ ...base, minValue: '20' })
    expect(w).toHaveLength(1)
    expect(w[0].field).toBe('minValue')
    expect(w[0].text).toContain('85%')
    expect(w[0].text).toContain('will not act until then')
  })

  it('names the fixed threshold rather than telling the reader to change it', () => {
    // Disk is deliberately not configurable, so advice to go and change it
    // would send someone looking for a setting that does not exist.
    expect(ruleWarnings({ ...base, minValue: '20' })[0].text).toContain('fixed')
    expect(ruleWarnings({ ...base, minValue: '20' })[0].text).not.toContain('Settings')
  })

  it('points CPU at the setting, because that one can be moved', () => {
    const w = ruleWarnings({ ...base, kind: 'cpu', minValue: '20' })
    expect(w[0].text).toContain('80%')
    expect(w[0].text).toContain('Settings')
  })
})

describe('ruleWarnings — the boundary', () => {
  it('warns at exactly the disk floor, because disk raises strictly above it', () => {
    expect(ruleWarnings({ ...base, minValue: '85' })).toHaveLength(1)
  })

  it('is silent just above the disk floor', () => {
    expect(ruleWarnings({ ...base, minValue: '85.1' })).toEqual([])
  })

  it('is silent at exactly the CPU floor, because that alert raises at it', () => {
    // The whole reason `strict` is carried rather than assumed.
    expect(ruleWarnings({ ...base, kind: 'cpu', minValue: '80' })).toEqual([])
  })

  it('warns just below the CPU floor', () => {
    expect(ruleWarnings({ ...base, kind: 'cpu', minValue: '79.9' })).toHaveLength(1)
  })

  it('uses this host’s override rather than the global', () => {
    // The panel resolves the override before calling, so a rule scoped to a
    // host held to 50 must not be told about the workspace's 80.
    expect(ruleWarnings({ ...base, kind: 'cpu', minValue: '60', resourceThreshold: 50 })).toEqual([])
  })
})

describe('ruleWarnings — when it must stay quiet', () => {
  it('says nothing for a blank box, which means any reading', () => {
    expect(ruleWarnings({ ...base, minValue: '' })).toEqual([])
    expect(ruleWarnings({ ...base, minValue: '   ' })).toEqual([])
  })

  it('says nothing for a filter above the floor, which is what the filter is for', () => {
    // "Webhook me only when disk passes 95, not at the usual 85" is the
    // intended use, and warning about it would train people to ignore the note.
    expect(ruleWarnings({ ...base, minValue: '95' })).toEqual([])
  })

  it('says nothing for an unparseable number', () => {
    expect(ruleWarnings({ ...base, minValue: 'abc' })).toEqual([])
  })

  it('says nothing on resolved, where the reading travels the other way', () => {
    // A disk alert clears at 85 or below, so a filter of 20 is reachable on
    // resolve and the raise-side warning would be false there.
    expect(ruleWarnings({ ...base, minValue: '20', event: 'resolved' })).toEqual([])
  })

  it('says nothing for a kind with no numeric reading', () => {
    expect(ruleWarnings({ ...base, kind: 'job-failed', minValue: '20' })).toEqual([])
  })
})

describe('ruleWarnings — delivery', () => {
  it('warns when the action posts to a webhook that is switched off', () => {
    const w = ruleWarnings({ ...base, action: 'notify', webhookEnabled: false })
    expect(w).toHaveLength(1)
    expect(w[0].field).toBe('action')
    expect(w[0].text).toContain('send nothing')
  })

  it('does not warn about the webhook when the rule runs a job instead', () => {
    expect(ruleWarnings({ ...base, action: 'job', webhookEnabled: false })).toEqual([])
  })

  it('reports both problems at once rather than the first', () => {
    // Showing one would send someone away to fix half of it and come back to
    // a rule that still does nothing.
    const w = ruleWarnings({ ...base, minValue: '20', action: 'notify', webhookEnabled: false })
    expect(w.map((x) => x.field)).toEqual(['minValue', 'action'])
  })
})
