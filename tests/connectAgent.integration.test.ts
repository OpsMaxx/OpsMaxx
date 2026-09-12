import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hasBuiltCli, warnIfUnbuilt } from './fixtures/builtCli'

import { refreshMcpDataCache, listCachedWorkspaces } from '../src/main/services/mcpDataCache'
import { setAssignment, listAssignments, listGroups, resetPolicyCacheForTests } from '../src/main/services/policyStore'
import { setMcpConfig, createSession, resetMcpAuthForTests } from '../src/main/services/mcpAuth'
import { startMcpServer, stopMcpServer, explainSessionAccess } from '../src/main/services/mcpServer'
import { writeClaudeDesktopConfigTo, writeCodexConfigTo, claudeCodeCommand } from '../src/main/services/clientConfig'
import { resolveDefaultSessionGroup } from '../src/shared/mcp'

// Exercises exactly what the "Connect Claude Code" / "Connect Claude Desktop"
// buttons do, end to end: gap-fill the workspace assignments, mint a session,
// then reach OpsMaxx with the credential each button hands out. Clicking the
// buttons proves a session was created; only this proves the agent on the other
// end can actually see a server, which is the part that silently fails.
const PORT = 58734

const sampleData = {
  workspaces: [
    { id: 'ws-prod', name: 'Production' },
    { id: 'ws-dev', name: 'Development' }
  ],
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

let dir: string

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'opsmaxx-connect-'))
  resetPolicyCacheForTests()
  resetMcpAuthForTests()
  refreshMcpDataCache(sampleData)
  setMcpConfig({ enabled: true, port: PORT })
  await startMcpServer()
})

afterAll(async () => {
  await stopMcpServer()
  rmSync(dir, { recursive: true, force: true })
})

// The renderer's connect() loop, extracted so the test drives the same rules the
// button does rather than a paraphrase of them.
function fillAssignmentGaps(groupId: string | null): void {
  const assigned = new Set(
    listAssignments()
      .filter((a) => a.scope.level === 'workspace')
      .map((a) => (a.scope as { workspaceId: string }).workspaceId)
  )
  for (const w of listCachedWorkspaces()) {
    if (!assigned.has(w.id)) setAssignment({ level: 'workspace', workspaceId: w.id }, groupId)
  }
}

function newSession(
  agentName: string,
  groupId: string | null,
  groupName: string,
  // Defaults to every workspace, which is what these tests want; pass [] to
  // build a session scoped to nothing.
  workspaces?: { id: string; name: string }[]
): string {
  const { token } = createSession({
    agentName,
    workspaces: workspaces ?? listCachedWorkspaces().map((w) => ({ id: w.id, name: w.name })),
    groupId,
    groupName,
    ttlMinutes: null
  })
  return token
}

async function httpClient(token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } }
  })
  const client = new Client({ name: 'connect-test', version: '1.0.0' })
  await client.connect(transport)
  return client
}

async function callText(client: Client, name: string): Promise<string> {
  const res = (await client.callTool({ name, arguments: {} })) as { content: { type: string; text: string }[] }
  return res.content.map((c) => c.text).join('\n')
}

warnIfUnbuilt()

describe('connect flow', () => {
  it('a session with no assignment anywhere sees the servers its own group allows', async () => {
    // INVERTED, deliberately. This used to assert that an agent with no
    // assignment saw nothing -- which was the whole complaint: the knob the
    // user turns is the session's access group, and it could only ever take
    // access away. The session's group is the grant now, so an estate with no
    // assignments at all is governed by it.
    expect(listAssignments()).toHaveLength(0)
    const token = newSession('Unassigned', 'grp-read-only', 'Read Only')
    const client = await httpClient(token)
    try {
      expect(await callText(client, 'list_servers')).toContain('Nginx Server Prod')
    } finally {
      await client.close()
    }
  })

  it('a session still sees nothing outside its own workspaces', async () => {
    // The boundary that did NOT move, and the one that matters most now that a
    // missing assignment no longer denies: a session is scoped to the
    // workspaces chosen when it was created, and no access group can widen
    // that. Without this, "the session's group grants" would mean a Full Access
    // session reached the whole estate.
    const token = newSession('Elsewhere', 'grp-full', 'Full Access', [])
    const client = await httpClient(token)
    try {
      expect(await callText(client, 'list_servers')).not.toContain('Nginx Server Prod')
    } finally {
      await client.close()
    }
  })

  it('fills the assignment gaps and the agent then sees the server', async () => {
    const readOnly = listGroups().find((g) => g.id === 'grp-read-only')!
    fillAssignmentGaps(readOnly.id)

    expect(listAssignments().map((a) => a.groupId)).toEqual([readOnly.id, readOnly.id])

    const token = newSession('Claude Code', readOnly.id, readOnly.name)
    const client = await httpClient(token)
    try {
      expect(await callText(client, 'list_servers')).toContain('Nginx Server Prod')
      expect(await callText(client, 'list_workspaces')).toContain('Production')
    } finally {
      await client.close()
    }
  })

  it('never overwrites a workspace the user has already assigned', () => {
    // A workspace deliberately set to No AI Access must stay that way.
    setAssignment({ level: 'workspace', workspaceId: 'ws-dev' }, null)
    fillAssignmentGaps('grp-full')
    const dev = listAssignments().find(
      (a) => a.scope.level === 'workspace' && (a.scope as { workspaceId: string }).workspaceId === 'ws-dev'
    )
    expect(dev?.groupId).toBeNull()
  })

  it('the Claude Code command carries a token that actually authenticates', async () => {
    const token = newSession('Claude Code', 'grp-read-only', 'Read Only')
    const command = claudeCodeCommand(token, PORT)

    // Pull the token back out of the generated command line, so a quoting or
    // ordering mistake in the string shows up as an auth failure here.
    const bearer = /--header "Authorization: Bearer ([^"]+)"/.exec(command)?.[1]
    expect(bearer).toBe(token)
    const url = /(http:\/\/127\.0\.0\.1:\d+\/mcp)/.exec(command)?.[1]
    expect(url).toBe(`http://127.0.0.1:${PORT}/mcp`)

    const client = await httpClient(bearer!)
    try {
      expect(await callText(client, 'list_servers')).toContain('Nginx Server Prod')
    } finally {
      await client.close()
    }
  })

  it.skipIf(!hasBuiltCli)('the Codex config it writes is a usable MCP server', async () => {
    const file = join(dir, 'config.toml')
    const token = newSession('Codex', 'grp-read-only', 'Read Only')
    expect(writeCodexConfigTo(file, token, PORT).ok).toBe(true)

    // Parsed back out of the TOML that was written, so a quoting or escaping
    // mistake in the block shows up here rather than in Codex.
    const toml = readFileSync(file, 'utf8')
    const command = JSON.parse(/^command = (".*")$/m.exec(toml)![1]) as string
    const args = JSON.parse(`[${/^args = \[(.*)\]$/m.exec(toml)![1]}]`) as string[]

    const transport = new StdioClientTransport({
      command,
      args,
      env: { ...(process.env as Record<string, string>), ELECTRON_RUN_AS_NODE: '1' }
    })
    const client = new Client({ name: 'codex-test', version: '1.0.0' })
    await client.connect(transport)
    try {
      expect(await callText(client, 'list_servers')).toContain('Nginx Server Prod')
    } finally {
      await client.close()
    }
  })

  it.skipIf(!hasBuiltCli)('the Claude Desktop config it writes is a usable MCP server', async () => {
    const file = join(dir, 'claude_desktop_config.json')
    const token = newSession('Claude Desktop', 'grp-read-only', 'Read Only')
    const result = writeClaudeDesktopConfigTo(file, token, PORT)
    expect(result.ok).toBe(true)

    // Spawn strictly from what was written to disk — nothing hardcoded — so
    // this fails if the entry Claude Desktop would read is wrong in any way.
    const entry = JSON.parse(readFileSync(file, 'utf8')).mcpServers.opsmaxx as {
      command: string
      args: string[]
      env: Record<string, string>
    }
    const transport = new StdioClientTransport({
      command: entry.command,
      args: entry.args,
      env: { ...(process.env as Record<string, string>), ...entry.env }
    })
    const client = new Client({ name: 'desktop-test', version: '1.0.0' })
    await client.connect(transport)
    try {
      const { tools } = await client.listTools()
      expect(tools.map((t) => t.name)).toContain('list_servers')
      expect(await callText(client, 'list_servers')).toContain('Nginx Server Prod')
    } finally {
      await client.close()
    }
  })
})

// Which group the Connect buttons land on, and what that group actually permits.
//
// The picker is preselected before anyone looks at it and the session it mints
// never expires, so the preselected value IS the grant in the common case. It
// used to fall through to `list[0]` — whichever group sat first in the policy
// file — when neither the configured default nor Read & Write could be found.
describe('the connect flow resolves its access group from the configured default', () => {
  beforeAll(() => {
    // The tests above leave assignments behind, including a deliberate No AI
    // Access on ws-dev. An assignment is a restriction that caps the session's
    // group, so leaving one in place would hide what is being measured here:
    // the grant the resolved group gives on its own.
    resetPolicyCacheForTests()
    expect(listAssignments()).toHaveLength(0)
  })

  // ConnectAgent.tsx's preselect, called with exactly the arguments it passes —
  // including its own deliberate Read & Write fallback.
  const preselect = (
    defaultSessionGroupId?: string
  ): { id: string | null; name: string } =>
    resolveDefaultSessionGroup({ defaultSessionGroupId }, listGroups(), 'grp-read-write')

  // The effective answer, from the same code the tools call — not the group's
  // name, which is the thing that was reassuring and wrong.
  function decisions(agentName: string, resolved: { id: string | null; name: string }): Map<string, string> {
    const { session } = createSession({
      agentName,
      workspaces: listCachedWorkspaces().map((w) => ({ id: w.id, name: w.name })),
      groupId: resolved.id,
      groupName: resolved.name,
      ttlMinutes: null
    })
    const explained = explainSessionAccess(session.id, 's1')
    expect(explained).not.toBeNull()
    return new Map((explained ?? []).map((c) => [c.capability, c.decision]))
  }

  it('prefers a configured default over its own Read & Write fallback', () => {
    const resolved = preselect('grp-read-only')
    expect(resolved.id).toBe('grp-read-only')
    const effective = decisions('Configured default', resolved)
    // Read Only really is in force: reads go through, writes do not. Asserting
    // only `groupId` would pass just as well if the grant were ignored.
    expect(effective.get('readFiles')).toBe('allow')
    expect(effective.get('writeFiles')).toBe('deny')
  })

  it('falls back to Read & Write when nothing is configured, and nothing wider', () => {
    const resolved = preselect(undefined)
    expect(resolved.id).toBe('grp-read-write')
    const effective = decisions('No default configured', resolved)
    // The flow's deliberate choice, and the reason it is defensible: every
    // mutating capability in it still stops for an approval.
    expect(effective.get('readFiles')).toBe('allow')
    expect(effective.get('writeFiles')).toBe('ask')
    expect(effective.get('sudo')).toBe('deny')
  })

  it('does not fall back to whichever group is first in the list', () => {
    const groups = listGroups()
    expect(groups.length).toBeGreaterThan(1)
    expect(groups[0].id).not.toBe('grp-read-write')
    expect(preselect(undefined).id).not.toBe(groups[0].id)
  })

  it('gives no access at all when the configured default has been deleted', () => {
    // The user did choose, and their choice is gone — so this flow's fallback
    // does not get to stand in for it either.
    const resolved = preselect('grp-deleted-by-the-user')
    expect(resolved.id).toBeNull()
    expect(resolved.name).toBe('No AI Access')
    expect(new Set(decisions('Stale default', resolved).values())).toEqual(new Set(['deny']))
  })
})
