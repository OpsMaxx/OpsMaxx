import { describe, it, expect, beforeEach } from 'vitest'

import {
  agentRunsInFlight,
  forgetAgentRun,
  noteAgentRun,
  dispose,
  reload
} from '../src/main/services/cicd/wiring'

/**
 * What STOP ALL AI ACCESS cannot stop, and can at least name.
 *
 * The switch revokes sessions and denies pending approvals. It has no power
 * over a build the provider already accepted — and the operator pressing it at
 * 2am had no way to learn one existed, because `list_runs` is the agent's tool
 * and not a notification. This ledger exists purely so the dialog can say it.
 *
 * It deliberately does NOT cancel anything. Auto-cancelling on the panic button
 * would be a destructive, unapproved action taken on the operator's behalf, and
 * a pipeline stopped half-way has done some of its work and not the rest.
 */

const saved = {
  cicdConnections: [
    {
      id: 'c1',
      workspaceId: 'ws-1',
      name: 'platform-jenkins',
      provider: 'jenkins',
      baseUrl: 'https://ci.internal',
      username: 'svc',
      vaultEntryId: 'v1',
      route: { kind: 'direct' },
      enabled: true
    }
  ]
}

describe('runs an agent started', () => {
  beforeEach(() => {
    dispose()
    reload(saved)
  })

  it('is empty when no agent has started anything', () => {
    expect(agentRunsInFlight()).toEqual([])
  })

  it('names the connection and the pipeline', () => {
    noteAgentRun('c1', 'job/deploy-prod', { run: { id: '4821', attempt: 1 }, note: '' })
    const [r] = agentRunsInFlight()
    expect(r.connectionName).toBe('platform-jenkins')
    expect(r.pipeline).toBe('job/deploy-prod')
  })

  it('says "unknown" — not "running" — when the provider returned no run id', () => {
    // Jenkins hands back a queue item and GitHub Enterprise answers 204, so
    // nothing has been able to check on it since. Reporting that as `running`
    // would be the one claim nobody made.
    noteAgentRun('c1', 'job/deploy-prod', { queueRef: 'queue/item/47', note: '' })
    expect(agentRunsInFlight()[0].state).toBe('unknown')
  })

  it('forgets a run once the provider accepted a cancel for it', () => {
    noteAgentRun('c1', 'job/deploy-prod', { run: { id: '4821', attempt: 1 }, note: '' })
    forgetAgentRun('c1', '4821')
    expect(agentRunsInFlight()).toEqual([])
  })

  it('ignores a cancel for a run it never recorded', () => {
    noteAgentRun('c1', 'job/deploy-prod', { run: { id: '4821', attempt: 1 }, note: '' })
    forgetAgentRun('c1', 'not-a-run')
    expect(agentRunsInFlight()).toHaveLength(1)
  })

  it('ages out a record nothing can ever resolve, so the dialog cannot cry wolf', () => {
    noteAgentRun('c1', 'job/deploy-prod', { queueRef: 'q', note: '' })
    const sevenHours = Date.now() + 7 * 60 * 60 * 1000
    expect(agentRunsInFlight(sevenHours)).toEqual([])
    // And it is really gone, not merely filtered out of one answer.
    expect(agentRunsInFlight()).toEqual([])
  })

  it('keeps a record that is merely old but still inside the window', () => {
    noteAgentRun('c1', 'job/deploy-prod', { queueRef: 'q', note: '' })
    expect(agentRunsInFlight(Date.now() + 60 * 60 * 1000)).toHaveLength(1)
  })

  it('reports several in the order they were started', () => {
    noteAgentRun('c1', 'job/a', { run: { id: '1', attempt: 1 }, note: '' })
    noteAgentRun('c1', 'job/b', { run: { id: '2', attempt: 1 }, note: '' })
    expect(agentRunsInFlight().map((r) => r.pipeline)).toEqual(['job/a', 'job/b'])
  })

  it('falls back to the id when the connection is gone', () => {
    // A connection deleted between the trigger and the switch. Naming the id is
    // worse than naming the connection and far better than dropping the row —
    // the run is still out there.
    noteAgentRun('deleted', 'job/x', { run: { id: '9', attempt: 1 }, note: '' })
    expect(agentRunsInFlight()[0].connectionName).toBe('deleted')
  })

  it('is cleared by dispose, because it is a claim about this session only', () => {
    noteAgentRun('c1', 'job/deploy-prod', { run: { id: '4821', attempt: 1 }, note: '' })
    dispose()
    expect(agentRunsInFlight()).toEqual([])
  })
})
