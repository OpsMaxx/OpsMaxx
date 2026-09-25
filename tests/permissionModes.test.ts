import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { AccessGroup, PermissionValue, PolicyState, SessionMode } from '../src/shared/mcp'

// PERMISSION MODES: Read only, Ask first, Auto, Bypass -- and the two things
// that stand outside them. No AI Access is scope, not a permission, so no mode
// reaches past it. A Protected target caps Auto and Bypass at Ask.
//
// Four layers, from the one pure function every answer goes through, out to
// the live bridge an agent actually talks to:
//
//   1. applyMode, the whole matrix, written out.
//   2. Confirm risky actions: off gives the literal answer in every evaluator
//      that used to upgrade allow to ask unconditionally; on or absent keeps it.
//   3. The version-3 policy migration.
//   4. The agent cannot change any of it: statically, and over MCP.

// ---------------------------------------------------------------------------
// Mocks for the live-bridge half. Everything below the tool handlers is
// recorded rather than done.
// ---------------------------------------------------------------------------

const ran: { server: string; command: string }[] = []
const queries: string[] = []
const provider: string[] = []
const vpnStarted: string[] = []

vi.mock('../src/main/services/ssh', () => ({
  sshExec: (cfg: { host?: string }, command: string) => {
    ran.push({ server: cfg.host ?? '', command })
    return Promise.resolve({ ok: true, stdout: 'ran\n', stderr: '', code: 0 })
  },
  sshTest: () => Promise.resolve({ ok: true })
}))

vi.mock('../src/main/services/db', () => ({
  dbQuery: (_cfg: unknown, statement: string) => {
    queries.push(statement)
    return Promise.resolve({ ok: true, columns: ['id'], rows: [[1]], rowCount: 1 })
  }
}))

vi.mock('../src/main/services/tunnel', () => ({
  tunnelStart: () => Promise.resolve({ ok: true, listenPort: 15432 }),
  tunnelStop: () => Promise.resolve(),
  tunnelList: () => []
}))

vi.mock('../src/main/services/cicd/service', () => ({
  resolveSecret: () => 'token',
  createCicdAdapter: () => ({
    provider: 'gitlab',
    apiRoot: (u: string) => u,
    capabilities: () => ({ logMode: 'reread', triggerReturnsRun: true, resume: 'play' }),
    verify: async () => ({ identity: 'ci-bot' }),
    listPipelines: async () => [],
    listRuns: async () => [],
    getRun: async () => ({ run: null, steps: [] }),
    getLog: async () => ({ mode: 'snapshot', text: '', more: false }),
    listParams: async () => []
  })
}))

vi.mock('../src/main/services/cicd/wiring', () => ({
  getConnection: (id: string) =>
    id === 'ci1'
      ? {
          id: 'ci1',
          workspaceId: 'ws',
          name: 'platform-gitlab',
          provider: 'gitlab',
          baseUrl: 'https://gitlab.example.com',
          vaultEntryId: 'vault-1',
          route: { kind: 'direct' },
          enabled: true
        }
      : null,
  triggerRun: async () => {
    provider.push('trigger')
    return { run: { id: '99', attempt: 1 }, note: 'GitLab created pipeline #7 on main.' }
  },
  cancelRun: async () => {
    provider.push('cancel')
    return { note: 'cancelling' }
  },
  rerunRun: async () => {
    provider.push('rerun')
    return { run: { id: '99', attempt: 2 }, note: 're-running' }
  },
  noteAgentRun: () => undefined,
  forgetAgentRun: () => undefined
}))

const {
  applyMode,
  confirmsRisky,
  evaluateCiTrigger,
  evaluateCommand,
  evaluateDatabaseStatement,
  evaluateServerWrite,
  evaluateTunnelDefine,
  evaluateTunnelOpen,
  evaluateVpnControl,
  extractPathAccesses
} = await import('../src/main/services/policyEngine')
type Decision = import('../src/main/services/policyEngine').Decision
const {
  getGroup,
  listGroups,
  migrateV3ForTests,
  resetPolicyCacheForTests,
  saveGroup,
  setAssignment,
  setProtected
} = await import('../src/main/services/policyStore')
const { refreshMcpDataCache } = await import('../src/main/services/mcpDataCache')
const { setMcpConfig, createSession, resetMcpAuthForTests, setSessionMode } = await import(
  '../src/main/services/mcpAuth'
)
const { startMcpServer, stopMcpServer } = await import('../src/main/services/mcpServer')
const { onApprovalEvent, respondToApproval, resetApprovalVolumeForTests } = await import(
  '../src/main/services/approvals'
)
const { listAudit } = await import('../src/main/services/auditLog')
const { registerVpnManager, resetVpnManagerForTests } = await import('../src/main/services/vpn/managerApi')
type ApprovalRequest = import('../src/shared/mcp').ApprovalRequest

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const MCP_SERVER_SRC = readFileSync(`${ROOT}src/main/services/mcpServer.ts`, 'utf8')

// ---------------------------------------------------------------------------
// 1. applyMode
// ---------------------------------------------------------------------------

describe('applyMode, every mode against every answer', () => {
  const MODES: SessionMode[] = ['readOnly', 'ask', 'auto', 'bypass']
  const DECISIONS: PermissionValue[] = ['allow', 'ask', 'deny']

  // Written out rather than derived, so a change to any cell has to be made
  // deliberately. Key: `${decision}/${mutating ? 'change' : 'read'}`.
  type Row = Record<`${PermissionValue}/${'change' | 'read'}`, PermissionValue>
  const IDENTITY: Row = {
    'allow/change': 'allow', 'allow/read': 'allow',
    'ask/change': 'ask', 'ask/read': 'ask',
    'deny/change': 'deny', 'deny/read': 'deny'
  }
  const ASKS_CHANGES: Row = { ...IDENTITY, 'allow/change': 'ask' }
  const READ_ONLY: Row = { ...IDENTITY, 'allow/change': 'deny', 'ask/change': 'deny' }
  const EVERYTHING: Row = {
    'allow/change': 'allow', 'allow/read': 'allow',
    'ask/change': 'allow', 'ask/read': 'allow',
    'deny/change': 'allow', 'deny/read': 'allow'
  }
  const EXPECTED: Record<SessionMode, { open: Row; protected: Row }> = {
    auto: { open: IDENTITY, protected: ASKS_CHANGES },
    bypass: { open: EVERYTHING, protected: ASKS_CHANGES },
    ask: { open: ASKS_CHANGES, protected: ASKS_CHANGES },
    readOnly: { open: READ_ONLY, protected: READ_ONLY }
  }

  for (const mode of MODES) {
    for (const prot of [false, true]) {
      for (const decision of DECISIONS) {
        for (const mutating of [true, false]) {
          const cell = `${decision}/${mutating ? 'change' : 'read'}` as const
          const want = EXPECTED[mode][prot ? 'protected' : 'open'][cell]
          it(`${mode}${prot ? ', Protected' : ''}: ${cell} -> ${want}`, () => {
            const d: Decision = { decision, reason: 'group said so' }
            const out = applyMode(d, { mode, protectedTarget: prot, mutating })
            expect(out.decision).toBe(want)
            // Bypass says so, and only when it actually changed the answer.
            expect(out.bypassed === true).toBe(mode === 'bypass' && !prot && decision !== 'allow')
            // A Protected target is named on anything that asks while it holds a
            // looser mode (Auto, Bypass) at Ask first -- including an ask the
            // group produced itself, so the card tells a user reaching for
            // Bypass that it will not stop this one. A session the user put in
            // Ask first or Read only is not "held" by anything.
            expect(out.protectedTarget === true).toBe(
              prot && (mode === 'auto' || mode === 'bypass') && want === 'ask'
            )
            // Idempotent: a caller unsure whether it has been applied may apply it again.
            expect(applyMode(out, { mode, protectedTarget: prot, mutating })).toEqual(out)
          })
        }
      }
    }
  }

  it('passes an out-of-scope refusal through untouched, whatever the mode', () => {
    const shut: Decision = { decision: 'deny', reason: 'This target is set to No AI Access.', outOfScope: true }
    for (const mode of MODES) {
      for (const protectedTarget of [false, true]) {
        for (const mutating of [false, true]) {
          expect(applyMode(shut, { mode, protectedTarget, mutating })).toBe(shut)
        }
      }
    }
  })

  it('keeps the group\'s own reason when Bypass lifts it, so the audit row says what was waived', () => {
    const out = applyMode({ decision: 'deny', reason: 'Sudo is denied' }, { mode: 'bypass', protectedTarget: false, mutating: true })
    expect(out.reason).toBe('Bypass mode: Sudo is denied')
  })
})

// ---------------------------------------------------------------------------
// 2. Confirm risky actions
// ---------------------------------------------------------------------------

describe('Confirm risky actions', () => {
  // Every capability these evaluators read is ALLOW on the seeded Full Access.
  let literal: AccessGroup
  let on: AccessGroup
  let absent: AccessGroup

  beforeEach(() => {
    resetPolicyCacheForTests()
    const full = listGroups().find((g) => g.id === 'grp-full')!
    // sudo raised to allow on the literal group: a computed command word may BE
    // sudo, so with sudo at ask (the seed) it asks whatever the switch says --
    // pinned on its own below.
    literal = { ...full, confirmRisky: false, capabilities: { ...full.capabilities, sudo: 'allow' } }
    on = { ...full, confirmRisky: true }
    absent = { ...full }
    delete absent.confirmRisky
  })

  // Each evaluator that used to upgrade allow to ask unconditionally.
  const EVALUATORS: [string, (g: AccessGroup) => Decision][] = [
    ['evaluateCommand: unshare -r', (g) => evaluateCommand(g, 'unshare -r id')],
    ['evaluateCommand: a computed command word', (g) => evaluateCommand(g, '$TOOL --run')],
    ['evaluateCommand: the risk classifier', (g) => evaluateCommand(g, 'rm -rf /var/lib/app')],
    ['evaluateDatabaseStatement: a write', (g) => evaluateDatabaseStatement(g, 'UPDATE t SET a = 1')],
    ['evaluateDatabaseStatement: a DDL', (g) => evaluateDatabaseStatement(g, 'DROP TABLE t')],
    ['evaluateTunnelOpen', (g) => evaluateTunnelOpen(g)],
    ['evaluateTunnelDefine', (g) => evaluateTunnelDefine(g)],
    ['evaluateServerWrite: change', (g) => evaluateServerWrite(g, 'change')],
    ['evaluateServerWrite: delete', (g) => evaluateServerWrite(g, 'delete')],
    ['evaluateVpnControl: start', (g) => evaluateVpnControl(g, 'start', false)],
    ['evaluateVpnControl: stop with live dependents', (g) => evaluateVpnControl(g, 'stop', true)],
    ['evaluateCiTrigger', (g) => evaluateCiTrigger(g)]
  ]

  it.each(EVALUATORS)('%s: off gives the literal allow', (_label, evaluate) => {
    expect(evaluate(literal).decision).toBe('allow')
  })

  it.each(EVALUATORS)('%s: on asks', (_label, evaluate) => {
    expect(evaluate(on).decision).toBe('ask')
  })

  it.each(EVALUATORS)('%s: absent is on, and asks', (_label, evaluate) => {
    expect(evaluate(absent).decision).toBe('ask')
  })

  it('a computed command word still asks with the switch off, unless sudo is allowed outright', () => {
    // It may be sudo, and switching risky confirmations off must not let
    // `$(which sudo) reboot` walk past a group that asks about or refuses sudo.
    const full = listGroups().find((g) => g.id === 'grp-full')!
    expect(full.confirmRisky).toBe(false)
    expect(full.capabilities.sudo).toBe('ask')
    expect(evaluateCommand(full, '$(which sudo) reboot').decision).toBe('ask')
    const sudoDenied = { ...full, capabilities: { ...full.capabilities, sudo: 'deny' as const } }
    expect(evaluateCommand(sudoDenied, '$(which sudo) reboot').decision).toBe('ask')
    expect(evaluateCommand(literal, '$(which sudo) reboot').decision).toBe('allow')
  })

  it('reads absent as on, and only false as off', () => {
    expect(confirmsRisky(absent)).toBe(true)
    expect(confirmsRisky(on)).toBe(true)
    expect(confirmsRisky(literal)).toBe(false)
  })

  it('never turns a deny into anything with the switch off', () => {
    const denied: AccessGroup = {
      ...literal,
      capabilities: { ...literal.capabilities, ciTrigger: 'deny', sshTunnel: 'deny', vpnControl: 'deny', manageServers: 'deny' }
    }
    expect(evaluateCiTrigger(denied).decision).toBe('deny')
    expect(evaluateTunnelOpen(denied).decision).toBe('deny')
    expect(evaluateVpnControl(denied, 'start', false).decision).toBe('deny')
    expect(evaluateServerWrite(denied, 'delete').decision).toBe('deny')
  })

  it('ships on for every seeded group but Full Access', () => {
    for (const g of listGroups()) expect(g.confirmRisky, g.name).toBe(g.id !== 'grp-full')
  })
})

describe('the kernel\'s stream devices are not files', () => {
  it('does not count 2>/dev/null as a write', () => {
    expect(extractPathAccesses('ls 2>/dev/null').filter((a) => a.mode === 'write')).toEqual([])
    for (const dev of ['/dev/null', '/dev/zero', '/dev/stdout', '/dev/stderr', '/dev/tty', '/dev/fd/3']) {
      expect(extractPathAccesses(`echo x > ${dev}`), dev).toEqual([])
    }
  })

  it('still counts a real file next to one', () => {
    expect(extractPathAccesses('echo x > /tmp/out 2>/dev/null')).toEqual([{ path: '/tmp/out', mode: 'write' }])
  })

  it('lets ls ... 2>/dev/null run under a group that denies writes', () => {
    resetPolicyCacheForTests()
    const readOnly = getGroup('grp-read-only')!
    expect(readOnly.capabilities.writeFiles).toBe('deny')
    expect(evaluateCommand(readOnly, 'ls /tmp 2>/dev/null').decision).toBe('allow')
    // And a real write is still what it was.
    expect(evaluateCommand(readOnly, 'ls /tmp > /tmp/listing').decision).toBe('deny')
  })
})

// ---------------------------------------------------------------------------
// 3. The version-3 migration
// ---------------------------------------------------------------------------

describe('migrating a policy file to version 3', () => {
  const caps = (o: Record<string, PermissionValue>): AccessGroup['capabilities'] =>
    ({ terminal: 'allow', sudo: 'ask', ...o }) as AccessGroup['capabilities']

  const v2 = (): PolicyState =>
    ({
      version: 2,
      groups: [
        {
          id: 'grp-full',
          name: 'Full Access',
          builtIn: true,
          // As versions 1 and 2 seeded it -- except ciTrigger, which the user
          // raised to ask themselves.
          capabilities: caps({ hostFacts: 'deny', ciRead: 'deny', ciTrigger: 'ask', manageServers: 'ask', vpnControl: 'ask' }),
          filePolicies: []
        },
        { id: 'grp-read-write', name: 'Read & Write', builtIn: true, capabilities: caps({ vpnControl: 'ask' }), filePolicies: [] },
        { id: 'grp-custom', name: 'Logs Only', builtIn: false, capabilities: caps({ ciTrigger: 'deny' }), filePolicies: [] },
        { id: 'grp-chosen', name: 'Chosen', builtIn: false, capabilities: caps({}), filePolicies: [], confirmRisky: false }
      ],
      assignments: [],
      serverMeta: []
    }) as unknown as PolicyState

  it('moves the unedited Full Access keys to the new seed', () => {
    const full = migrateV3ForTests(v2()).groups.find((g) => g.id === 'grp-full')!
    expect(full.capabilities.hostFacts).toBe('allow')
    expect(full.capabilities.ciRead).toBe('allow')
    expect(full.capabilities.manageServers).toBe('allow')
    expect(full.capabilities.vpnControl).toBe('allow')
  })

  it('leaves a key the user edited alone', () => {
    const full = migrateV3ForTests(v2()).groups.find((g) => g.id === 'grp-full')!
    expect(full.capabilities.ciTrigger).toBe('ask')
    // And keys version 3 did not change.
    expect(full.capabilities.sudo).toBe('ask')
  })

  it('does not touch any other group\'s capabilities', () => {
    const out = migrateV3ForTests(v2())
    expect(out.groups.find((g) => g.id === 'grp-read-write')!.capabilities.vpnControl).toBe('ask')
    expect(out.groups.find((g) => g.id === 'grp-custom')!.capabilities.ciTrigger).toBe('deny')
  })

  it('sets Confirm risky actions: off on Full Access, on everywhere it was unset, and keeps an explicit choice', () => {
    const byId = new Map(migrateV3ForTests(v2()).groups.map((g) => [g.id, g.confirmRisky]))
    expect(byId.get('grp-full')).toBe(false)
    expect(byId.get('grp-read-write')).toBe(true)
    expect(byId.get('grp-custom')).toBe(true)
    expect(byId.get('grp-chosen')).toBe(false)
  })

  it('stamps version 3, and is idempotent', () => {
    const once = migrateV3ForTests(v2())
    expect(once.version).toBe(3)
    const twice = migrateV3ForTests(structuredClone(once))
    expect(twice).toEqual(once)
  })

  it('leaves a file already at version 3 exactly as it is', () => {
    const current = { ...v2(), version: 3 } as PolicyState
    const out = migrateV3ForTests(structuredClone(current))
    expect(out).toEqual(current)
    expect(out.groups.find((g) => g.id === 'grp-full')!.capabilities.hostFacts).toBe('deny')
  })
})

// ---------------------------------------------------------------------------
// 4a. The agent cannot change its own mode: statically
// ---------------------------------------------------------------------------

/** The top-level keys of every `inputSchema: { ... }` literal in a source file. */
function inputSchemaKeys(src: string): Set<string> {
  const keys = new Set<string>()
  const opener = /inputSchema:\s*\{/g
  for (let m = opener.exec(src); m; m = opener.exec(src)) {
    let depth = 1
    let i = m.index + m[0].length
    const start = i
    while (depth > 0 && i < src.length) {
      if (src[i] === '{') depth++
      else if (src[i] === '}') depth--
      i++
    }
    const lines = src.slice(start, i - 1).split('\n').filter((l) => /^\s*\w+\s*:/.test(l))
    if (lines.length === 0) continue
    const top = Math.min(...lines.map((l) => l.search(/\S/)))
    for (const l of lines) if (l.search(/\S/) === top) keys.add(l.trim().split(/\s*:/)[0])
  }
  return keys
}

describe('an agent has no path to its own mode or to Protected', () => {
  it('mcpServer.ts never references the functions that set them', () => {
    expect(MCP_SERVER_SRC).not.toMatch(/\bsetSessionMode\b/)
    expect(MCP_SERVER_SRC).not.toMatch(/\bsetProtected\b/)
  })

  it('no tool takes a mode or a protected argument', () => {
    const keys = inputSchemaKeys(MCP_SERVER_SRC)
    // The scanner found the schemas at all, or the assertion below is vacuous.
    expect(keys).toContain('serverName')
    expect(keys).toContain('command')
    for (const forbidden of ['mode', 'sessionMode', 'protected', 'protectedTarget', 'confirmRisky']) {
      expect(keys, forbidden).not.toContain(forbidden)
    }
  })
})

// ---------------------------------------------------------------------------
// 4b. Through the live bridge
// ---------------------------------------------------------------------------

describe('modes on the live bridge', () => {
  const PORT = 18794
  const WS = { id: 'ws', name: 'Prod' }
  const SHUT = { id: 'wsShut', name: 'Shut' }
  const GUARDED = { id: 'wsGuarded', name: 'Guarded' }
  const ALL = [WS, SHUT, GUARDED]
  // Full Access with ciTrigger at ask and the switch on, so a Bypass session
  // has something to lift.
  const ASKS = 'grp-modes-asks'

  let answer: 'approved' | 'denied' = 'denied'
  let asked: ApprovalRequest[] = []
  const clients: Client[] = []

  beforeAll(async () => {
    resetPolicyCacheForTests()
    resetMcpAuthForTests()
    resetVpnManagerForTests()
    refreshMcpDataCache({
      workspaces: ALL,
      servers: [
        { id: 's1', workspaceId: 'ws', name: 'Box', host: '10.0.0.1', port: 22, username: 'root', auth: 'key', os: 'Linux', route: [] },
        { id: 's2', workspaceId: 'ws', name: 'Vault', host: '10.0.0.2', port: 22, username: 'root', auth: 'key', os: 'Linux', route: [] },
        { id: 's3', workspaceId: 'wsShut', name: 'Closed', host: '10.0.0.3', port: 22, username: 'root', auth: 'key', os: 'Linux', route: [] }
      ],
      databases: [
        { id: 'db1', workspaceId: 'wsShut', name: 'Orders', kind: 'postgres', host: '10.0.0.5', port: 5432, username: 'app', database: 'orders', ssl: false, uri: false, sshServerId: null }
      ],
      tunnels: [
        { id: 't1', workspaceId: 'ws', name: 'DB Forward', kind: 'local', serverId: 's1', listen: '127.0.0.1:15432', target: '10.0.0.5:5432' },
        { id: 't2', workspaceId: 'ws', name: 'Vault Forward', kind: 'local', serverId: 's2', listen: '127.0.0.1:15433', target: '10.0.0.6:5432' }
      ],
      cicdConnections: [{ id: 'ci1', workspaceId: 'ws', name: 'platform-gitlab', provider: 'gitlab', enabled: true }],
      vpns: [
        { id: 'vpn-frp', workspaceId: 'ws', name: 'expose', autoStart: false, spec: { kind: 'frp', proxies: [{}] } },
        { id: 'vpn-frp-guarded', workspaceId: 'wsGuarded', name: 'expose-guarded', autoStart: false, spec: { kind: 'frp', proxies: [{}] } }
      ]
    })
    const full = getGroup('grp-full')!
    saveGroup({
      ...full,
      id: ASKS,
      name: 'Modes Asks',
      builtIn: false,
      capabilities: { ...full.capabilities, ciTrigger: 'ask' },
      confirmRisky: true
    })
    // Deliberately shut, and deliberately Protected.
    setAssignment({ level: 'workspace', workspaceId: SHUT.id }, null)
    setProtected({ level: 'server', serverId: 's2' }, true)
    setProtected({ level: 'workspace', workspaceId: GUARDED.id }, true)
    registerVpnManager({
      statusOf: () => null,
      dependentsOf: () => [],
      startVpn: async (id) => {
        vpnStarted.push(id)
        return { ok: true, listeners: [] }
      },
      stopVpn: async () => ({ ok: true })
    })
    setMcpConfig({ enabled: true, port: PORT, approvalTimeoutSeconds: 5 })
    await startMcpServer()
  })

  const offApprovals = onApprovalEvent((e) => {
    if (e.type !== 'created') return
    asked.push(e.request)
    respondToApproval(e.request.id, answer)
  })

  afterAll(async () => {
    offApprovals()
    for (const c of clients) await c.close()
    await stopMcpServer()
    resetVpnManagerForTests()
  })

  beforeEach(() => {
    resetApprovalVolumeForTests()
    ran.length = 0
    queries.length = 0
    provider.length = 0
    vpnStarted.length = 0
    asked = []
    answer = 'denied'
  })

  async function agent(mode: SessionMode, groupId = 'grp-full'): Promise<{ c: Client; id: string; name: string }> {
    const name = `Modes ${mode} ${clients.length}`
    const { token, session } = createSession({
      agentName: name,
      workspaces: ALL,
      groupId,
      groupName: groupId,
      ttlMinutes: null,
      mode
    })
    const c = new Client({ name: 'modes-test', version: '1.0.0' })
    await c.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } }
      })
    )
    clients.push(c)
    return { c, id: session.id, name }
  }

  async function call(c: Client, name: string, args: Record<string, unknown>): Promise<string> {
    const r = (await c.callTool({ name, arguments: args })) as { content: { text: string }[] }
    return r.content.map((x) => x.text).join('\n')
  }

  it('Bypass starts a build the group asks about, with no approval, audited as bypassed', async () => {
    const { c, name } = await agent('bypass', ASKS)
    const out = await call(c, 'trigger_run', {
      connectionName: 'platform-gitlab',
      pipelineRef: 'group/app',
      ref: 'main'
    })
    expect(out).toContain('GitLab created pipeline')
    expect(asked).toEqual([])
    expect(provider).toEqual(['trigger'])
    const row = listAudit().find((a) => a.agentName === name && a.action.startsWith('Start pipeline'))
    expect(row?.approval).toBe('bypassed')
    expect(row?.mode).toBe('bypass')
  })

  it('the same build asks in Auto, so the Bypass result above is the mode and not the group', async () => {
    const { c } = await agent('auto', ASKS)
    const out = await call(c, 'trigger_run', { connectionName: 'platform-gitlab', pipelineRef: 'group/app', ref: 'main' })
    expect(asked).toHaveLength(1)
    expect(asked[0].sessionMode).toBe('auto')
    expect(out).toContain('Denied')
    expect(provider).toEqual([])
  })

  it('Read only refuses execute_command, even on Full Access, and nothing reaches the host', async () => {
    const { c } = await agent('readOnly')
    const out = await call(c, 'execute_command', { serverName: 'Box', command: 'uptime' })
    expect(out).toMatch(/^Denied: Read-only mode/)
    expect(ran).toEqual([])
    expect(asked).toEqual([])
  })

  it('Read only still lists tunnels, which is a read', async () => {
    const { c } = await agent('readOnly')
    expect(await call(c, 'list_tunnels', {})).toContain('DB Forward')
  })

  it('Ask first asks for a command the group allows outright', async () => {
    const { c } = await agent('ask')
    answer = 'approved'
    expect(await call(c, 'execute_command', { serverName: 'Box', command: 'uptime' })).toContain('ran')
    expect(asked).toHaveLength(1)
    expect(asked[0].sessionMode).toBe('ask')
    expect(asked[0].protectedTarget).toBe(false)
  })

  it('a Protected server caps a Bypass session at an approval request', async () => {
    const { c } = await agent('bypass')
    const out = await call(c, 'execute_command', { serverName: 'Vault', command: 'uptime' })
    expect(asked).toHaveLength(1)
    expect(asked[0].serverName).toBe('Vault')
    expect(asked[0].sessionMode).toBe('bypass')
    expect(asked[0].protectedTarget).toBe(true)
    expect(out).toContain('Denied')
    expect(ran).toEqual([])
  })

  it('...and the same Bypass session runs the same command on an unprotected server without asking', async () => {
    const { c } = await agent('bypass')
    expect(await call(c, 'execute_command', { serverName: 'Box', command: 'uptime' })).toContain('ran')
    expect(asked).toEqual([])
    expect(ran).toEqual([{ server: '10.0.0.1', command: 'uptime' }])
  })

  it('a Protected carrier server caps starting the tunnel it carries', async () => {
    // Only the server is marked, not its workspace: set_tunnel has to pass the
    // tunnel's carrier for the mark to reach it.
    const { c } = await agent('bypass')
    const out = await call(c, 'set_tunnel', { tunnelName: 'Vault Forward', running: true })
    expect(asked).toHaveLength(1)
    expect(asked[0].protectedTarget).toBe(true)
    expect(out).toContain('Denied')
  })

  it('...while the tunnel on an unprotected carrier starts under Bypass without asking', async () => {
    const { c } = await agent('bypass')
    await call(c, 'set_tunnel', { tunnelName: 'DB Forward', running: true })
    expect(asked).toEqual([])
  })

  it('an explicit No AI Access still denies under Bypass, and asks nobody', async () => {
    const { c } = await agent('bypass')
    const out = await call(c, 'execute_command', { serverName: 'Closed', command: 'uptime' })
    expect(out).toContain('No AI Access')
    expect(asked).toEqual([])
    expect(ran).toEqual([])
  })

  // The bug this release fixed: the database, tunnel and VPN tools resolved the
  // workspace with a helper that read an explicit No AI Access as "no
  // assignment", so a workspace somebody had deliberately shut stayed open to
  // them.
  it.each(['auto', 'bypass'] as SessionMode[])(
    'query_database is denied in a workspace set to No AI Access (%s)',
    async (mode) => {
      const { c } = await agent(mode)
      const out = await call(c, 'query_database', { databaseName: 'Orders', statement: 'SELECT 1' })
      expect(out).toMatch(/^Denied: .*No AI Access/)
      expect(queries).toEqual([])
    }
  )

  it('Bypass reaches frp, the one refusal no access group can lift', async () => {
    const { c, name } = await agent('bypass')
    const out = await call(c, 'set_vpn', { vpnName: 'expose', running: true })
    expect(out).toContain('Started "expose"')
    expect(vpnStarted).toEqual(['vpn-frp'])
    expect(listAudit().find((a) => a.agentName === name && a.action.startsWith('Start VPN'))?.approval).toBe('bypassed')
  })

  it('...but not frp in a Protected workspace, where it stays refused', async () => {
    const { c } = await agent('bypass')
    const out = await call(c, 'set_vpn', { vpnName: 'expose-guarded', running: true })
    expect(out).toMatch(/^Denied:.*reverse proxy \(frp\)/)
    expect(vpnStarted).toEqual([])
    expect(asked).toEqual([])
  })

  it('...and not frp in Auto, whatever the group', async () => {
    const { c } = await agent('auto')
    expect(await call(c, 'set_vpn', { vpnName: 'expose', running: true })).toMatch(/^Denied:/)
    expect(vpnStarted).toEqual([])
  })

  it('a mode changed on a live session takes effect on its next call', async () => {
    const { c, id } = await agent('auto')
    expect(await call(c, 'execute_command', { serverName: 'Box', command: 'uptime' })).toContain('ran')
    expect(setSessionMode(id, 'readOnly')?.mode).toBe('readOnly')
    expect(await call(c, 'execute_command', { serverName: 'Box', command: 'uptime' })).toMatch(/^Denied: Read-only mode/)
    setSessionMode(id, 'auto')
    expect(await call(c, 'execute_command', { serverName: 'Box', command: 'uptime' })).toContain('ran')
    expect(ran).toHaveLength(2)
  })

  it('tells the agent its mode, and who sets it', async () => {
    const { c } = await agent('readOnly')
    const out = await call(c, 'get_server_details', { serverName: 'Vault' })
    expect(out).toContain('Session mode: Read only')
    expect(out).toContain('an agent cannot change it')
    expect(out).toMatch(/Protected target: yes/)
  })

  it('offers no tool a mode or protected argument, as the client actually sees them', async () => {
    const { c } = await agent('auto')
    const { tools } = await c.listTools()
    expect(tools.length).toBeGreaterThan(10)
    for (const t of tools) {
      const props = Object.keys((t.inputSchema?.properties ?? {}) as object)
      for (const forbidden of ['mode', 'sessionMode', 'protected', 'protectedTarget', 'confirmRisky']) {
        expect(props, `${t.name}.${forbidden}`).not.toContain(forbidden)
      }
    }
  })
})
