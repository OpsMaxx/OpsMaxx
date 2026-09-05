import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import {
  buildK8sReviewCommand,
  crashloopFindings,
  MARKER_SECTION,
  REVIEW_MARKERS,
  REVIEW_READS,
  reviewFindings,
  splitReview,
  type ReviewFinding
} from '../src/shared/k8sReview'

// Item 39's reads, called at last. The fixture is ONE round trip against a k3s
// v1.31.5 cluster carrying every condition the eleven modules were written
// against: a bounded deployment and an unbounded one, an HPA with no metrics
// server, a budget at its limit and an orphaned one, a failed Job and a
// completed one, a Retain PV, a DaemonSet that rolled out and does not run, an
// unreferenced ConfigMap and an unmounted claim.

const DIR = fileURLToPath(new URL('./fixtures/k8s/review', import.meta.url))
const read = (n: string): string => readFileSync(join(DIR, n), 'utf8')
const NOW = Date.parse('2026-09-05T21:00:00Z')
const result = (): ReturnType<typeof reviewFindings> => reviewFindings(splitReview(read('review.txt')), NOW)
// By subject AND section: one object legitimately appears in several sections
// -- a deployment has both a resource verdict and a budget-coverage verdict.
const find = (subject: string, section?: string): ReviewFinding | undefined =>
  result().findings.find((f) => f.subject === subject && (section === undefined || f.section === section))

describe('the reads', () => {
  it('was captured with the reads this module builds', () => {
    const cmd = read('command.sh')
    for (const spec of Object.values(REVIEW_READS)) expect(cmd).toContain(spec)
  })

  it('emits every marker, and never swallows a failure with || true', () => {
    const cmd = buildK8sReviewCommand()
    for (const m of Object.values(REVIEW_MARKERS)) expect(cmd).toContain(`===SHELLPILOT-${m}===`)
    // A denial has to arrive as its section's text so it becomes a blind spot
    // for that section alone. `|| true` would make one RBAC refusal look like a
    // clean read of an empty cluster.
    expect(cmd).not.toContain('|| true')
  })

  it('names a section for every marker', () => {
    for (const key of Object.keys(REVIEW_MARKERS)) {
      expect(MARKER_SECTION[key as keyof typeof REVIEW_MARKERS]).toBeTruthy()
    }
  })

  it('puts the context on every read, not just the first', () => {
    const cmd = buildK8sReviewCommand('kubectl', 'prod')
    expect(cmd.split('--context=prod').length - 1).toBe(Object.keys(REVIEW_MARKERS).length)
  })
})

describe('splitting one round trip', () => {
  it('gives every section its own text', () => {
    const b = splitReview(read('review.txt'))
    expect(b.nodes.ok && b.nodes.text).toContain('True')
    expect(b.pdb.ok && b.pdb.text).toContain('orphan-pdb')
    expect(b.refs.ok && b.refs.text).toContain('kube-root-ca.crt')
  })

  // The command may stop part way -- the connection drops, kubectl is not
  // installed, the shell dies. A missing marker is NOT an empty section.
  it('calls a section that never arrived missing, with what the host last said', () => {
    const b = splitReview('===SHELLPILOT-NODES===\nnode-1 False False False True 4 8Gi 110 <none>\nbash: kubectl: command not found')
    expect(b.nodes.ok).toBe(true)
    expect(b.pdb.ok).toBe(false)
    expect(b.pdb.ok === false && b.pdb.detail).toContain('command not found')
  })

  it('does not report a blind spot for a section that is simply empty', () => {
    // An empty section is a real answer: this cluster has none of that thing.
    const b = splitReview('===SHELLPILOT-PV===\n===SHELLPILOT-NODES===\n')
    expect(b.pv.ok && b.pv.text).toBe('')
  })
})

describe('what one real cluster produced', () => {
  it('finds the DaemonSet that rolled out to every node and runs on none', () => {
    const f = find('default/broken-addon')!
    expect(f.level).toBe('alarm')
    expect(f.because).toContain('The rollout is complete and the add-on is not running.')
  })

  it('alarms on the autoscaler that cannot see a metric', () => {
    const f = find('default/bounded-hpa')!
    expect(f.section).toBe('hpa')
    expect(f.level).toBe('alarm')
  })

  it('finds the workload nothing bounds', () => {
    expect(find('default/unbounded', 'workloads')!.because).toContain('no CPU or memory limit')
    expect(find('default/bounded', 'workloads')!.because).toContain('declares limits')
  })

  it('separates a budget at its limit from one guarding nothing', () => {
    // Both report disruptionsAllowed 0. Only `expectedPods` tells them apart,
    // and only one of them will ever block a drain.
    const orphan = find('default/orphan-pdb')!
    expect(orphan.level).toBe('watch')
    expect(orphan.because).toContain('guards no pods at all')
    const blocked = result().findings.find((f) => f.section === 'pdb' && f.level === 'alarm')!
    expect(blocked.because).toContain('will wait')
  })

  it('finds the unreferenced ConfigMap and the unmounted claim', () => {
    expect(find('default/nobody-uses-me')!.section).toBe('unused')
    expect(find('default/orphan-claim')!.section).toBe('unused')
  })

  it('never proposes the cluster-owned ConfigMap that every namespace carries', () => {
    expect(result().findings.some((f) => f.subject.endsWith('/kube-root-ca.crt'))).toBe(false)
  })

  it('carries the caveat that makes the unused list a list of candidates', () => {
    expect(result().notes.join(' ')).toContain('scaled to zero has no pods')
  })

  it('groups the warnings rather than repeating one cause', () => {
    const warnings = result().findings.filter((f) => f.section === 'warnings')
    // Nine raw rows, and no object-and-reason appears twice.
    const keys = warnings.map((w) => `${w.subject} ${w.because.split(' ')[0]}`)
    expect(new Set(keys).size).toBe(keys.length)
    expect(warnings.some((w) => w.because.includes('InvalidDiskCapacity'))).toBe(false)
  })

  it('reports the healthy things it checked, not only the problems', () => {
    // A review showing only problems cannot be told from one that did not run.
    const ok = result().findings.filter((f) => f.level === 'ok')
    expect(ok.some((f) => f.section === 'nodes')).toBe(true)
    expect(ok.some((f) => f.section === 'pv')).toBe(true)
  })

  it('puts the alarms first', () => {
    const levels = result().findings.map((f) => f.level)
    const order = { alarm: 0, watch: 1, ok: 2 }
    expect(levels.map((l) => order[l])).toEqual([...levels.map((l) => order[l])].sort((a, b) => a - b))
  })

  it('is blind to nothing on a cluster that answered everything', () => {
    expect(result().blind).toEqual([])
  })
})

describe('a read that did not happen', () => {
  it('names what was not looked at instead of shortening the list quietly', () => {
    const blocks = splitReview(read('review.txt'))
    blocks.pv = { ok: true, text: 'Error from server (Forbidden): persistentvolumes is forbidden' }
    const r = reviewFindings(blocks, NOW)
    expect(r.blind).toContainEqual({ section: 'pv', detail: expect.stringContaining('Forbidden') })
    expect(r.findings.some((f) => f.section === 'pv')).toBe(false)
  })

  // The defect this module actually had. An early version read PDBs in a shape
  // `parseDrainPdbs` could not parse; it returned [], and `pdbCoverage` then
  // reported EVERY workload as having no budget -- a screen of confident
  // findings produced by a read that failed.
  it('does not turn an unparseable budget listing into "nothing has a budget"', () => {
    const blocks = splitReview(read('review.txt'))
    blocks.pdb = { ok: true, text: 'default   bounded-pdb   0   2   2   2   map[app:bounded]   <none>' }
    const r = reviewFindings(blocks, NOW)
    expect(r.blind).toContainEqual({ section: 'pdb', detail: expect.stringContaining('could not read') })
    expect(r.findings.some((f) => f.section === 'pdb')).toBe(false)
  })

  it('still reports every other section when one is denied', () => {
    const blocks = splitReview(read('review.txt'))
    blocks.nodes = { ok: true, text: 'error: You must be logged in to the server' }
    const r = reviewFindings(blocks, NOW)
    expect(r.blind).toHaveLength(1)
    expect(r.findings.some((f) => f.section === 'addons')).toBe(true)
  })

  it('reports one blind spot per section, not one per read inside it', () => {
    const blocks = splitReview(read('review.txt'))
    const denied = { ok: true as const, text: 'error: forbidden' }
    blocks.cm = denied
    blocks.pvc = denied
    blocks.refs = denied
    const r = reviewFindings(blocks, NOW)
    expect(r.blind.filter((b) => b.section === 'unused')).toHaveLength(1)
  })
})

describe('restarts, which need two readings', () => {
  const pods = [{ namespace: 'default', name: 'web', restarts: 5 }]

  it('says nothing at all without a previous sample', () => {
    // A restart COUNT is not a rate. With one reading there is no answer, and
    // no answer must not render as an all-clear.
    expect(crashloopFindings('ok', pods, null)).toEqual([])
  })

  it('reports the delta once there is one', () => {
    const before = [{ namespace: 'default', name: 'web', restarts: 2 }]
    const f = crashloopFindings('ok', pods, before)
    expect(f).toHaveLength(1)
    expect(f[0].level).toBe('alarm')
    expect(f[0].because).toContain('restarted 3 more times')
  })

  it('says nothing when a pod has not restarted since the last look', () => {
    expect(crashloopFindings('ok', pods, pods)).toEqual([])
  })

  it('says nothing when the pod list could not be read', () => {
    expect(crashloopFindings('forbidden', pods, pods)).toEqual([])
  })

  it('says nothing when only one namespace could be listed', () => {
    // A partial read is not a claim about the cluster, and "no pod restarted"
    // about a fraction of it is the all-clear this must never print.
    const before = [{ namespace: 'default', name: 'web', restarts: 2 }]
    expect(crashloopFindings('one-namespace', pods, before)).toEqual([])
  })

  it('ignores a pod that was not in the previous sample', () => {
    // It may have been recreated with a fresh count, and a new pod's restarts
    // are not evidence of anything yet.
    expect(crashloopFindings('ok', pods, [{ namespace: 'default', name: 'other', restarts: 0 }])).toEqual([])
  })
})

describe('the panel passes the review on rather than flattening it', () => {
  // Read off the source, the same way `k8sSkew.test.ts` reads its guard and for
  // the same reason: mounting KubernetesPanel pulls in the whole app store, and
  // the mistakes worth guarding here are all one edit wide.
  const src = (): string =>
    readFileSync(
      fileURLToPath(new URL('../src/renderer/src/components/kubernetes/KubernetesPanel.tsx', import.meta.url)),
      'utf8'
    )

  it('renders the blind spots, not only the findings', () => {
    // A short list of findings reads as a clean cluster. The denied read is the
    // difference, and it has to be on screen.
    expect(src()).toMatch(/r\.blind\.map\(/)
    expect(src()).toContain('was not read, so nothing here says anything about it')
  })

  it('renders the notes that make the unused list a candidate list', () => {
    expect(src()).toMatch(/r\.notes\.map\(/)
  })

  it('does not run the review inside the refresh', () => {
    // Thirteen kubectl calls. Folding it in would make every refresh wait on
    // it, which is how a read that is worth having gets turned off.
    const body = src()
    const loader = body.slice(body.indexOf('setApiScan('), body.indexOf('setApiScan(') + 800)
    expect(loader).not.toContain('review(')
    expect(body).toContain('const runReview = async')
  })

  it('reports a review that could not run at all rather than an empty one', () => {
    expect(src()).toMatch(/!review\.ok && \(/)
    expect(src()).toContain('Nothing was read:')
  })
})
