import { describe, it, expect } from 'vitest'
import {
  chmodSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import {
  recordAudit,
  listAudit,
  auditAppendFailure,
  AUDIT_LOG_PATH
} from '../src/main/services/auditLog'

describe('audit logging', () => {
  it('records agent, session, workspace, server, action, approval and result', () => {
    recordAudit({
      agentName: 'Claude Code',
      sessionId: 'sess-1',
      workspaceId: 'ws-1',
      workspaceName: 'Production',
      serverId: 'srv-1',
      serverName: 'Nginx Server Prod',
      action: 'systemctl restart nginx',
      capability: 'terminal',
      approval: 'approved',
      result: 'success',
      exitCode: 0
    })
    const entries = listAudit(10)
    const entry = entries.find((e) => e.action === 'systemctl restart nginx')
    expect(entry).toBeTruthy()
    expect(entry?.agentName).toBe('Claude Code')
    expect(entry?.workspaceName).toBe('Production')
    expect(entry?.approval).toBe('approved')
    expect(entry?.result).toBe('success')
    expect(entry?.exitCode).toBe(0)
    expect(entry?.id).toBeTruthy()
    expect(entry?.timestamp).toBeTruthy()
  })

  it('never stores a secret value even if the action text carried one', () => {
    recordAudit({
      agentName: 'Claude Code',
      sessionId: 'sess-1',
      workspaceId: 'ws-1',
      workspaceName: 'Production',
      serverId: 'srv-1',
      serverName: 'DB Prod',
      action: 'echo DB_PASSWORD=hunter2',
      capability: 'terminal',
      approval: 'not-required',
      result: 'success'
    })
    const entries = listAudit(10)
    const entry = entries.find((e) => e.action.includes('DB_PASSWORD'))
    expect(entry?.action).not.toContain('hunter2')
  })

  it('newest entries come first', () => {
    recordAudit({
      agentName: 'A',
      sessionId: 's',
      workspaceId: null,
      workspaceName: null,
      serverId: null,
      serverName: null,
      action: 'first',
      capability: null,
      approval: 'not-required',
      result: 'success'
    })
    recordAudit({
      agentName: 'A',
      sessionId: 's',
      workspaceId: null,
      workspaceName: null,
      serverId: null,
      serverName: null,
      action: 'second',
      capability: null,
      approval: 'not-required',
      result: 'success'
    })
    const entries = listAudit(2)
    expect(entries[0].action).toBe('second')
    expect(entries[1].action).toBe('first')
  })
})

// ===========================================================================
// The file the rows land in
// ===========================================================================
//
// These rows name the workspace, the server and the command an agent ran. Two
// things the old `appendFileSync(FILE, line, { mode: 0o600 })` did not do: fix
// the mode of a file that already existed at something wider, and refuse a
// symlink pre-created at this very predictable path. logAppend.ts carries the
// argument; these are this writer's half of it.
describe.skipIf(process.platform === 'win32')('the log file on disk', () => {
  const row = {
    agentName: 'Claude Code',
    sessionId: 'sess-mode',
    workspaceId: null,
    workspaceName: null,
    serverId: null,
    serverName: null,
    capability: null,
    approval: 'not-required',
    result: 'success'
  } as const

  it('tightens a log that already existed at 0666', () => {
    recordAudit({ ...row, action: 'before' })
    chmodSync(AUDIT_LOG_PATH, 0o666)
    recordAudit({ ...row, action: 'after' })
    expect(statSync(AUDIT_LOG_PATH).mode & 0o777).toBe(0o600)
    expect(listAudit(5).some((e) => e.action === 'after')).toBe(true)
  })

  it('refuses a symlink at the log path without taking the agent call down', () => {
    // The append is the last thing that happens in a tool call that has already
    // run. A throw here would turn a successful command into a failed one.
    const elsewhere = join(dirname(AUDIT_LOG_PATH), 'audit-somewhere-else.jsonl')
    rmSync(AUDIT_LOG_PATH, { force: true })
    writeFileSync(elsewhere, 'not ours\n')
    symlinkSync(elsewhere, AUDIT_LOG_PATH)
    try {
      expect(() => recordAudit({ ...row, action: 'through the link' })).not.toThrow()
      expect(readFileSync(elsewhere, 'utf8')).toBe('not ours\n')
    } finally {
      rmSync(AUDIT_LOG_PATH, { force: true })
      rmSync(elsewhere, { force: true })
    }
  })

  it('says so when appends are failing, rather than only looking quiet', () => {
    // A refused append is right and INVISIBLE. Every caller of appendLogLine,
    // this one included, catches and console.errors — and a packaged Electron app
    // has no console anybody reads. An install whose audit log is symlinked
    // writes zero rows from then on, while listAudit keeps returning the rows
    // from before, so the AI audit view does not look broken: it looks quiet.
    // For the file SECURITY.md offers as the record of what an AI agent did,
    // that is the wrong failure mode, so there is a flag to read.
    const elsewhere = join(dirname(AUDIT_LOG_PATH), 'audit-flag-elsewhere.jsonl')
    rmSync(AUDIT_LOG_PATH, { force: true })
    rmSync(elsewhere, { force: true })
    try {
      // A working append first: the flag is about NOW, not about ever.
      recordAudit({ ...row, action: 'fine' })
      expect(auditAppendFailure()).toBeNull()

      writeFileSync(elsewhere, 'not ours\n')
      rmSync(AUDIT_LOG_PATH, { force: true })
      symlinkSync(elsewhere, AUDIT_LOG_PATH)
      recordAudit({ ...row, action: 'refused' })
      expect(auditAppendFailure()).toMatch(/symlink/)

      // And it clears when the cause is gone, so a UI reading it stops shouting
      // without needing a restart.
      rmSync(AUDIT_LOG_PATH, { force: true })
      recordAudit({ ...row, action: 'fine again' })
      expect(auditAppendFailure()).toBeNull()
      expect(listAudit(5).some((e) => e.action === 'refused')).toBe(false)
    } finally {
      rmSync(AUDIT_LOG_PATH, { force: true })
      rmSync(elsewhere, { force: true })
    }
  })
})
