import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

// set_tunnel could only run a tunnel somebody had already written, so an agent
// asked to forward a port had nothing to offer. These two close that, and the
// line they must not cross is the VPN one: a profile decides which network
// everything after it travels over and is still un-authorable, while a tunnel
// binds one named port, is visible in the Tunnels view, and needs a second
// approval before it carries anything.

vi.mock('../src/main/services/tunnel', () => ({
  tunnelStart: () => Promise.resolve({ ok: true, listenPort: 15432 }),
  tunnelStop: () => Promise.resolve(),
  tunnelList: () => []
}))

vi.mock('../src/main/services/ssh', () => ({
  sshExec: () => Promise.resolve({ ok: true, stdout: '', stderr: '', code: 0 }),
  sshTest: () => Promise.resolve({ ok: true })
}))

const { refreshMcpDataCache } = await import('../src/main/services/mcpDataCache')
const { setAssignment, resetPolicyCacheForTests } = await import('../src/main/services/policyStore')
const { setMcpConfig, createSession, resetMcpAuthForTests } = await import('../src/main/services/mcpAuth')
const { startMcpServer, stopMcpServer } = await import('../src/main/services/mcpServer')
const { onApprovalEvent, respondToApproval } = await import('../src/main/services/approvals')
const { setAgentConfigWriter } = await import('../src/main/services/agentConfigWrite')
type AgentConfigRequest = import('../src/main/services/agentConfigWrite').AgentConfigRequest

const PORT = 18763

const sampleData = {
  workspaces: [{ id: 'ws', name: 'Personal' }],
  servers: [
    { id: 's1', workspaceId: 'ws', name: 'Bastion', host: '10.21.15.239', port: 22, username: 'root', auth: 'key', os: 'Linux', route: [] }
  ],
  tunnels: [{ id: 't1', workspaceId: 'ws', name: 'DB Forward', kind: 'local', serverId: 's1', listen: '127.0.0.1:15432', target: '10.0.0.5:5432' }]
}

let written: AgentConfigRequest[] = []

beforeAll(async () => {
  resetPolicyCacheForTests()
  resetMcpAuthForTests()
  refreshMcpDataCache(sampleData)
  setMcpConfig({ enabled: true, port: PORT, approvalTimeoutSeconds: 5 })
  setAgentConfigWriter((req) => {
    written.push(req)
    return Promise.resolve({ ok: true, id: 'tun-new' })
  })
  await startMcpServer()
})

afterAll(async () => await stopMcpServer())

beforeEach(() => {
  written = []
  setAssignment({ level: 'workspace', workspaceId: 'ws' }, 'grp-full')
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
  const c = new Client({ name: 'tunnel-define', version: '1.0.0' })
  await c.connect(transport)
  return c
}

async function call(c: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const r = (await c.callTool({ name, arguments: args })) as { content: { text: string }[] }
  return r.content.map((x) => x.text).join('\n')
}

function watch(decision: 'approved' | 'denied'): { stop: () => void; count: () => number; last: () => string } {
  let seen = 0
  let because = ''
  const off = onApprovalEvent((e) => {
    if (e.type === 'created') {
      seen += 1
      because = e.request.riskReason ?? ''
      respondToApproval(e.request.id, decision)
    }
  })
  return { stop: off, count: () => seen, last: () => because }
}

describe('create_tunnel', () => {
  it('saves a local forward and does NOT start it', async () => {
    const a = watch('approved')
    const c = await clientFor('grp-full')
    try {
      const out = await call(c, 'create_tunnel', {
        kind: 'local',
        name: 'PG forward',
        serverName: 'Bastion',
        listen: '127.0.0.1:15433',
        target: '10.21.15.7:5432'
      })
      expect(out).toContain('NOT running')
      const req = written[0] as Extract<AgentConfigRequest, { kind: 'tunnel.add' }>
      expect(req.tunnelKind).toBe('local')
      expect(req.serverId).toBe('s1')
      expect(req.listen).toBe('127.0.0.1:15433')
    } finally {
      a.stop()
      await c.close()
    }
  })

  it('always asks, even on Full Access', async () => {
    const a = watch('approved')
    const c = await clientFor('grp-full')
    try {
      await call(c, 'create_tunnel', { kind: 'socks', name: 'Proxy', serverName: 'Bastion' })
      expect(a.count()).toBe(1)
    } finally {
      a.stop()
      await c.close()
    }
  })

  it('asks again for a second tunnel in the same session', async () => {
    const a = watch('approved')
    const c = await clientFor('grp-full')
    try {
      await call(c, 'create_tunnel', { kind: 'socks', name: 'Proxy A', serverName: 'Bastion' })
      await call(c, 'create_tunnel', { kind: 'socks', name: 'Proxy B', serverName: 'Bastion' })
      expect(a.count()).toBe(2)
    } finally {
      a.stop()
      await c.close()
    }
  })

  it('takes a socks proxy with no target, and defaults its listen address to loopback', async () => {
    const a = watch('approved')
    const c = await clientFor('grp-full')
    try {
      await call(c, 'create_tunnel', { kind: 'socks', name: 'Proxy', serverName: 'Bastion' })
      const req = written[0] as Extract<AgentConfigRequest, { kind: 'tunnel.add' }>
      expect(req.target).toBe('')
      expect(req.listen).toBe('127.0.0.1:1080')
    } finally {
      a.stop()
      await c.close()
    }
  })

  it('says, in the approval, when a remote forward would publish a port on the server', async () => {
    // A remote forward listens ON THE SERVER. Loopback there is what sshd
    // allows without GatewayPorts; anything else opens the port to that
    // server's whole network, and that is the fact the approving person most
    // needs and would never infer from "define a tunnel".
    const a = watch('denied')
    const c = await clientFor('grp-full')
    try {
      await call(c, 'create_tunnel', {
        kind: 'remote',
        name: 'Exposed',
        serverName: 'Bastion',
        listen: '0.0.0.0:8080',
        target: '127.0.0.1:3000'
      })
      expect(a.last()).toContain('ON THE SERVER')
      expect(a.last()).toContain('publishes')
    } finally {
      a.stop()
      await c.close()
    }
  })

  it('does not say that about a loopback remote forward', async () => {
    const a = watch('denied')
    const c = await clientFor('grp-full')
    try {
      await call(c, 'create_tunnel', {
        kind: 'remote',
        name: 'Contained',
        serverName: 'Bastion',
        listen: '127.0.0.1:8080',
        target: '127.0.0.1:3000'
      })
      expect(a.last()).not.toContain('publishes')
    } finally {
      a.stop()
      await c.close()
    }
  })

  it('rejects a listen address that parseEndpoint cannot turn into a port', async () => {
    // parseEndpoint answers with port 0 rather than throwing, so an unchecked
    // value is saved as a tunnel that can never bind.
    const a = watch('approved')
    const c = await clientFor('grp-full')
    try {
      const out = await call(c, 'create_tunnel', {
        kind: 'local',
        name: 'Broken',
        serverName: 'Bastion',
        listen: 'not-a-port',
        target: '10.0.0.5:5432'
      })
      expect(out).toContain('not a valid listen address')
      expect(written).toHaveLength(0)
      expect(a.count()).toBe(0)
    } finally {
      a.stop()
      await c.close()
    }
  })

  it('rejects a local forward with no target', async () => {
    const c = await clientFor('grp-full')
    try {
      const out = await call(c, 'create_tunnel', { kind: 'local', name: 'Nowhere', serverName: 'Bastion', listen: '127.0.0.1:9000' })
      expect(out).toContain('needs a target')
      expect(written).toHaveLength(0)
    } finally {
      await c.close()
    }
  })

  it('refuses a name that already exists', async () => {
    const c = await clientFor('grp-full')
    try {
      const out = await call(c, 'create_tunnel', {
        kind: 'local',
        name: 'DB Forward',
        serverName: 'Bastion',
        listen: '127.0.0.1:9001',
        target: '10.0.0.5:5432'
      })
      expect(out).toContain('already exists')
    } finally {
      await c.close()
    }
  })

  it('is denied under Read Only', async () => {
    setAssignment({ level: 'workspace', workspaceId: 'ws' }, 'grp-read-only')
    const c = await clientFor('grp-read-only')
    try {
      const out = await call(c, 'create_tunnel', { kind: 'socks', name: 'Proxy', serverName: 'Bastion' })
      expect(out).toContain('Denied')
      expect(written).toHaveLength(0)
    } finally {
      await c.close()
    }
  })
})

describe('delete_tunnel', () => {
  it('always asks, and removes on approval', async () => {
    const a = watch('approved')
    const c = await clientFor('grp-full')
    try {
      const out = await call(c, 'delete_tunnel', { tunnelName: 'DB Forward' })
      expect(out).toContain('Removed')
      expect(a.count()).toBe(1)
      expect((written[0] as Extract<AgentConfigRequest, { kind: 'tunnel.remove' }>).tunnelId).toBe('t1')
    } finally {
      a.stop()
      await c.close()
    }
  })

  it('does not remove when the user declines', async () => {
    const a = watch('denied')
    const c = await clientFor('grp-full')
    try {
      const out = await call(c, 'delete_tunnel', { tunnelName: 'DB Forward' })
      expect(out).toContain('Denied')
      expect(written).toHaveLength(0)
    } finally {
      a.stop()
      await c.close()
    }
  })
})

describe('the VPN boundary is unchanged', () => {
  it('still has no tool that creates or edits a VPN profile', async () => {
    // docs/AI-SECURITY.md states this as a decision rather than an omission,
    // and the arrival of create_tunnel is exactly the change that could have
    // eroded it by analogy.
    const c = await clientFor('grp-full')
    try {
      const names = (await c.listTools()).tools.map((t) => t.name)
      expect(names).not.toContain('add_vpn')
      expect(names).not.toContain('edit_vpn')
      expect(names).not.toContain('create_vpn')
      expect(names).not.toContain('delete_vpn')
      // And the two that did arrive, so this test fails if they are ever
      // quietly renamed into the shape above.
      expect(names).toContain('create_tunnel')
      expect(names).toContain('delete_tunnel')
    } finally {
      await c.close()
    }
  })
})
