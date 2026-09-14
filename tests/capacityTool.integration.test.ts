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

const DAY = 86_400_000
const NOW = 1_700_000_000_000

const report = (over: Partial<CapacityReport> = {}): CapacityReport => ({
  hostId: 's1',
  from: NOW - 30 * DAY,
  to: NOW,
  now: NOW,
  fullResolutionDays: 7,
  retainedDays: 90,
  trends: [
    {
      metric: 'diskPct',
      segments: [],
      read: 145,
      latest: { ts: NOW, v: 71.4, res: 'full' },
      low: 60,
      high: 72,
      resolutionBoundary: null,
      forecast: {
        ok: true,
        days: 11,
        at: NOW + 11 * DAY,
        threshold: 90,
        perDay: 1.7,
        r2: 0.94,
        confidence: 'high',
        from: NOW - 21 * DAY,
        to: NOW,
        points: 145,
        res: 'full',
        coverage: { parts: 10, occupied: 9, longestGapMs: 2 * DAY }
      },
      bytes: {
        perDay: 2_040_109_465,
        crossesAt: NOW + 11 * DAY,
        days: 11,
        refusal: null,
        r2: 0.94,
        confidence: 'high',
        from: NOW - 21 * DAY,
        to: NOW,
        points: 145,
        latest: 149_000_000_000
      }
    }
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

  it('answers in sentences, and asks main for the window the agent named', async () => {
    asked = []
    setCapacityReader((hostId, windowDays) => {
      asked.push({ hostId, windowDays })
      return report()
    })
    const text = await call({ serverName: 'Nginx Server Prod', windowDays: 30 })
    expect(asked).toEqual([{ hostId: 's1', windowDays: 30 }])
    // The conclusion, in words. Not the field name, and not the JSON.
    expect(text).toContain('Disk: 71.4% now')
    expect(text).toContain('Reaches 90% in 11 day(s)')
    // The window and the coverage travel with the date, always. "Reaches 90% in
    // 11 days" on its own is the sentence this whole feature is written against.
    expect(text).toContain('from 21 days of data')
    expect(text).toContain('9 of 10 parts of it sampled')
    // And the precise figure the rounded percentage is derived from.
    expect(text).toContain('139 GiB used')
    expect(text).not.toContain('"metric"')
    expect(text).not.toContain('segments')
  })

  // THE SIZE BUDGET. The bug this replaced was not a wrong number, it was ten
  // kilobytes of chart points returned to answer a question about a trend --
  // five hundred samples whose every conclusion was the word "flat". Only a
  // budget stops that coming back one convenience field at a time.
  it('answers in well under a kilobyte, however much history there is', async () => {
    setCapacityReader(() => report())
    const text = await call({ serverName: 'Nginx Server Prod', windowDays: 90 })
    expect(text.length).toBeLessThan(1000)
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
