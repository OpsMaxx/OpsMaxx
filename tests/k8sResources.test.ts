import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import {
  cpuToMillis,
  memToBytes,
  parsePvcs,
  parseStorageClasses,
  parseWorkloadResources,
  pvcVerdict,
  readCommitment
} from '../src/shared/k8sResources'

// Item 39's requests/limits and storage rows. Fixtures from a real k3s
// v1.31.5 with two deployments added — one with requests and limits, one with
// neither — and a PersistentVolumeClaim left unmounted.

const DIR = fileURLToPath(new URL('./fixtures/k8s/resources', import.meta.url))
const fixture = (n: string): string => readFileSync(join(DIR, n), 'utf8')

describe('reading a Kubernetes quantity', () => {
  // A bare number is CORES; `m` is millicores. Getting that backwards
  // understates a node by a factor of a thousand and reports every cluster as
  // wildly overcommitted.
  it('knows a bare CPU number is cores and 100m is not', () => {
    expect(cpuToMillis('12')).toBe(12000)
    expect(cpuToMillis('100m')).toBe(100)
    expect(cpuToMillis('0.5')).toBe(500)
  })

  it('knows Ki is 1024 and K is 1000, because both appear', () => {
    // A node reports 24571576Ki; a manifest may say 64Mi or 64M.
    expect(memToBytes('24571576Ki')).toBe(24571576 * 1024)
    expect(memToBytes('64Mi')).toBe(64 * 1024 * 1024)
    expect(memToBytes('64M')).toBe(64_000_000)
  })

  it('returns null for what it cannot read, and for kubectl’s empty column', () => {
    for (const q of ['<none>', '', 'lots', '12Q']) {
      expect(cpuToMillis(q), q).toBeNull()
      expect(memToBytes(q), q).toBeNull()
    }
  })
})

describe('what the cluster has asked for', () => {
  const workloads = parseWorkloadResources(fixture('deploy-requests.txt'))

  it('reads the real deployments, requests, limits and all', () => {
    const web = workloads.find((w) => w.name === 'web')!
    expect(web.replicas).toBe(2)
    expect(web.cpuRequestMillis).toBe(100)
    expect(web.memRequestBytes).toBe(64 * 1024 * 1024)
    expect(web.cpuLimitMillis).toBe(200)
  })

  it('reads a mixed workload without inventing the missing half', () => {
    // coredns sets a memory limit and no CPU limit. Real, and from the stock
    // k3s install.
    const dns = workloads.find((w) => w.name === 'coredns')!
    expect(dns.memLimitBytes).toBe(170 * 1024 * 1024)
    expect(dns.cpuLimitMillis).toBeNull()
  })

  // THE finding. Two of five stock deployments set no requests at all, and a
  // container with no request is not a container that needs nothing — it is
  // one the scheduler places blind and the kubelet evicts first.
  it('counts the workloads that ask for nothing rather than adding zero', () => {
    const r = readCommitment(workloads, [{ allocatableCpu: '12', allocatableMemory: '24571576Ki' }])
    expect(r.unbounded.map((u) => u.name).sort()).toEqual(['local-path-provisioner', 'nolimits'])
    expect(r.because).toContain('set no request at all')
    expect(r.because).toContain('evicts them first')
  })

  it('multiplies a request by its replicas, because two pods ask twice', () => {
    const r = readCommitment(
      [
        {
          namespace: 'd', name: 'web', replicas: 3,
          cpuRequestMillis: 100, memRequestBytes: 1024, cpuLimitMillis: null, memLimitBytes: null
        }
      ],
      [{ allocatableCpu: '12', allocatableMemory: '24571576Ki' }]
    )
    expect(r.cpuRequestedMillis).toBe(300)
  })

  it('says nothing rather than a percentage when no node reported its capacity', () => {
    // A percentage against zero capacity is not a number anybody should see.
    const r = readCommitment(workloads, [{ allocatableCpu: '<none>', allocatableMemory: '<none>' }])
    expect(r.cpuAllocatableMillis).toBeNull()
    expect(r.because).toContain('cannot be compared to capacity')
  })
})

describe('a Pending claim is usually not a fault', () => {
  const pvcs = parsePvcs(fixture('pvcs.txt'))
  const classes = parseStorageClasses(fixture('storageclasses.txt'))

  it('reads the real claim and the real class', () => {
    expect(pvcs[0]).toMatchObject({ name: 'data', phase: 'Pending', storageClass: 'local-path' })
    expect(classes[0]).toMatchObject({
      name: 'local-path',
      bindingMode: 'WaitForFirstConsumer',
      isDefault: true
    })
  })

  // k3s's default, and EKS's, and GKE's. Every claim sits Pending until a pod
  // that mounts it is scheduled, so reporting Pending as a fault would fire on
  // every such cluster for every claim.
  it('calls Pending on a WaitForFirstConsumer class normal, and says why', () => {
    const v = pvcVerdict(pvcs[0], classes)
    expect(v.level).toBe('ok')
    expect(v.because).toContain('binds when a pod that mounts it is scheduled')
  })

  it('calls Pending on an Immediate class what it is', () => {
    const immediate = [{ ...classes[0], bindingMode: 'Immediate' }]
    const v = pvcVerdict(pvcs[0], immediate)
    expect(v.level).toBe('alarm')
    expect(v.because).toContain('should have given it a volume')
  })

  it('does not guess when the claim’s class was not among those read', () => {
    const v = pvcVerdict({ ...pvcs[0], storageClass: 'gone' }, classes)
    expect(v.level).toBe('unknown')
    expect(v.because).toContain('cannot be said')
  })

  it('calls a Lost volume what it is', () => {
    const v = pvcVerdict({ ...pvcs[0], phase: 'Lost' }, classes)
    expect(v.level).toBe('alarm')
    expect(v.because).toContain('data with it')
  })
})
