import { describe, it, expect } from 'vitest'

import {
  assessNodeSkew,
  parseK8sVersion,
  pdbHeadroom,
  summariseUpgradeReadiness,
  KUBELET_SKEW_MINORS
} from '../src/shared/k8sSkew'

// Item 41's recommended alternative. The item's own closing paragraph argues
// against building the upgrade -- "leave the upgrade to the distribution's
// tooling" -- and asks for the read that says whether one is safe to start.

const nodes = (...v: (string | null)[]): { name: string; kubeletVersion: string | null }[] =>
  v.map((kubeletVersion, i) => ({ name: `node-${i}`, kubeletVersion }))

const verdicts = (server: string | null, ...v: (string | null)[]): string[] =>
  assessNodeSkew(server, nodes(...v)).map((s) => s.verdict)

describe('reading a Kubernetes version', () => {
  it('reads the shapes distributions actually ship', () => {
    expect(parseK8sVersion('v1.29.4')).toMatchObject({ major: 1, minor: 29, patch: 4 })
    expect(parseK8sVersion('v1.29.4+k3s1')).toMatchObject({ major: 1, minor: 29, suffix: '+k3s1' })
    expect(parseK8sVersion('v1.28.9-eks-a1b2c3')).toMatchObject({ minor: 28, suffix: '-eks-a1b2c3' })
    expect(parseK8sVersion('1.30')).toMatchObject({ major: 1, minor: 30, patch: null })
  })

  it('returns null rather than guessing at something it cannot read', () => {
    // A version this cannot read is a version whose skew cannot be judged.
    for (const bad of [null, undefined, '', 'unknown', 'v', 'latest']) {
      expect(parseK8sVersion(bad), String(bad)).toBeNull()
    }
  })
})

describe('how far a kubelet may lag', () => {
  it('is fine at the same version and one behind', () => {
    expect(verdicts('v1.30.0', 'v1.30.2', 'v1.29.8')).toEqual(['ok', 'ok'])
  })

  it('is behind but supported inside the window', () => {
    expect(verdicts('v1.30.0', 'v1.28.0', 'v1.27.0')).toEqual(['behind', 'behind'])
  })

  it('is unsupported past it, at the exact boundary', () => {
    expect(verdicts('v1.30.0', `v1.${30 - KUBELET_SKEW_MINORS}.0`)).toEqual(['behind'])
    expect(verdicts('v1.30.0', `v1.${30 - KUBELET_SKEW_MINORS - 1}.0`)).toEqual(['unsupported'])
  })

  // Never supported in any version of the policy, and the usual cause is a
  // control-plane upgrade that stopped halfway -- which is worth saying rather
  // than reporting as merely out of range.
  it('calls a node NEWER than the API server its own thing', () => {
    const s = assessNodeSkew('v1.29.0', nodes('v1.30.0'))[0]
    expect(s.verdict).toBe('ahead')
    expect(s.because).toContain('stopped halfway')
  })

  it('does not call an unreadable version fine, on either side', () => {
    expect(verdicts('v1.30.0', 'wat')).toEqual(['unknown'])
    expect(verdicts(null, 'v1.30.0')).toEqual(['unknown'])
    expect(verdicts(null, 'v1.30.0')[0]).not.toBe('ok')
  })

  it('compares the major version rather than assuming it is 1', () => {
    expect(verdicts('v2.0.0', 'v1.30.0')).toEqual(['unsupported'])
  })
})

describe('the budgets that would stop a drain', () => {
  it('flags the ones allowing nothing', () => {
    // The number that turns a routine drain into a command that hangs to its
    // timeout, and it is invisible until somebody tries.
    const h = pdbHeadroom([
      { namespace: 'prod', name: 'web', disruptionsAllowed: 0 },
      { namespace: 'prod', name: 'api', disruptionsAllowed: 2 }
    ])
    expect(h.map((x) => x.blocksDrain)).toEqual([true, false])
    expect(h[0].because).toContain('will wait rather than proceed')
  })

  it('does not claim an unreadable budget would block, and does not call it fine either', () => {
    // Null is not zero and is not headroom.
    const h = pdbHeadroom([{ namespace: 'prod', name: 'web', disruptionsAllowed: null }])
    expect(h[0].blocksDrain).toBe(false)
    expect(h[0].because).toContain('unknown')
  })
})

describe('the line somebody reads before starting an upgrade', () => {
  it('says ready only when nothing is wrong and nothing is unreadable', () => {
    const s = summariseUpgradeReadiness(
      assessNodeSkew('v1.30.0', nodes('v1.30.0', 'v1.29.0')),
      pdbHeadroom([{ namespace: 'p', name: 'a', disruptionsAllowed: 1 }])
    )
    expect(s.ready).toBe(true)
  })

  // A readiness number that improves as the cluster gets harder to read is
  // pointing the wrong way.
  // Each on its own, because a case with both would pass while either half was
  // dropped -- which is exactly what happened the first time this was written.
  it('counts a node whose version could not be read as a reason not to start', () => {
    const s = summariseUpgradeReadiness(
      assessNodeSkew('v1.30.0', nodes('v1.30.0', 'wat')),
      pdbHeadroom([{ namespace: 'p', name: 'a', disruptionsAllowed: 1 }])
    )
    expect(s.ready).toBe(false)
    expect(s.headline).toContain('version could not be read')
  })

  it('counts a budget that could not be read the same way', () => {
    const s = summariseUpgradeReadiness(
      assessNodeSkew('v1.30.0', nodes('v1.30.0')),
      pdbHeadroom([{ namespace: 'p', name: 'a', disruptionsAllowed: null }])
    )
    expect(s.ready).toBe(false)
    expect(s.headline).toContain('budget(s) that could not be read')
  })

  it('names every reason, not just the first', () => {
    const s = summariseUpgradeReadiness(
      assessNodeSkew('v1.30.0', nodes('v1.31.0', 'v1.20.0')),
      pdbHeadroom([{ namespace: 'p', name: 'a', disruptionsAllowed: 0 }])
    )
    expect(s.headline).toContain('newer than the API server')
    expect(s.headline).toContain('outside the skew window')
    expect(s.headline).toContain('no disruptions')
  })
})

describe('a budget read that failed is not a cluster with no budgets', () => {
  // `[]` would say the cluster has nothing that could block a drain. That is a
  // measurement nobody took, and it is the difference between "ready" and "we
  // could not tell".
  it('refuses to call the cluster ready when the budgets could not be read', () => {
    const skews = assessNodeSkew('v1.30.0', nodes('v1.30.0'))
    expect(summariseUpgradeReadiness(skews, []).ready).toBe(true)
    const s = summariseUpgradeReadiness(skews, null)
    expect(s.ready).toBe(false)
    expect(s.headline).toContain('could not be read at all')
  })
})

describe('the panel passes the distinction on rather than flattening it', () => {
  // Read off the source, the same way moduleBoundaries reads its tab guards:
  // mounting KubernetesPanel pulls in the whole app store, and the bug this
  // guards against is one character wide -- `[]` where `null` belongs, which
  // turns "we could not read the budgets" into "there are none".
  it('hands summariseUpgradeReadiness null when the budget read failed', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const src = readFileSync(
      resolve(__dirname, '..', 'src/renderer/src/components/kubernetes/KubernetesPanel.tsx'),
      'utf8'
    )
    expect(src).toContain('summariseUpgradeReadiness(')
    expect(src).toMatch(/overview\.pdbs\.ok \? pdbHeadroom\(overview\.pdbs\.items\) : null/)
  })
})
