import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import {
  CLUSTER_OWNED_CONFIGMAPS,
  parseNamedObjects,
  parsePodReferences,
  proposable,
  UNUSED_REFS_JSONPATH,
  unusedCandidates,
  unusedCaveat,
  type PodReferences,
  type UnusedCandidate
} from '../src/shared/k8sUnused'

// Item 39's stale objects, ConfigMap and PVC half. The fixture is one k3s
// v1.31.5 cluster carrying a ConfigMap referenced each of the four ways, one
// referenced by nothing, one referenced only by a Deployment scaled to zero, a
// mounted PVC and an unmounted one.

const DIR = fileURLToPath(new URL('./fixtures/k8s/unused', import.meta.url))
const read = (n: string): string => readFileSync(join(DIR, n), 'utf8')
const refs = (): PodReferences[] => parsePodReferences(read('references.txt'))
const cms = (): UnusedCandidate[] =>
  unusedCandidates(parseNamedObjects(read('configmaps.txt')), refs(), 'configmap')
const pvcs = (): UnusedCandidate[] =>
  unusedCandidates(parseNamedObjects(read('pvcs.txt')), refs(), 'pvc')
const cm = (n: string): UnusedCandidate => cms().find((c) => c.name === n && c.namespace === 'default')!

describe('finding the references', () => {
  it('was captured with the jsonpath the parser is written against', () => {
    expect(read('command.txt')).toContain(UNUSED_REFS_JSONPATH)
  })

  it('reads all four reference sites off one pod', () => {
    const c = refs().find((r) => r.pod === 'consumer')!
    // Volume, envFrom and configMapKeyRef, plus the injected one below.
    expect(c.configMaps).toContain('used-as-volume')
    expect(c.configMaps).toContain('used-as-envfrom')
    expect(c.configMaps).toContain('used-as-keyref')
    expect(c.pvcs).toEqual(['mounted-claim'])
  })

  // The finding. `kube-root-ca.crt` is referenced ONLY from inside a projected
  // volume's sources[], in a volume the API server injects and that appears in
  // nobody's manifest. The obvious scan path misses it, in every namespace, on
  // every cluster.
  it('sees the configmap that is only referenced through a projected volume', () => {
    for (const r of refs()) expect(r.configMaps).toContain('kube-root-ca.crt')
    expect(cm('kube-root-ca.crt').referenced).toBe(true)
  })

  it('drops the empty terms every volume without a configMap emits', () => {
    const c = refs().find((r) => r.pod === 'consumer')!
    expect(c.configMaps.every((n) => n !== '')).toBe(true)
    expect(c.pvcs).toHaveLength(1)
  })
})

describe('what nothing references', () => {
  it('finds the configmap nobody names', () => {
    expect(cm('nobody-uses-me').referenced).toBe(false)
  })

  // The other half of the finding, and the reason the list is candidates and
  // not a recommendation: this ConfigMap is mounted by a Deployment with zero
  // replicas, so no pod names it and scaling that Deployment up needs it.
  it('cannot tell a dead configmap from one a scaled-down workload needs', () => {
    expect(cm('only-a-scaled-down-deploy').referenced).toBe(false)
    expect(cm('nobody-uses-me').referenced).toBe(false)
    // Nothing in the reading distinguishes them, which is why the caveat is
    // not optional.
    expect(unusedCaveat('configmap', 2)).toContain('scaled to zero has no pods')
    expect(unusedCaveat('configmap', 2)).toContain('Check each one before acting on it.')
  })

  it('does not caveat a list with nothing in it', () => {
    expect(unusedCaveat('pvc', 0)).toContain('named by a running pod')
  })

  it('finds the claim no pod mounts and leaves the mounted one alone', () => {
    expect(pvcs().find((p) => p.name === 'orphan-claim')!.referenced).toBe(false)
    expect(pvcs().find((p) => p.name === 'mounted-claim')!.referenced).toBe(true)
  })
})

describe('what must never be proposed', () => {
  // In the fixture kube-root-ca.crt also sits in kube-public and
  // kube-node-lease, which contain NO PODS AT ALL -- so there it is
  // unreferenced by construction and forever.
  it('keeps the cluster-owned configmap out of the proposals in every namespace', () => {
    const rootCas = cms().filter((c) => c.name === 'kube-root-ca.crt')
    expect(rootCas.length).toBeGreaterThan(1)
    expect(rootCas.every((c) => c.keptBecause !== null)).toBe(true)
    expect(proposable(cms()).some((c) => c.name === 'kube-root-ca.crt')).toBe(false)
    expect(CLUSTER_OWNED_CONFIGMAPS.has('kube-root-ca.crt')).toBe(true)
  })

  it('proposes nothing out of a namespace whose contents are not ours', () => {
    expect(proposable(cms()).some((c) => c.namespace === 'kube-system')).toBe(false)
    // `cluster-dns` and `local-path-config` are unreferenced in the fixture --
    // kept for the namespace, not because anything names them.
    const clusterDns = cms().find((c) => c.name === 'cluster-dns')!
    expect(clusterDns.referenced).toBe(false)
    expect(clusterDns.keptBecause).toContain('installed the cluster')
  })

  it('still lists the kept ones rather than hiding them', () => {
    expect(cms().some((c) => c.name === 'cluster-dns')).toBe(true)
    expect(cms().some((c) => c.name === 'kube-root-ca.crt')).toBe(true)
  })

  it('leaves exactly the two workspace configmaps as candidates', () => {
    expect(proposable(cms()).map((c) => c.name).sort()).toEqual([
      'nobody-uses-me',
      'only-a-scaled-down-deploy'
    ])
  })
})
