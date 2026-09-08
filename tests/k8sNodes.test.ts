import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import {
  judgeNodes,
  parseNodeHealth,
  summariseNodes,
  type K8sNodeHealth
} from '../src/shared/k8sNodes'

// Item 39's node conditions, taints and allocatable. Both fixtures are the
// same real k3s v1.31.5 node, before and after `kubectl cordon`.

const DIR = fileURLToPath(new URL('./fixtures/k8s/nodes', import.meta.url))
const fixture = (n: string): K8sNodeHealth[] =>
  parseNodeHealth(readFileSync(join(DIR, n), 'utf8'))

describe('what a healthy node actually reports', () => {
  const n = fixture('healthy.txt')[0]

  // The thing that would be got wrong by reasoning rather than looking:
  // `False` is GOOD for the three pressures and BAD for Ready. Reading them
  // as one boolean inverts three of the four.
  it('reports the pressures False and Ready True', () => {
    expect(n.memoryPressure).toBe('False')
    expect(n.diskPressure).toBe('False')
    expect(n.pidPressure).toBe('False')
    expect(n.ready).toBe('True')
    expect(judgeNodes([n])).toEqual([])
  })

  it('keeps the allocatable quantities as Kubernetes wrote them', () => {
    // `24571576Ki` is not a number and converting it here would put a unit
    // decision in a parser. The caller that compares can convert.
    expect(n.allocatableCpu).toBe('12')
    expect(n.allocatableMemory).toBe('24571576Ki')
    expect(n.allocatablePods).toBe('110')
  })

  it('reads kubectl’s empty list as no taints, not as a taint called none', () => {
    expect(n.taints).toEqual([])
  })
})

describe('a cordoned node is not a broken one', () => {
  const n = fixture('cordoned.txt')[0]

  it('sees the taint the API server adds', () => {
    expect(n.taints).toEqual(['node.kubernetes.io/unschedulable'])
    // Still Ready, still no pressure. Only its schedulability changed.
    expect(n.ready).toBe('True')
  })

  it('says it is deliberate rather than calling it unhealthy', () => {
    // Otherwise somebody investigates their own change.
    const f = judgeNodes([n])
    expect(f[0].verdict).toBe('unschedulable')
    expect(f[0].because).toContain('not broken')
    expect(summariseNodes([n], f).ready).toBe(true)
  })
})

describe('the value a boolean cannot hold', () => {
  const node = (over: Partial<K8sNodeHealth> = {}): K8sNodeHealth => ({
    ...fixture('healthy.txt')[0],
    ...over
  })

  // PARSED from the text, not constructed as an object. The cases below build
  // K8sNodeHealth directly, which bypasses the parser entirely -- collapsing
  // `Unknown` into `False` inside it passed every one of them, and that
  // collapse is the exact mistake this file is written against.
  //
  // The line is hand-built rather than captured: producing a real `Unknown`
  // needs a kubelet to stop reporting while its API server keeps answering,
  // which one container cannot do. `Unknown` is the third value of a
  // Kubernetes node condition and the control plane writes it on kubelet
  // timeout.
  it('parses Unknown as Unknown, and does not fold it into False', () => {
    const parsed = parseNodeHealth('n1 Unknown False False Unknown 12 16Gi 110 <none>')[0]
    expect(parsed.ready).toBe('Unknown')
    expect(parsed.memoryPressure).toBe('Unknown')
    expect(parsed.ready).not.toBe('False')
  })

  it('parses anything it does not recognise as Unknown rather than as healthy', () => {
    // A column that arrived empty or garbled is not a node reporting False.
    const parsed = parseNodeHealth('n1 - - - - 12 16Gi 110 <none>')[0]
    expect(parsed.ready).toBe('Unknown')
  })

  // `Unknown` is what the control plane writes when the kubelet has STOPPED
  // REPORTING. A node whose kubelet is dead reports Ready: Unknown, not False.
  it('separates a node nobody can hear from, from a node reporting NotReady', () => {
    expect(judgeNodes([node({ ready: 'Unknown' })])[0].verdict).toBe('unreported')
    expect(judgeNodes([node({ ready: 'False' })])[0].verdict).toBe('not-ready')
  })

  it('says the other conditions on an unreporting node are stale', () => {
    // They are the last values it sent, and may describe a machine that has
    // since run out of memory.
    const f = judgeNodes([node({ ready: 'Unknown', memoryPressure: 'False' })])
    expect(f[0].because).toContain('last ones it sent')
  })

  it('does not read an unknown pressure as an absent one', () => {
    const f = judgeNodes([node({ memoryPressure: 'Unknown' })])
    expect(f[0].verdict).toBe('pressure')
    expect(f[0].because).toContain('unknown')
  })

  it('names every pressure, not just the first', () => {
    const f = judgeNodes([node({ memoryPressure: 'True', diskPressure: 'True' })])
    expect(f[0].because).toContain('memory')
    expect(f[0].because).toContain('disk')
  })
})

describe('the headline', () => {
  it('is not ready when a node is silent, however healthy the rest look', () => {
    const nodes = [fixture('healthy.txt')[0], { ...fixture('healthy.txt')[0], name: 'b', ready: 'Unknown' as const }]
    const s = summariseNodes(nodes, judgeNodes(nodes))
    expect(s.ready).toBe(false)
    expect(s.headline).toContain('not reporting')
  })

  it('does not call an empty list a cluster with no problems', () => {
    // No node answered is not a cluster with no nodes.
    const s = summariseNodes([], [])
    expect(s.ready).toBe(false)
    expect(s.headline).toContain('not a cluster with no nodes')
  })
})
