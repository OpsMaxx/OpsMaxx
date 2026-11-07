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

  // A cancel is a different POST from the call it cancels, and the endpoint is
  // stateless, so it lands on a fresh server that never saw that request id. It
  // used to be dropped there: the call's own POST stayed open, the question
  // stayed on screen, and a yes after the client had given up -- the SDK's 60s
  // timeout is shorter than the 120s approval window -- ran the command for an
  // agent that had already been told it failed, and that might retry it.
  it('ends the request as disconnected when the client cancels it', async () => {
    const client = await connectedClient()
    const abort = new AbortController()
    const resolved = new Promise<ApprovalEvent>((resolve) => {
      const off = onApprovalEvent((e) => {
        if (e.type === 'created') abort.abort()
        if (e.type === 'resolved') {
          off()
          resolve(e)
        }
      })
    })
    void client
      .callTool(
        { name: 'write_file', arguments: { serverName: 'Nginx Server Prod', path: '/tmp/cancelled', content: 'x' } },
        undefined,
        { signal: abort.signal }
      )
      .catch(() => undefined)

    const e = await resolved
    expect(e.request.status).toBe('disconnected')
    expect(listPendingApprovals()).toHaveLength(0)
    await client.close()
  }, 10_000)

  // A cancelled request gets no response, so its stream had no reason to end:
  // the POST and its McpServer stayed open until the client process exited.
  it("closes the cancelled call's stream rather than leaving it open", async () => {
    const post = (body: unknown): Promise<Response> =>
      fetch(`http://127.0.0.1:${PORT}/mcp`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream'
        },
        body: JSON.stringify(body)
      })
    const created = new Promise<void>((resolve) => {
      const off = onApprovalEvent((e) => {
        if (e.type === 'created') {
          off()
          resolve()
        }
      })
    })
    const call = await post({
      jsonrpc: '2.0',
      id: 42,
      method: 'tools/call',
      params: { name: 'write_file', arguments: { serverName: 'Nginx Server Prod', path: '/tmp/closed', content: 'x' } }
    })
    await created
    expect((await post({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 42 } })).status).toBe(202)

    // Reads to the end: resolves only if the server ended the stream.
    const text = await call.text()
    expect(text).not.toContain('"id":42')
    await vi.waitFor(() => expect(listPendingApprovals()).toHaveLength(0))
  }, 10_000)

  // Ids are per client: every SDK client numbers its calls from 0, so an id alone
  // would let one agent's cancel stop another agent's call.
  it("does not let another session's cancel stop the call", async () => {
    const other = createSession({
      agentName: 'Other Agent',
      workspaces: [{ id: 'ws-prod', name: 'Production' }],
      groupId: 'grp-read-write',
      groupName: 'Read & Write',
      ttlMinutes: 60
    }).token
    const client = await connectedClient()
    const created = new Promise<void>((resolve) => {
      const off = onApprovalEvent((e) => {
        if (e.type === 'created') {
          off()
          resolve()
        }
      })
    })
    void client
      .callTool({ name: 'write_file', arguments: { serverName: 'Nginx Server Prod', path: '/tmp/theirs', content: 'x' } })
      .catch(() => undefined)
    await created

    // Every id this client could have used so far, sent with the other token.
    const res = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${other}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
      },
      body: JSON.stringify(
        [0, 1, 2].map((requestId) => ({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId } }))
      )
    })
    expect(res.status).toBe(202)
    await new Promise((r) => setTimeout(r, 200))
    expect(listPendingApprovals()).toHaveLength(1)
    await client.close()
    await vi.waitFor(() => expect(listPendingApprovals()).toHaveLength(0))
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
