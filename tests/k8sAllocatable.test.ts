import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  ALLOC_NODE_COLS,
  ALLOC_POD_COLS,
  allocationHeadline,
  allocationReport,
  parseCpuMilli,
  parseMemBytes,
  parseNodeAllocatable,
  parsePodRequests,
  podEffective,
  type PodRequestRow
} from '../src/shared/k8sAllocatable'
import { buildK8sAllocatableCommand, parseK8sAllocatable } from '../src/shared/kubernetes'

// Item 47's last capacity row, measured on a three-node kind cluster (v1.33)
// and CHECKED AGAINST THE SCHEDULER'S OWN ARITHMETIC.
//
// `kubectl describe node` prints an "Allocated resources" block: the numbers
// the scheduler actually booked. `describe-allocated.txt` is that block for all
// three nodes, and the first test below computes the same figures from the pod
// list and compares them. That is the whole reason this row could be built
// honestly -- there is a ground truth to be wrong against.

const fx = (n: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/k8s/alloc/${n}`, import.meta.url)), 'utf8')

const pods = (): PodRequestRow[] => parsePodRequests(fx('pod-requests.txt'))
const nodes = (): ReturnType<typeof parseNodeAllocatable> =>
  parseNodeAllocatable(fx('node-allocatable.txt'))

/** The scheduler's own figures, out of the describe block. */
function booked(node: string): { cpuMilli: number; memBytes: number } {
  const text = fx('describe-allocated.txt')
  const start = text.indexOf(`### ${node}`)
  const next = text.indexOf('### ', start + 4)
  const block = text.slice(start, next === -1 ? undefined : next)
  const cpu = block.match(/^\s*cpu\s+(\S+)\s/m)![1]
  const mem = block.match(/^\s*memory\s+(\S+)\s/m)![1]
  return { cpuMilli: parseCpuMilli(cpu)!, memBytes: parseMemBytes(mem)! }
}

describe('against what the scheduler actually booked', () => {
  // THE test. If this passes, the formula is the scheduler's formula.
  it('computes each node’s requests to the number the node reports', () => {
    const r = allocationReport(nodes(), pods())
    for (const n of r.nodes) {
      const truth = booked(n.node)
      expect(n.cpuRequestedMilli, `${n.node} cpu`).toBe(truth.cpuMilli)
      expect(n.memRequestedBytes, `${n.node} memory`).toBe(truth.memBytes)
    }
  })

  // Finding 3, and the one that would have gone unnoticed: `withinit` requests
  // 10m in its container and 500m in its init, and the node books 500m.
  it('takes an initContainer’s request when it exceeds the containers’ sum', () => {
    const p = pods().find((x) => x.name.startsWith('withinit'))!
    expect(podEffective(p).cpuMilli).toBe(500)
    expect(podEffective(p).memBytes).toBe(256 * 1024 * 1024)
  })

  it('sums the containers of one pod rather than counting them separately', () => {
    const p = pods().find((x) => x.name.startsWith('twocontainer'))!
    expect(podEffective(p).cpuMilli).toBe(100)
    expect(podEffective(p).memBytes).toBe(96 * 1024 * 1024)
  })
})

describe('what `<none>` means', () => {
  // Finding 1. An unsized pod is not a pod requesting nothing; it is the pod an
  // operator is looking for.
  it('reads no request as unset rather than as zero', () => {
    const p = pods().find((x) => x.name.startsWith('unbounded'))!
    const e = podEffective(p)
    expect(e.cpuUnset).toBe(true)
    expect(e.memUnset).toBe(true)
    expect(e.cpuMilli).toBe(0)
  })

  // Three on this node, and the third is the finding: the two `unbounded`
  // replicas plus KUBE-PROXY, which Kubernetes ships with no CPU request of its
  // own. So the unsized count is never zero on a real cluster, and a panel
  // presenting it as an anomaly would flag every cluster that exists. It is a
  // number to read beside the percentage, not an alert.
  it('counts unsized pods per node, beside the sum they contribute nothing to', () => {
    const r = allocationReport(nodes(), pods())
    const w1 = r.nodes.find((n) => n.node === 'sp-alloc-worker')!
    expect(w1.cpuUnsetPods).toBe(3)
    expect(
      pods().filter((p) => p.node === 'sp-alloc-worker' && p.cpu.length === 0).map((p) => p.name)
    ).toEqual(expect.arrayContaining([expect.stringContaining('kube-proxy')]))
    expect(w1.cpuRequestedMilli).toBeGreaterThan(0)
  })

  // Finding 2. `mixed` has two containers, one sized and one not, and the
  // column prints ONE value with no placeholder — so only the name count
  // reveals it.
  it('sees a pod that sizes only some of its containers', () => {
    const p = pods().find((x) => x.name.startsWith('mixed'))!
    expect(p.containers).toBe(2)
    expect(p.cpu).toEqual(['40m'])
    const e = podEffective(p)
    expect(e.cpuPartial).toBe(true)
    // Not "unset": something IS declared, which is a different fact.
    expect(e.cpuUnset).toBe(false)
  })

  it('does not call a fully sized pod partial', () => {
    const p = pods().find((x) => x.name.startsWith('twocontainer'))!
    expect(podEffective(p).cpuPartial).toBe(false)
  })
})

describe('pods the scheduler has not placed', () => {
  // Finding 4: `toobig` asks for 64 cores and sits Pending with no nodeName.
  it('names them rather than dropping them, and adds them to no node', () => {
    const r = allocationReport(nodes(), pods())
    expect(r.unplaced.map((u) => u.name.split('-')[0])).toContain('toobig')
    expect(r.unplaced.find((u) => u.name.startsWith('toobig'))!.cpuMilli).toBe(64_000)
    // And the sum of every node is still the scheduler's, i.e. it is not in it.
    for (const n of r.nodes) expect(n.cpuRequestedMilli).toBe(booked(n.node).cpuMilli)
  })

  // A finished pod keeps its nodeName long after its resources are back.
  it('does not book a Succeeded or Failed pod against its old node', () => {
    const base = pods()
    const ghost: PodRequestRow = {
      namespace: 'alloc',
      name: 'ghost',
      node: 'sp-alloc-worker',
      phase: 'Succeeded',
      containers: 1,
      cpu: ['8'],
      mem: ['8Gi'],
      initContainers: 0,
      initCpu: [],
      initMem: []
    }
    const r = allocationReport(nodes(), [...base, ghost])
    expect(r.nodes.find((n) => n.node === 'sp-alloc-worker')!.cpuRequestedMilli).toBe(
      booked('sp-alloc-worker').cpuMilli
    )
  })
})

describe('quantities', () => {
  // A bare number is CORES. Reading `12` as 12 millicores reports a full node
  // as empty, which is a factor of a thousand in the worst direction.
  it('reads a bare cpu value as cores', () => {
    expect(parseCpuMilli('12')).toBe(12_000)
    expect(parseCpuMilli('150m')).toBe(150)
    expect(parseCpuMilli('0.5')).toBe(500)
  })

  it('reads binary memory suffixes before decimal ones', () => {
    expect(parseMemBytes('24571576Ki')).toBe(24_571_576 * 1024)
    expect(parseMemBytes('96Mi')).toBe(96 * 1024 * 1024)
    // `M` is a thousand thousand; `Mi` is 1024². Matching `M` first would make
    // these equal.
    expect(parseMemBytes('1M')).toBe(1_000_000)
    expect(parseMemBytes('1Mi')).toBe(1_048_576)
  })

  // The suffix is matched WHOLE. Under a `startsWith`/`endsWith` match -- the
  // obvious implementation -- `Mi` would match the decimal `M`.
  it('does not let a binary suffix match its decimal prefix', () => {
    expect(parseMemBytes('96Mi')).not.toBe(96 * 1000 * 1000)
    expect(parseMemBytes('1Gi')).toBe(1024 ** 3)
    expect(parseMemBytes('1G')).toBe(1000 ** 3)
    // And an unknown suffix is null rather than silently the bare number.
    expect(parseMemBytes('5Xi')).toBeNull()
  })

  it('returns null for absent and for anything it cannot read', () => {
    for (const v of ['<none>', '', 'lots', '12x']) {
      expect(parseCpuMilli(v)).toBeNull()
      expect(parseMemBytes(v)).toBeNull()
    }
  })
})

describe('the nodes', () => {
  it('reads allocatable off the real node list', () => {
    const n = nodes()
    expect(n).toHaveLength(3)
    expect(n.every((x) => !x.unschedulable)).toBe(true)
    const r = allocationReport(n, pods())
    expect(r.nodes[0].cpuAllocatableMilli).toBe(12_000)
  })

  // `.spec.unschedulable` is a boolean. An unexpected word there is not
  // evidence the node is closed, and treating it as closed would drop a working
  // node's capacity out of the cluster total.
  it('reads only `true` as cordoned, never an unexpected word', () => {
    const n = parseNodeAllocatable(
      ['NAME CPU MEM PODS SCHED', 'a 12 8Gi 110 true', 'b 12 8Gi 110 <none>', 'c 12 8Gi 110 maybe'].join('\n')
    )
    expect(n.map((x) => x.unschedulable)).toEqual([true, false, false])
  })

  it('sees a cordoned node in the read that recorded one', () => {
    const n = parseNodeAllocatable(fx('node-allocatable-cordoned.txt'))
    expect(n.find((x) => x.name === 'sp-alloc-worker2')!.unschedulable).toBe(true)
    expect(n.filter((x) => x.unschedulable)).toHaveLength(1)
  })

  // Null, never zero: a node whose capacity could not be read has unknown
  // headroom, and zero renders it as full.
  it('leaves an unreadable allocatable null and names the node', () => {
    const r = allocationReport(
      [{ name: 'odd', cpu: '?', mem: '?', pods: '110', unschedulable: false }],
      []
    )
    expect(r.nodes[0].cpuAllocatableMilli).toBeNull()
    expect(r.nodes[0].cpuPct).toBeNull()
    expect(r.unreadableNodes).toEqual(['odd'])
  })
})

describe('the headline', () => {
  // A cluster at 8% whose pods are unsized is not a cluster with headroom.
  it('carries the unsized count beside the percentage', () => {
    const h = allocationHeadline(allocationReport(nodes(), pods()))
    expect(h).toMatch(/% of CPU is requested/)
    expect(h).toContain('request no CPU at all')
    expect(h).toContain('not in that number')
  })

  it('says how many pods are sized only in part', () => {
    expect(allocationHeadline(allocationReport(nodes(), pods()))).toContain(
      'size only some of their containers'
    )
  })

  it('names an unscheduled pod rather than leaving it out silently', () => {
    expect(allocationHeadline(allocationReport(nodes(), pods()))).toContain('not scheduled anywhere')
  })

  // A cordoned node's free space is not headroom: it accepts nothing new.
  it('excludes a cordoned node and says so', () => {
    const n = parseNodeAllocatable(fx('node-allocatable-cordoned.txt'))
    const h = allocationHeadline(allocationReport(n, pods()))
    expect(h).toContain('2 schedulable node(s)')
    expect(h).toContain('1 cordoned node(s) are excluded')
  })

  it('refuses to report a cluster whose nodes are all closed', () => {
    const n = parseNodeAllocatable(fx('node-allocatable-cordoned.txt')).map((x) => ({
      ...x,
      unschedulable: true
    }))
    expect(allocationHeadline(allocationReport(n, pods()))).toContain('no schedulable capacity')
  })

  it('says nothing rather than 0% when no node was read', () => {
    expect(allocationHeadline(allocationReport([], []))).toContain('No nodes were read')
  })
})

describe('the read itself', () => {
  it('asks for the container names, which is the only way to see finding 2', () => {
    expect(ALLOC_POD_COLS).toContain('NAMES:.spec.containers[*].name')
    expect(ALLOC_POD_COLS).toContain('.spec.initContainers[*].resources.requests.cpu')
  })

  it('asks the node for allocatable rather than capacity', () => {
    // `.status.capacity` is what the machine has; `.status.allocatable` is what
    // is left after the kubelet's reservations, and only the second is what a
    // pod can be scheduled into.
    expect(ALLOC_NODE_COLS).toContain('.status.allocatable.cpu')
    expect(ALLOC_NODE_COLS).not.toContain('.status.capacity')
  })

  // A line with the wrong column count is a message. Read as a row it would
  // invent a pod, which is the defect the PDB read had.
  it('ignores a line that is not a row', () => {
    expect(parsePodRequests('No resources found in alloc namespace.')).toEqual([])
    expect(parseNodeAllocatable('error: the server doesn’t have a resource type "nodes"')).toEqual([])
  })
})

// A SECOND, INDEPENDENT CLUSTER. Everything above is `kind`; this is a live
// single-node k3s on a different distribution, with different node naming and a
// different set of system pods. A parser tuned to one implementation passes its
// own fixtures and fails here, which is the only thing that check can catch.
//
// PROVENANCE: verbatim except the node name, which was replaced with
// `k3s-node-1` because it identifies a real host and this repository is public.
// Nothing else in either file was altered, and the describe block is the same
// ground truth the kind tests use.
describe('a different cluster, to catch a parser tuned to one', () => {
  const k3s = (): ReturnType<typeof parseK8sAllocatable> =>
    parseK8sAllocatable(fx('k3s-single-node.txt'), 0)

  function k3sBooked(): { cpuMilli: number; memBytes: number } {
    const block = fx('k3s-describe-allocated.txt')
    return {
      cpuMilli: parseCpuMilli(block.match(/^\s*cpu\s+(\S+)\s/m)![1])!,
      memBytes: parseMemBytes(block.match(/^\s*memory\s+(\S+)\s/m)![1])!
    }
  }

  it('computes k3s’s own numbers to the byte', () => {
    const p = k3s()
    expect(p.ok).toBe(true)
    const n = p.report!.nodes[0]
    const truth = k3sBooked()
    expect(n.cpuRequestedMilli).toBe(truth.cpuMilli)
    expect(n.memRequestedBytes).toBe(truth.memBytes)
  })

  // k3s ships `local-path-provisioner` with no requests at all -- a different
  // unsized system pod from kind's `kube-proxy`, and the same lesson: the
  // unsized count is never zero on a real cluster.
  it('finds an unsized system pod here too, a different one', () => {
    const n = k3s().report!.nodes[0]
    expect(n.cpuUnsetPods).toBe(1)
    expect(fx('k3s-single-node.txt')).toContain('local-path-provisioner')
  })

  // `describe node` prints the node's OWN percentage beside each figure --
  // `cpu 200m (3%)`. That is the scheduler dividing by its own allocatable, so
  // it validates the allocatable read and the arithmetic together, and it
  // catches a units mistake that the request totals alone cannot: k3s reports
  // `6` cores and `12247552Ki`, neither of which the kind fixture exercises.
  it('matches the percentage the node itself printed', () => {
    const block = fx('k3s-describe-allocated.txt')
    const cpuPct = Number(block.match(/^\s*cpu\s+\S+\s+\((\d+)%\)/m)![1])
    const memPct = Number(block.match(/^\s*memory\s+\S+\s+\((\d+)%\)/m)![1])
    const n = k3s().report!.nodes[0]
    expect(n.cpuAllocatableMilli).toBe(6000)
    expect(n.memAllocatableBytes).toBe(12247552 * 1024)
    expect(Math.round(n.cpuPct!)).toBe(cpuPct)
    expect(Math.round(n.memPct!)).toBe(memPct)
  })

  it('reads a single-node cluster without treating it as a failure', () => {
    const p = k3s()
    expect(p.report!.nodes).toHaveLength(1)
    expect(p.report!.unplaced).toEqual([])
    expect(p.headline).toContain('1 schedulable node(s)')
  })
})

describe('the round trip', () => {
  // A read that produced no rows is a BLIND SPOT, not an empty cluster. This is
  // the rule the PDB read had to learn: text kubectl wrote that yields no
  // objects means the read did not work, and reporting it as "nothing is
  // scheduled" turns a failure into an all-clear.
  it('reads an empty node list as a failure, never as an empty cluster', () => {
    const out = '===OPSMAXX-ALLOCNODES===\nerror: You must be logged in to the server\n===OPSMAXX-ALLOCPODS===\n'
    const p = parseK8sAllocatable(out, 1)
    expect(p.ok).toBe(false)
    expect(p.detail).toContain('logged in')
    expect(p.report).toBeUndefined()
  })

  it('says so even when kubectl exited zero with nothing', () => {
    const p = parseK8sAllocatable('===OPSMAXX-ALLOCNODES===\n===OPSMAXX-ALLOCPODS===\n', 0)
    expect(p.ok).toBe(false)
    expect(p.detail).toContain('empty')
  })

  it('parses the recorded output of both sections', () => {
    const out = [
      '===OPSMAXX-ALLOCNODES===',
      fx('node-allocatable.txt'),
      '===OPSMAXX-ALLOCPODS===',
      fx('pod-requests.txt')
    ].join('\n')
    const p = parseK8sAllocatable(out, 0)
    expect(p.ok).toBe(true)
    expect(p.report!.nodes).toHaveLength(3)
    for (const n of p.report!.nodes) expect(n.cpuRequestedMilli).toBe(booked(n.node).cpuMilli)
    expect(p.headline).toMatch(/% of CPU is requested/)
  })

  // A namespace-scoped read would report a node as empty because the pods
  // filling it live in kube-system.
  it('asks for every namespace, whatever namespace is selected', () => {
    const cmd = buildK8sAllocatableCommand('kind-sp-alloc')
    expect(cmd).toContain('--all-namespaces')
    expect(cmd).not.toContain('--namespace=')
    expect(cmd).toContain('--context=kind-sp-alloc')
  })

  it('refuses a context that is not a context rather than interpolating it', () => {
    expect(buildK8sAllocatableCommand('a; rm -rf /')).not.toContain('rm -rf')
  })
})
