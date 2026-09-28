import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

// Databases were the one saved connection an agent could query but not define:
// servers had add/update/remove/test, and a database meant stopping to ask a
// person to type it into a dialog. These pin the four tools that close that,
// and the lines they must hold -- a connection string never lands in the audit
// log or the record, manageServers governs the list the way it governs servers,
// and a Protected bastion caps the database it carries.

let testResult: Record<string, unknown> = { ok: true }
vi.mock('../src/main/services/db', () => ({
  dbQuery: () => Promise.resolve({ ok: true, rows: [] }),
  dbTest: () => Promise.resolve(testResult)
}))

const { refreshMcpDataCache } = await import('../src/main/services/mcpDataCache')
const { setAssignment, resetPolicyCacheForTests, saveGroup, getGroup, setProtected } = await import(
  '../src/main/services/policyStore'
)
const { setMcpConfig, createSession, resetMcpAuthForTests } = await import('../src/main/services/mcpAuth')
const { startMcpServer, stopMcpServer } = await import('../src/main/services/mcpServer')
const { onApprovalEvent, respondToApproval } = await import('../src/main/services/approvals')
const { listAudit } = await import('../src/main/services/auditLog')
const { setAgentConfigWriter } = await import('../src/main/services/agentConfigWrite')
type AgentConfigRequest = import('../src/main/services/agentConfigWrite').AgentConfigRequest

const PORT = 18772
const URI = 'postgresql://app:s3cret-in-uri@db.internal:5432/orders'

const sampleData = {
  workspaces: [
    { id: 'ws', name: 'Prod' },
    { id: 'ws2', name: 'Lab' }
  ],
  servers: [
    { id: 's1', workspaceId: 'ws', name: 'Bastion', host: '10.0.0.1', port: 22, username: 'root', auth: 'key', os: 'Linux', route: [] },
    { id: 's2', workspaceId: 'ws2', name: 'Lab box', host: '10.9.0.1', port: 22, username: 'root', auth: 'key', os: 'Linux', route: [] }
  ],
  databases: [
    { id: 'db1', workspaceId: 'ws', name: 'Orders', kind: 'postgres', host: '10.0.0.5', port: 5432, username: 'app', database: 'orders', ssl: false, uri: false, sshServerId: 's1' },
    { id: 'db2', workspaceId: 'ws2', name: 'Scratch', kind: 'redis', host: '10.9.0.5', port: 6379, username: '', database: '', ssl: false, uri: false, sshServerId: null }
  ]
}

let written: AgentConfigRequest[] = []

beforeAll(async () => {
  resetPolicyCacheForTests()
  resetMcpAuthForTests()
  refreshMcpDataCache(sampleData)
  setMcpConfig({ enabled: true, port: PORT, approvalTimeoutSeconds: 5 })
  setAgentConfigWriter((req) => {
    written.push(req)
    return Promise.resolve({ ok: true, id: 'db-new' })
  })
  await startMcpServer()
})

afterAll(async () => await stopMcpServer())

beforeEach(() => {
  written = []
  testResult = { ok: true }
  setAssignment({ level: 'workspace', workspaceId: 'ws' }, 'grp-full')
  setAssignment({ level: 'workspace', workspaceId: 'ws2' }, 'grp-full')
  setProtected({ level: 'server', serverId: 's1' }, false)
})

async function clientFor(groupId: string, workspaces = [{ id: 'ws', name: 'Prod' }]): Promise<Client> {
  const { token } = createSession({ agentName: 'DB Write Test', workspaces, groupId, groupName: groupId, ttlMinutes: null })
  const t = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } }
  })
  const c = new Client({ name: 'db-write-test', version: '1.0.0' })
  await c.connect(t)
  return c
}

async function call(c: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const r = (await c.callTool({ name, arguments: args })) as { content: { text: string }[] }
  return r.content.map((x) => x.text).join('\n')
}

function watch(decision: 'approved' | 'denied'): { stop: () => void; count: () => number } {
  let seen = 0
  const off = onApprovalEvent((e) => {
    if (e.type === 'created') {
      seen += 1
      respondToApproval(e.request.id, decision)
    }
  })
  return { stop: off, count: () => seen }
}

describe('add_database', () => {
  it('saves a host/port connection through the bastion and hands the password over as a secret', async () => {
    const c = await clientFor('grp-full')
    try {
      const out = await call(c, 'add_database', {
        name: 'Billing',
        kind: 'mysql',
        host: '10.0.0.7',
        username: 'billing',
        password: 'pw',
        sshServer: 'Bastion'
      })
      expect(out).toContain('Added "Billing"')
      const req = written[0] as Extract<AgentConfigRequest, { kind: 'database.add' }>
      expect(req.workspaceId).toBe('ws')
      expect(req.fields).toMatchObject({ kind: 'mysql', port: 3306, sshServerId: 's1', uri: false })
      expect(req.secret).toEqual({ password: 'pw' })
    } finally {
      await c.close()
    }
  })

  it('never puts a connection string in the record or the audit log', async () => {
    const c = await clientFor('grp-full')
    try {
      await call(c, 'add_database', { name: 'Orders URI', kind: 'postgres', uri: URI })
      const req = written[0] as Extract<AgentConfigRequest, { kind: 'database.add' }>
      expect(req.fields.host).toBe('db.internal')
      expect(req.fields.uri).toBe(true)
      expect(JSON.stringify(req.fields)).not.toContain('s3cret')
      expect(req.secret).toEqual({ uri: URI })
      const row = listAudit().find((e) => e.action.startsWith('Add database "Orders URI"'))
      expect(row).toBeTruthy()
      expect(row!.action).not.toContain('s3cret')
    } finally {
      await c.close()
    }
  })

  it('refuses a duplicate name, which would make one of the two unreachable', async () => {
    const c = await clientFor('grp-full')
    try {
      const out = await call(c, 'add_database', { name: 'orders', kind: 'postgres', host: 'x' })
      expect(out).toContain('already exists')
      expect(written).toHaveLength(0)
    } finally {
      await c.close()
    }
  })

  it('refuses a carrier from another workspace', async () => {
    const c = await clientFor('grp-full', [
      { id: 'ws', name: 'Prod' },
      { id: 'ws2', name: 'Lab' }
    ])
    try {
      const out = await call(c, 'add_database', {
        name: 'Cross',
        kind: 'postgres',
        host: 'x',
        workspaceName: 'Prod',
        sshServer: 'Lab box'
      })
      expect(out).toContain('different workspace')
      expect(written).toHaveLength(0)
    } finally {
      await c.close()
    }
  })

  it('asks when the bastion it rides on is Protected, even on Full Access', async () => {
    setProtected({ level: 'server', serverId: 's1' }, true)
    const a = watch('denied')
    const c = await clientFor('grp-full')
    try {
      await call(c, 'add_database', { name: 'Behind', kind: 'postgres', host: 'x', sshServer: 'Bastion' })
      expect(a.count()).toBe(1)
      expect(written).toHaveLength(0)
    } finally {
      a.stop()
      await c.close()
    }
  })
})

describe('update_database and remove_database', () => {
  it('sends only the fields that changed, and keeps the credential unless one was sent', async () => {
    const c = await clientFor('grp-full')
    try {
      await call(c, 'update_database', { databaseName: 'Orders', port: 6432 })
      const req = written[0] as Extract<AgentConfigRequest, { kind: 'database.update' }>
      expect(req.databaseId).toBe('db1')
      expect(req.patch).toEqual({ port: 6432 })
      expect(req.secret).toBeUndefined()
    } finally {
      await c.close()
    }
  })

  it('removes by name', async () => {
    const c = await clientFor('grp-full')
    try {
      const out = await call(c, 'remove_database', { databaseName: 'Orders' })
      expect(out).toContain('Removed "Orders"')
      expect(written[0]).toEqual({ kind: 'database.remove', databaseId: 'db1' })
    } finally {
      await c.close()
    }
  })

  it('asks for a removal while Confirm risky actions is on, even with manageServers at allow', async () => {
    saveGroup({ ...getGroup('grp-full')!, id: 'grp-confirming', name: 'Full, confirming', builtIn: false, confirmRisky: true })
    const a = watch('denied')
    const c = await clientFor('grp-confirming')
    try {
      await call(c, 'remove_database', { databaseName: 'Orders' })
      expect(a.count()).toBe(1)
      expect(written).toHaveLength(0)
    } finally {
      a.stop()
      await c.close()
    }
  })

  it('is refused outright where manageServers is denied', async () => {
    // Commands, no writes: manageServers is left at allowAll()'s deny.
    const c = await clientFor('grp-read-only')
    try {
      for (const [tool, args] of [
        ['add_database', { name: 'N', kind: 'postgres', host: 'x' }],
        ['update_database', { databaseName: 'Orders', port: 1 }],
        ['remove_database', { databaseName: 'Orders' }]
      ] as const) {
        const out = await call(c, tool, args)
        expect(out, tool).toMatch(/denied|not allowed|refused/i)
      }
      expect(written).toHaveLength(0)
    } finally {
      await c.close()
    }
  })
})

describe('test_database', () => {
  it('reports a failure as a category, never the driver text with the host in it', async () => {
    testResult = { ok: false, error: 'connect ECONNREFUSED 10.0.0.5:5432' }
    const c = await clientFor('grp-full')
    try {
      const out = await call(c, 'test_database', { databaseName: 'Orders' })
      expect(out).toContain('did not connect')
      expect(out).not.toContain('10.0.0.5')
    } finally {
      await c.close()
    }
  })
})

describe('list_databases', () => {
  it('leaves out workspaces whose group denies databaseAccess', async () => {
    // Read Only: databaseAccess is not among the four things it allows.
    setAssignment({ level: 'workspace', workspaceId: 'ws2' }, 'grp-observer')
    const c = await clientFor('grp-full', [
      { id: 'ws', name: 'Prod' },
      { id: 'ws2', name: 'Lab' }
    ])
    try {
      const out = await call(c, 'list_databases', {})
      expect(out).toContain('Orders')
      expect(out).not.toContain('Scratch')
    } finally {
      await c.close()
    }
  })
})
