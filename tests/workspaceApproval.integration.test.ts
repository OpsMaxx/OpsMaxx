import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { ApprovalRequest } from '../src/shared/mcp'

// AN `ask` ON A WORKSPACE-WIDE READ IS PUT TO A HUMAN.
//
// fleet_inventory, list_alerts, fleet_drift, backup_status and
// list_ci_connections name no server. gate() used to refuse every `ask` that
// named no server -- "an approval needs a single server to name" -- so setting
// fleetRead, backupRead or ciRead to Ask behaved exactly like Deny, and nobody
// was ever asked. The request now names the workspace, and a session grant on
// it is keyed session + workspace + TOOL + rule: a different kind of key from a
// server's, so neither can answer the other, workspace A's grant cannot answer
// workspace B, and a yes to list_alerts does not buy fleet_drift.

const { refreshMcpDataCache } = await import('../src/main/services/mcpDataCache')
const { setAssignment, saveGroup, getGroup, resetPolicyCacheForTests } = await import('../src/main/services/policyStore')
const { setMcpConfig, createSession, resetMcpAuthForTests } = await import('../src/main/services/mcpAuth')
const {
  startMcpServer,
  stopMcpServer,
  setFleetReader,
  setAlertReader,
  setBackupReader,
  clearAllSessionElevations,
  gateForTests
} = await import('../src/main/services/mcpServer')
const { listAudit } = await import('../src/main/services/auditLog')
const { onApprovalEvent, respondToApproval, resetApprovalVolumeForTests } = await import('../src/main/services/approvals')
const { auditOutcome } = await import('../src/renderer/src/components/ai/auditOutcome')

const PORT = 18891
const ASK = 'grp-ws-ask'
const ALPHA = { id: 'wsA', name: 'Alpha' }
const BETA = { id: 'wsB', name: 'Beta' }

beforeAll(async () => {
  resetPolicyCacheForTests()
  resetMcpAuthForTests()
  refreshMcpDataCache({
    workspaces: [ALPHA, BETA],
    servers: [
      { id: 'sA', workspaceId: 'wsA', name: 'AlphaBox', host: '10.0.0.1', port: 22, username: 'root', auth: 'key', os: 'Linux', route: [] },
      { id: 'sB', workspaceId: 'wsB', name: 'BetaBox', host: '10.0.0.2', port: 22, username: 'root', auth: 'key', os: 'Linux', route: [] }
    ],
    cicdConnections: [{ id: 'ciA', workspaceId: 'wsA', name: 'alpha-gitlab', provider: 'gitlab', enabled: true }]
  })
  const full = getGroup('grp-full')!
  saveGroup({
    ...full,
    id: ASK,
    name: 'Workspace Ask',
    builtIn: false,
    capabilities: { ...full.capabilities, fleetRead: 'ask', backupRead: 'ask', ciRead: 'ask' }
  })
  setAssignment({ level: 'workspace', workspaceId: 'wsA' }, ASK)
  setAssignment({ level: 'workspace', workspaceId: 'wsB' }, ASK)
  setFleetReader({
    factsFor: () => ({ facts: { osName: 'Ubuntu', osVersion: '24.04', updates: { count: 3, security: 1 } }, at: Date.now() }),
    driftFor: () => ({ drift: { at: Date.now(), readings: [{ watchId: 'sshd_config', status: 'changed' }] }, at: Date.now() })
  })
  setAlertReader(() => [{ at: Date.now(), serverId: 'sA', serverName: 'AlphaBox', kind: 'cpu', event: 'CPU ran hot' }])
  setBackupReader(() => ({ destinations: [{ id: 'd1', name: 'Nightly offsite', kind: 'sftp' }], alarms: [] }))
  setMcpConfig({ enabled: true, port: PORT, approvalTimeoutSeconds: 5 })
  await startMcpServer()
})

afterAll(async () => await stopMcpServer())

// How the "operator" answers, per request, and everything they were shown.
let answer: (r: ApprovalRequest) => ['approved' | 'denied', ('once' | 'session')?] = () => ['denied']
let asked: ApprovalRequest[] = []
const off = onApprovalEvent((e) => {
  if (e.type !== 'created') return
  asked.push(e.request)
  const [decision, scope] = answer(e.request)
  respondToApproval(e.request.id, decision, scope)
})
afterAll(() => off())

beforeEach(() => {
  resetApprovalVolumeForTests()
  asked = []
  answer = () => ['denied']
})

async function session(
  workspaces = [ALPHA]
): Promise<{ c: Client; id: string; s: ReturnType<typeof createSession>['session'] }> {
  const { token, session: s } = createSession({
    agentName: 'Workspace Reader',
    workspaces,
    groupId: ASK,
    groupName: 'Workspace Ask',
    ttlMinutes: null
  })
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } }
  })
  const c = new Client({ name: 'workspace-approval', version: '1.0.0' })
  await c.connect(transport)
  return { c, id: s.id, s }
}

async function call(c: Client, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const r = (await c.callTool({ name, arguments: args })) as { content: { text: string }[] }
  return r.content.map((x) => x.text).join('\n')
}

const rowsFor = (sessionId: string): ReturnType<typeof listAudit> => listAudit().filter((e) => e.sessionId === sessionId)

const TOOLS = [
  { tool: 'fleet_inventory', capability: 'fleetRead', data: /AlphaBox[\s\S]*1 security/ },
  { tool: 'list_alerts', capability: 'fleetRead', data: /CPU ran hot/ },
  { tool: 'fleet_drift', capability: 'fleetRead', data: /AlphaBox — 1 of 1 watched file/ },
  { tool: 'backup_status', capability: 'backupRead', data: /Nightly offsite/ },
  { tool: 'list_ci_connections', capability: 'ciRead', data: /alpha-gitlab — gitlab/ }
] as const

describe('an ask on a workspace-wide read', () => {
  it.each(TOOLS)('$tool: asks about the workspace, and an approval returns the data', async ({ tool, capability, data }) => {
    answer = () => ['approved', 'once']
    const { c, id } = await session()
    try {
      expect(await call(c, tool)).toMatch(data)
      expect(asked).toHaveLength(1)
      // The question names the workspace and no server -- the dialog renders
      // that as "the Alpha workspace", never as an empty or null server.
      expect(asked[0]).toMatchObject({
        workspaceId: 'wsA',
        workspaceName: 'Alpha',
        serverId: null,
        serverName: null,
        capability,
        toolName: tool,
        // Narrowed to the tool: see "how far a yes about a workspace reaches".
        sessionGrant: 'tool'
      })
      const rows = rowsFor(id)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ approval: 'approved', result: 'success', serverId: null, workspaceId: 'wsA' })
    } finally {
      await c.close()
    }
  })

  it.each(TOOLS)('$tool: a denial refuses it, and the row says you refused it', async ({ tool, data }) => {
    answer = () => ['denied']
    const { c, id } = await session()
    try {
      const out = await call(c, tool)
      expect(out).toMatch(/Denied: the user rejected this action/)
      expect(out).not.toMatch(data)
      expect(asked).toHaveLength(1)
      const rows = rowsFor(id)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ approval: 'denied', result: 'denied', serverId: null, workspaceId: 'wsA' })
      expect(auditOutcome(rows[0]).label).toBe('Denied')
    } finally {
      await c.close()
    }
  })

  it('does not ask again straight after a denial, and records that nobody was asked', async () => {
    const { c, id } = await session()
    try {
      await call(c, 'fleet_inventory')
      expect(await call(c, 'fleet_inventory')).toMatch(/did not ask/)
      expect(asked).toHaveLength(1)
      expect(rowsFor(id)[0]).toMatchObject({ approval: 'not-asked', result: 'denied' })
    } finally {
      await c.close()
    }
  })
})

describe('how far a yes about a workspace reaches', () => {
  it('"Approve once" is one call: the next one asks again', async () => {
    answer = () => ['approved', 'once']
    const { c } = await session()
    try {
      await call(c, 'fleet_inventory')
      await call(c, 'fleet_inventory')
      expect(asked).toHaveLength(2)
    } finally {
      await c.close()
    }
  })

  it('a session grant carries later calls of that tool on that workspace, audited as approved earlier', async () => {
    answer = () => ['approved', 'session']
    const { c, id } = await session()
    try {
      await call(c, 'fleet_inventory')
      expect(await call(c, 'fleet_inventory')).toMatch(/AlphaBox/)
      expect(asked).toHaveLength(1)
      const [second, first] = rowsFor(id)
      expect(first.approval).toBe('approved-for-session')
      expect(second.approval).toBe('approved-earlier')
    } finally {
      await c.close()
    }
  })

  // fleetRead covers all three fleet reads, and they are graded low (alerts),
  // medium (inventory) and high (drift). A grant keyed on the capability let a
  // yes to the first buy the last without a dialog.
  it.each(['list_alerts', 'fleet_inventory'])('a session grant on %s does not cover fleet_drift', async (first) => {
    answer = () => ['approved', 'session']
    const { c } = await session()
    try {
      await call(c, first)
      await call(c, 'fleet_drift')
      expect(asked.map((r) => r.toolName)).toEqual([first, 'fleet_drift'])
    } finally {
      await c.close()
    }
  })

  it('a workspace grant does not answer a question about one of its servers', async () => {
    answer = () => ['approved', 'session']
    const { c } = await session()
    try {
      await call(c, 'fleet_inventory')
      // get_config_drift is fleetRead too, asked per SERVER.
      await call(c, 'get_config_drift', { serverName: 'AlphaBox' })
      expect(asked).toHaveLength(2)
      expect(asked[1]).toMatchObject({ serverId: 'sA', serverName: 'AlphaBox', capability: 'fleetRead' })
    } finally {
      await c.close()
    }
  })

  it('a server grant does not answer a question about its workspace', async () => {
    answer = () => ['approved', 'session']
    const { c } = await session()
    try {
      await call(c, 'get_config_drift', { serverName: 'AlphaBox' })
      await call(c, 'fleet_inventory')
      expect(asked).toHaveLength(2)
      expect(asked[1]).toMatchObject({ serverId: null, workspaceId: 'wsA', capability: 'fleetRead' })
    } finally {
      await c.close()
    }
  })

  it('a grant in workspace A does not cover workspace B', async () => {
    // A session holding both: each workspace that says ask is asked about by
    // name. Alpha is granted for the session, Beta only once.
    answer = (r) => (r.workspaceId === 'wsA' ? ['approved', 'session'] : ['approved', 'once'])
    const { c } = await session([ALPHA, BETA])
    try {
      const out = await call(c, 'fleet_inventory')
      expect(out).toMatch(/AlphaBox/)
      expect(out).toMatch(/BetaBox/)
      expect(asked.map((r) => r.workspaceId)).toEqual(['wsA', 'wsB'])
      // Each dialog says which of how many it is.
      expect(asked.map((r) => r.workspaceOf)).toEqual([
        { index: 1, total: 2 },
        { index: 2, total: 2 }
      ])

      await call(c, 'fleet_inventory')
      // Alpha's grant carried; Beta was asked again.
      expect(asked.map((r) => r.workspaceId)).toEqual(['wsA', 'wsB', 'wsB'])
    } finally {
      await c.close()
    }
  })

  it('refuses the whole call when any one workspace is refused', async () => {
    answer = (r) => (r.workspaceId === 'wsA' ? ['approved', 'once'] : ['denied'])
    const { c } = await session([ALPHA, BETA])
    try {
      const out = await call(c, 'fleet_inventory')
      expect(out).toMatch(/Denied: the user rejected this action/)
      expect(out).not.toMatch(/AlphaBox/)
    } finally {
      await c.close()
    }
  })

  it('does not survive STOP ALL AI ACCESS', async () => {
    answer = () => ['approved', 'session']
    const { c } = await session()
    try {
      await call(c, 'fleet_inventory')
      clearAllSessionElevations()
      await call(c, 'fleet_inventory')
      expect(asked).toHaveLength(2)
    } finally {
      await c.close()
    }
  })
  it('writes one row that names every workspace the data covers and how each was let through', async () => {
    answer = (r) => (r.workspaceId === 'wsA' ? ['approved', 'session'] : ['approved', 'once'])
    const { c, id } = await session([ALPHA, BETA])
    try {
      await call(c, 'fleet_inventory')
      await call(c, 'fleet_inventory')
      expect(rowsFor(id)).toHaveLength(2)
      const [second, first] = rowsFor(id)
      expect(first.action).toBe('fleet_inventory (Alpha: approved-for-session, Beta: approved)')
      expect(second.action).toBe('fleet_inventory (Alpha: approved-earlier, Beta: approved)')
    } finally {
      await c.close()
    }
  })

  it('takes back a session grant given earlier in a call that is then refused', async () => {
    answer = (r) => (r.workspaceId === 'wsA' ? ['approved', 'session'] : ['denied'])
    const { c } = await session([ALPHA, BETA])
    try {
      expect(await call(c, 'fleet_inventory')).toMatch(/Denied: the user rejected this action/)
      // Clears Beta's deny cooldown; session grants live elsewhere and survive it.
      resetApprovalVolumeForTests()
      answer = () => ['approved', 'once']
      await call(c, 'fleet_inventory')
      // Alpha is asked again: its grant was for a call that never ran.
      expect(asked.map((r) => r.workspaceId)).toEqual(['wsA', 'wsB', 'wsA', 'wsB'])
    } finally {
      await c.close()
    }
  })

  it('asks nobody when a later workspace would be refused without asking', async () => {
    answer = (r) => (r.workspaceId === 'wsA' ? ['approved', 'once'] : ['denied'])
    const { c, id } = await session([ALPHA, BETA])
    try {
      await call(c, 'fleet_inventory')
      expect(asked).toHaveLength(2)
      // Beta is in its deny cooldown. Alpha must not be put to the operator for
      // a call that is going to be refused anyway.
      expect(await call(c, 'fleet_inventory')).toMatch(/did not ask/)
      expect(asked).toHaveLength(2)
      expect(rowsFor(id)[0]).toMatchObject({ approval: 'not-asked', result: 'denied', workspaceId: 'wsB' })
    } finally {
      await c.close()
    }
  })
})

describe('an ask gate() is not told is about a workspace', () => {
  // Only gateWorkspaces marks a call workspace-wide. A per-server tool that
  // passed a null server by mistake must be refused, not quietly turned into a
  // workspace question an existing workspace grant could answer.
  it('is refused, as the policy’s answer, and nobody is asked', async () => {
    const { c, id, s } = await session()
    try {
      const gated = await gateForTests(
        {
          session: s,
          workspaceId: 'wsA',
          workspaceName: 'Alpha',
          serverId: null,
          serverName: null,
          action: 'get_config_drift',
          capability: 'fleetRead'
        },
        { decision: 'ask', reason: 'Fleet: ask' },
        { toolName: 'get_config_drift', level: 'medium', because: 'test' }
      )
      expect(gated.ok).toBe(false)
      expect(asked).toHaveLength(0)
      const rows = rowsFor(id)
      expect(rows).toHaveLength(1)
      expect(auditOutcome(rows[0]).label).toBe('Blocked by policy')
      expect(rows[0].error).toMatch(/names neither a server nor a workspace/)
    } finally {
      await c.close()
    }
  })
})
