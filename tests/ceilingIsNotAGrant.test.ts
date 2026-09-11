import { describe, expect, it } from 'vitest'
import { evaluateCommand, evaluateCapability, mostRestrictive } from '../src/main/services/policyEngine'
import type { AccessGroup } from '../src/shared/mcp'

/**
 * The ceiling is a cap, not a grant.
 *
 * Reported as "even after giving full access it keeps asking for permission",
 * and then as "Denied: Sudo is denied for this access group" while the session
 * said Full Access. Both are the same thing: the effective answer is the more
 * restrictive of the session's ceiling and the access group assigned to the
 * workspace or server, so raising the ceiling cannot widen what the assignment
 * allows.
 *
 * That is the correct model -- a session must not be able to grant itself more
 * than the target was assigned -- and the app was enforcing it silently. These
 * tests pin the behaviour so it cannot be "fixed" into a hole, and the UI
 * changes beside them are what make it visible.
 */

const group = (name: string, caps: Partial<AccessGroup['capabilities']>): AccessGroup =>
  ({
    id: `grp-${name}`,
    name,
    builtIn: false,
    capabilities: { terminal: 'allow', readFiles: 'allow', sudo: 'allow', ...caps },
    filePolicies: []
  }) as AccessGroup

const FULL = group('Full Access', { terminal: 'allow', sudo: 'ask' })
const ASK_FIRST = group('Ask Before Commands', { terminal: 'ask', sudo: 'deny' })

describe('a narrow assignment under a wide ceiling', () => {
  it('still asks for an ordinary command', () => {
    const scope = evaluateCommand(ASK_FIRST, 'df -h /run')
    const ceiling = evaluateCommand(FULL, 'df -h /run')
    expect(ceiling.decision).toBe('allow')
    expect(mostRestrictive(scope, ceiling).decision).toBe('ask')
  })

  it('still denies sudo, which no approval can lift', () => {
    // The second report: a denial, not a prompt. `sudo = deny` on the
    // assignment beats `sudo = ask` on the ceiling, and a denial never opens an
    // approval card -- which is why the agent could not be waved through.
    const scope = evaluateCommand(ASK_FIRST, 'sudo install -d -m 750 /opt/x')
    expect(scope.decision).toBe('deny')
    expect(mostRestrictive(scope, evaluateCommand(FULL, 'sudo install -d -m 750 /opt/x')).decision).toBe('deny')
  })

  it('names the rule that decided, so the card can show it', () => {
    // The reason existed all along and the approval request dropped it, which
    // is what left the operator with no way to tell which layer said no.
    expect(evaluateCapability(ASK_FIRST, 'terminal').reason).toContain('Ask Before Commands')
    expect(evaluateCapability(ASK_FIRST, 'terminal').reason).toContain('terminal = ask')
  })
})

describe('a wide assignment under a narrow ceiling', () => {
  it('is capped by the ceiling, which is the direction that must never leak', () => {
    const scope = evaluateCommand(FULL, 'df -h')
    const ceiling = evaluateCommand(ASK_FIRST, 'df -h')
    expect(mostRestrictive(scope, ceiling).decision).toBe('ask')
  })
})
