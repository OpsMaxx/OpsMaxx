import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

// The whole point of this tool is that it answers "is this entry healthy"
// without running anything and without saying where the entry points.
//
// The second half is the one worth a test file. ssh2 and node's socket layer
// put the address in the message -- `connect ECONNREFUSED 10.21.15.7:22` -- and
// errorText() in mcpServer.ts does not redact. Passing a driver string through
// would disclose, in a failure, the one thing the addressing model exists to
// withhold. So every assertion below is about what is NOT in the answer.

let testResult: { ok: boolean; error?: string } = { ok: true }
let dialled: unknown[] = []

vi.mock('../src/main/services/ssh', () => ({
  sshExec: () => Promise.resolve({ ok: true, stdout: '', stderr: '', code: 0 }),
  sshTest: (cfg: unknown) => {
    dialled.push(cfg)
    return Promise.resolve(testResult)
  }
}))

const { refreshMcpDataCache } = await import('../src/main/services/mcpDataCache')
const { setAssignment, resetPolicyCacheForTests } = await import('../src/main/services/policyStore')
const { setMcpConfig, createSession, resetMcpAuthForTests } = await import('../src/main/services/mcpAuth')
const { startMcpServer, stopMcpServer } = await import('../src/main/services/mcpServer')

const PORT = 18762
const HOST = '10.21.15.7'

const sampleData = {
  workspaces: [{ id: 'ws', name: 'Personal' }],
  servers: [
    {
      id: 's1',
      workspaceId: 'ws',
      name: 'Scanner01',
      host: HOST,
      port: 22,
      username: 'svc-scanner',
      auth: 'key',
      os: 'Linux',
      route: [{ id: 'h1', label: 'Bastion', host: '10.21.15.239', port: 22, username: 'root', auth: 'key', serverId: 'bastion' }]
    },
    { id: 'bastion', workspaceId: 'ws', name: 'Bastion', host: '10.21.15.239', port: 22, username: 'root', auth: 'key', os: 'Linux', route: [] }
  ]
}

beforeAll(async () => {
  resetPolicyCacheForTests()
  resetMcpAuthForTests()
  refreshMcpDataCache(sampleData)
  setMcpConfig({ enabled: true, port: PORT, approvalTimeoutSeconds: 5 })
  await startMcpServer()
})

afterAll(async () => await stopMcpServer())

beforeEach(() => {
  testResult = { ok: true }
  dialled = []
  setAssignment({ level: 'workspace', workspaceId: 'ws' }, 'grp-read-only')
})

async function clientFor(groupId: string): Promise<Client> {
  const { token } = createSession({
    agentName: 'Test Agent',
    workspaces: [{ id: 'ws', name: 'Personal' }],
    groupId,
    groupName: groupId,
    ttlMinutes: null
  })
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } }
  })
  const c = new Client({ name: 'test-conn', version: '1.0.0' })
  await c.connect(transport)
  return c
}

async function call(c: Client, args: Record<string, unknown>): Promise<string> {
  const r = (await c.callTool({ name: 'test_connection', arguments: args })) as { content: { text: string }[] }
  return r.content.map((x) => x.text).join('\n')
}

describe('test_connection', () => {
  it('works on Read Only, which grants viewServer but no terminal', async () => {
    // "Is this entry healthy" must not require the ability to run things --
    // which is what the reporter had to do instead: `hostname` over SSH on
    // every saved server.
    const c = await clientFor('grp-read-only')
    try {
      const out = await call(c, { serverName: 'Scanner01' })
      expect(out).toContain('reachable')
      expect(dialled).toHaveLength(1)
    } finally {
      await c.close()
    }
  })

  it('dials through the saved jump chain rather than direct', async () => {
    const c = await clientFor('grp-read-only')
    try {
      await call(c, { serverName: 'Scanner01' })
      const cfg = dialled[0] as { hops?: unknown[] }
      expect(cfg.hops).toHaveLength(1)
    } finally {
      await c.close()
    }
  })

  for (const [label, error] of [
    ['a refused connection', `connect ECONNREFUSED ${HOST}:22`],
    ['a timeout', `connect ETIMEDOUT ${HOST}:22`],
    ['a DNS failure', `getaddrinfo ENOTFOUND scanner01.internal.example`],
    ['a rejected credential', 'All configured authentication methods failed'],
    ['an unreadable key', "ENOENT: no such file or directory, open '/home/ops/.ssh/id_scanner'"],
    ['text nothing recognises', 'kaboom 10.21.15.7 port 22 user svc-scanner']
  ] as const) {
    it(`never leaks the address through ${label}`, async () => {
      testResult = { ok: false, error }
      const c = await clientFor('grp-read-only')
      try {
        const out = await call(c, { serverName: 'Scanner01' })
        expect(out).toContain('did not connect')
        // The three things the bridge promises never to disclose.
        expect(out).not.toContain(HOST)
        expect(out).not.toContain('10.21.15')
        expect(out).not.toContain('svc-scanner')
        expect(out).not.toContain('scanner01.internal.example')
        expect(out).not.toContain('id_scanner')
        // And the driver's own words, which are where an address hides.
        expect(out).not.toContain(error)
      } finally {
        await c.close()
      }
    })
  }

  it('reports an untrusted host key as its own outcome, not a generic failure', async () => {
    // The one failure nothing on this bridge can fix: OpsMaxx will not record
    // trust for a host key because an agent asked it to.
    testResult = { ok: false, error: 'Host denied (verification failed)' }
    const c = await clientFor('grp-read-only')
    try {
      const out = await call(c, { serverName: 'Scanner01' })
      expect(out).toContain('host key')
      expect(out).toContain('open this server in OpsMaxx')
    } finally {
      await c.close()
    }
  })

  it('says it could not tell, rather than inventing a cause, for unrecognised text', async () => {
    testResult = { ok: false, error: 'kaboom' }
    const c = await clientFor('grp-read-only')
    try {
      const out = await call(c, { serverName: 'Scanner01' })
      expect(out).toContain('could not tell')
      // An agent told "authentication failed" when the truth is unknown goes
      // and rewrites a credential that was never wrong.
      expect(out).not.toContain('rejected the username')
    } finally {
      await c.close()
    }
  })

  it('refuses a server this session cannot see, without confirming it exists', async () => {
    const c = await clientFor('grp-read-only')
    try {
      const out = await call(c, { serverName: 'Not A Server' })
      expect(out).toContain('No server matching')
      expect(dialled).toHaveLength(0)
    } finally {
      await c.close()
    }
  })
})
