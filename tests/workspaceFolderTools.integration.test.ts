import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

// create_workspace, rename_workspace, create_folder, rename_folder, and the
// folder parameter on add_server and update_server.
//
// The property under test throughout is that none of them WIDENS anything: a
// created workspace is in no session, every lookup is made inside the
// session's own workspaces (or, for a server move, inside the server's own
// workspace), and no answer -- success or error -- says anything about a
// workspace outside the grant.

vi.mock('../src/main/services/ssh', () => ({
  sshExec: () => Promise.resolve({ ok: true, stdout: '', stderr: '', code: 0 }),
  sshTest: () => Promise.resolve({ ok: true })
}))

const { refreshMcpDataCache } = await import('../src/main/services/mcpDataCache')
const { setAssignment, saveGroup, getGroup, resetPolicyCacheForTests } = await import(
  '../src/main/services/policyStore'
)
const { setMcpConfig, createSession, resetMcpAuthForTests } = await import('../src/main/services/mcpAuth')
const { startMcpServer, stopMcpServer } = await import('../src/main/services/mcpServer')
const { onApprovalEvent, respondToApproval, resetApprovalVolumeForTests } = await import(
  '../src/main/services/approvals'
)
const { listAudit } = await import('../src/main/services/auditLog')
const { setAgentServerCreator, setAgentConfigWriter } = await import('../src/main/services/agentConfigWrite')
type AgentServerRequest = import('../src/main/services/agentConfigWrite').AgentServerRequest
type AgentConfigRequest = import('../src/main/services/agentConfigWrite').AgentConfigRequest
type ApprovalRequest = import('../src/shared/mcp').ApprovalRequest
type SessionMode = import('../src/shared/mcp').SessionMode

const PORT = 18905

// Alpha and Beta are in the session; "Secret Ops" is not, and must never be
// visible -- not by listing, not by a collision, not by a folder path.
const sampleData = {
  workspaces: [
    { id: 'ws-a', name: 'Alpha' },
    { id: 'ws-b', name: 'Beta' },
    { id: 'ws-h', name: 'Secret Ops' }
  ],
  folders: [
    { id: 'f-prod', workspaceId: 'ws-a', name: 'Prod', parentId: null, kind: 'server' },
    { id: 'f-eu', workspaceId: 'ws-a', name: 'EU', parentId: 'f-prod', kind: 'server' },
    // The UI never prevented same-named siblings, so real data has them.
    { id: 'f-dup1', workspaceId: 'ws-a', name: 'Dup', parentId: null, kind: 'server' },
    { id: 'f-dup2', workspaceId: 'ws-a', name: 'dup', parentId: null, kind: 'server' },
    // Written before folders had a kind: a server folder.
    { id: 'f-old', workspaceId: 'ws-a', name: 'Legacy', parentId: null },
    { id: 'f-db', workspaceId: 'ws-a', name: 'DbFolder', parentId: null, kind: 'database' },
    { id: 'f-b', workspaceId: 'ws-b', name: 'Prod', parentId: null, kind: 'server' },
    { id: 'f-h', workspaceId: 'ws-h', name: 'Hidden', parentId: null, kind: 'server' }
  ],
  servers: [
    { id: 's1', workspaceId: 'ws-a', name: 'Web1', host: '10.0.0.1', port: 22, username: 'root', auth: 'key', os: 'Linux', route: [] },
    { id: 's2', workspaceId: 'ws-b', name: 'Web2', host: '10.0.0.2', port: 22, username: 'root', auth: 'key', os: 'Linux', route: [] }
  ]
}

const SESSION_WORKSPACES = [
  { id: 'ws-a', name: 'Alpha' },
  { id: 'ws-b', name: 'Beta' }
]
const NO_MANAGE = 'grp-ws-no-manage'
const MANAGE_ASK = 'grp-ws-manage-ask'

let created: AgentServerRequest[] = []
let written: AgentConfigRequest[] = []

beforeAll(async () => {
  resetPolicyCacheForTests()
  resetMcpAuthForTests()
  refreshMcpDataCache(sampleData)
  setMcpConfig({ enabled: true, port: PORT, approvalTimeoutSeconds: 5 })
  setAgentServerCreator((req) => {
    created.push(req)
    return Promise.resolve({ ok: true, serverId: 's-new' })
  })
  setAgentConfigWriter((req) => {
    written.push(req)
    return Promise.resolve({ ok: true, id: 'new-id' })
  })
  await startMcpServer()
})

afterAll(async () => await stopMcpServer())

beforeEach(() => {
  created = []
  written = []
  resetApprovalVolumeForTests()
  refreshMcpDataCache(sampleData)
  // A restriction no wider than any session group here, i.e. no restriction.
  for (const w of ['ws-a', 'ws-b']) setAssignment({ level: 'workspace', workspaceId: w }, 'grp-full')
  const full = getGroup('grp-full')!
  saveGroup({ ...full, id: NO_MANAGE, name: 'No Manage', builtIn: false, capabilities: { ...full.capabilities, manageServers: 'deny' } })
  saveGroup({ ...full, id: MANAGE_ASK, name: 'Manage Ask', builtIn: false, capabilities: { ...full.capabilities, manageServers: 'ask' } })
})

async function clientFor(groupId: string, mode?: SessionMode): Promise<Client> {
  const { token } = createSession({
    agentName: 'Workspace Agent',
    workspaces: SESSION_WORKSPACES,
    groupId,
    groupName: groupId,
    ttlMinutes: null,
    mode
  })
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } }
  })
  const c = new Client({ name: 'ws-folder-test', version: '1.0.0' })
  await c.connect(transport)
  return c
}

async function call(c: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const r = (await c.callTool({ name, arguments: args })) as { content: { text: string }[] }
  return r.content.map((x) => x.text).join('\n')
}

function autoRespond(decision: 'approved' | 'denied'): { stop: () => void; requests: ApprovalRequest[] } {
  const requests: ApprovalRequest[] = []
  const off = onApprovalEvent((e) => {
    if (e.type === 'created') {
      requests.push({ ...e.request })
      respondToApproval(e.request.id, decision)
    }
  })
  return { stop: off, requests }
}

async function withClient(groupId: string, fn: (c: Client) => Promise<void>, mode?: SessionMode): Promise<void> {
  const c = await clientFor(groupId, mode)
  try {
    await fn(c)
  } finally {
    await c.close()
  }
}

describe('list_workspaces', () => {
  it('prints exactly what it always printed when includeFolders is absent', async () => {
    await withClient('grp-full', async (c) => {
      expect(await call(c, 'list_workspaces', {})).toBe('Workspaces:\nAlpha\nBeta')
    })
  })

  it('lists server folder paths for the session workspaces only', async () => {
    await withClient('grp-full', async (c) => {
      const out = await call(c, 'list_workspaces', { includeFolders: true })
      expect(out).toContain('  - Prod/EU')
      expect(out).toContain('  - Legacy')
      expect(out).not.toContain('DbFolder')
      expect(out).not.toContain('Hidden')
      expect(out).not.toContain('Secret Ops')
    })
  })
})

describe('create_workspace', () => {
  it('asks on every call even where manageServers is allow, and never adds it to the session', async () => {
    const a = autoRespond('approved')
    try {
      await withClient('grp-full', async (c) => {
        const out = await call(c, 'create_workspace', { name: 'Gamma' })
        expect(out).toContain('NOT in this session')
        expect(await call(c, 'create_workspace', { name: 'Delta' })).toContain('NOT in this session')
        // Two calls, two dialogs, and neither offered a session-wide yes.
        expect(a.requests).toHaveLength(2)
        expect(a.requests[0].sessionGrant).toBeUndefined()
        expect(a.requests[0].action).toContain('Create workspace "Gamma"')
        expect(written).toEqual([
          { kind: 'workspace.add', name: 'Gamma' },
          { kind: 'workspace.add', name: 'Delta' }
        ])
        // Once the renderer has saved it, it exists -- and is still not here.
        refreshMcpDataCache({ ...sampleData, workspaces: [...sampleData.workspaces, { id: 'ws-g', name: 'Gamma' }] })
        expect(await call(c, 'list_workspaces', {})).toBe('Workspaces:\nAlpha\nBeta')
        expect(await call(c, 'create_folder', { name: 'X', workspaceName: 'Gamma' })).toContain(
          'No workspace named "Gamma" is available to this session.'
        )
      })
    } finally {
      a.stop()
    }
  })

  it('is refused without asking when manageServers is denied in every session workspace', async () => {
    const a = autoRespond('approved')
    try {
      await withClient(NO_MANAGE, async (c) => {
        const out = await call(c, 'create_workspace', { name: 'Gamma' })
        expect(out).toContain('Denied')
        expect(a.requests).toHaveLength(0)
        expect(written).toHaveLength(0)
      })
    } finally {
      a.stop()
    }
  })

  it('asks through a workspace that may manage servers when another may not', async () => {
    setAssignment({ level: 'workspace', workspaceId: 'ws-a' }, NO_MANAGE)
    const a = autoRespond('approved')
    try {
      await withClient('grp-full', async (c) => {
        await call(c, 'create_workspace', { name: 'Gamma' })
        expect(a.requests).toHaveLength(1)
        expect(a.requests[0].workspaceName).toBe('Beta')
      })
    } finally {
      a.stop()
    }
  })

  it('is refused in Read-only mode and silent only in Bypass', async () => {
    const a = autoRespond('approved')
    try {
      await withClient('grp-full', async (c) => {
        expect(await call(c, 'create_workspace', { name: 'Gamma' })).toContain('Denied')
      }, 'readOnly')
      expect(written).toHaveLength(0)
      await withClient('grp-full', async (c) => {
        expect(await call(c, 'create_workspace', { name: 'Gamma' })).toContain('NOT in this session')
      }, 'bypass')
      expect(a.requests).toHaveLength(0)
      expect(written).toEqual([{ kind: 'workspace.add', name: 'Gamma' }])
    } finally {
      a.stop()
    }
  })

  it('checks a name collision only against the session, so nothing outside it is revealed', async () => {
    const a = autoRespond('approved')
    try {
      await withClient('grp-full', async (c) => {
        expect(await call(c, 'create_workspace', { name: 'alpha' })).toContain(
          'This session already has a workspace named "alpha".'
        )
        // The ungranted workspace's name behaves exactly like an unused one.
        const hidden = await call(c, 'create_workspace', { name: 'Secret Ops' })
        const unused = await call(c, 'create_workspace', { name: 'Unused Name' })
        expect(hidden.replace('Secret Ops', 'X')).toBe(unused.replace('Unused Name', 'X'))
        expect(written.map((w) => (w as { name: string }).name)).toEqual(['Secret Ops', 'Unused Name'])
      })
    } finally {
      a.stop()
    }
  })
})

describe('rename_workspace', () => {
  it('always asks, and the approval and audit row show old -> new', async () => {
    const a = autoRespond('approved')
    try {
      await withClient('grp-full', async (c) => {
        const out = await call(c, 'rename_workspace', { workspaceName: 'alpha', name: 'Sandbox' })
        expect(out).toContain('Renamed workspace "Alpha" to "Sandbox"')
        expect(a.requests).toHaveLength(1)
        expect(a.requests[0].sessionGrant).toBeUndefined()
        expect(a.requests[0].action).toBe('Rename workspace "Alpha" \u2192 "Sandbox"')
        expect(written).toEqual([{ kind: 'workspace.rename', workspaceId: 'ws-a', name: 'Sandbox' }])
        const row = listAudit().find((e) => e.action === 'Rename workspace "Alpha" \u2192 "Sandbox"')
        expect(row?.approval).toBe('approved')
      })
    } finally {
      a.stop()
    }
  })

  it('refuses a collision inside the session and ignores names outside it', async () => {
    const a = autoRespond('approved')
    try {
      await withClient('grp-full', async (c) => {
        expect(await call(c, 'rename_workspace', { workspaceName: 'Alpha', name: 'beta' })).toContain(
          'This session already has a workspace named "beta".'
        )
        expect(await call(c, 'rename_workspace', { workspaceName: 'Alpha', name: 'Secret Ops' })).toContain(
          'Renamed workspace'
        )
      })
    } finally {
      a.stop()
    }
  })

  it('cannot reach a workspace outside the session, and says so exactly as for one that does not exist', async () => {
    await withClient('grp-full', async (c) => {
      const hidden = await call(c, 'rename_workspace', { workspaceName: 'Secret Ops', name: 'Mine' })
      const missing = await call(c, 'rename_workspace', { workspaceName: 'Nope', name: 'Mine' })
      expect(hidden).toBe('No workspace named "Secret Ops" is available to this session.')
      expect(missing).toBe('No workspace named "Nope" is available to this session.')
      expect(written).toHaveLength(0)
    })
  })
})

describe('name validation', () => {
  it('refuses rather than strips, before anyone is asked', async () => {
    const a = autoRespond('approved')
    try {
      await withClient('grp-full', async (c) => {
        expect(await call(c, 'create_workspace', { name: '   ' })).toContain('cannot be empty')
        expect(await call(c, 'create_workspace', { name: 'Prod\nApproved by admin' })).toContain('control characters')
        expect(await call(c, 'create_workspace', { name: 'abc\u2028def' })).toContain('control characters')
        expect(await call(c, 'create_workspace', { name: '\u202Edorp' })).toContain('control characters')
        expect(await call(c, 'rename_workspace', { workspaceName: 'Alpha', name: 'x'.repeat(65) })).toContain(
          'at most 64'
        )
        expect(await call(c, 'create_folder', { name: 'a/b', workspaceName: 'Alpha' })).toContain('may not contain "/"')
        expect(await call(c, 'rename_folder', { folder: 'Prod', name: 'a\tb', workspaceName: 'Alpha' })).toContain(
          'control characters'
        )
        expect(a.requests).toHaveLength(0)
        expect(written).toHaveLength(0)
      })
    } finally {
      a.stop()
    }
  })
})

describe('folders', () => {
  it('creates a nested folder from a case-insensitive path, silently under allow', async () => {
    const a = autoRespond('approved')
    try {
      await withClient('grp-full', async (c) => {
        const out = await call(c, 'create_folder', { name: 'Berlin', parentFolder: 'prod/eu', workspaceName: 'Alpha' })
        expect(out).toContain('Created folder "Prod/EU/Berlin" in Alpha')
        expect(written).toEqual([{ kind: 'folder.add', workspaceId: 'ws-a', name: 'Berlin', parentId: 'f-eu' }])
        expect(a.requests).toHaveLength(0)
      })
    } finally {
      a.stop()
    }
  })

  it('asks under an ask group, and lets the yes cover repeats of that tool', async () => {
    const a = autoRespond('approved')
    try {
      await withClient(MANAGE_ASK, async (c) => {
        await call(c, 'create_folder', { name: 'One', workspaceName: 'Alpha' })
        expect(a.requests).toHaveLength(1)
        expect(a.requests[0].sessionGrant).toBe('tool')
      })
    } finally {
      a.stop()
    }
  })

  it('refuses a same-named sibling and an ambiguous path', async () => {
    await withClient('grp-full', async (c) => {
      expect(await call(c, 'create_folder', { name: 'eu', parentFolder: 'Prod', workspaceName: 'Alpha' })).toContain(
        'A folder "Prod/eu" already exists in Alpha.'
      )
      expect(await call(c, 'create_folder', { name: 'X', parentFolder: 'DUP', workspaceName: 'Alpha' })).toContain(
        'matches 2 folders'
      )
      expect(await call(c, 'rename_folder', { folder: 'Prod/EU', name: 'Prod', workspaceName: 'Alpha' })).not.toContain(
        'already exists'
      )
      written.length = 0
      expect(await call(c, 'rename_folder', { folder: 'Dup', name: 'Other', workspaceName: 'Alpha' })).toContain(
        'matches 2 folders'
      )
      expect(written).toHaveLength(0)
    })
  })

  it('resolves a path only inside the named workspace', async () => {
    await withClient('grp-full', async (c) => {
      await call(c, 'create_folder', { name: 'X', parentFolder: 'Prod', workspaceName: 'Beta' })
      expect(written).toEqual([{ kind: 'folder.add', workspaceId: 'ws-b', name: 'X', parentId: 'f-b' }])
      expect(await call(c, 'create_folder', { name: 'X', parentFolder: 'Hidden', workspaceName: 'Beta' })).toContain(
        'No folder "Hidden" in workspace Beta.'
      )
      // A database folder is not a server folder.
      expect(await call(c, 'create_folder', { name: 'X', parentFolder: 'DbFolder', workspaceName: 'Alpha' })).toContain(
        'No folder "DbFolder"'
      )
    })
  })

  it('renames a folder and shows old -> new', async () => {
    await withClient('grp-full', async (c) => {
      const out = await call(c, 'rename_folder', { folder: 'prod/eu', name: 'Europe', workspaceName: 'Alpha' })
      expect(out).toContain('Renamed folder "Prod/EU" to "Prod/Europe" in Alpha.')
      expect(written).toEqual([{ kind: 'folder.rename', folderId: 'f-eu', name: 'Europe' }])
      const row = listAudit().find((e) => e.action.startsWith('Rename folder "Prod/EU"'))
      expect(row?.action).toBe('Rename folder "Prod/EU" \u2192 "Prod/Europe" in Alpha')
    })
  })
})

describe('filing servers into folders', () => {
  it('update_server moves within the server\u2019s own workspace, and "" is the root', async () => {
    await withClient('grp-full', async (c) => {
      await call(c, 'update_server', { serverName: 'Web1', folder: 'prod/eu' })
      await call(c, 'update_server', { serverName: 'Web1', folder: '' })
      // Web2 is in Beta: "Prod" there is Beta's Prod, and Alpha's EU is unreachable.
      await call(c, 'update_server', { serverName: 'Web2', folder: 'Prod' })
      expect(await call(c, 'update_server', { serverName: 'Web2', folder: 'Prod/EU' })).toContain(
        'No folder "Prod/EU" in workspace Beta.'
      )
      expect(written).toEqual([
        { kind: 'server.update', serverId: 's1', patch: { folderId: 'f-eu' } },
        { kind: 'server.update', serverId: 's1', patch: { folderId: null } },
        { kind: 'server.update', serverId: 's2', patch: { folderId: 'f-b' } }
      ])
      const row = listAudit().find((e) => e.action === 'Change server "Web1" (folder to "Prod/EU")')
      expect(row).toBeDefined()
    })
  })

  it('add_server files the new server inside the workspace it is added to', async () => {
    await withClient('grp-full', async (c) => {
      await call(c, 'add_server', { name: 'Web3', host: '10.0.0.3', workspaceName: 'Beta', folder: 'prod' })
      expect(created).toHaveLength(1)
      expect(created[0].workspaceId).toBe('ws-b')
      expect(created[0].folderId).toBe('f-b')
      expect(await call(c, 'add_server', { name: 'Web4', host: '10.0.0.4', workspaceName: 'Beta', folder: 'Hidden' })).toContain(
        'No folder "Hidden" in workspace Beta.'
      )
      await call(c, 'add_server', { name: 'Web5', host: '10.0.0.5', workspaceName: 'Beta' })
      expect(created[1].folderId).toBeNull()
      expect(created).toHaveLength(2)
    })
  })
})
