import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import { refreshMcpDataCache } from '../src/main/services/mcpDataCache'
import { setAssignment, resetPolicyCacheForTests } from '../src/main/services/policyStore'
import { setMcpConfig, createSession, resetMcpAuthForTests } from '../src/main/services/mcpAuth'
import { startMcpServer, stopMcpServer, setCapacityReader } from '../src/main/services/mcpServer'
import type { CapacityReport } from '../src/shared/capacity'

// Item 47's `get_capacity_trends` — the first agent-reachable capacity surface.
//
// The thing worth pinning is not that it returns numbers. It is that a REFUSAL
// is an answer: "not enough data", "the samples are stale" and "history is off"
// all have to reach the agent as themselves, because an agent that reads any of
// them as "usage is fine" will say so to somebody.

const PORT = 58741

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
let asked: { hostId: string; windowDays: number }[] = []

const report = (over: Partial<CapacityReport> = {}): CapacityReport => ({
  hostId: 's1',
  from: 0,
  to: 1,
  now: 1,
  fullResolutionDays: 7,
  retainedDays: 90,
  trends: [
    {
      metric: 'diskPct',
      read: 145,
      latest: 71,
      direction: 'rising',
      forecast: { ok: true, days: 11, at: 2, threshold: 90, from: 0, to: 1, points: 145 }
    } as never
  ],
  ...over
})

async function call(args: Record<string, unknown>): Promise<string> {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } }
  })
  const client = new Client({ name: 'test-client', version: '1.0.0' })
  await client.connect(transport)
  try {
    const r = (await client.callTool({ name: 'get_capacity_trends', arguments: args })) as {
      content: { text: string }[]
    }
    return r.content.map((c) => c.text).join('\n')
  } finally {
    await client.close()
  }
}

describe('an agent asking where a server is heading', () => {
  beforeAll(async () => {
    resetMcpAuthForTests()
    resetPolicyCacheForTests()
    refreshMcpDataCache(sampleData)
    setAssignment({ level: 'workspace', workspaceId: 'ws-prod' }, 'grp-read-only')
    setMcpConfig({ enabled: true, port: PORT, approvalTimeoutSeconds: 2 })
    token = createSession({
      agentName: 'Test Agent',
      workspaces: [{ id: 'ws-prod', name: 'Production' }],
      groupId: 'grp-read-only',
      groupName: 'Read Only',
      ttlMinutes: 60
    }).token
    expect((await startMcpServer()).ok).toBe(true)
  })

  afterAll(async () => {
    await stopMcpServer()
    setCapacityReader(() => null)
  })

  it('answers with the conclusion, and asks main for the window the agent named', async () => {
    asked = []
    setCapacityReader((hostId, windowDays) => {
      asked.push({ hostId, windowDays })
      return report()
    })
    const text = await call({ serverName: 'Nginx Server Prod', windowDays: 30 })
    expect(asked).toEqual([{ hostId: 's1', windowDays: 30 }])
    expect(text).toContain('diskPct')
    expect(text).toContain('"days": 11')
  })

  it('defaults the window rather than reading everything that is retained', async () => {
    asked = []
    setCapacityReader((hostId, windowDays) => {
      asked.push({ hostId, windowDays })
      return report()
    })
    await call({ serverName: 'Nginx Server Prod' })
    expect(asked[0].windowDays).toBe(7)
  })

  // THE assertion. An agent told nothing will fill the gap itself.
  it('says history is off rather than returning an empty answer', async () => {
    setCapacityReader(() => null)
    const text = await call({ serverName: 'Nginx Server Prod' })
    expect(text).toContain('not recording history')
    expect(text).toContain('does not mean the server has spare capacity')
  })

  it('refuses a server the session cannot see, without saying whether it exists', async () => {
    setCapacityReader(() => report())
    const text = await call({ serverName: 'Some Other Server' })
    expect(text).not.toContain('diskPct')
  })
})
