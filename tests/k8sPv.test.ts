import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import { heldCapacity, parsePvs, PV_COLS, pvVerdict, reclaimFate, type K8sPv } from '../src/shared/k8sPv'

// Item 39's PV half. The fixture is one k3s v1.31.5 cluster carrying three
// volumes at once: one dynamically provisioned and bound, one static volume
// left Released by deleting its claim, and one static volume never claimed.

const DIR = fileURLToPath(new URL('./fixtures/k8s/pv', import.meta.url))
const read = (n: string): string => readFileSync(join(DIR, n), 'utf8')
const pvs = (): K8sPv[] => parsePvs(read('pvs.txt'))
const by = (n: string): K8sPv => pvs().find((p) => p.name === n)!

describe('reading the listing', () => {
  it('was captured with the spec the parser is written against', () => {
    // Not decoration. The whitespace split below is only safe because every
    // absent value prints as `<none>`, which is a property of this spec.
    expect(read('command.txt')).toContain(PV_COLS)
  })

  it('reads all three volumes', () => {
    expect(pvs().map((p) => p.name).sort()).toEqual([
      'manual-delete',
      'manual-retain',
      'pvc-dd77949d-01cd-4fdb-8f47-4cddcb53c825'
    ])
  })

  it('keeps a row with no claim in its own columns', () => {
    // The Available volume has <none> in both claim columns. Were those blank,
    // its storage class would be read as its claim namespace.
    const av = by('manual-delete')
    expect(av.claim).toBe('')
    expect(av.storageClass).toBe('manual')
    expect(av.phase).toBe('Available')
  })

  it('still names the claim on a volume whose claim is gone', () => {
    expect(by('manual-retain')).toMatchObject({ phase: 'Released', claim: 'default/takes-manual' })
  })

  it('reports an unrecognised phase as unknown rather than guessing one', () => {
    const [p] = parsePvs('v 1Gi Retain Rebinding <none> <none> manual <none>')
    expect(p.phase).toBeNull()
    expect(pvVerdict(p).level).toBe('unknown')
  })
})

describe('the reclaim policy is what happens when the claim is deleted', () => {
  // Measured: a static hostPath PV with Delete, bound to a claim, VANISHED from
  // the API within seconds of that claim being deleted. No event, no Released
  // state to catch it in. That is the sentence a bound volume needs.
  it('says a Delete volume dies with its claim', () => {
    const fate = reclaimFate(by('pvc-dd77949d-01cd-4fdb-8f47-4cddcb53c825'))
    expect(fate).toContain('default/bound-claim')
    expect(fate).toContain('destroys')
  })

  it('says a Retain volume outlives its claim and needs a hand', () => {
    const bound: K8sPv = { ...by('manual-retain'), phase: 'Bound', claim: 'default/takes-manual' }
    const fate = reclaimFate(bound)
    expect(fate).toContain('Released')
    expect(fate).toContain('1Gi')
    expect(fate).not.toContain('destroys')
  })

  it('says nothing about a volume with no claim to delete', () => {
    expect(reclaimFate(by('manual-delete'))).toBe('')
    expect(reclaimFate(by('manual-retain'))).toBe('')
  })

  it('does not describe a policy it does not know', () => {
    const odd: K8sPv = { ...by('manual-retain'), phase: 'Bound', reclaim: 'Archive' }
    expect(reclaimFate(odd)).toContain('not determined')
  })
})

describe('what each phase means to whoever is on call', () => {
  // Bound + Delete is the default on k3s, EKS and GKE. Grading it as a problem
  // would fire on every volume of every such cluster, so the warning lives in
  // the fate line and the verdict stays ok.
  it('does not grade the ordinary bound volume as a problem', () => {
    expect(pvVerdict(by('pvc-dd77949d-01cd-4fdb-8f47-4cddcb53c825')).level).toBe('ok')
  })

  it('flags a Released Retain volume as capacity nobody can reach', () => {
    const v = pvVerdict(by('manual-retain'))
    expect(v.level).toBe('watch')
    expect(v.because).toContain('1Gi')
    expect(v.because).toContain('will not rebind on its own')
  })

  it('alarms on a failed reclaim and does not claim the data survived', () => {
    const f: K8sPv = { ...by('manual-retain'), phase: 'Failed', reason: 'no deleter' }
    const v = pvVerdict(f)
    expect(v.level).toBe('alarm')
    expect(v.because).toContain('no deleter')
    expect(v.because).toContain('not determined')
  })

  it('leaves an unclaimed volume alone', () => {
    expect(pvVerdict(by('manual-delete')).level).toBe('ok')
  })

  it('counts held capacity separately, because no claim reports it', () => {
    expect(heldCapacity(pvs()).map((p) => p.name)).toEqual(['manual-retain'])
  })
})
