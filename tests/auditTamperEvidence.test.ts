import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import {
  recordAudit,
  listAudit,
  verifyAuditLog,
  refreshAuditFloor,
  AUDIT_LOG_PATH
} from '../src/main/services/auditLog'
import { setSecret, MACHINE_ONLY_SECRET_PREFIX } from '../src/main/services/secrets'
import type { AuditEntry } from '../src/shared/mcp'

// The audit log was a plain 0600 JSONL that anything running as the user could
// rewrite or truncate with nothing noticing — for the one file SECURITY.md
// offers as the record of what an AI agent did on somebody's servers.
//
// Rows are hash-chained and the head is pinned outside the file, the way addy's
// device roster is prev_hash-linked with a (pinSeq, pinHead) anti-rollback pin,
// against the same attack: a store answering with a shorter history than it was
// given.
//
// WHAT THIS IS NOT. The pin is in the user's own keychain and an attacker
// running as the user can reach it. What changes is that rewriting history
// stops being "edit a text file" and becomes "edit a text file, recompute a
// chain, and rewrite a keychain entry". Evidence, not proof.

const row = (action: string): Omit<AuditEntry, 'id' | 'timestamp'> => ({
  agentName: 'Claude Code',
  sessionId: 'sess-1',
  workspaceId: 'ws-1',
  workspaceName: 'Personal',
  serverId: 'srv-1',
  serverName: 'k3s-node-01',
  action,
  capability: 'terminal',
  approval: 'not-required',
  result: 'success'
})

const lines = (): string[] => readFileSync(AUDIT_LOG_PATH, 'utf8').split('\n').filter(Boolean)
const rewrite = (ls: string[]): void => writeFileSync(AUDIT_LOG_PATH, ls.length ? `${ls.join('\n')}\n` : '')

beforeEach(() => {
  rmSync(AUDIT_LOG_PATH, { force: true })
  // A fresh chain per test. The head is machine-only, so it survives across
  // tests in one process exactly as it survives across app restarts.
  setSecret(`${MACHINE_ONLY_SECRET_PREFIX}audit-head`, JSON.stringify({ seq: 0, h: '', floorSeq: 1 }))
})

describe('an untouched log', () => {
  it('verifies', () => {
    recordAudit(row('one'))
    recordAudit(row('two'))
    recordAudit(row('three'))
    const v = verifyAuditLog()
    expect(v.state).toBe('ok')
    expect(v).toMatchObject({ rows: 3 })
  })

  it('still reads as ordinary entries, with no chain bookkeeping leaking out', () => {
    recordAudit(row('one'))
    const [entry] = listAudit(5)
    expect(entry.action).toBe('one')
    // `seq` and `h` are the chain's business, not part of what an audit row
    // means. A consumer that started depending on them would make the chain
    // impossible to change.
    expect(entry).not.toHaveProperty('seq')
    expect(entry).not.toHaveProperty('h')
  })
})

describe('a log somebody edited', () => {
  it('notices a changed row', () => {
    recordAudit(row('rm -rf /var/log'))
    recordAudit(row('two'))
    recordAudit(row('three'))

    // The interesting attack: not deleting the row, rewriting what it says.
    const ls = lines()
    ls[0] = ls[0].replace('rm -rf /var/log', 'ls -la')
    rewrite(ls)

    const v = verifyAuditLog()
    expect(v.state).toBe('broken')
  })

  it('notices a row removed from the middle', () => {
    recordAudit(row('one'))
    recordAudit(row('two'))
    recordAudit(row('three'))
    const ls = lines()
    rewrite([ls[0], ls[2]])
    expect(verifyAuditLog().state).toBe('broken')
  })

  it('notices rows removed from the end, which a chain alone would not', () => {
    // A truncated chain is still internally valid — every row still links to
    // the one before it. Only the pinned head says the file used to be longer.
    recordAudit(row('one'))
    recordAudit(row('two'))
    recordAudit(row('the one they want gone'))
    rewrite(lines().slice(0, 2))

    const v = verifyAuditLog()
    expect(v.state).toBe('broken')
    expect(v.state === 'broken' && v.reason).toMatch(/removed or replaced/i)
  })

  it('notices the whole file being replaced with a fresh-looking one', () => {
    recordAudit(row('one'))
    recordAudit(row('two'))
    rmSync(AUDIT_LOG_PATH, { force: true })
    // Start over and hope nobody counts. The pin is at seq 2 and nothing in the
    // new file can be, because recordAudit reads the pin rather than the file.
    rewrite([JSON.stringify({ ...row('innocent'), id: 'x', timestamp: 'now', seq: 1, h: 'made up' })])
    expect(verifyAuditLog().state).toBe('broken')
  })

  it('notices rows removed from the front', () => {
    recordAudit(row('one'))
    recordAudit(row('two'))
    recordAudit(row('three'))
    rewrite(lines().slice(1))
    const v = verifyAuditLog()
    expect(v.state).toBe('broken')
    expect(v.state === 'broken' && v.reason).toMatch(/start of the log/i)
  })
})

describe('the things that must NOT read as tampering', () => {
  it('retention dropping old rows, once it says so', () => {
    recordAudit(row('old'))
    recordAudit(row('newer'))
    recordAudit(row('newest'))

    // Exactly what pruneJsonl does: survivors written out, oldest gone.
    rewrite(lines().slice(1))
    expect(verifyAuditLog().state).toBe('broken') // ...until retention says it was retention
    refreshAuditFloor()
    expect(verifyAuditLog().state).toBe('ok')
  })

  it('a log written before any of this existed', () => {
    // Every install that predates the chain. Reporting these as tampering would
    // make the indicator worthless on the day it shipped.
    rewrite([
      JSON.stringify({ ...row('from before'), id: 'a', timestamp: '2026-01-01T00:00:00.000Z' }),
      JSON.stringify({ ...row('also before'), id: 'b', timestamp: '2026-01-02T00:00:00.000Z' })
    ])
    const v = verifyAuditLog()
    expect(v.state).toBe('unknown')
    expect(v.state === 'unknown' && v.reason).toMatch(/predate/i)
  })

  it('old rows sitting underneath new chained ones', () => {
    // The state every existing install passes through on its next launch.
    rewrite([JSON.stringify({ ...row('from before'), id: 'a', timestamp: '2026-01-01T00:00:00.000Z' })])
    recordAudit(row('after the upgrade'))
    recordAudit(row('and another'))
    const v = verifyAuditLog()
    expect(v.state).toBe('ok')
    // And it is honest about how much of the file it actually vouched for.
    expect(v).toMatchObject({ unverifiable: 1 })
  })

  it('an empty log on a machine that has done nothing', () => {
    expect(existsSync(AUDIT_LOG_PATH)).toBe(false)
    expect(verifyAuditLog().state).toBe('unknown')
  })
})

describe('the append itself', () => {
  it('records the row before it moves the head, so a failed write cannot accuse the user', () => {
    // A head moved first and an append that then refused would leave the pin
    // naming a row that is not in the file — which reads as truncation. The app
    // would be accusing itself of tampering because a disk was full.
    recordAudit(row('one'))
    const before = readFileSync(AUDIT_LOG_PATH, 'utf8')
    expect(verifyAuditLog().state).toBe('ok')
    expect(before).toContain('"seq":1')
  })
})
