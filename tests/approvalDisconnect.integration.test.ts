import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

// Half of the request's behaviour is swapped per test: `approveOnAbort` makes
// requestApproval hold until the client goes and then answer yes, which is the
// operator's approve landing in the same moment the agent disconnected.
const mode = vi.hoisted(() => ({ approveOnAbort: false }))
vi.mock('../src/main/services/approvals', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/main/services/approvals')>()
  return {
    ...real,
    requestApproval: (input: Parameters<typeof real.requestApproval>[0]) =>
      mode.approveOnAbort
        ? new Promise((resolve) => input.signal?.addEventListener('abort', () => resolve('approved'), { once: true }))
        : real.requestApproval(input)
  }
})

import { refreshMcpDataCache } from '../src/main/services/mcpDataCache'
import { setAssignment, resetPolicyCacheForTests } from '../src/main/services/policyStore'
import { setMcpConfig, createSession, resetMcpAuthForTests } from '../src/main/services/mcpAuth'
import { startMcpServer, stopMcpServer } from '../src/main/services/mcpServer'
import { onApprovalEvent, listPendingApprovals, resetApprovalVolumeForTests } from '../src/main/services/approvals'
import { listAudit } from '../src/main/services/auditLog'
import type { ApprovalEvent } from '../src/main/services/approvals'

// Found by killing an MCP client while its request was on screen: the question
// stayed up until the fuse ran out and was then reported as "told no by the
// clock". The per-request transport closes with the response, which aborts the
// handler's signal; gate() hands that signal to the request.
const PORT = 18791

const sampleData = {
  workspaces: [{ id: 'ws-prod', name: 'Production' }],
  servers: [
    {
      id: 's1',
      workspaceId: 'ws-prod',
      name: 'Nginx Server Prod',
      host: '10.0.0.1',
      port: 22,
      username: 'root',
      auth: 'key',
      os: 'Linux',
      route: []
    }
  ]
}

let token: string

async function connectedClient(): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } }
  })
  const client = new Client({ name: 'test-client', version: '1.0.0' })
  await client.connect(transport)
  return client
}

const lastAuditFor = (path: string): ReturnType<typeof listAudit>[number] | undefined =>
  listAudit().find((a) => a.action.includes(path))

describe('an agent that disconnects while its request is waiting', () => {
  beforeEach(() => {
    resetApprovalVolumeForTests()
    mode.approveOnAbort = false
  })

  beforeAll(async () => {
    resetMcpAuthForTests()
    resetPolicyCacheForTests()
    refreshMcpDataCache(sampleData)
    setAssignment({ level: 'workspace', workspaceId: 'ws-prod' }, 'grp-read-write')
    setMcpConfig({ enabled: true, port: PORT, approvalTimeoutSeconds: 60 })
    token = createSession({
      agentName: 'Test Agent',
      workspaces: [{ id: 'ws-prod', name: 'Production' }],
      groupId: 'grp-read-write',
      groupName: 'Read & Write',
      ttlMinutes: 60
    }).token
    expect((await startMcpServer()).ok).toBe(true)
  })

  afterAll(async () => {
    await stopMcpServer()
  })

  it('ends the request at once as disconnected, and audits it as that', async () => {
    const client = await connectedClient()
    const resolved = new Promise<ApprovalEvent>((resolve) => {
      const off = onApprovalEvent((e) => {
        if (e.type === 'created') void client.close()
        if (e.type === 'resolved') {
          off()
          resolve(e)
        }
      })
    })
    void client
      .callTool({ name: 'write_file', arguments: { serverName: 'Nginx Server Prod', path: '/tmp/gone', content: 'x' } })
      .catch(() => undefined)

    const e = await resolved
    expect(e.request.status).toBe('disconnected')
    expect(listPendingApprovals()).toHaveLength(0)
    await vi.waitFor(() => expect(lastAuditFor('/tmp/gone')?.approval).toBe('disconnected'))
  }, 10_000)

  // The yes and the disconnect in the same moment: gate() re-reads the signal
  // after the answer, and runs nothing for a caller that is not there. Without
  // that check this call would go on to dial 10.0.0.1.
  it('runs nothing when the answer is yes but the agent has already gone', async () => {
    mode.approveOnAbort = true
    const client = await connectedClient()
    const call = client
      .callTool({ name: 'write_file', arguments: { serverName: 'Nginx Server Prod', path: '/tmp/late', content: 'x' } })
      .catch(() => undefined)
    // Let the request reach gate() and block, then leave.
    await new Promise((r) => setTimeout(r, 200))
    await client.close()
    await call

    await vi.waitFor(() => {
      const row = lastAuditFor('/tmp/late')
      expect(row?.approval).toBe('disconnected')
      expect(row?.error).toContain('Approved, but the agent disconnected before it ran')
    })
  }, 10_000)
})
