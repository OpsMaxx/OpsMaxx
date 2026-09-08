import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { parseNodeHealth } from '../src/shared/k8sNodes'
import {
  GATE_NODE_MARKERS,
  NODE_BLOCKING_VERDICTS,
  buildGateNodeCommand,
  type GateNode,
  gateNodesFromWave,
  matchNodes,
  parseGateNodeRead,
  summariseNodeGate
} from '../src/shared/nodeGate'
import { evaluateGate, type GateHost } from '../src/shared/patch'

// The wave gate, taught that a host might be a Kubernetes node.
//
// THE BUG. The gate read systemd and nothing else, and systemd and Kubernetes
// disagree exactly when it matters: a node that reboots into a broken kubelet
// answers SSH, runs no failed units, and is NotReady. The gate passed it,
// started the next wave, and took a cluster out one wave at a time using the
// mechanism whose entire purpose was to stop that.

const fx = (n: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/k8s/nodes/${n}.txt`, import.meta.url)), 'utf8')

// Recorded from a real k3s v1.31.5 node, before and after `kubectl cordon`.
const HEALTHY = parseNodeHealth(fx('healthy'))
const CORDONED = parseNodeHealth(fx('cordoned'))
const NODE = HEALTHY[0].name

/** The same real node, reporting the two states a kubelet failure produces. */
const notReady = HEALTHY.map((n) => ({ ...n, ready: 'False' as const }))
const unreported = HEALTHY.map((n) => ({ ...n, ready: 'Unknown' as const }))

const host = (over: Partial<GateHost> = {}): GateHost => ({
  serverId: 's1',
  serverName: 'web-1',
  sampledAt: 100,
  unreachable: false,
  unreachableError: null,
  failedUnits: [],
  ...over
})

const at = (node: GateNode): GateHost => host({ node })
const nodeOf = (list: typeof HEALTHY): GateNode => {
  const m = matchNodes([{ serverId: 's1', hostname: NODE }], list)
  return m.get('s1')!
}

describe('the reboot that used to pass', () => {
  // The whole point. Nothing wrong with the machine; everything wrong with the
  // node. Both of these passed the gate before this existed.
  it('halts on a node that came back NotReady with a perfectly healthy machine', () => {
    const v = evaluateGate([at(nodeOf(notReady))], { since: 0 })
    expect(v.ok).toBe(false)
    if (v.ok) throw new Error('unreachable')
    expect(v.kind).toBe('unhealthy')
    expect(v.reason).toContain('NotReady')
    expect(v.reason).toContain('The remaining waves were not started')
  })

  it('halts on a node whose kubelet has stopped reporting', () => {
    const v = evaluateGate([at(nodeOf(unreported))], { since: 0 })
    expect(v).toMatchObject({ ok: false, kind: 'unhealthy' })
    if (v.ok) throw new Error('unreachable')
    expect(v.reason).toContain('stopped reporting')
  })

  // A cordoned node is NOT broken — judgeNodes is explicit that calling it
  // unhealthy sends somebody to investigate their own change. But one still
  // cordoned AFTER its wave is a machine this run took out of service and did
  // not put back, and rolling on to cordon the next one is how an operator ends
  // up with a cluster of empty nodes and a gate that said yes every time.
  it('halts on a node this run left cordoned', () => {
    const v = evaluateGate([at(nodeOf(CORDONED))], { since: 0 })
    expect(v).toMatchObject({ ok: false, kind: 'unhealthy' })
    if (v.ok) throw new Error('unreachable')
    expect(v.reason).toContain('still cordoned')
    expect(v.reason).toContain('not put it back')
  })

  it('passes the same real node when it is Ready and uncordoned', () => {
    const v = evaluateGate([at(nodeOf(HEALTHY))], { since: 0 })
    expect(v.ok).toBe(true)
  })
})

describe('a node nobody could read is not a Ready node', () => {
  // The same rule a stale sample gets, and for the same reason: "we still
  // cannot tell" is not permission to continue. STALE, so the runner polls and
  // halts at the timeout rather than deciding on nothing.
  it('waits rather than passing or failing', () => {
    const v = evaluateGate(
      [at({ role: 'node-unread', nodeName: NODE, why: 'the API server did not answer' })],
      { since: 0 }
    )
    expect(v).toMatchObject({ ok: false, kind: 'stale' })
    if (v.ok) throw new Error('unreachable')
    expect(v.reason).toContain('did not answer')
    expect(v.reason).toContain('not assumed Ready')
  })

  // An unread node must not be reported as a broken one either — a halt that
  // says "NotReady" about a node nobody asked is a fabricated finding.
  it('does not call it unhealthy', () => {
    const v = evaluateGate([at({ role: 'node-unread', nodeName: NODE, why: 'timeout' })], {
      since: 0
    })
    if (v.ok) throw new Error('unreachable')
    expect(v.reason).not.toMatch(/NotReady|failed unit/)
  })
})

describe('nothing changes for an estate with no Kubernetes in it', () => {
  // Every caller written before this existed supplies no reading at all, and
  // that must keep meaning "the systemd rules alone" rather than quietly
  // becoming a node check that always passes.
  it('passes a host with no node reading, exactly as before', () => {
    expect(evaluateGate([host()], { since: 0 }).ok).toBe(true)
    expect(evaluateGate([at({ role: 'unknown' })], { since: 0 }).ok).toBe(true)
    expect(evaluateGate([at({ role: 'not-a-node' })], { since: 0 }).ok).toBe(true)
  })

  // The systemd checks still come first and still decide. A node is a server
  // too, and a machine with failed units is a problem whatever the control
  // plane thinks of it.
  it('still fails a Ready node whose machine has failed units', () => {
    const v = evaluateGate([host({ node: nodeOf(HEALTHY), failedUnits: ['nginx.service'] })], {
      since: 0
    })
    expect(v).toMatchObject({ ok: false, kind: 'unhealthy' })
    if (v.ok) throw new Error('unreachable')
    expect(v.reason).toContain('nginx.service')
  })

  // ORDER MATTERS, and not because the outcome differs — both halt. It is the
  // SENTENCE. A machine that is switched off is NotReady precisely because it
  // is off, so leading with "NotReady" sends somebody to the control plane to
  // diagnose a host that is not answering SSH. The machine's own state is the
  // actionable truth and is reported first.
  it('reports an unreachable node as not answering, not as NotReady', () => {
    const v = evaluateGate(
      [host({ node: nodeOf(notReady), unreachable: true, unreachableError: 'connect ETIMEDOUT' })],
      { since: 0 }
    )
    expect(v).toMatchObject({ ok: false, kind: 'unhealthy' })
    if (v.ok) throw new Error('unreachable')
    expect(v.reason).toContain('not answering')
    expect(v.reason).toContain('connect ETIMEDOUT')
    expect(v.reason).not.toContain('NotReady')
  })

  it('still waits on a stale sample before looking at the node at all', () => {
    const v = evaluateGate([host({ sampledAt: 1, node: nodeOf(notReady) })], { since: 50 })
    expect(v).toMatchObject({ ok: false, kind: 'stale' })
    if (v.ok) throw new Error('unreachable')
    expect(v.reason).toContain('No health check newer than this wave')
  })
})

describe('pressure is said, not enforced', () => {
  // Memory or disk pressure is usually a property the node already had, so
  // halting a whole estate's patch run on it would stop legitimate work on a
  // condition this run did not cause. It is reported by name every time.
  it('passes a node under pressure and names it in the note', () => {
    const pressured = HEALTHY.map((n) => ({ ...n, memoryPressure: 'True' as const }))
    const v = evaluateGate([at(nodeOf(pressured))], { since: 0 })
    expect(v.ok).toBe(true)
    if (!v.ok) throw new Error('unreachable')
    expect(v.note).toContain('web-1')
    expect(v.note).toContain('reported rather than blocked')
  })

  it('keeps pressure out of the list that stops a run', () => {
    expect([...NODE_BLOCKING_VERDICTS]).toEqual(['not-ready', 'unreported', 'unschedulable'])
    expect([...NODE_BLOCKING_VERDICTS]).not.toContain('pressure')
  })
})

describe('matching a server to a node is exact, because the failure is the wrong machine', () => {
  const m = (hostname: string | null): GateNode =>
    matchNodes([{ serverId: 's1', hostname }], HEALTHY).get('s1')!

  it('matches the hostname the host reported about itself', () => {
    expect(m(NODE).role).toBe('node')
    expect(m(NODE.toUpperCase()).role).toBe('node')
    // DNS and Kubernetes both treat the trailing dot and the domain as noise.
    expect(m(`${NODE}.internal`).role).toBe('node')
  })

  // THE failure mode is not "no match" — it is gating the WRONG machine, and
  // passing a wave because some other node is Ready is a false all-clear this
  // app produced itself. A prefix match would say these are the same host.
  it('does not match a name that merely starts the same', () => {
    expect(m(`${NODE}9`).role).toBe('not-a-node')
    expect(m(NODE.slice(0, -1)).role).toBe('not-a-node')
  })

  it('does not guess from a host that cannot say what it is called', () => {
    expect(m(null).role).toBe('not-a-node')
    expect(m('   ').role).toBe('not-a-node')
  })

  // "We asked and you are not one" and "nobody asked" are different facts, and
  // only the first is a statement about this host.
  it('says nobody asked when the cluster was never read', () => {
    const none = matchNodes([{ serverId: 's1', hostname: NODE }], null)
    expect(none.get('s1')?.role).toBe('unknown')
  })
})

describe('a healthy node has no finding, which is not the same as no reading', () => {
  // `judgeNodes` reports PROBLEMS, so a node it says nothing about is a node it
  // judged and found fine. The first version of this file read a missing
  // finding as "could not be read", which turned every healthy node into a gate
  // that waits until it times out and then halts the run — a self-inflicted
  // outage on a perfectly good cluster.
  it('passes a node the judge had nothing to say about', () => {
    const n = matchNodes([{ serverId: 's1', hostname: NODE }], HEALTHY).get('s1')!
    expect(n.role).toBe('node')
    if (n.role !== 'node') throw new Error('unreachable')
    expect(n.finding).toBeNull()
    expect(evaluateGate([at(n)], { since: 0 }).ok).toBe(true)
  })

  // The other half: once a run knows a machine is a node, a later failed read
  // must not downgrade it to a host nobody asked about — `unknown` does not
  // block and this must.
  it('keeps a known node blocking when a later cluster read fails', () => {
    const m = matchNodes([{ serverId: 's1', hostname: NODE }], null, {
      knownNodes: [NODE],
      readFailure: 'the API server refused the connection'
    })
    expect(m.get('s1')?.role).toBe('node-unread')
    const v = evaluateGate([at(m.get('s1')!)], { since: 0 })
    expect(v).toMatchObject({ ok: false, kind: 'stale' })
  })

  it('still says nobody asked about a host that was never a node', () => {
    const m = matchNodes([{ serverId: 's1', hostname: 'db-1' }], null, { knownNodes: [NODE] })
    expect(m.get('s1')?.role).toBe('unknown')
  })
})

describe('the summary keeps the four states apart', () => {
  it('files each host under what is actually known about it', () => {
    const s = summariseNodeGate([
      { serverName: 'a', node: nodeOf(notReady) },
      { serverName: 'ok', node: nodeOf(HEALTHY) },
      { serverName: 'b', node: { role: 'node-unread', nodeName: 'n', why: 'x' } },
      { serverName: 'c', node: { role: 'not-a-node' } },
      { serverName: 'd', node: { role: 'unknown' } },
      { serverName: 'e' }
    ])
    expect(s.blocking.map((b) => b.serverName)).toEqual(['a'])
    expect(s.unread.map((u) => u.serverName)).toEqual(['b'])
    expect(s.notNodes).toEqual(['c'])
    // An absent reading is the same as nobody having asked.
    expect(s.unasked).toEqual(['d', 'e'])
  })
})


// ---------------------------------------------------------------------------
// Asking the wave's own hosts, which is what makes this need no nomination
// ---------------------------------------------------------------------------

const NODE_ROW = 'e9b442a99227   False   False   False   True   12    24571576Ki   110   <none>'

describe('the read that runs on the host', () => {
  it('asks the machine what it is called and never escalates', () => {
    const c = buildGateNodeCommand()
    expect(c).toContain('hostname')
    expect(c).toContain('get nodes --no-headers')
    // A read of a cluster the operator's own kubeconfig can already see. Root
    // is a larger privilege than the question needs.
    expect(c).not.toContain('sudo')
  })

  // The journal lesson, in another module: an error message must not land where
  // a table goes and get parsed as data.
  it('discards kubectl’s stderr so a refusal is not read as a node', () => {
    expect(buildGateNodeCommand()).toContain('2>/dev/null')
  })

  it('carries a context when there is one, and nothing when there is not', () => {
    expect(buildGateNodeCommand('prod')).toContain('--context=prod')
    expect(buildGateNodeCommand()).not.toContain('--context')
    expect(buildGateNodeCommand('')).not.toContain('--context')
  })

  it('reads a host that answered with both halves', () => {
    const out = [
      `${GATE_NODE_MARKERS.host}`,
      'e9b442a99227',
      `${GATE_NODE_MARKERS.kubectl}`,
      'present',
      `${GATE_NODE_MARKERS.nodes}`,
      NODE_ROW
    ].join('\n')
    const r = parseGateNodeRead(out)
    expect(r.hostname).toBe('e9b442a99227')
    expect(r.kubectl).toBe('present')
    expect(r.nodes).toHaveLength(1)
  })

  // AN EMPTY TABLE IS NOT AN EMPTY CLUSTER. The command swallows kubectl's
  // stderr, so a refusal arrives as no output — and a cluster with no nodes at
  // all is not something that happens to a wave running on one. Null keeps
  // every host in the wave unmatched rather than turning them into "not a node".
  it('does not read a host with no kubeconfig as a cluster with no nodes', () => {
    const out = [
      `${GATE_NODE_MARKERS.host}`,
      'worker-3',
      `${GATE_NODE_MARKERS.kubectl}`,
      'absent',
      `${GATE_NODE_MARKERS.nodes}`
    ].join('\n')
    const r = parseGateNodeRead(out)
    expect(r.kubectl).toBe('absent')
    expect(r.nodes).toBeNull()
  })
})

describe('what kubectl prints when it cannot answer', () => {
  // THE reason stderr is discarded. `error: You must be logged in to the server
  // (Unauthorized)` is ten whitespace-separated fields, and `parseNodeHealth`
  // takes any line with nine or more — so with the streams merged it becomes a
  // NODE named `error:` whose Ready condition is `Unknown`, which judges as
  // `unreported` and HALTS the run. A false outage produced by an error message.
  it('keeps kubectl’s stderr out of the table it parses', () => {
    // The harm is not a false halt, it is a SILENT FALSE PASS, and it takes a
    // moment to see. `error: You must be logged in to the server
    // (Unauthorized)` is ten whitespace-separated fields and `parseNodeHealth`
    // takes any line with nine or more, so with the streams merged it becomes a
    // node named `error:`. It matches no real hostname, so nothing halts —
    // but the wave now HAS a node list, and every genuine node in it is judged
    // `not-a-node` instead of `unknown`. The check quietly does nothing while
    // reporting that it looked.
    // Scoped to the node read itself. An unscoped search finds the `2>&1` on
    // the `command -v kubectl` probe, which is a legitimate use, and then
    // passes or fails on the wrong line.
    const read = buildGateNodeCommand().split('kubectl get nodes')[1] ?? ''
    expect(read).toContain('2>/dev/null')
    expect(read).not.toContain('2>&1')

    // What arrives with the redirect in place: nothing, so the host is unknown
    // — the honest answer, and the one that says the question went unanswered.
    const quiet = parseGateNodeRead(
      [GATE_NODE_MARKERS.host, NODE, GATE_NODE_MARKERS.kubectl, 'present', GATE_NODE_MARKERS.nodes].join('\n')
    )
    expect(gateNodesFromWave([{ serverId: 's1', read: quiet }]).get('s1')?.role).toBe('unknown')

    // And what would arrive without it: a real node demoted to "not a node".
    const merged = parseGateNodeRead(
      [
        GATE_NODE_MARKERS.host,
        NODE,
        GATE_NODE_MARKERS.kubectl,
        'present',
        GATE_NODE_MARKERS.nodes,
        'error: You must be logged in to the server (Unauthorized)'
      ].join('\n')
    )
    expect(
      gateNodesFromWave([{ serverId: 's1', read: merged }]).get('s1')?.role,
      'a merged stderr silently demoted a real node to “not a node”'
    ).not.toBe('node')
  })

  // A table that arrives but yields no rows is not a cluster with no nodes —
  // that is not a thing that happens to a wave running on one. Null keeps the
  // wave unmatched instead of quietly declaring every host "not a node", which
  // is a silent loss of the whole check.
  it('does not read an unparseable table as a cluster with no nodes', () => {
    const r = parseGateNodeRead(
      [GATE_NODE_MARKERS.host, 'web-1', GATE_NODE_MARKERS.kubectl, 'present', GATE_NODE_MARKERS.nodes, '   ', 'garbage'].join('\n')
    )
    expect(r.nodes).toBeNull()
    expect(gateNodesFromWave([{ serverId: 's1', read: r }]).get('s1')?.role).toBe('unknown')
  })
})

describe('folding a wave’s answers together', () => {
  const answered = (id: string, hostname: string, nodes: boolean): {
    serverId: string
    read: ReturnType<typeof parseGateNodeRead>
  } => ({
    serverId: id,
    read: parseGateNodeRead(
      [
        GATE_NODE_MARKERS.host,
        hostname,
        GATE_NODE_MARKERS.kubectl,
        nodes ? 'present' : 'absent',
        GATE_NODE_MARKERS.nodes,
        ...(nodes ? [NODE_ROW] : [])
      ].join('\n')
    )
  })

  // One host with a kubeconfig answers for the whole wave: they are all in the
  // same run against the same cluster.
  it('uses the node list from whichever host could produce one', () => {
    const m = gateNodesFromWave([
      answered('a', 'worker-3', false),
      answered('b', NODE, true)
    ])
    expect(m.get('b')?.role).toBe('node')
    // And the host that is genuinely not in that cluster is not a node.
    expect(m.get('a')?.role).toBe('not-a-node')
  })

  // The stated limit: a wave where nobody can reach the API server gets no
  // protection, and says `unknown` rather than pretending to have looked.
  it('leaves a wave that cannot reach any cluster entirely unknown', () => {
    const m = gateNodesFromWave([answered('a', 'worker-3', false), answered('b', 'worker-4', false)])
    expect([...m.values()].map((v) => v.role)).toEqual(['unknown', 'unknown'])
    const hosts = [...m.entries()].map(([id, node]) => host({ serverId: id, node }))
    expect(evaluateGate(hosts, { since: 0 }).ok).toBe(true)
  })

  // A host that did not answer at all matches nothing rather than being matched
  // by guesswork, and falls back to the systemd rules.
  // A host that did not answer must match NOTHING. The serverId is not a
  // hostname, and falling back to it would match a node whenever the two
  // happened to coincide — gating on a machine that never said who it was.
  it('does not guess a node for a host that never answered', () => {
    const m = gateNodesFromWave([{ serverId: 'a', read: null }, answered('b', NODE, true)])
    expect(m.get('a')?.role).toBe('not-a-node')
    // The trap, with an id that WOULD match if the serverId were used.
    const m2 = gateNodesFromWave([{ serverId: NODE, read: null }, answered('b', NODE, true)])
    expect(m2.get(NODE)?.role).toBe('not-a-node')
  })
})
