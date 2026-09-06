import { describe, it, expect } from 'vitest'

import { planNodeMaintenance, nodeMaintenanceSummary } from '../src/shared/nodeMaintenance'
import type { JobStep } from '../src/shared/jobs'

// cordon → patch → reboot → uncordon, as one confirmable job.
//
// Each of the four already worked as a separate click. The sequence is only
// safe AS a sequence, and the way a human gets it wrong at 2am is specific:
// they patch and reboot, the node comes back, and they forget the uncordon. The
// cluster then has a node that is Ready, healthy, running nothing, and
// reporting no problem to anybody.

const PATCH: JobStep[] = [{ command: 'apt-get -y upgrade' }]
const REBOOT: JobStep = { command: 'systemctl reboot', reboot: true }
const req = (over: Partial<Parameters<typeof planNodeMaintenance>[0]> = {}): ReturnType<
  typeof planNodeMaintenance
> => planNodeMaintenance({ node: 'k3s-node-1', patch: PATCH, reboot: REBOOT, kubectl: true, ...over })

const okPlan = (): Exclude<ReturnType<typeof planNodeMaintenance>, { ok: false }>['plan'] => {
  const r = req()
  if (!r.ok) throw new Error(r.reason)
  return r.plan
}

describe('the order is the feature', () => {
  it('cordons first and uncordons last, with the reboot inside', () => {
    const s = okPlan().steps
    expect(s).toHaveLength(4)
    expect(s[0].command).toContain('cordon k3s-node-1')
    expect(s[0].command).not.toContain('uncordon')
    expect(s[1].command).toBe('apt-get -y upgrade')
    expect(s[2].reboot).toBe(true)
    expect(s[3].command).toContain('uncordon k3s-node-1')
  })

  // Nothing new schedules onto a machine that is about to go down, and the node
  // only takes work again after it has actually come back.
  it('never lets the reboot land before the cordon', () => {
    const s = okPlan().steps
    const cordonAt = s.findIndex((x) => /(?<!un)cordon /.test(x.command))
    const rebootAt = s.findIndex((x) => x.reboot === true)
    const uncordonAt = s.findIndex((x) => x.command.includes('uncordon'))
    expect(cordonAt).toBeLessThan(rebootAt)
    expect(rebootAt).toBeLessThan(uncordonAt)
  })

  it('carries the context into both kubectl steps when there is one', () => {
    const r = req({ context: 'prod' })
    if (!r.ok) throw new Error(r.reason)
    expect(r.plan.steps[0].command).toContain('--context=prod')
    expect(r.plan.steps[3].command).toContain('--context=prod')
  })
})

describe('the half-finished chain', () => {
  // A run that fails after the cordon leaves the node cordoned, and that is the
  // correct outcome: a node whose patch did not finish should not be taking
  // work. Putting it back is a DECISION, and item 44 already settled that a
  // rollback is never run automatically.
  it('ships the uncordon as a rollback and not as an automatic step', () => {
    const p = okPlan()
    expect(p.rollback).toHaveLength(1)
    expect(p.rollback[0].command).toContain('uncordon k3s-node-1')
    expect(p.rollback[0].reboot).toBeUndefined()
  })

  it('says the node stays cordoned on a failure, rather than implying cleanup', () => {
    const c = okPlan().cautions.join(' ')
    expect(c).toContain('stays cordoned')
    expect(c).toContain('nothing runs that for you')
  })
})

describe('what it refuses, rather than guessing', () => {
  // THE refusal. The kubectl steps run ON the node, which works for k3s and a
  // control-plane node and not for a typical worker. A chain that cordoned and
  // then could not uncordon would leave the node in exactly the state this
  // feature exists to prevent — having been confirmed by somebody who was told
  // it would work.
  it('refuses a node that cannot run kubectl, and says why that is normal', () => {
    const r = req({ kubectl: false })
    expect(r).toMatchObject({ ok: false, refusal: 'no-kubectl' })
    if (r.ok) throw new Error('unreachable')
    expect(r.reason).toContain('worker node')
    expect(r.reason).toContain('kubelet and no kubeconfig')
  })

  // A maybe is not a yes. This is the same rule the rest of the app applies to
  // a read that did not happen.
  it('refuses on an unknown just as firmly as on a no', () => {
    const r = req({ kubectl: null })
    expect(r).toMatchObject({ ok: false, refusal: 'kubectl-unknown' })
    if (r.ok) throw new Error('unreachable')
    expect(r.reason).toContain('will not cordon a node on a maybe')
  })

  // `jobs.ts` is explicit: a step that restarts the machine and does not say so
  // is treated as an ordinary one. Here that means the runner reads the
  // disconnect as a failure and halts the chain with the node still cordoned.
  it('refuses a reboot step that does not declare itself', () => {
    const r = req({ reboot: { command: 'systemctl reboot' } })
    expect(r).toMatchObject({ ok: false, refusal: 'no-reboot-step' })
    if (r.ok) throw new Error('unreachable')
    expect(r.reason).toContain('still cordoned')
  })

  it('refuses to cordon and reboot for no change at all', () => {
    const r = req({ patch: [] })
    expect(r).toMatchObject({ ok: false, refusal: 'no-patch-steps' })
    if (r.ok) throw new Error('unreachable')
    expect(r.reason).toContain('A reboot with no change is still an outage')
  })

  it('refuses a node name it will not write into a command', () => {
    for (const bad of ['', 'a b', 'node;rm -rf /', '--all']) {
      expect(req({ node: bad }), bad).toMatchObject({ ok: false, refusal: 'invalid-node' })
    }
  })
})

describe('it does not pretend to have drained anything', () => {
  // A cordon evicts nothing, and "cordon" reads to a lot of people as
  // "emptied". Drain is the module's dangerous verb with seven refusals of its
  // own; folding it into a button labelled "patch" would smuggle the most
  // destructive operation in the module into a routine chain.
  it('says the running pods are killed by the reboot, not moved', () => {
    const c = okPlan().cautions.join(' ')
    expect(c).toContain('A cordon evicts nothing')
    expect(c).toContain('until the reboot kills them')
    expect(c).toContain('does not drain')
  })

  it('never builds a drain', () => {
    const p = okPlan()
    for (const s of [...p.steps, ...p.rollback]) expect(s.command).not.toContain('drain')
  })
})

describe('the sentence the operator reads', () => {
  it('says what happens to the node and when it takes work again', () => {
    const s = nodeMaintenanceSummary('k3s-node-1', okPlan())
    expect(s).toContain('k3s-node-1')
    expect(s).toContain('stops taking new work')
    expect(s).toContain('starts again at the last')
  })
})
