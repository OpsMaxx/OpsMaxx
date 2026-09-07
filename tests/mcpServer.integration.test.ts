import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import { refreshMcpDataCache } from '../src/main/services/mcpDataCache'
import { setAssignment, resetPolicyCacheForTests } from '../src/main/services/policyStore'
import { setMcpConfig, createSession, resetMcpAuthForTests } from '../src/main/services/mcpAuth'
import { startMcpServer, stopMcpServer } from '../src/main/services/mcpServer'

const PORT = 58732

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
    },
    {
      id: 's2',
      workspaceId: 'ws-dev',
      name: 'Dev Box',
      host: '10.0.1.1',
      port: 22,
      username: 'dev',
      auth: 'password',
      os: 'Linux',
      route: []
    }
  ]
}

async function connectedClient(token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } }
  })
  const client = new Client({ name: 'test-client', version: '1.0.0' })
  await client.connect(transport)
  return client
}

describe('MCP server (integration)', () => {
  let token: string
  let multiWorkspaceToken: string

  beforeAll(async () => {
    resetMcpAuthForTests()
    resetPolicyCacheForTests()
    refreshMcpDataCache(sampleData)
    // Production and Development both default to Read Only for AI.
    setAssignment({ level: 'workspace', workspaceId: 'ws-prod' }, 'grp-read-only')
    setAssignment({ level: 'workspace', workspaceId: 'ws-dev' }, 'grp-read-only')
    setMcpConfig({ enabled: true, port: PORT, approvalTimeoutSeconds: 5 })
    const created = createSession({
      agentName: 'Test Agent',
      workspaces: [{ id: 'ws-prod', name: 'Production' }],
      groupId: 'grp-read-only',
      groupName: 'Read Only',
      ttlMinutes: 60
    })
    token = created.token
    const createdMulti = createSession({
      agentName: 'Multi-workspace Agent',
      workspaces: [
        { id: 'ws-prod', name: 'Production' },
        { id: 'ws-dev', name: 'Development' }
      ],
      groupId: 'grp-read-only',
      groupName: 'Read Only',
      ttlMinutes: 60
    })
    multiWorkspaceToken = createdMulti.token
    const result = await startMcpServer()
    expect(result.ok).toBe(true)
  })

  afterAll(async () => {
    await stopMcpServer()
  })

  it('a valid MCP client can connect and discover tools with friendly names', async () => {
    const client = await connectedClient(token)
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name)
    expect(names).toEqual(
      expect.arrayContaining([
        'list_workspaces',
        'list_servers',
        'get_server_details',
        'execute_command',
        'read_file',
        'write_file',
        'list_files',
        'get_server_metrics'
      ])
    )
    await client.close()
  })

  it('list_servers returns the friendly name, never raw connection details', async () => {
    const client = await connectedClient(token)
    const result = await client.callTool({ name: 'list_servers', arguments: {} })
    const text = (result.content as { type: string; text: string }[])[0].text
    expect(text).toContain('Nginx Server Prod')
    expect(text).not.toContain('10.0.0.1')
    await client.close()
  })

  it('rejects a request with no/invalid bearer token', async () => {
    const client = await connectedClient('not-a-real-token')
    const result = await client.callTool({ name: 'list_workspaces', arguments: {} })
    expect(result.isError).toBe(true)
    const text = (result.content as { type: string; text: string }[])[0].text
    expect(text.toLowerCase()).toContain('not recognized')
    await client.close()
  })

  it('a Read Only session is denied writing a file without ever reaching SSH', async () => {
    const client = await connectedClient(token)
    const result = await client.callTool({
      name: 'write_file',
      arguments: { serverName: 'Nginx Server Prod', path: '/etc/nginx/nginx.conf', content: 'x' }
    })
    expect(result.isError).toBe(true)
    const text = (result.content as { type: string; text: string }[])[0].text
    expect(text).toContain('Denied')
    await client.close()
  })

  it('an unknown server name is reported, not guessed at', async () => {
    const client = await connectedClient(token)
    const result = await client.callTool({
      name: 'get_server_details',
      arguments: { serverName: 'totally-unknown-host' }
    })
    expect(result.isError).toBe(true)
    await client.close()
  })

  it('a single-workspace session cannot see a server outside its grant', async () => {
    const client = await connectedClient(token)
    const list = await client.callTool({ name: 'list_servers', arguments: {} })
    const listText = (list.content as { type: string; text: string }[])[0].text
    expect(listText).not.toContain('Dev Box')

    const details = await client.callTool({ name: 'get_server_details', arguments: { serverName: 'Dev Box' } })
    expect(details.isError).toBe(true)
    await client.close()
  })

  it('a multi-workspace session sees servers from every workspace it was granted', async () => {
    const client = await connectedClient(multiWorkspaceToken)
    const list = await client.callTool({ name: 'list_servers', arguments: {} })
    const listText = (list.content as { type: string; text: string }[])[0].text
    expect(listText).toContain('Nginx Server Prod')
    expect(listText).toContain('Dev Box')

    const workspaces = await client.callTool({ name: 'list_workspaces', arguments: {} })
    const workspacesText = (workspaces.content as { type: string; text: string }[])[0].text
    expect(workspacesText).toContain('Production')
    expect(workspacesText).toContain('Development')

    const details = await client.callTool({ name: 'get_server_details', arguments: { serverName: 'Dev Box' } })
    const detailsText = (details.content as { type: string; text: string }[])[0].text
    expect(detailsText).toContain('Workspace: Development')
    await client.close()
  })

// The container tools, and specifically the two decisions that are easy to
// reverse by accident later: that reading containers is its own capability
// rather than folded into an existing one, and that the tier meant to be handed
// out without thinking does not grant it.
    describe('container tools', () => {
    it('offers both container tools to an agent', async () => {
      const client = await connectedClient(token)
      const names = (await client.listTools()).tools.map((t) => t.name)
      expect(names).toContain('list_containers')
      expect(names).toContain('container_logs')
      await client.close()
    })

    it('refuses both on the Read Only tier, whose promise is that it needs no thought', async () => {
      // grp-observer, NOT grp-read-only — the latter is named "Commands, no
      // writes" and is far more permissive than its id suggests. The tier this
      // is about is the one a cautious user picks first and then stops thinking
      // about, and a container log carries the application's own connection
      // strings, so it is denied there for the same reason host facts are.
      setAssignment({ level: 'workspace', workspaceId: 'ws-prod' }, 'grp-observer')
      const observer = createSession({
        agentName: 'Observer Agent',
        workspaces: [{ id: 'ws-prod', name: 'Production' }],
        groupId: 'grp-observer',
        groupName: 'Read Only',
        ttlMinutes: 60
      })
      const client = await connectedClient(observer.token)
      try {
        for (const name of ['list_containers', 'container_logs']) {
          const res = (await client.callTool({
            name,
            arguments:
              name === 'container_logs'
                ? { serverName: 'Nginx Server Prod', container: 'api', intent: 'checking' }
                : { serverName: 'Nginx Server Prod', intent: 'checking' }
          })) as { content: { text?: string }[] }
          const said = res.content.map((c) => c.text ?? '').join(' ')
          expect(said, `${name} must be refused on the Read Only tier`).toMatch(
            /not permitted|denied|refus/i
          )
        }
      } finally {
        await client.close()
        setAssignment({ level: 'workspace', workspaceId: 'ws-prod' }, 'grp-read-only')
      }
    })

    it('never offers a way to follow a log', async () => {
      // A stream would outlive the approval that authorised it, which is the
      // durability argument the job engine is excluded on. The schema is the
      // enforcement: there is no parameter to ask for it.
      const client = await connectedClient(token)
      const logs = (await client.listTools()).tools.find((t) => t.name === 'container_logs')
      const props = Object.keys(
        (logs?.inputSchema as { properties?: Record<string, unknown> })?.properties ?? {}
      )
      expect(props).not.toContain('follow')
      expect(props).not.toContain('stream')
      expect(props).toContain('since')
      await client.close()
    })
  })
})
