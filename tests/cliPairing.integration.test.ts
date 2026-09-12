import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { join } from 'node:path'
import { hasBuiltCli, warnIfUnbuilt } from './fixtures/builtCli'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

import { refreshMcpDataCache } from '../src/main/services/mcpDataCache'
import { setAssignment, listGroups, resetPolicyCacheForTests } from '../src/main/services/policyStore'
import { setMcpConfig, listSessions, resetMcpAuthForTests } from '../src/main/services/mcpAuth'
import { startMcpServer, stopMcpServer, explainSessionAccess } from '../src/main/services/mcpServer'
import {
  onCliPairingEvent,
  startCliPairing,
  confirmCliPairing,
  type CliPairingEvent
} from '../src/main/services/cliPairing'
import type { McpAgentSession } from '../src/shared/mcp'

// Exercises the whole `opsmaxx claude|codex|run` launcher path against the
// real HTTP server: /pair/start never leaks the code (only an in-process
// event, standing in for the app UI, does), /pair/confirm mints a real
// session, and the compiled CLI's `bridge` subcommand relays a genuine MCP
// client's traffic over stdio into that same authenticated HTTP endpoint.
const PORT = 58733

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

async function postJson(path: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  return (await res.json()) as Record<string, unknown>
}

warnIfUnbuilt()

describe('CLI pairing (integration)', () => {
  beforeAll(async () => {
    resetMcpAuthForTests()
    resetPolicyCacheForTests()
    refreshMcpDataCache(sampleData)
    setAssignment({ level: 'workspace', workspaceId: 'ws-prod' }, 'grp-read-only')
    setMcpConfig({ enabled: true, port: PORT, approvalTimeoutSeconds: 5 })
    const result = await startMcpServer()
    expect(result.ok).toBe(true)
  })

  afterAll(async () => {
    await stopMcpServer()
  })

  it('/pair/start never returns the code — it only reaches an in-app event', async () => {
    const codes: string[] = []
    const off = onCliPairingEvent((e: CliPairingEvent) => {
      if (e.type === 'created') codes.push(e.request.code)
    })
    const start = await postJson('/pair/start', { agentName: 'Test CLI' })
    off()
    expect(start).not.toHaveProperty('code')
    expect(typeof start.pairingId).toBe('string')
    expect(codes).toHaveLength(1)
    expect(codes[0]).toMatch(/^\d{6}$/)
  })

  it.skipIf(!hasBuiltCli)('rejects the wrong code, then accepts the right one and hands back a working token', async () => {
    let code = ''
    const off = onCliPairingEvent((e: CliPairingEvent) => {
      if (e.type === 'created') code = e.request.code
    })
    const start = await postJson('/pair/start', { agentName: 'Test CLI' })
    off()
    const pairingId = start.pairingId as string

    const wrongCode = code === '000000' ? '111111' : '000000'
    const wrong = await postJson('/pair/confirm', { pairingId, code: wrongCode })
    expect(wrong.ok).toBe(false)

    const right = await postJson('/pair/confirm', { pairingId, code })
    expect(right.ok).toBe(true)
    expect(typeof right.token).toBe('string')
    expect(right.port).toBe(PORT)

    // The same code cannot be replayed.
    const replay = await postJson('/pair/confirm', { pairingId, code })
    expect(replay.ok).toBe(false)

    const client = await connectViaBridge(right.token as string)
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toContain('list_workspaces')
    await client.close()
  })
})

async function connectViaBridge(token: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(__dirname, '../out/cli/index.js'), 'bridge', '--token', token, '--port', String(PORT)]
  })
  const client = new Client({ name: 'bridge-test-client', version: '1.0.0' })
  await client.connect(transport)
  return client
}

// The group a paired session lands on is the whole grant, and pairing is the
// one path with no picker in front of it — so the configured default is the
// only thing that may decide, and its absence has to mean denied rather than
// whichever group sits first in the policy file.
describe('CLI pairing resolves the session group from the configured default', () => {
  beforeAll(() => {
    resetMcpAuthForTests()
    resetPolicyCacheForTests()
    refreshMcpDataCache(sampleData)
    setMcpConfig({ enabled: true, port: PORT + 1 })
  })

  function pair(agentName: string): McpAgentSession {
    let code = ''
    const off = onCliPairingEvent((e: CliPairingEvent) => {
      if (e.type === 'created') code = e.request.code
    })
    const { pairingId } = startCliPairing(agentName)
    off()
    const result = confirmCliPairing(pairingId, code)
    expect(result.ok).toBe(true)
    const session = listSessions().find((s) => s.agentName === agentName)
    expect(session).toBeDefined()
    return session as McpAgentSession
  }

  // What "most restrictive" has to mean in practice: not a reassuring group
  // name, but every capability actually refused by the same code the tools call.
  function decisions(session: McpAgentSession): string[] {
    const explained = explainSessionAccess(session.id, 's1')
    expect(explained).not.toBeNull()
    return (explained ?? []).map((c) => c.decision)
  }

  it('assigns the group named by defaultSessionGroupId', () => {
    setMcpConfig({ defaultSessionGroupId: 'grp-read-only' })
    const session = pair('Default group honoured')
    expect(session.groupId).toBe('grp-read-only')
    expect(session.groupName).toBe(listGroups().find((g) => g.id === 'grp-read-only')?.name)
    // Not denied across the board — the grant really is in force.
    expect(decisions(session)).toContain('allow')
  })

  it('falls back to no access at all when no default is configured', () => {
    setMcpConfig({ defaultSessionGroupId: undefined })
    const session = pair('No default configured')
    expect(session.groupId).toBeNull()
    // The actual effective permission, not the label: null groupId must fail
    // closed in every gate, or the fallback is cosmetic.
    expect(new Set(decisions(session))).toEqual(new Set(['deny']))
  })

  it('does not pick an arbitrary group when several exist', () => {
    setMcpConfig({ defaultSessionGroupId: undefined })
    const groups = listGroups()
    expect(groups.length).toBeGreaterThan(1)
    const session = pair('Several groups exist')
    expect(session.groupId).not.toBe(groups[0].id)
    expect(session.groupId).toBeNull()
  })

  it('falls back to no access when the configured default no longer exists', () => {
    setMcpConfig({ defaultSessionGroupId: 'grp-deleted-by-the-user' })
    const session = pair('Stale default')
    expect(session.groupId).toBeNull()
    expect(new Set(decisions(session))).toEqual(new Set(['deny']))
  })
})
