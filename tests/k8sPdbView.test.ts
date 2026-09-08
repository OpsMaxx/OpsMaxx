import { describe, it, expect } from 'vitest'

import { orphanedPdbs, pdbCoverage, type WorkloadRef } from '../src/shared/k8sPdbView'
import type { K8sPdb } from '../src/shared/kubernetes'

// Item 39's "PDBs as a view". The numbers below are what a real k3s v1.31.5
// reported for three budgets over one three-replica deployment: one selecting
// it by matchLabels, one by matchExpressions, and one selecting a label
// nothing carries.

const pdb = (over: Partial<K8sPdb>): K8sPdb =>
  ({
    namespace: 'default',
    name: 'p',
    disruptionsAllowed: 1,
    currentHealthy: 3,
    desiredHealthy: 2,
    expectedPods: 3,
    matchLabels: { app: 'web' },
    hasMatchExpressions: false,
    ...over
  }) as K8sPdb

const web: WorkloadRef = {
  namespace: 'default',
  name: 'web',
  labels: { app: 'web', tier: 'front' },
  replicas: 3
}

describe('a budget that guards nothing looks exactly like one at its limit', () => {
  // MEASURED. On the fixture cluster, `orphan-pdb` (selector `app: gone`,
  // which nothing carries) and `web-pdb` (protecting three real replicas at
  // its limit) BOTH report disruptionsAllowed 0. From that field alone they
  // are indistinguishable, and the operator is told a drain will wait on a
  // budget guarding nothing.
  const orphan = pdb({ name: 'orphan-pdb', matchLabels: { app: 'gone' }, disruptionsAllowed: 0, currentHealthy: 0, desiredHealthy: 1, expectedPods: 0 })
  const atLimit = pdb({ name: 'web-pdb', disruptionsAllowed: 0, currentHealthy: 2, desiredHealthy: 2, expectedPods: 3 })

  it('cannot be told apart by disruptionsAllowed', () => {
    expect(orphan.disruptionsAllowed).toBe(atLimit.disruptionsAllowed)
  })

  // `expectedPods` is the count the CONTROLLER arrived at, so it is right for
  // matchExpressions too -- which recomputing from matchLabels would not be.
  it('is told apart by expectedPods, which the controller computed', () => {
    expect(orphanedPdbs([orphan, atLimit]).map((p) => p.name)).toEqual(['orphan-pdb'])
  })
})

describe('whether a workload is protected', () => {
  it('reports the budget that selects it and how much room it has', () => {
    const c = pdbCoverage([web], [pdb({ name: 'web-pdb', disruptionsAllowed: 1 })])[0]
    expect(c.verdict).toBe('protected')
    expect(c.covering).toEqual(['web-pdb'])
    expect(c.allowed).toBe(1)
  })

  it('says a drain will WAIT when the budget currently allows none', () => {
    const c = pdbCoverage([web], [pdb({ name: 'web-pdb', disruptionsAllowed: 0 })])[0]
    expect(c.verdict).toBe('blocking')
    expect(c.because).toContain('will wait rather than proceed')
  })

  it('says an uncovered workload loses every replica on the node at once', () => {
    const c = pdbCoverage([web], [pdb({ matchLabels: { app: 'other' } })])[0]
    expect(c.verdict).toBe('uncovered')
    expect(c.because).toContain('every one of its 3 replica(s)')
  })

  it('takes the SMALLEST allowance when two budgets cover one workload', () => {
    // Both apply, so the tighter one is what a drain actually meets.
    const c = pdbCoverage([web], [pdb({ name: 'a', disruptionsAllowed: 3 }), pdb({ name: 'b', disruptionsAllowed: 1 })])[0]
    expect(c.allowed).toBe(1)
  })

  it('matches a budget whose selector is a subset of the pod’s labels', () => {
    // The pod carries app AND tier; the budget names only app.
    expect(pdbCoverage([web], [pdb({ matchLabels: { app: 'web' } })])[0].verdict).toBe('protected')
  })

  it('does not match a budget naming a label the pod does not carry', () => {
    expect(pdbCoverage([web], [pdb({ matchLabels: { app: 'web', zone: 'a' } })])[0].verdict).toBe(
      'uncovered'
    )
  })

  it('does not reach across namespaces', () => {
    expect(pdbCoverage([web], [pdb({ namespace: 'other' })])[0].verdict).toBe('uncovered')
  })
})

describe('a selector this cannot evaluate is not a selector that misses', () => {
  // The drain preflight already refuses to guess at matchExpressions, in these
  // words: "an unknown budget is not a permission". A view that silently
  // ignored one would report a workload as unprotected when it may be the best
  // protected thing on the cluster -- and somebody would add a second budget.
  it('says unknown rather than uncovered', () => {
    const c = pdbCoverage([web], [pdb({ name: 'expr-pdb', hasMatchExpressions: true, matchLabels: {} })])[0]
    expect(c.verdict).toBe('cannot-evaluate')
    expect(c.because).toContain('unknown, not no')
  })

  it('does not cloud a workload in another namespace', () => {
    const c = pdbCoverage([web], [pdb({ namespace: 'other', hasMatchExpressions: true })])[0]
    expect(c.verdict).toBe('uncovered')
  })

  it('prefers a definite answer when one budget matches and another cannot be read', () => {
    const c = pdbCoverage(
      [web],
      [pdb({ name: 'web-pdb', disruptionsAllowed: 1 }), pdb({ name: 'expr-pdb', hasMatchExpressions: true })]
    )[0]
    expect(c.verdict).toBe('protected')
  })
})
