import { describe, it, expect, beforeAll } from 'vitest'

import { evaluateCommand } from '../src/main/services/policyEngine'
import { listGroups, resetPolicyCacheForTests } from '../src/main/services/policyStore'
import type { AccessGroup } from '../src/shared/mcp'

// The dangerous form is never granted silently while the group's Confirm risky
// actions switch is on -- which it is on every group but Full Access, and on
// any group saved before the switch existed.
//
// That rule was written for `DROP TABLE` and never applied to the terminal.
// `terminal` is `allow` in all four built-in groups, so an agent on ANY of
// them could run `docker volume rm`, `rm -rf` or `systemctl stop postgresql`
// with no approval card -- and grading those `high` in mcpServer.ts changed
// nothing on its own, because a decision of `allow` never opens a card for a
// grade to appear on. These tests pin the decision, not the grade.

const DESTRUCTIVE = [
  'docker volume rm app_data',
  'podman system prune -f',
  'rm -rf /var/lib/postgresql',
  'systemctl stop postgresql',
  'mkfs.ext4 /dev/sdb1',
  'find /srv -name "*.log" -delete',
  'iptables -F',
  'kill -9 4242'
]

// Full Access's capabilities with the switch on: terminal allow, sudo ask.
let full: AccessGroup
let unswitched: AccessGroup
let literal: AccessGroup
let sudoAllowed: AccessGroup

beforeAll(() => {
  resetPolicyCacheForTests()
  literal = listGroups().find((g) => g.id === 'grp-full')!
  full = { ...literal, confirmRisky: true }
  unswitched = { ...literal }
  delete unswitched.confirmRisky
  sudoAllowed = { ...full, capabilities: { ...full.capabilities, sudo: 'allow' } }
})

describe('a destructive command is not allowed silently while Confirm risky actions is on', () => {
  it('stops the commands that reached a Full Access agent with no approval at all', () => {
    for (const c of DESTRUCTIVE) {
      expect(evaluateCommand(full, c).decision, c).toBe('ask')
      expect(evaluateCommand(unswitched, c).decision, `${c} (switch absent)`).toBe('ask')
    }
  })

  it('gives the literal allow on a group with the switch off, such as the seeded Full Access', () => {
    expect(literal.confirmRisky).toBe(false)
    for (const c of DESTRUCTIVE) expect(evaluateCommand(literal, c).decision, c).toBe('allow')
  })

  it('says which finding stopped it, not just that something did', () => {
    const d = evaluateCommand(full, 'docker volume rm app_data')
    expect(d.reason).toContain('removes containers, images or volumes')
  })

  it('leaves an ordinary command alone, or the gate is a prompt on everything', () => {
    for (const c of ['ls -la /var/log', 'docker ps', 'df -h', 'systemctl status nginx', 'cat /etc/os-release']) {
      expect(evaluateCommand(full, c).decision, c).toBe('allow')
    }
  })

  // Full Access keeps sudo at ASK by default and the operator may raise it.
  // Re-asking on the strength of the word `sudo` would overrule a decision a
  // human already made, so a command whose ONLY finding is "runs as root" is
  // left to the sudo capability.
  it('does not overrule an operator who deliberately allowed sudo', () => {
    expect(evaluateCommand(sudoAllowed, 'sudo systemctl status nginx').decision).toBe('allow')
    expect(evaluateCommand(sudoAllowed, 'sudo -n tail -f /var/log/syslog').decision).toBe('allow')
  })

  it('still stops a destructive command that happens to be run with that sudo', () => {
    // The finding here is the rm, not the sudo, so the exemption does not reach it.
    expect(evaluateCommand(sudoAllowed, 'sudo rm -rf /var/lib/postgresql').decision).toBe('ask')
    expect(evaluateCommand(sudoAllowed, 'sudo docker volume rm app_data').decision).toBe('ask')
  })
})
