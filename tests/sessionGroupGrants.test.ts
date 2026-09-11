import { describe, expect, it } from 'vitest'
import { evaluateCommand, evaluateCapability, mostRestrictive } from '../src/main/services/policyEngine'
import type { AccessGroup } from '../src/shared/mcp'

/**
 * The session's access group is the GRANT.
 *
 * It used to be only a ceiling. The grant came from an access group assigned to
 * the server's workspace, a target with no assignment was denied outright, and
 * the session's group could only narrow that — so the knob the user actually
 * turns changed nothing when they turned it up. Reported twice: "even after
 * giving full access it keeps asking for permission", then "Denied: Sudo is
 * denied for this access group" on a session reading Full Access.
 *
 * Now the session's group decides, and an assignment is an OPTIONAL restriction
 * that still wins where it is set, so a particular box can be held below what
 * the agent's group allows. These tests pin both halves: that one knob is
 * enough, and that a deliberately locked-down target cannot be talked past.
 */

const group = (name: string, caps: Partial<AccessGroup['capabilities']>): AccessGroup =>
  ({
    id: `grp-${name}`,
    name,
    builtIn: false,
    capabilities: { terminal: 'allow', readFiles: 'allow', sudo: 'allow', ...caps },
    filePolicies: []
  }) as AccessGroup

const FULL = group('Full Access', { terminal: 'allow', sudo: 'allow' })
const LOCKED = group('Ask Before Commands', { terminal: 'ask', sudo: 'deny' })

/** What mcpServer's resolveGroups/withRestriction pair does, in miniature. */
const effective = (grant: AccessGroup, restriction: AccessGroup | null, cmd: string) =>
  restriction
    ? mostRestrictive(evaluateCommand(grant, cmd), evaluateCommand(restriction, cmd))
    : evaluateCommand(grant, cmd)

describe('one knob is enough', () => {
  it('allows an ordinary command on a target with no assignment', () => {
    // The whole point. This used to be a flat deny -- "No AI access is assigned
    // to this server" -- no matter what the session was set to.
    expect(effective(FULL, null, 'df -h /run').decision).toBe('allow')
  })

  it('allows sudo when the group allows sudo', () => {
    expect(effective(FULL, null, 'sudo ls -l /opt').decision).toBe('allow')
  })

  it('but sudo = allow is not a blanket pass for dangerous commands', () => {
    // `sudo systemctl restart nginx` still asks, and should: the sudo
    // capability answers "may this run as root", and the command classifier
    // answers "is this the kind of thing somebody should see first". Allowing
    // the first has never meant waiving the second, and a group set to allow
    // sudo would otherwise stop a service without anybody being told.
    expect(effective(FULL, null, 'sudo systemctl restart nginx').decision).toBe('ask')
  })

  it('still asks when the group itself says ask', () => {
    // Turning the knob DOWN has to work too, and this is the setting that makes
    // a session safe to hand to an agent you are still getting to know.
    expect(effective(LOCKED, null, 'df -h').decision).toBe('ask')
  })
})

describe('a target held below the agent group', () => {
  it('is still held, however wide the session group is', () => {
    // The protection that has to survive the change: a production box locked
    // down individually cannot be reached by creating a Full Access session.
    expect(effective(FULL, LOCKED, 'df -h').decision).toBe('ask')
    expect(effective(FULL, LOCKED, 'sudo rm -rf /var').decision).toBe('deny')
  })

  it('cannot widen a narrow session group either', () => {
    // The restriction narrows and never grants: a permissive assignment on a
    // server must not lift a deliberately limited agent.
    expect(effective(LOCKED, FULL, 'df -h').decision).toBe('ask')
  })
})

describe('rules that no group may override', () => {
  it('never lets an agent have an unrestricted root shell', () => {
    for (const cmd of ['sudo -i', 'su -', 'sudo bash']) {
      expect(evaluateCommand(FULL, cmd).decision, cmd).toBe('deny')
    }
  })

  it('keeps grading dangerous commands even under a group that allows everything', () => {
    // `terminal: allow` must not mean `rm -rf /var/lib` runs unseen.
    expect(evaluateCommand(FULL, 'rm -rf /var/lib').decision).not.toBe('allow')
  })

  it('still names the group in its reason, so the card can show it', () => {
    expect(evaluateCapability(LOCKED, 'terminal').reason).toContain('Ask Before Commands')
    expect(evaluateCapability(LOCKED, 'terminal').reason).toContain('terminal = ask')
  })
})

describe('an explicit No AI Access', () => {
  // The hole this nearly shipped with. `resolveGroupId` returns null both for
  // "nobody has set anything here" and for "somebody set this to No AI Access".
  // Under the old model both denied, so collapsing them was harmless. Under the
  // new one the first means "no restriction, the session's group applies" -- so
  // reading the second the same way would silently unlock every target a user
  // had deliberately shut. The integration suite caught it.
  it('is a different fact from having no assignment', async () => {
    const { resolveRestriction } = await import('../src/main/services/policyEngine')
    const at = (groupId: string | null) => [
      { id: 'a1', scope: { level: 'workspace' as const, workspaceId: 'ws-1' }, groupId }
    ]
    expect(resolveRestriction([], '', 'ws-1')).toEqual({ kind: 'none' })
    expect(resolveRestriction(at(null), '', 'ws-1')).toEqual({ kind: 'no-ai-access' })
    expect(resolveRestriction(at('grp-full'), '', 'ws-1')).toEqual({
      kind: 'group',
      groupId: 'grp-full'
    })
  })

  it('is honoured by the resolver, whatever the session group says', async () => {
    const src = (await import('node:fs')).readFileSync(
      (await import('node:url')).fileURLToPath(
        new URL('../src/main/services/mcpServer.ts', import.meta.url)
      ),
      'utf8'
    )
    // Checked before the grant is even consulted, in every resolver.
    expect(src.match(/if \(shut\) return NO_AI_ACCESS/g)?.length).toBeGreaterThanOrEqual(3)
  })
})
