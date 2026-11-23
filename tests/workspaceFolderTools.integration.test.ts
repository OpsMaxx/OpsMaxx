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
const { setMcpConfig, createSession, revokeSession, resetMcpAuthForTests } = await import('../src/main/services/mcpAuth')
const { startMcpServer, stopMcpServer } = await import('../src/main/services/mcpServer')
const { onApprovalEvent, respondToApproval, resetApprovalVolumeForTests } = await import(
  '../src/main/services/approvals'
)
const { listAudit } = await import('../src/main/services/auditLog')
const { describeConsequence } = await import('../src/shared/approvalRisk')
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
    { id: 'f-h', workspaceId: 'ws-h', name: 'Hidden', parentId: null, kind: 'server' },
    // Three a path can never reach: a "/" in the name, a parent that is gone,
    // and a parent in another workspace.
    { id: 'f-slash', workspaceId: 'ws-a', name: 'a/b', parentId: null, kind: 'server' },
    { id: 'f-orphan', workspaceId: 'ws-a', name: 'Orphan', parentId: 'f-gone', kind: 'server' },
    { id: 'f-cross', workspaceId: 'ws-a', name: 'Cross', parentId: 'f-b', kind: 'server' }
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
// allow, with Confirm risky actions on: adds are silent, connection rewrites ask.
const MANAGE_CONFIRM = 'grp-ws-manage-confirm'
// May manage servers but not see them.
const BLIND = 'grp-ws-blind'

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
  saveGroup({ ...full, id: MANAGE_CONFIRM, name: 'Manage Confirm', builtIn: false, confirmRisky: true, capabilities: { ...full.capabilities, manageServers: 'allow' } })
  saveGroup({ ...full, id: BLIND, name: 'Blind', builtIn: false, capabilities: { ...full.capabilities, viewServer: 'deny', manageServers: 'allow' } })
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
        // The dialog reads the action this tool built; it must not say "adds a server".
        expect(describeConsequence(a.requests[0]).text).toContain('not granted to any AI session')
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
        expect(describeConsequence(a.requests[0]).text).toContain('\u201cAlpha\u201d to \u201cSandbox\u201d')
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
        expect(await call(c, 'create_workspace', { name: 'Prod\nApproved by admin' })).toContain('invisible, control or text-direction')
        expect(await call(c, 'create_workspace', { name: 'abc\u2028def' })).toContain('invisible, control or text-direction')
        expect(await call(c, 'create_workspace', { name: '\u202Edorp' })).toContain('invisible, control or text-direction')
        expect(await call(c, 'rename_workspace', { workspaceName: 'Alpha', name: 'x'.repeat(65) })).toContain(
          'at most 64'
        )
        expect(await call(c, 'create_folder', { name: 'a/b', workspaceName: 'Alpha' })).toContain('may not contain "/"')
        expect(await call(c, 'rename_folder', { folder: 'Prod', name: 'a\tb', workspaceName: 'Alpha' })).toContain(
          'invisible, control or text-direction'
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
        expect(describeConsequence(a.requests[0]).text).toContain('server folder \u201cOne\u201d')
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
      const row = listAudit().find((e) => e.action === 'Move server "Web1" to folder "Prod/EU" in Alpha')
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

// The user can take a workspace out of a live session -- or revoke it -- while
// one of its approval cards is still open. A yes clicked afterwards was about
// a session that no longer reaches that workspace, so gate() re-reads the
// session after the answer and refuses.
describe('a session that changes while its approval waits', () => {
  async function pendingCall(change: (sessionId: string, session: { workspaces: { id: string; name: string }[] }) => void): Promise<string> {
    const { session, token } = createSession({
      agentName: 'Shrinking Agent',
      workspaces: SESSION_WORKSPACES,
      groupId: MANAGE_ASK,
      groupName: MANAGE_ASK,
      ttlMinutes: null
    })
    const off = onApprovalEvent((e) => {
      if (e.type === 'created') {
        change(session.id, session)
        respondToApproval(e.request.id, 'approved')
      }
    })
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } }
    })
    const c = new Client({ name: 'ws-shrink-test', version: '1.0.0' })
    await c.connect(transport)
    try {
      return await call(c, 'create_folder', { name: 'Late', workspaceName: 'Alpha' })
    } finally {
      off()
      await c.close()
    }
  }

  it('refuses when the workspace was taken out of the session', async () => {
    const out = await pendingCall((_, session) => {
      session.workspaces = [{ id: 'ws-b', name: 'Beta' }]
    })
    expect(out).toBe('Denied: This session no longer has access to that workspace.')
    expect(written).toHaveLength(0)
    const row = listAudit().find((e) => e.action === 'Create folder "Late" in Alpha')
    expect(row?.result).toBe('denied')
  })

  it('refuses when the session was revoked', async () => {
    const out = await pendingCall((id) => revokeSession(id))
    expect(out).toContain('revoked or expired while the request waited')
    expect(written).toHaveLength(0)
  })

  it('refuses when the session expired', async () => {
    const out = await pendingCall((_, session) => {
      ;(session as unknown as { expiresAt: string | null }).expiresAt = new Date(Date.now() - 1000).toISOString()
    })
    expect(out).toContain('revoked or expired while the request waited')
    expect(written).toHaveLength(0)
  })

  it('refuses when the workspace was deleted', async () => {
    const out = await pendingCall(() =>
      refreshMcpDataCache({ ...sampleData, workspaces: sampleData.workspaces.filter((w) => w.id !== 'ws-a') })
    )
    expect(out).toBe('Denied: That workspace was deleted while the request waited, so nothing ran.')
    expect(written).toHaveLength(0)
  })

  it('still runs when nothing changed', async () => {
    const out = await pendingCall(() => undefined)
    expect(out).toContain('Created folder "Late"')
    expect(written).toHaveLength(1)
  })
})

describe('review round 1', () => {
  it('refuses invisible, quoting, stacked, and mixed-script names, and stores NFC', async () => {
    const a = autoRespond('approved')
    try {
      await withClient('grp-full', async (c) => {
        for (const bad of ['Pro\u200Bd', '\uFEFFProd', 'Prod\u200E', 'Pro\u00ADd', 'Prod\u3164', 'Prod\uFE0F'])
          expect(await call(c, 'create_workspace', { name: bad })).toContain('invisible, control or text-direction')
        expect(await call(c, 'create_workspace', { name: 'say "hi"' })).toContain('quotation marks')
        expect(await call(c, 'create_workspace', { name: '\u201cProd\u201d' })).toContain('quotation marks')
        expect(await call(c, 'create_workspace', { name: 'a\u0301\u0301\u0301' })).toContain('combining marks')
        // A Cyrillic "o" inside a Latin word.
        expect(await call(c, 'create_workspace', { name: 'Pr\u043Ed' })).toContain('may not mix Latin and Cyrillic')
        expect(a.requests).toHaveLength(0)
        expect(written).toHaveLength(0)
        // Wholly Cyrillic is fine; a decomposed accent is stored composed.
        await call(c, 'create_workspace', { name: '\u041F\u0440\u043E\u0434' })
        await call(c, 'create_workspace', { name: 'Cafe\u0301' })
        expect(written).toEqual([
          { kind: 'workspace.add', name: '\u041F\u0440\u043E\u0434' },
          { kind: 'workspace.add', name: 'Caf\u00E9' }
        ])
        // Compatibility forms collide: full-width ALPHA is Alpha.
        expect(await call(c, 'create_workspace', { name: '\uFF21\uFF2C\uFF30\uFF28\uFF21' })).toContain(
          'already has a workspace'
        )
      })
    } finally {
      a.stop()
    }
  })

  it('records the new workspace id on the success row', async () => {
    const a = autoRespond('approved')
    try {
      await withClient('grp-full', async (c) => {
        await call(c, 'create_workspace', { name: 'Epsilon' })
      })
      const row = listAudit().find((e) => e.action.startsWith('Create workspace "Epsilon"') && e.result === 'success')
      expect(row?.serverId).toBe('workspace:new-id')
    } finally {
      a.stop()
    }
  })

  it('still asks to rename a workspace under Bypass', async () => {
    const a = autoRespond('approved')
    try {
      await withClient(
        'grp-full',
        async (c) => {
          expect(await call(c, 'rename_workspace', { workspaceName: 'Alpha', name: 'Zeta' })).toContain('Renamed')
        },
        'bypass'
      )
      expect(a.requests).toHaveLength(1)
    } finally {
      a.stop()
    }
  })

  it('refuses create_workspace under Bypass when every granted workspace denies manageServers', async () => {
    setAssignment({ level: 'workspace', workspaceId: 'ws-a' }, NO_MANAGE)
    setAssignment({ level: 'workspace', workspaceId: 'ws-b' }, NO_MANAGE)
    await withClient(
      'grp-full',
      async (c) => {
        expect(await call(c, 'create_workspace', { name: 'Gamma' })).toContain('denied in all of them')
      },
      'bypass'
    )
    expect(written).toHaveLength(0)
  })

  it('refuses before any lookup, so a refused session learns nothing about names or folders', async () => {
    await withClient(NO_MANAGE, async (c) => {
      const taken = await call(c, 'add_server', { name: 'Web1', host: '10.0.0.9', workspaceName: 'Alpha' })
      const free = await call(c, 'add_server', { name: 'Fresh', host: '10.0.0.9', workspaceName: 'Alpha' })
      expect(taken).toContain('Denied')
      expect(taken.replace('Web1', 'X')).toBe(free.replace('Fresh', 'X'))
      for (const parentFolder of ['Prod', 'Nope', 'Dup'])
        expect(await call(c, 'create_folder', { name: 'X', parentFolder, workspaceName: 'Alpha' })).toContain('Denied')
      expect(await call(c, 'rename_folder', { folder: 'Nope', name: 'X', workspaceName: 'Alpha' })).toContain('Denied')
      expect(await call(c, 'update_server', { serverName: 'Web1', folder: 'Nope' })).toContain('Denied')
    })
    expect(written).toHaveLength(0)
    expect(created).toHaveLength(0)
  })

  it('gives one folder error when the session may not see the workspace servers', async () => {
    await withClient(BLIND, async (c) => {
      const outs = [
        await call(c, 'create_folder', { name: 'X', parentFolder: 'Nope', workspaceName: 'Alpha' }),
        await call(c, 'create_folder', { name: 'X', parentFolder: 'Dup', workspaceName: 'Alpha' }),
        await call(c, 'create_folder', { name: 'Prod', workspaceName: 'Alpha' }),
        await call(c, 'rename_folder', { folder: 'Nope', name: 'X', workspaceName: 'Alpha' })
      ]
      for (const out of outs) expect(out).toBe('That folder path cannot be used in workspace Alpha.')
    })
  })

  it('moves a server between folders without the connection-rewrite ask, and asks for a mixed change', async () => {
    const a = autoRespond('approved')
    try {
      await withClient(MANAGE_CONFIRM, async (c) => {
        await call(c, 'update_server', { serverName: 'Web1', folder: 'Prod' })
        expect(a.requests).toHaveLength(0)
        await call(c, 'update_server', { serverName: 'Web1', folder: 'Prod/EU', port: 2222 })
        expect(a.requests).toHaveLength(1)
        expect(a.requests[0].action).toBe('Change server "Web1" (port to 2222, folder to "Prod/EU")')
      })
      expect(written).toHaveLength(2)
    } finally {
      a.stop()
    }
  })

  it('describes a folder move from fields, under an ask group', async () => {
    const a = autoRespond('approved')
    try {
      await withClient(MANAGE_ASK, async (c) => {
        await call(c, 'update_server', { serverName: 'Web1', folder: '' })
      })
      expect(a.requests[0].structural).toEqual({ kind: 'folderMove', server: 'Web1', to: null })
      expect(describeConsequence(a.requests[0]).text).toContain('root of the same workspace')
    } finally {
      a.stop()
    }
  })

  it('lists only folders a path reaches, and counts the rest', async () => {
    await withClient('grp-full', async (c) => {
      const out = await call(c, 'list_workspaces', { includeFolders: true })
      expect(out).toContain("(3 folder(s) can't be addressed by path)")
      expect(out).not.toContain('Orphan')
      expect(out).not.toContain('Cross')
      expect(out).not.toContain('a/b')
      expect(await call(c, 'update_server', { serverName: 'Web1', folder: 'Orphan' })).toContain('No folder "Orphan"')
    })
  })
})
