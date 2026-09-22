import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

// EVERY GATED CALL LEAVES EXACTLY ONE AUDIT ROW -- and a policy refusal reads
// as one.
//
// Both found by driving the real app over MCP. One read_file whose SFTP
// connection failed left no row at all: four rows for five calls, and the
// missing one was the call that went wrong. And a refusal by the policy itself
// -- a terminal the group denies, the /etc/shadow rule, a server on No AI
// Access -- was labelled "Allowed, then blocked: the access group allowed this
// outright", the opposite of what happened.
//
// So this counts rows against calls for every file and terminal tool, across
// the three ways a call can end after the gate is reached: it runs, the policy
// refuses it, or the connection behind it fails. And it reads the refusal rows
// back through the same labelling the Audit screen uses.

let sshOk = true
let sftpOk = true

vi.mock('../src/main/services/ssh', () => ({
  sshExec: () =>
    Promise.resolve(
      sshOk ? { ok: true, stdout: 'ok', stderr: '', code: 0 } : { ok: false, error: 'connect ECONNREFUSED' }
    ),
  sshTest: () => Promise.resolve({ ok: true })
}))

vi.mock('../src/main/services/sftp', () => ({
  sftpConnect: () => Promise.resolve(sftpOk ? { ok: true, data: { home: '/root' } } : { ok: false, error: 'connect ECONNREFUSED' }),
  sftpRead: () => Promise.resolve({ ok: true, data: 'contents' }),
  sftpWrite: () => Promise.resolve({ ok: true }),
  sftpList: () => Promise.resolve({ ok: true, data: [] }),
  sftpDisconnect: () => undefined
}))

const { refreshMcpDataCache } = await import('../src/main/services/mcpDataCache')
const { setAssignment, saveGroup, getGroup, resetPolicyCacheForTests } = await import('../src/main/services/policyStore')
const { setMcpConfig, createSession, resetMcpAuthForTests } = await import('../src/main/services/mcpAuth')
const { startMcpServer, stopMcpServer } = await import('../src/main/services/mcpServer')
const { listAudit } = await import('../src/main/services/auditLog')
const { onApprovalEvent, respondToApproval, resetApprovalVolumeForTests } = await import('../src/main/services/approvals')
const { auditOutcome } = await import('../src/renderer/src/components/ai/auditOutcome')

const PORT = 18877

// Box is open, NoTerm's own group denies the terminal, and Locked is on No AI
// Access. Every one of them is in the session's workspace.
const sampleData = {
  workspaces: [{ id: 'ws', name: 'Personal' }],
  servers: [
    { id: 's1', workspaceId: 'ws', name: 'Box', host: '10.0.0.1', port: 22, username: 'root', auth: 'key', os: 'Linux', route: [] },
    { id: 's2', workspaceId: 'ws', name: 'NoTerm', host: '10.0.0.2', port: 22, username: 'root', auth: 'key', os: 'Linux', route: [] },
    { id: 's3', workspaceId: 'ws', name: 'Locked', host: '10.0.0.3', port: 22, username: 'root', auth: 'key', os: 'Linux', route: [] }
  ]
}

const OPEN = 'grp-audit-open'
const NO_TERMINAL = 'grp-audit-noterm'

beforeAll(async () => {
  resetPolicyCacheForTests()
  resetMcpAuthForTests()
  refreshMcpDataCache(sampleData)
  const full = getGroup('grp-full')!
  // Everything this file exercises is ALLOW, so no call waits on a human: the
  // point here is what happens after the gate, not the gate's question.
  const allowAll = {
    ...full.capabilities,
    terminal: 'allow' as const,
    sudo: 'allow' as const,
    readFiles: 'allow' as const,
    writeFiles: 'allow' as const,
    sftpDownload: 'allow' as const,
    sftpUpload: 'allow' as const
  }
  const shadow = { id: 'shadow', pattern: '/etc/shadow', read: 'deny' as const, write: 'deny' as const }
  saveGroup({ ...full, id: OPEN, name: 'Audit Open', builtIn: false, capabilities: allowAll, filePolicies: [shadow] })
  saveGroup({
    ...full,
    id: NO_TERMINAL,
    name: 'Audit No Terminal',
    builtIn: false,
    capabilities: { ...allowAll, terminal: 'deny' },
    filePolicies: [shadow]
  })
  setAssignment({ level: 'workspace', workspaceId: 'ws' }, OPEN)
  setAssignment({ level: 'server', serverId: 's2' }, NO_TERMINAL)
  setAssignment({ level: 'server', serverId: 's3' }, null)
  setMcpConfig({ enabled: true, port: PORT, approvalTimeoutSeconds: 5 })
  await startMcpServer()
})

afterAll(async () => await stopMcpServer())

beforeEach(() => {
  sshOk = true
  sftpOk = true
  resetApprovalVolumeForTests()
})

/** Re-save the open group with some capabilities changed, for one test. */
function withOpen(changes: Record<string, 'allow' | 'ask' | 'deny'>): () => void {
  const before = getGroup(OPEN)!
  saveGroup({ ...before, capabilities: { ...before.capabilities, ...changes } })
  return () => saveGroup(before)
}

async function session(): Promise<{ c: Client; id: string }> {
  const { token, session: s } = createSession({
    agentName: 'Audit Rows',
    workspaces: [{ id: 'ws', name: 'Personal' }],
    groupId: OPEN,
    groupName: 'Audit Open',
    ttlMinutes: null
  })
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } }
  })
  const c = new Client({ name: 'audit-rows', version: '1.0.0' })
  await c.connect(transport)
  return { c, id: s.id }
}

async function call(c: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const r = (await c.callTool({ name, arguments: args })) as { content: { text: string }[] }
  return r.content.map((x) => x.text).join('\n')
}

const rowsFor = (sessionId: string): ReturnType<typeof listAudit> =>
  listAudit().filter((e) => e.sessionId === sessionId)

type Case = { tool: string; args: Record<string, unknown>; connect: () => void }

const TOOLS: Case[] = [
  { tool: 'execute_command', args: { serverName: 'Box', command: 'uptime' }, connect: () => (sshOk = false) },
  { tool: 'read_file', args: { serverName: 'Box', path: '/tmp/x' }, connect: () => (sftpOk = false) },
  { tool: 'write_file', args: { serverName: 'Box', path: '/tmp/x', content: 'hi' }, connect: () => (sftpOk = false) },
  { tool: 'list_files', args: { serverName: 'Box', path: '/tmp' }, connect: () => (sftpOk = false) }
]

describe('one audit row per gated call', () => {
  it.each(TOOLS)('$tool: success, policy refusal and a failed connection leave one row each', async ({ tool, args, connect }) => {
    const { c, id } = await session()
    try {
      await call(c, tool, args)
      expect(rowsFor(id)).toHaveLength(1)
      expect(rowsFor(id)[0].result).toBe('success')

      // Refused by the policy: the Locked server is on No AI Access.
      await call(c, tool, { ...args, serverName: 'Locked' })
      expect(rowsFor(id)).toHaveLength(2)
      expect(rowsFor(id)[0].result).toBe('denied')

      // Past the gate, and the connection behind it fails.
      connect()
      const out = await call(c, tool, args)
      expect(out).toMatch(/Could not connect|Command failed/)
      expect(rowsFor(id)).toHaveLength(3)
      expect(rowsFor(id)[0].result).toBe('error')
      expect(rowsFor(id)[0].approval).toBe('not-required')
    } finally {
      await c.close()
    }
  })
})

describe('a refusal by the policy reads as one', () => {
  it.each([
    ['the terminal is denied by the server’s group', 'execute_command', { serverName: 'NoTerm', command: 'uptime' }],
    ['the /etc/shadow rule', 'read_file', { serverName: 'Box', path: '/etc/shadow' }],
    ['the /etc/shadow rule, from the terminal', 'execute_command', { serverName: 'Box', command: 'cat /etc/shadow' }],
    ['the server is on No AI Access', 'read_file', { serverName: 'Locked', path: '/tmp/x' }]
  ])('when %s', async (_why, tool, args) => {
    const { c, id } = await session()
    try {
      expect(await call(c, tool as string, args as Record<string, unknown>)).toMatch(/Denied/)
      const rows = rowsFor(id)
      expect(rows).toHaveLength(1)
      const outcome = auditOutcome(rows[0])
      expect(outcome.label).toBe('Blocked by policy')
      expect(outcome.decidedBy).toBe('policy')
      expect(outcome.label).not.toMatch(/Allowed/)
      expect(outcome.detail).not.toMatch(/allowed this outright/)
      // The rule that refused it is named, not paraphrased.
      expect(outcome.detail).toContain(rows[0].error)
    } finally {
      await c.close()
    }
  })
})

// An `ask` on a call that names no server -- the fleet-wide reads pass
// serverId null -- used to be refused with no row at all.
describe('an ask with no server to name', () => {
  it('is refused with one row that reads as the policy\u2019s answer', async () => {
    const restore = withOpen({ fleetRead: 'ask' })
    const { c, id } = await session()
    try {
      expect(await call(c, 'fleet_inventory', {})).toMatch(/Denied/)
      const rows = rowsFor(id)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ approval: 'not-required', result: 'denied', serverId: null })
      expect(auditOutcome(rows[0]).label).toBe('Blocked by policy')
    } finally {
      restore()
      await c.close()
    }
  })
})

// `refused` -- the deny cooldown or a full queue -- is OpsMaxx declining to
// ask. It used to be written as `denied` and read "You refused this request".
describe('a request OpsMaxx declined to ask', () => {
  it('is recorded as not asked, never as the operator\u2019s refusal', async () => {
    const restore = withOpen({ terminal: 'ask' })
    const off = onApprovalEvent((e) => {
      if (e.type === 'created') respondToApproval(e.request.id, 'denied')
    })
    const { c, id } = await session()
    try {
      // Denied by the operator, which starts the cooldown on this subject...
      await call(c, 'execute_command', { serverName: 'Box', command: 'uptime' })
      // ...so the same call straight after is refused without a prompt.
      expect(await call(c, 'execute_command', { serverName: 'Box', command: 'uptime' })).toMatch(/did not ask/)
      const [refused, denied] = rowsFor(id)
      expect(denied.approval).toBe('denied')
      expect(auditOutcome(denied).label).toBe('Denied')
      expect(refused).toMatchObject({ approval: 'not-asked', result: 'denied' })
      const outcome = auditOutcome(refused)
      expect(outcome.label).toBe('Denied — not asked')
      expect(outcome.detail).not.toMatch(/You refused/)
      expect(outcome.detail).toMatch(/did not ask/)
    } finally {
      off()
      restore()
      await c.close()
    }
  })
})
