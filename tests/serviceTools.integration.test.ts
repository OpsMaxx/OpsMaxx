import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

// list_services, service_action and list_cron, driven over real MCP with the
// SSH transport faked. What matters here is who is allowed to reach the host at
// all, and what command reaches it -- so every exec is recorded and most
// assertions are about that list.

const execs: string[] = []

const UNITS_OUTPUT = [
  '===OPSMAXX-LINGER===',
  'Linger=no',
  '===OPSMAXX-USERUNITS===',
  'worker.service loaded active running Queue worker',
  'sync.service   loaded failed failed  Nightly sync'
].join('\n')

const CRON_OUTPUT = [
  '===OPSMAXX-USER===',
  '0 2 * * * /home/me/backup.sh',
  '===OPSMAXX-SYSTEM===',
  '17 * * * * root cd / && run-parts --report /etc/cron.hourly',
  '===OPSMAXX-CROND===',
  '#FILE:/etc/cron.d/certbot',
  '0 */12 * * * root certbot -q renew',
  '#FILE:/etc/cron.d/secretjob',
  '5 * * * * root /opt/secretjob.sh',
  '===OPSMAXX-TIMERS==='
].join('\n')

vi.mock('../src/main/services/ssh', () => ({
  sshExec: (_cfg: unknown, command: string) => {
    execs.push(command)
    if (command.includes('OPSMAXX-USERUNITS')) return Promise.resolve({ ok: true, code: 0, stdout: UNITS_OUTPUT, stderr: '' })
    if (command.includes('OPSMAXX-CROND')) return Promise.resolve({ ok: true, code: 0, stdout: CRON_OUTPUT, stderr: '' })
    if (command.includes('is-active')) return Promise.resolve({ ok: true, code: 0, stdout: 'active\n', stderr: '' })
    return Promise.resolve({ ok: true, code: 0, stdout: '', stderr: '' })
  },
  sshTest: () => Promise.resolve({ ok: true })
}))

const { refreshMcpDataCache } = await import('../src/main/services/mcpDataCache')
const { setAssignment, resetPolicyCacheForTests, saveGroup, getGroup } = await import('../src/main/services/policyStore')
const { setMcpConfig, createSession, resetMcpAuthForTests } = await import('../src/main/services/mcpAuth')
const { startMcpServer, stopMcpServer } = await import('../src/main/services/mcpServer')
const { onApprovalEvent, respondToApproval } = await import('../src/main/services/approvals')

const PORT = 18790

beforeAll(async () => {
  resetPolicyCacheForTests()
  resetMcpAuthForTests()
  refreshMcpDataCache({
    workspaces: [{ id: 'ws', name: 'Prod' }],
    servers: [
      { id: 's1', workspaceId: 'ws', name: 'Web', host: '10.0.0.1', port: 22, username: 'ops', auth: 'key', os: 'Linux', route: [] }
    ]
  })
  setMcpConfig({ enabled: true, port: PORT, approvalTimeoutSeconds: 5 })
  await startMcpServer()
})
afterAll(async () => await stopMcpServer())
beforeEach(() => {
  execs.length = 0
})

async function clientFor(groupId: string, mode?: 'bypass'): Promise<Client> {
  setAssignment({ level: 'workspace', workspaceId: 'ws' }, groupId)
  const { token } = createSession({
    agentName: 'Service Test',
    workspaces: [{ id: 'ws', name: 'Prod' }],
    groupId,
    groupName: groupId,
    ttlMinutes: null,
    mode
  })
  const t = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } }
  })
  const c = new Client({ name: 'service-test', version: '1.0.0' })
  await c.connect(t)
  return c
}

async function call(c: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const r = (await c.callTool({ name, arguments: args })) as { content: { text: string }[] }
  return r.content.map((x) => x.text).join('\n')
}

describe('list_services', () => {
  it('reads user units and the linger state on the Read Only tier', async () => {
    const c = await clientFor('grp-observer')
    try {
      const out = await call(c, 'list_services', { serverName: 'Web' })
      expect(out).toContain('worker.service')
      expect(out).toContain('Linger: not-lingering')
      // Running without linger is the thing this reader exists to say.
      expect(out).toMatch(/not lingering/)
      expect(execs).toHaveLength(1)
    } finally {
      await c.close()
    }
  })

  it('filters by name', async () => {
    const c = await clientFor('grp-observer')
    try {
      const out = await call(c, 'list_services', { serverName: 'Web', filter: 'SYNC' })
      expect(out).toContain('sync.service')
      expect(out).not.toContain('worker.service')
    } finally {
      await c.close()
    }
  })
})

describe('service_action', () => {
  it('is refused where sudo is denied, without reaching the host', async () => {
    const c = await clientFor('grp-observer')
    try {
      const out = await call(c, 'service_action', { serverName: 'Web', unit: 'nginx', action: 'restart' })
      expect(out).toContain('Denied')
      expect(execs).toEqual([])
    } finally {
      await c.close()
    }
  })

  it('asks for every call, shows the exact command, then checks the result', async () => {
    const asked: { action: string; toolName?: string }[] = []
    const stop = onApprovalEvent((e) => {
      if (e.type !== 'created') return
      asked.push({ action: e.request.action, toolName: e.request.toolName })
      // A session-scoped yes is offered back; per-call must ignore it.
      respondToApproval(e.request.id, 'approved', 'session')
    })
    const c = await clientFor('grp-sudo')
    try {
      const out = await call(c, 'service_action', { serverName: 'Web', unit: 'nginx', action: 'restart' })
      expect(out).toContain("Ran `sudo -n systemctl restart 'nginx.service'`")
      expect(out).toContain('Checked: active')
      expect(execs).toEqual(["sudo -n systemctl restart 'nginx.service'", "sudo -n systemctl is-active 'nginx.service'"])

      await call(c, 'service_action', { serverName: 'Web', unit: 'nginx', action: 'stop' })
      expect(asked).toHaveLength(2)
      expect(asked[0]).toEqual({ action: "sudo -n systemctl restart 'nginx.service'", toolName: 'service_action' })
      expect(asked[1].action).toBe("sudo -n systemctl stop 'nginx.service'")
    } finally {
      stop()
      await c.close()
    }
  })

  it('does not run when the approval is denied', async () => {
    const stop = onApprovalEvent((e) => e.type === 'created' && respondToApproval(e.request.id, 'denied'))
    const c = await clientFor('grp-sudo')
    try {
      await call(c, 'service_action', { serverName: 'Web', unit: 'nginx', action: 'restart' })
      expect(execs).toEqual([])
    } finally {
      stop()
      await c.close()
    }
  })

  it('refuses to cut its own connection, even in Bypass', async () => {
    const c = await clientFor('grp-full', 'bypass')
    try {
      for (const unit of ['sshd', 'ssh.service', 'ssh.socket']) {
        const out = await call(c, 'service_action', { serverName: 'Web', unit, action: 'stop' })
        expect(out).toContain('Denied')
      }
      expect(execs).toEqual([])
    } finally {
      await c.close()
    }
  })

  it('refuses a unit name with shell in it', async () => {
    const c = await clientFor('grp-full', 'bypass')
    try {
      const out = await call(c, 'service_action', { serverName: 'Web', unit: "nginx'; reboot; '", action: 'start' })
      expect(out).toContain('Denied')
      expect(execs).toEqual([])
    } finally {
      await c.close()
    }
  })
})

describe('list_cron', () => {
  it('reads the schedule without escalating where sudo is denied', async () => {
    const c = await clientFor('grp-observer')
    try {
      const out = await call(c, 'list_cron', { serverName: 'Web' })
      expect(out).toContain('/home/me/backup.sh')
      expect(out).toContain('certbot -q renew')
      expect(execs).toHaveLength(1)
      expect(execs[0]).not.toContain('sudo -n')
    } finally {
      await c.close()
    }
  })

  it('lets the collector retry as root where sudo is not denied', async () => {
    const c = await clientFor('grp-sudo')
    try {
      await call(c, 'list_cron', { serverName: 'Web' })
      expect(execs[0]).toContain('sudo -n')
    } finally {
      await c.close()
    }
  })

  it('filters by the account an entry runs as', async () => {
    const c = await clientFor('grp-observer')
    try {
      const out = await call(c, 'list_cron', { serverName: 'Web', user: 'root' })
      expect(out).toContain('certbot')
      expect(out).not.toContain('/home/me/backup.sh')
    } finally {
      await c.close()
    }
  })

  it('is refused by a path rule on a directory it reads', async () => {
    saveGroup({
      ...getGroup('grp-observer')!,
      id: 'grp-no-crond',
      name: 'No cron.d',
      builtIn: false,
      filePolicies: [{ id: 'r1', pattern: '/etc/cron.d/**', read: 'deny' }]
    })
    const c = await clientFor('grp-no-crond')
    try {
      expect(await call(c, 'list_cron', { serverName: 'Web' })).toContain('Denied')
      expect(execs).toEqual([])
    } finally {
      await c.close()
    }
  })

  it('withholds entries from one file a stricter rule covers', async () => {
    saveGroup({
      ...getGroup('grp-observer')!,
      id: 'grp-no-secretjob',
      name: 'No secretjob',
      builtIn: false,
      filePolicies: [{ id: 'r1', pattern: '/etc/cron.d/secretjob', read: 'deny' }]
    })
    const c = await clientFor('grp-no-secretjob')
    try {
      const out = await call(c, 'list_cron', { serverName: 'Web' })
      expect(out).toContain('certbot')
      expect(out).not.toContain('/opt/secretjob.sh')
      expect(out).toContain('1 entry withheld')
    } finally {
      await c.close()
    }
  })
})
