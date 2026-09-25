import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const queries: { statement: string }[] = []
let queryResult: Record<string, unknown> = { ok: true, columns: ['id'], rows: [[1]], rowCount: 1 }

const tunnelCalls: { id: string; started: boolean }[] = []
let tunnelStartResult: Record<string, unknown> = { ok: true, listenPort: 15432 }

vi.mock('../src/main/services/tunnel', () => ({
  tunnelStart: (_wc: unknown, cfg: { id: string }) => {
    tunnelCalls.push({ id: cfg.id, started: true })
    return Promise.resolve(tunnelStartResult)
  },
  tunnelStop: (id: string) => {
    tunnelCalls.push({ id, started: false })
    return Promise.resolve()
  },
  tunnelList: () => []
}))

vi.mock('../src/main/services/db', () => ({
  dbQuery: (_cfg: unknown, statement: string) => {
    queries.push({ statement })
    return Promise.resolve(queryResult)
  }
}))

const { refreshMcpDataCache } = await import('../src/main/services/mcpDataCache')
const { setAssignment, resetPolicyCacheForTests, saveGroup, getGroup } = await import('../src/main/services/policyStore')
const { setMcpConfig, createSession, resetMcpAuthForTests } = await import('../src/main/services/mcpAuth')
const { startMcpServer, stopMcpServer } = await import('../src/main/services/mcpServer')
const { onApprovalEvent, respondToApproval } = await import('../src/main/services/approvals')
const { listAudit } = await import('../src/main/services/auditLog')

const PORT = 18738

beforeAll(async () => {
  resetPolicyCacheForTests()
  resetMcpAuthForTests()
  refreshMcpDataCache({
    workspaces: [{ id: 'ws', name: 'Prod' }],
    tunnels: [
      { id: 'tn1', workspaceId: 'ws', name: 'DB Forward', kind: 'local', serverId: 's1', listen: '127.0.0.1:15432', target: '10.0.0.5:5432' }
    ],
    servers: [
      { id: 's1', workspaceId: 'ws', name: 'Bastion', host: '10.0.0.1', port: 22, username: 'root', auth: 'key', os: 'Linux', route: [] }
    ],
    databases: [
      { id: 'db1', workspaceId: 'ws', name: 'Orders', kind: 'postgres', host: '10.0.0.5', port: 5432, username: 'app', database: 'orders', ssl: false, uri: false, sshServerId: null }
    ]
  })
  setMcpConfig({ enabled: true, port: PORT, approvalTimeoutSeconds: 5 })
  await startMcpServer()
})
afterAll(async () => await stopMcpServer())
beforeEach(() => {
  queries.length = 0
  tunnelCalls.length = 0
  tunnelStartResult = { ok: true, listenPort: 15432 }
  queryResult = { ok: true, columns: ['id'], rows: [[1]], rowCount: 1 }
})

// Full Access's capabilities with Confirm risky actions ON. The seeded Full
// Access ships with the switch off, so on it a write or a tunnel start is the
// literal allow; this is the group on which they still ask.
const CONFIRMING = 'grp-confirming'
const useConfirming = (): void => {
  saveGroup({ ...getGroup('grp-full')!, id: CONFIRMING, name: 'Full, confirming', builtIn: false, confirmRisky: true })
  setAssignment({ level: 'workspace', workspaceId: 'ws' }, 'grp-full')
}

async function clientFor(groupId: string, mode?: 'bypass'): Promise<Client> {
  const { token } = createSession({
    agentName: 'DB Test',
    workspaces: [{ id: 'ws', name: 'Prod' }],
    groupId,
    groupName: groupId,
    ttlMinutes: null,
    mode
  })
  const t = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } }
  })
  const c = new Client({ name: 'db-test', version: '1.0.0' })
  await c.connect(t)
  return c
}

async function call(c: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const r = (await c.callTool({ name, arguments: args })) as { content: { text: string }[] }
  return r.content.map((x) => x.text).join('\n')
}

const autoApprove = (): (() => void) =>
  onApprovalEvent((e) => e.type === 'created' && respondToApproval(e.request.id, 'approved'))

describe('database tools', () => {
  it('lists databases by friendly name without leaking connection details', async () => {
    setAssignment({ level: 'workspace', workspaceId: 'ws' }, 'grp-read-only')
    const c = await clientFor('grp-read-only')
    try {
      const out = await call(c, 'list_databases', {})
      expect(out).toContain('Orders')
      expect(out).toContain('postgres')
      // The host is exactly what an agent must never see.
      expect(out).not.toContain('10.0.0.5')
    } finally {
      await c.close()
    }
  })

  it('runs a read under Read Only', async () => {
    setAssignment({ level: 'workspace', workspaceId: 'ws' }, 'grp-read-only')
    const c = await clientFor('grp-read-only')
    try {
      expect(await call(c, 'query_database', { databaseName: 'Orders', statement: 'SELECT 1' })).toContain('id')
      expect(queries).toHaveLength(1)
    } finally {
      await c.close()
    }
  })

  it('refuses a write under Read Only, which cannot change anything', async () => {
    setAssignment({ level: 'workspace', workspaceId: 'ws' }, 'grp-read-only')
    const c = await clientFor('grp-read-only')
    try {
      expect(await call(c, 'query_database', { databaseName: 'Orders', statement: 'DELETE FROM orders' })).toContain('Denied')
      expect(queries).toHaveLength(0)
    } finally {
      await c.close()
    }
  })

  it('never lets a DROP through silently while Confirm risky actions is on', async () => {
    // databaseAccess and writeFiles are both ALLOW there, so without the
    // clamp this would run with no prompt at all.
    useConfirming()
    const stop = autoApprove()
    const c = await clientFor(CONFIRMING)
    try {
      await call(c, 'query_database', { databaseName: 'Orders', statement: 'DROP TABLE orders' })
      const approvals = listAudit().filter((a) => a.action === 'DROP TABLE orders')
      expect(approvals.some((a) => a.approval === 'approved')).toBe(true)
    } finally {
      stop()
      await c.close()
    }
  })

  it('runs a DROP on Full Access, whose switch is off, without asking', async () => {
    setAssignment({ level: 'workspace', workspaceId: 'ws' }, 'grp-full')
    let asked = 0
    const off = onApprovalEvent((e) => {
      if (e.type === 'created') asked += 1
    })
    const c = await clientFor('grp-full')
    try {
      await call(c, 'query_database', { databaseName: 'Orders', statement: 'DROP TABLE literal' })
      expect(asked).toBe(0)
      expect(queries).toEqual([{ statement: 'DROP TABLE literal' }])
      expect(listAudit().find((a) => a.action === 'DROP TABLE literal')?.approval).toBe('not-required')
    } finally {
      off()
      await c.close()
    }
  })

  it('runs a DROP in a Bypass session on a group that asks, audited as bypassed', async () => {
    useConfirming()
    let asked = 0
    const off = onApprovalEvent((e) => {
      if (e.type === 'created') asked += 1
    })
    const c = await clientFor(CONFIRMING, 'bypass')
    try {
      await call(c, 'query_database', { databaseName: 'Orders', statement: 'DROP TABLE bypassed' })
      expect(asked).toBe(0)
      expect(queries).toEqual([{ statement: 'DROP TABLE bypassed' }])
      const row = listAudit().find((a) => a.action === 'DROP TABLE bypassed')
      expect(row?.approval).toBe('bypassed')
      expect(row?.mode).toBe('bypass')
    } finally {
      off()
      await c.close()
    }
  })

  it('rejects a database outside the session, by name', async () => {
    setAssignment({ level: 'workspace', workspaceId: 'ws' }, 'grp-full')
    const c = await clientFor('grp-full')
    try {
      expect(await call(c, 'query_database', { databaseName: 'Nope', statement: 'SELECT 1' })).toContain('No database named')
      expect(queries).toHaveLength(0)
    } finally {
      await c.close()
    }
  })

  it('reports a driver error rather than claiming success', async () => {
    setAssignment({ level: 'workspace', workspaceId: 'ws' }, 'grp-read-only')
    queryResult = { ok: false, error: 'relation "orders" does not exist' }
    const c = await clientFor('grp-read-only')
    try {
      expect(await call(c, 'query_database', { databaseName: 'Orders', statement: 'SELECT 1' })).toContain('does not exist')
    } finally {
      await c.close()
    }
  })

  it('caps a huge result instead of returning all of it', async () => {
    setAssignment({ level: 'workspace', workspaceId: 'ws' }, 'grp-read-only')
    queryResult = {
      ok: true,
      columns: ['n'],
      rows: Array.from({ length: 500 }, (_, i) => [i]),
      rowCount: 500
    }
    const c = await clientFor('grp-read-only')
    try {
      const out = await call(c, 'query_database', { databaseName: 'Orders', statement: 'SELECT n FROM big' })
      expect(out).toContain('more rows not shown')
    } finally {
      await c.close()
    }
  })
})

describe('tunnel tools', () => {
  it('lists tunnels by name with where they point', async () => {
    setAssignment({ level: 'workspace', workspaceId: 'ws' }, 'grp-full')
    const c = await clientFor('grp-full')
    try {
      const out = await call(c, 'list_tunnels', {})
      expect(out).toContain('DB Forward')
      expect(out).toContain('local')
    } finally {
      await c.close()
    }
  })

  it('refuses to start one under Read Only, which denies sshTunnel', async () => {
    setAssignment({ level: 'workspace', workspaceId: 'ws' }, 'grp-read-only')
    const c = await clientFor('grp-read-only')
    try {
      expect(await call(c, 'set_tunnel', { tunnelName: 'DB Forward', running: true })).toContain('Denied')
      expect(tunnelCalls).toHaveLength(0)
    } finally {
      await c.close()
    }
  })

  it('asks before binding a port while Confirm risky actions is on', async () => {
    // Opening a listener on the user's own machine is not silent on such a group.
    useConfirming()
    const stop = autoApprove()
    const c = await clientFor(CONFIRMING)
    try {
      const out = await call(c, 'set_tunnel', { tunnelName: 'DB Forward', running: true })
      expect(out).toContain('Started')
      const entry = listAudit().find((a) => a.action.startsWith('Start tunnel'))
      expect(entry?.approval).toBe('approved')
    } finally {
      stop()
      await c.close()
    }
  })

  it('binds without asking on Full Access, whose switch is off', async () => {
    setAssignment({ level: 'workspace', workspaceId: 'ws' }, 'grp-full')
    let asked = 0
    const off = onApprovalEvent((e) => {
      if (e.type === 'created') asked += 1
    })
    const c = await clientFor('grp-full')
    try {
      expect(await call(c, 'set_tunnel', { tunnelName: 'DB Forward', running: true })).toContain('Started')
      expect(asked).toBe(0)
      expect(tunnelCalls).toEqual([{ id: 'tn1', started: true }])
    } finally {
      off()
      await c.close()
    }
  })

  it('stops one without demanding approval, which is the safe direction', async () => {
    setAssignment({ level: 'workspace', workspaceId: 'ws' }, 'grp-full')
    const c = await clientFor('grp-full')
    try {
      expect(await call(c, 'set_tunnel', { tunnelName: 'DB Forward', running: false })).toContain('Stopped')
      expect(tunnelCalls).toEqual([{ id: 'tn1', started: false }])
    } finally {
      await c.close()
    }
  })

  it('cannot invent a tunnel, only run one the user defined', async () => {
    setAssignment({ level: 'workspace', workspaceId: 'ws' }, 'grp-full')
    const c = await clientFor('grp-full')
    try {
      expect(await call(c, 'set_tunnel', { tunnelName: 'Made Up', running: true })).toContain('No tunnel named')
      expect(tunnelCalls).toHaveLength(0)
    } finally {
      await c.close()
    }
  })

  it('reports a failure to start rather than claiming success', async () => {
    setAssignment({ level: 'workspace', workspaceId: 'ws' }, 'grp-full')
    tunnelStartResult = { ok: false, error: 'address already in use' }
    const stop = autoApprove()
    const c = await clientFor('grp-full')
    try {
      expect(await call(c, 'set_tunnel', { tunnelName: 'DB Forward', running: true })).toContain('already in use')
    } finally {
      stop()
      await c.close()
    }
  })
})

// A session grant is an answer to one question, and "always asks" has to stay
// true after the operator has said "for this session" to something nearby.
// Each of these carried silently before starts, writes and non-reads became
// per-call.
describe('what a session grant cannot buy', () => {
  // Full Access with the two capabilities under test lowered to ASK, so a read
  // and a stop reach a human at all -- on the seeded groups neither asks.
  const ASKS = 'grp-db-tunnel-ask'
  const useAskGroup = (): void => {
    const full = getGroup('grp-full')!
    saveGroup({
      ...full,
      id: ASKS,
      name: 'DB and tunnels ask',
      builtIn: false,
      capabilities: { ...full.capabilities, databaseAccess: 'ask', sshTunnel: 'ask' }
    })
    setAssignment({ level: 'workspace', workspaceId: 'ws' }, ASKS)
  }

  function answerForSession(): { stop: () => void; asked: () => number } {
    let asked = 0
    const off = onApprovalEvent((e) => {
      if (e.type === 'created') {
        asked += 1
        respondToApproval(e.request.id, 'approved', 'session')
      }
    })
    return { stop: off, asked: () => asked }
  }

  it('a session grant on a SELECT does not cover a DROP TABLE', async () => {
    useAskGroup()
    const a = answerForSession()
    const c = await clientFor(ASKS)
    try {
      await call(c, 'query_database', { databaseName: 'Orders', statement: 'SELECT 1' })
      await call(c, 'query_database', { databaseName: 'Orders', statement: 'SELECT 2' })
      // Reads may be granted for the session...
      expect(a.asked()).toBe(1)
      await call(c, 'query_database', { databaseName: 'Orders', statement: 'DROP TABLE carried' })
      // ...a write is asked for regardless.
      expect(a.asked()).toBe(2)
      const row = listAudit().find((e) => e.action === 'DROP TABLE carried')
      expect(row?.approval).toBe('approved')
    } finally {
      a.stop()
      await c.close()
    }
  })

  it('a write answered for the session still asks for the next write', async () => {
    useAskGroup()
    const a = answerForSession()
    const c = await clientFor(ASKS)
    try {
      await call(c, 'query_database', { databaseName: 'Orders', statement: 'DELETE FROM a' })
      await call(c, 'query_database', { databaseName: 'Orders', statement: 'DELETE FROM b' })
      expect(a.asked()).toBe(2)
    } finally {
      a.stop()
      await c.close()
    }
  })

  it('a session grant on one tunnel start does not cover the next start', async () => {
    useConfirming()
    const a = answerForSession()
    const c = await clientFor(CONFIRMING)
    try {
      await call(c, 'set_tunnel', { tunnelName: 'DB Forward', running: true })
      await call(c, 'set_tunnel', { tunnelName: 'DB Forward', running: true })
      expect(a.asked()).toBe(2)
    } finally {
      a.stop()
      await c.close()
    }
  })

  it('a session grant on a tunnel stop does not cover a start', async () => {
    useAskGroup()
    const a = answerForSession()
    const c = await clientFor(ASKS)
    try {
      await call(c, 'set_tunnel', { tunnelName: 'DB Forward', running: false })
      expect(a.asked()).toBe(1)
      await call(c, 'set_tunnel', { tunnelName: 'DB Forward', running: true })
      expect(a.asked()).toBe(2)
      expect(tunnelCalls).toEqual([
        { id: 'tn1', started: false },
        { id: 'tn1', started: true }
      ])
    } finally {
      a.stop()
      await c.close()
    }
  })
})
