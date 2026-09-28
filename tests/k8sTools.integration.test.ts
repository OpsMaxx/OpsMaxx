import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

// Kubernetes on the bridge. Allowed on 2026-09-28 on conditions, and these are
// the conditions: reads on `containers`, every change to a cluster asked for
// on every call, a drain that refuses on its own preflight, a pod command
// checked as a command, logs that never follow, and a context that is refused
// rather than silently dropped. Every assertion is on what would have reached
// the host, because that is the only place a loosened gate shows.

const sent: string[] = []
let reply: { ok: boolean; stdout?: string; stderr?: string; code?: number | null } = { ok: true, stdout: '' }

vi.mock('../src/main/services/ssh', () => ({
  sshExec: (_cfg: unknown, command: string) => {
    sent.push(command)
    return Promise.resolve(reply)
  },
  sshTest: () => Promise.resolve({ ok: true })
}))

const { refreshMcpDataCache } = await import('../src/main/services/mcpDataCache')
const { setAssignment, resetPolicyCacheForTests, saveGroup, getGroup } = await import('../src/main/services/policyStore')
const { setMcpConfig, createSession, resetMcpAuthForTests } = await import('../src/main/services/mcpAuth')
const { startMcpServer, stopMcpServer } = await import('../src/main/services/mcpServer')
const { onApprovalEvent, respondToApproval } = await import('../src/main/services/approvals')

const { buildK8sDrainCommand } = await import('../src/shared/kubernetes')

const PORT = 18785

beforeAll(async () => {
  resetPolicyCacheForTests()
  resetMcpAuthForTests()
  refreshMcpDataCache({
    workspaces: [{ id: 'ws', name: 'Prod' }],
    servers: [
      { id: 'k1', workspaceId: 'ws', name: 'Kube', host: '10.0.0.9', port: 22, username: 'root', auth: 'key', os: 'Linux', route: [] }
    ]
  })
  setMcpConfig({ enabled: true, port: PORT, approvalTimeoutSeconds: 5 })
  await startMcpServer()
})
afterAll(async () => await stopMcpServer())

const CONFIRMING = 'grp-k8s-confirming'
beforeEach(() => {
  sent.length = 0
  reply = { ok: true, stdout: '' }
  setAssignment({ level: 'workspace', workspaceId: 'ws' }, 'grp-full')
  saveGroup({ ...getGroup('grp-full')!, id: CONFIRMING, name: 'Full, confirming', builtIn: false, confirmRisky: true })
})

async function clientFor(groupId: string): Promise<Client> {
  const { token } = createSession({
    agentName: 'K8s Test',
    workspaces: [{ id: 'ws', name: 'Prod' }],
    groupId,
    groupName: groupId,
    ttlMinutes: null
  })
  const t = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } }
  })
  const c = new Client({ name: 'k8s-test', version: '1.0.0' })
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

describe('reads', () => {
  it('run on containers and reach the host through kubectl', async () => {
    const c = await clientFor('grp-full')
    try {
      await call(c, 'k8s_overview', { serverName: 'Kube' })
      expect(sent.length).toBeGreaterThan(0)
      expect(sent[0]).toMatch(/kubectl/)
    } finally {
      await c.close()
    }
  })

  it('are refused where containers is denied, and nothing is sent', async () => {
    // Read Only allows view, read files, download and metrics -- not containers.
    const c = await clientFor('grp-observer')
    try {
      const out = await call(c, 'k8s_overview', { serverName: 'Kube' })
      expect(out).toMatch(/denied|not allowed|refused/i)
      expect(sent).toEqual([])
    } finally {
      await c.close()
    }
  })

  it('refuse a bad context instead of acting on the current one', async () => {
    const c = await clientFor('grp-full')
    try {
      const out = await call(c, 'k8s_overview', { serverName: 'Kube', context: 'prod; rm -rf /' })
      expect(out).toContain('not a valid kubeconfig context')
      expect(sent).toEqual([])
    } finally {
      await c.close()
    }
  })

  it('never follow a log', async () => {
    const c = await clientFor('grp-full')
    try {
      await call(c, 'k8s_logs', { serverName: 'Kube', namespace: 'default', pod: 'web-1' })
      expect(sent).toHaveLength(1)
      expect(sent[0]).not.toMatch(/--follow|\s-f\b/)
      expect(sent[0]).toContain('logs')
    } finally {
      await c.close()
    }
  })
})

describe('changes to a cluster', () => {
  it('ask on every call, and a denial sends nothing', async () => {
    const a = watch('denied')
    const c = await clientFor(CONFIRMING)
    try {
      // One denial: a second identical ask moments later is held back by the
      // bridge's own cool-down, which is a different property from this one.
      await call(c, 'k8s_node_action', { serverName: 'Kube', node: 'node-1', action: 'cordon' })
      expect(a.count()).toBe(1)
      expect(sent).toEqual([])
    } finally {
      a.stop()
      await c.close()
    }
  })

  it('ask again after an approval, because one yes never covers the next change', async () => {
    const a = watch('approved')
    const c = await clientFor(CONFIRMING)
    try {
      await call(c, 'k8s_node_action', { serverName: 'Kube', node: 'node-1', action: 'cordon' })
      await call(c, 'k8s_node_action', { serverName: 'Kube', node: 'node-1', action: 'uncordon' })
      expect(a.count()).toBe(2)
    } finally {
      a.stop()
      await c.close()
    }
  })

  it('asks even on Full Access, where containerControl is a plain allow', async () => {
    const a = watch('denied')
    const c = await clientFor('grp-full')
    try {
      await call(c, 'k8s_rollout_restart', { serverName: 'Kube', kind: 'deployment', namespace: 'default', name: 'web' })
      expect(a.count()).toBe(1)
      expect(sent).toEqual([])
    } finally {
      a.stop()
      await c.close()
    }
  })

  it('a drain refuses when its own preflight cannot see the node, and never sends the drain', async () => {
    const a = watch('approved')
    const c = await clientFor('grp-full')
    try {
      reply = { ok: false, error: 'connect ETIMEDOUT' } as typeof reply
      const out = await call(c, 'k8s_node_action', { serverName: 'Kube', node: 'node-1', action: 'drain' })
      expect(out).toMatch(/refusing to drain/i)
      // Only the preflight went out; the drain itself was never built into a
      // command that reached the host.
      expect(sent).toHaveLength(1)
      expect(sent).not.toContain(buildK8sDrainCommand('node-1'))
    } finally {
      a.stop()
      await c.close()
    }
  })

  it('are refused where containerControl is denied', async () => {
    // Commands, no writes leaves containerControl at allowAll()'s allow, so use
    // Read Only, which denies it.
    const c = await clientFor('grp-observer')
    try {
      const out = await call(c, 'k8s_rollout_restart', { serverName: 'Kube', kind: 'deployment', namespace: 'default', name: 'web' })
      expect(out).toMatch(/denied|not allowed|refused/i)
      expect(sent).toEqual([])
    } finally {
      await c.close()
    }
  })
})

describe('pod_command', () => {
  it('is checked as the command it is, and asked for every call', async () => {
    const a = watch('approved')
    const c = await clientFor(CONFIRMING)
    try {
      reply = { ok: true, stdout: '===OPSMAXX-EXEC===\nhello\n', code: 0 }
      await call(c, 'pod_command', { serverName: 'Kube', namespace: 'default', pod: 'web-1', command: 'echo hello' })
      await call(c, 'pod_command', { serverName: 'Kube', namespace: 'default', pod: 'web-1', command: 'echo hello' })
      expect(a.count()).toBe(2)
      expect(sent).toHaveLength(2)
      expect(sent[0]).toContain('exec web-1')
    } finally {
      a.stop()
      await c.close()
    }
  })

  it('is refused where the terminal is denied, and nothing reaches the pod', async () => {
    const c = await clientFor('grp-observer')
    try {
      const out = await call(c, 'pod_command', { serverName: 'Kube', namespace: 'default', pod: 'web-1', command: 'id' })
      expect(out).toMatch(/denied|not allowed|refused/i)
      expect(sent).toEqual([])
    } finally {
      await c.close()
    }
  })
})
