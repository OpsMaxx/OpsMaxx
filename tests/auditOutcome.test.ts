import { describe, it, expect } from 'vitest'

import { auditExport, auditOutcome } from '../src/renderer/src/components/ai/auditOutcome'
import type { AuditEntry } from '../src/shared/mcp'

const e = (over: Partial<AuditEntry>): AuditEntry =>
  ({
    id: 'a1',
    timestamp: '2026-09-07T07:04:42.000Z',
    agentName: 'Claude Code',
    sessionId: 'sess-abcdef123456',
    workspaceId: 'w',
    workspaceName: 'Personal',
    serverId: 's',
    serverName: 'k3s-node-01',
    action: 'systemctl restart cron',
    capability: 'terminal',
    approval: 'denied',
    result: 'denied',
    ...over
  }) as AuditEntry

// The row carried `APPROVAL: denied` and `RESULT: denied` — the same word
// twice, in the two columns an incident reviewer looks at first, occupying
// exactly the width the missing session column needed.

describe('the two columns were not the same fact', () => {
  // THE distinction. Approval is what the human answered; result is what
  // happened afterwards. An approved-then-failed row must not read as a denial.
  it('separates an approval that then failed from a refusal', () => {
    const failed = auditOutcome(e({ approval: 'approved', result: 'error', exitCode: 1 }))
    const refused = auditOutcome(e({ approval: 'denied', result: 'denied' }))
    expect(failed.label).not.toBe(refused.label)
    expect(failed.label).toMatch(/approved/i)
    expect(refused.label).toMatch(/^denied$/i)
  })

  // Approval said yes and a path rule or a missing capability still said no.
  // Collapsing this into "denied" loses exactly the distinction a review needs.
  it('separates blocked-after-approval from refused-by-a-human', () => {
    const blocked = auditOutcome(e({ approval: 'approved', result: 'denied' }))
    expect(blocked.label).toMatch(/blocked/i)
    expect(blocked.detail).toMatch(/path rule|capability/i)
  })
})

describe('a timeout is never reported as a decision', () => {
  // The single most misleading thing this table could do: say a person decided
  // when nobody did. It is a denial, and it is the one the operator did not
  // make.
  it('names the timeout and attributes it to the fuse', () => {
    const o = auditOutcome(e({ approval: 'timeout', result: 'denied' }))
    expect(o.decidedBy).toBe('timeout')
    expect(o.label).toMatch(/timed out/i)
    expect(o.detail).toMatch(/fail-closed|Nobody answered/i)
  })

  it('does not attribute it to the user', () => {
    expect(auditOutcome(e({ approval: 'timeout', result: 'denied' })).decidedBy).not.toBe('you')
  })
})

describe('who decided, when anything did', () => {
  it.each([
    ['approved', 'you'],
    ['denied', 'you'],
    ['timeout', 'timeout'],
    ['not-required', 'policy']
  ] as [AuditEntry['approval'], string][])('%s → %s', (approval, who) => {
    expect(auditOutcome(e({ approval, result: 'success' })).decidedBy).toBe(who)
  })

  // "not-required" means the access group allowed it outright — a policy
  // decision, not an absence of one.
  it('says the group allowed it rather than leaving the cell blank', () => {
    const o = auditOutcome(e({ approval: 'not-required', result: 'success' }))
    expect(o.label).toMatch(/allowed/i)
    expect(o.detail).toMatch(/access group/i)
  })
})

describe('what the server said survives', () => {
  it('carries the error text into the detail rather than only saying "failed"', () => {
    const o = auditOutcome(e({ approval: 'approved', result: 'error', error: 'Unit not found' }))
    expect(o.detail).toContain('Unit not found')
  })

  it('reports the exit code where there is one, and nothing where there is not', () => {
    expect(auditOutcome(e({ approval: 'approved', result: 'success', exitCode: 0 })).label).toContain('exit 0')
    expect(auditOutcome(e({ approval: 'approved', result: 'success' })).label).not.toContain('exit')
  })
})

describe('the export', () => {
  const parsed = (): { entries: Record<string, unknown>[]; count: number } =>
    JSON.parse(auditExport([e({}), e({ id: 'a2', approval: 'timeout' })])) as never

  it('keeps every raw field alongside the derived outcome', () => {
    const rows = parsed().entries
    // Derived ALONGSIDE, never instead of: a reader six months from now should
    // be able to see what the app concluded and still check it.
    expect(rows[0]).toMatchObject({ approval: 'denied', result: 'denied', sessionId: 'sess-abcdef123456' })
    expect(rows[0].outcome).toBeDefined()
  })

  it('is valid JSON and says how many entries it holds', () => {
    expect(parsed().count).toBe(2)
    expect(parsed().entries).toHaveLength(2)
  })

  it('does not lose the session id, which is why it exists', () => {
    expect(auditExport([e({})])).toContain('sess-abcdef123456')
  })
})
