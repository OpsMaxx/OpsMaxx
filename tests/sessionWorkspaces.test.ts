import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  authenticate,
  createSession,
  getSession,
  revokeSession,
  setMcpConfig,
  setSessionWorkspaces,
  resetMcpAuthForTests
} from '../src/main/services/mcpAuth'

// Which workspaces a live session reaches, changed by the person after the
// session exists. Adding one is a grant, so the stored list comes from the
// app's own saved workspaces and never from the caller, and no agent path may
// reach the setter at all.

const KNOWN = [
  { id: 'ws-1', name: 'Production' },
  { id: 'ws-2', name: 'Staging' }
]

function makeSession(ttlMinutes: number | null = 60) {
  return createSession({
    agentName: 'Claude Code',
    workspaces: [{ id: 'ws-1', name: 'Production' }],
    groupId: 'grp-read-only',
    groupName: 'Read Only',
    ttlMinutes
  })
}

describe('setSessionWorkspaces', () => {
  beforeEach(() => resetMcpAuthForTests())

  it('grants a known workspace, with the saved name rather than the one sent', () => {
    const { session } = makeSession()
    const updated = setSessionWorkspaces(session.id, ['ws-1', 'ws-2'], KNOWN)
    expect(updated?.workspaces).toEqual(KNOWN)
    expect(getSession(session.id)?.workspaces).toEqual(KNOWN)
  })

  it('drops unknown ids and duplicates, and anything that is not a string', () => {
    const { session } = makeSession()
    const updated = setSessionWorkspaces(session.id, ['ws-2', 'ws-ghost', 'ws-2', 7, null], KNOWN)
    expect(updated?.workspaces).toEqual([{ id: 'ws-2', name: 'Staging' }])
  })

  it('refuses to leave a session with no workspace', () => {
    const { session } = makeSession()
    expect(setSessionWorkspaces(session.id, [], KNOWN)).toBeNull()
    // Only unknown ids is the same thing.
    expect(setSessionWorkspaces(session.id, ['ws-ghost'], KNOWN)).toBeNull()
    expect(setSessionWorkspaces(session.id, 'ws-2', KNOWN)).toBeNull()
    expect(getSession(session.id)?.workspaces).toEqual([{ id: 'ws-1', name: 'Production' }])
  })

  it('refuses a revoked, an expired or an unknown session', () => {
    const { session } = makeSession()
    revokeSession(session.id)
    expect(setSessionWorkspaces(session.id, ['ws-2'], KNOWN)).toBeNull()

    const expired = makeSession(1).session
    getSession(expired.id)!.expiresAt = new Date(Date.now() - 1000).toISOString()
    expect(setSessionWorkspaces(expired.id, ['ws-2'], KNOWN)).toBeNull()

    expect(setSessionWorkspaces('sess-nope', ['ws-2'], KNOWN)).toBeNull()
  })

  it('will not add a locked workspace, but lets one the session has stay', () => {
    const { session } = makeSession()
    expect(setSessionWorkspaces(session.id, ['ws-1', 'ws-2'], KNOWN, ['ws-2'])).toBeNull()
    expect(setSessionWorkspaces(session.id, ['ws-1', 'ws-2'], KNOWN, ['ws-1'])?.workspaces).toEqual(KNOWN)
  })

  it('refuses two workspaces an agent could not tell apart by name', () => {
    const { session } = makeSession()
    const known = [...KNOWN, { id: 'ws-3', name: 'ＰＲＯＤＵＣＴＩＯＮ' }]
    expect(setSessionWorkspaces(session.id, ['ws-1', 'ws-3'], known)).toBeNull()
    expect(getSession(session.id)?.workspaces).toEqual([{ id: 'ws-1', name: 'Production' }])
  })

  it('reaches a connected client on its next request, without a reconnect', () => {
    // Every MCP request authenticates afresh and reads the record found here.
    setMcpConfig({ enabled: true })
    const { session, token } = makeSession()
    setSessionWorkspaces(session.id, ['ws-2'], KNOWN)
    const auth = authenticate(token)
    expect('session' in auth && auth.session.workspaces).toEqual([{ id: 'ws-2', name: 'Staging' }])
  })
})

describe('only the person can change a session’s workspaces', () => {
  const src = (p: string): string => readFileSync(p, 'utf8')

  it('is wired over IPC, checked against the saved workspace list', () => {
    const handler = src('src/main/index.ts').match(/ipcMain\.handle\('aiMcp:setSessionWorkspaces',[\s\S]*?\n\}\)/)?.[0] ?? ''
    expect(handler).toContain('setSessionWorkspaces(id, workspaceIds, listCachedWorkspaces(), locked)')
    // Locked means protected and not unlocked since launch.
    expect(handler).toMatch(/wsLockIds\(\)\.filter\(\(w\) => !wsUnlockedThisRun\.has\(w\)\)/)
    // A removal drops the session's standing approvals, or a re-tick revives them.
    expect(handler).toContain('clearSessionElevations(id)')
    expect(src('src/preload/index.ts')).toContain("ipcRenderer.invoke('aiMcp:setSessionWorkspaces', id, workspaceIds)")
  })

  it('is never referenced by the MCP server', () => {
    const server = src('src/main/services/mcpServer.ts')
    expect(server).not.toMatch(/\bsetSessionWorkspaces\b/)
    expect(server).not.toMatch(/aiMcp:setSessionWorkspaces/)
  })
})
