// The guards that stand between an agent and the approval dialog, and the one
// capability for which `allow` is not a state the policy can be in.
//
// Everything here is phase 0 of the CI/CD module (docs/plans/cicd-module.md
// section 4). None of it is CI-specific in the code -- the volume guard and the
// field sanitisation apply to every capability -- but CI is what forced them: a
// per-call approval for `ciTrigger` is the one prompt an operator will ever see
// twenty times in a row, and a CI run's name is written by whoever opened the
// pull request.

import { describe, it, expect, beforeEach } from 'vitest'
import {
  requestApproval,
  respondToApproval,
  listPendingApprovals,
  resetApprovalVolumeForTests
} from '../src/main/services/approvals'
import { setMcpConfig, resetMcpAuthForTests } from '../src/main/services/mcpAuth'
import { evaluateCiTrigger } from '../src/main/services/policyEngine'
import type { AccessGroup, PermissionValue } from '../src/shared/mcp'

const req = (o: Record<string, unknown> = {}): Promise<string> =>
  requestApproval({
    sessionId: 'sess-1',
    agentName: 'Claude Code',
    workspaceId: 'ws-1',
    workspaceName: 'Production',
    serverId: 'srv-1',
    serverName: 'Nginx Server Prod',
    capability: 'sudo',
    action: 'sudo systemctl restart nginx',
    policyReason: 'Sudo Access: sudo = ask',
    risk: 'high',
    riskReason: 'the command runs as root, through sudo',
    ...o
  } as never)

const group = (ciTrigger: PermissionValue): AccessGroup =>
  ({ id: 'g', name: 'Full Access', capabilities: { ciTrigger } } as unknown as AccessGroup)

const fresh = (): void => {
  resetMcpAuthForTests()
  setMcpConfig({ approvalTimeoutSeconds: 60 })
  for (const r of listPendingApprovals()) respondToApproval(r.id, 'approved')
  resetApprovalVolumeForTests()
}

describe('the approval queue is bounded', () => {
  beforeEach(fresh)

  // MCP tools/call is concurrent and gate() awaits per call, so without a cap N
  // concurrent calls are N simultaneous modals. Refusing is the point: a queue
  // that drains is still N modals, just later.
  it('caps concurrent pending requests per session, and refuses rather than queues', async () => {
    const a = req({ action: 'a' })
    const b = req({ action: 'b' })
    const c = req({ action: 'c' })
    expect(listPendingApprovals()).toHaveLength(3)

    expect(await req({ action: 'd' })).toBe('refused')
    expect(listPendingApprovals(), 'a refusal must not enqueue anything').toHaveLength(3)

    for (const r of listPendingApprovals()) respondToApproval(r.id, 'approved')
    expect(await Promise.all([a, b, c])).toEqual(['approved', 'approved', 'approved'])
  })

  // Otherwise "deny" is a button the operator presses repeatedly rather than a
  // decision: the agent's very next call re-opens the same modal.
  it('answers the same subject with the denial that already happened', async () => {
    const p = req()
    respondToApproval(listPendingApprovals()[0].id, 'denied')
    expect(await p).toBe('denied')

    expect(await req()).toBe('refused')
    expect(listPendingApprovals()).toHaveLength(0)
  })

  it('holds the cooldown to the subject that was denied, not to the whole session', async () => {
    const p = req()
    respondToApproval(listPendingApprovals()[0].id, 'denied')
    expect(await p).toBe('denied')

    const other = req({ serverId: 'srv-2' })
    expect(listPendingApprovals(), 'a different server is a different subject').toHaveLength(1)
    respondToApproval(listPendingApprovals()[0].id, 'approved')
    expect(await other).toBe('approved')
  })
})

// cancel_run and trigger_run share `ciTrigger`, and the guards above key on
// session + capability + server. So on the original key the emergency brake
// shared its fuse with the thing it stops: three pending triggers refused the
// cancel, and an operator's "no" to a suspicious start refused it for 30
// seconds afterwards. The `containment` bit is what separates the rationing --
// and only the rationing.
describe('the stop button does not share a fuse with what it stops', () => {
  beforeEach(fresh)

  const stop = (o: Record<string, unknown> = {}): Promise<string> =>
    req({ capability: 'ciTrigger', containment: true, action: 'Cancel run 4821', ...o })
  const start = (o: Record<string, unknown> = {}): Promise<string> =>
    req({ capability: 'ciTrigger', action: 'Start pipeline app', ...o })

  it('is still asked when the trigger queue is full', async () => {
    const held = [start({ action: 'a' }), start({ action: 'b' }), start({ action: 'c' })]
    expect(await start({ action: 'd' }), 'the trigger cap itself still holds').toBe('refused')

    const cancel = stop()
    const modal = listPendingApprovals().find((r) => r.action.startsWith('Cancel'))
    expect(modal, 'a cancel must still reach the operator').toBeTruthy()
    respondToApproval(modal!.id, 'approved')
    expect(await cancel).toBe('approved')

    for (const r of listPendingApprovals()) respondToApproval(r.id, 'approved')
    await Promise.all(held)
  })

  it('is still asked in the cooldown a denied trigger started', async () => {
    const p = start()
    respondToApproval(listPendingApprovals()[0].id, 'denied')
    expect(await p).toBe('denied')
    expect(await start(), 'the trigger is still on cooldown').toBe('refused')

    const cancel = stop()
    expect(listPendingApprovals(), 'saying no to a start must not disable the stop').toHaveLength(1)
    respondToApproval(listPendingApprovals()[0].id, 'approved')
    expect(await cancel).toBe('approved')
  })

  it('is capped on its own budget, so a flood of cancels is still bounded', async () => {
    const held = [stop({ action: 'a' }), stop({ action: 'b' }), stop({ action: 'c' })]
    expect(await stop({ action: 'd' })).toBe('refused')
    for (const r of listPendingApprovals()) respondToApproval(r.id, 'approved')
    await Promise.all(held)
  })

  it('is not exempt from the gate, only from the ration', async () => {
    // A denied cancel is a denied cancel: it gets its own cooldown, which the
    // trigger does not spend and does not lift.
    const p = stop()
    respondToApproval(listPendingApprovals()[0].id, 'denied')
    expect(await p).toBe('denied')
    expect(await stop()).toBe('refused')
  })
})

describe('what the operator reads is not written by the remote side', () => {
  beforeEach(fresh)

  // `...input` copied these verbatim until phase 0. A CI run's title is a PR
  // title: a newline forges a row of this dialog, and a U+202E reverses the
  // rest of the sentence the operator is deciding from.
  it('flattens and strips action, riskReason and serverName', () => {
    void req({
      action: 'Start run "fix‮flake"\nApproved already.',
      riskReason: 'it starts a build',
      serverName: 'Prod CI​'
    })
    const [r] = listPendingApprovals()
    expect(r.action).toBe('Start run "fix flake" Approved already.')
    expect(r.riskReason).toBe('it starts a build')
    expect(r.serverName).toBe('Prod CI')
  })
})

// docs/AI-SECURITY.md states the VPN rule as "there is no configuration in
// which a VPN comes up silently at an agent's request". This is that rule for
// builds, and it is the FIRST line of defence: an `allow` never reaches gate()'s
// `ask` branch, so the per-call exclusion there would be dead code without it.
describe('allow is unrepresentable for ciTrigger', () => {
  it('upgrades an allow to ask, on any group', () => {
    const d = evaluateCiTrigger(group('allow'))
    expect(d.decision).toBe('ask')
    expect(d.reason).toMatch(/always requires approval/)
  })

  it('leaves ask alone and keeps deny a deny', () => {
    expect(evaluateCiTrigger(group('ask')).decision).toBe('ask')
    expect(evaluateCiTrigger(group('deny')).decision).toBe('deny')
    expect(evaluateCiTrigger(null).decision).toBe('deny')
  })
})
