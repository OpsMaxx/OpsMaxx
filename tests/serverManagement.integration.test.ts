import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

// add_server shipped alone, and the estate that found the gap was seven hosts
// behind one bastion: every entry the bridge could write dialled direct, timed
// out at TCP, and reported success — and nothing could take the dead entries
// back. These are the three halves of closing that: naming a jump host, saying
// when the result does not work, and being able to undo it.

let testResult: { ok: boolean; error?: string } = { ok: true }
const tested: unknown[] = []

vi.mock('../src/main/services/ssh', () => ({
  sshExec: () => Promise.resolve({ ok: true, stdout: '', stderr: '', code: 0 }),
  sshTest: (cfg: unknown) => {
    tested.push(cfg)
    return Promise.resolve(testResult)
  }
}))

const { refreshMcpDataCache } = await import('../src/main/services/mcpDataCache')
const { setAssignment, saveGroup, getGroup, resetPolicyCacheForTests } = await import('../src/main/services/policyStore')
const { setMcpConfig, createSession, resetMcpAuthForTests } = await import('../src/main/services/mcpAuth')
const { startMcpServer, stopMcpServer } = await import('../src/main/services/mcpServer')
const { onApprovalEvent, respondToApproval } = await import('../src/main/services/approvals')
const { listAudit } = await import('../src/main/services/auditLog')
const { setAgentServerCreator, setAgentConfigWriter } = await import('../src/main/services/agentConfigWrite')
type AgentServerRequest = import('../src/main/services/agentConfigWrite').AgentServerRequest
type AgentConfigRequest = import('../src/main/services/agentConfigWrite').AgentConfigRequest

const PORT = 58761

// Two servers behind a bastion, and the bastion, which is the shape the report
// described. Scanner01 routes through Bastion by saved reference.
const sampleData = {
  workspaces: [{ id: 'ws', name: 'Personal' }],
  servers: [
    { id: 'bastion', workspaceId: 'ws', name: 'Bastion', host: '10.21.15.239', port: 22, username: 'root', auth: 'key', os: 'Linux', route: [] },
    {
      id: 's1',
      workspaceId: 'ws',
      name: 'Scanner01',
      host: '10.21.15.7',
      port: 22,
      username: 'root',
      auth: 'key',
      os: 'Linux',
      route: [{ id: 'h1', label: 'Bastion', host: '10.21.15.239', port: 22, username: 'root', auth: 'key', serverId: 'bastion' }]
    },
    // Same machine as Scanner01, saved twice under another name. This is what
    // the dedup token exists to make visible.
    { id: 's2', workspaceId: 'ws', name: 'Scanner01-dup', host: '10.21.15.7', port: 22, username: 'ROOT', auth: 'key', os: 'Linux', route: [] }
  ]
}

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
    return Promise.resolve({ ok: true, id: 'x' })
  })
  await startMcpServer()
})

afterAll(async () => await stopMcpServer())

beforeEach(() => {
  created = []
  written = []
  testResult = { ok: true }
  tested.length = 0
  setAssignment({ level: 'workspace', workspaceId: 'ws' }, 'grp-full')
})

// An administrator who raised manageServers to ALLOW by hand. No built-in group
// is shaped this way -- they all seed it at ASK -- so the only way to exercise
// the rule that an allow is still not silent is to build one.
const ALLOW_GROUP = 'grp-manage-allow'

function useAllowGroup(): void {
  const full = getGroup('grp-full')!
  saveGroup({
    ...full,
    id: ALLOW_GROUP,
    name: 'Manage Allow',
    builtIn: false,
    capabilities: { ...full.capabilities, manageServers: 'allow' }
  })
  setAssignment({ level: 'workspace', workspaceId: 'ws' }, ALLOW_GROUP)
}

async function clientFor(groupId: string): Promise<Client> {
  const { token } = createSession({
    agentName: 'Test Agent',
    workspaces: [{ id: 'ws', name: 'Personal' }],
    groupId,
    groupName: groupId,
    ttlMinutes: null
  })
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } }
  })
  const c = new Client({ name: 'srv-mgmt-test', version: '1.0.0' })
  await c.connect(transport)
  return c
}

async function call(c: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const r = (await c.callTool({ name, arguments: args })) as { content: { text: string }[] }
  return r.content.map((x) => x.text).join('\n')
}

function autoRespond(decision: 'approved' | 'denied'): { stop: () => void; count: () => number } {
  let seen = 0
  const off = onApprovalEvent((e) => {
    if (e.type === 'created') {
      seen += 1
      respondToApproval(e.request.id, decision)
    }
  })
  return { stop: off, count: () => seen }
}

describe('add_server jumpHosts', () => {
  it('turns a friendly name into a saved-server reference, never a raw address', async () => {
    const a = autoRespond('approved')
    const c = await clientFor('grp-full')
    try {
      await call(c, 'add_server', { name: 'Pentester02', host: '10.21.15.8', jumpHosts: ['Bastion'] })
      expect(created).toHaveLength(1)
      // serverId is the whole point: the hop authenticates with the bastion's
      // own stored credential, so nothing had to be re-supplied here.
      expect(created[0].route).toEqual([
        { serverId: 'bastion', label: 'Bastion', host: '10.21.15.239', port: 22, username: 'root', auth: 'key' }
      ])
    } finally {
      a.stop()
      await c.close()
    }
  })

  it('names the bastion in the approval and the audit entry', async () => {
    const a = autoRespond('approved')
    const c = await clientFor('grp-full')
    try {
      await call(c, 'add_server', { name: 'Pentester03', host: '10.21.15.9', jumpHosts: ['Bastion'] })
      const entry = listAudit().find((e) => e.action.includes('Pentester03'))
      // The person approving is owed the fact that it goes through one of their
      // own machines, and which one.
      expect(entry?.action).toContain('through Bastion')
    } finally {
      a.stop()
      await c.close()
    }
  })

  it('refuses a jump host that does not resolve', async () => {
    const c = await clientFor('grp-full')
    try {
      const out = await call(c, 'add_server', { name: 'X', host: '10.0.0.9', jumpHosts: ['No Such Box'] })
      expect(out).toContain('No server matching')
      expect(created).toHaveLength(0)
    } finally {
      await c.close()
    }
  })

  it('refuses the same hop twice', async () => {
    const c = await clientFor('grp-full')
    try {
      const out = await call(c, 'add_server', { name: 'X', host: '10.0.0.9', jumpHosts: ['Bastion', 'Bastion'] })
      expect(out).toContain('listed twice')
      expect(created).toHaveLength(0)
    } finally {
      await c.close()
    }
  })

  it('resolves the chain before asking, so a bad name costs no approval', async () => {
    const a = autoRespond('approved')
    const c = await clientFor('grp-full')
    try {
      await call(c, 'add_server', { name: 'X', host: '10.0.0.9', jumpHosts: ['No Such Box'] })
      expect(a.count()).toBe(0)
    } finally {
      a.stop()
      await c.close()
    }
  })
})

describe('add_server verify', () => {
  it('says so when the connection does not come up, and keeps the entry', async () => {
    testResult = { ok: false, error: 'connect ECONNREFUSED 10.21.15.7:22' }
    const a = autoRespond('approved')
    const c = await clientFor('grp-full')
    try {
      // The cache has no 's-new' record, so this exercises the "not saved yet"
      // branch rather than the probe -- still a warning, never a silent success.
      const out = await call(c, 'add_server', { name: 'Probe1', host: '10.21.15.99', verify: true })
      expect(out).toContain('Added')
      expect(out).toMatch(/could not be verified|did not come up/)
      expect(created).toHaveLength(1)
    } finally {
      a.stop()
      await c.close()
    }
  })

  it('dials the saved record and reports the category when it refuses', async () => {
    // The creator answers with an id the cache already holds, which is what
    // reaching the real probe needs -- refreshMcpDataCache is driven by the
    // renderer's save in the running app and does not happen here.
    setAgentServerCreator((req) => {
      created.push(req)
      return Promise.resolve({ ok: true, serverId: 's1' })
    })
    testResult = { ok: false, error: 'connect ECONNREFUSED 10.21.15.7:22' }
    const a = autoRespond('approved')
    const c = await clientFor('grp-full')
    try {
      const out = await call(c, 'add_server', { name: 'Probe3', host: '10.21.15.97', verify: true })
      expect(out).toContain('Added')
      expect(out).toContain('did not come up')
      expect(out).toContain('nothing is listening on that port')
      // The entry is KEPT. A host that is down is still a real machine, and
      // rolling back would throw away the approval just given.
      expect(out).toContain('entry was kept')
      // And the driver's text, which carries the address, does not come with it.
      expect(out).not.toContain('10.21.15.7')
      expect(out).not.toContain('ECONNREFUSED')
    } finally {
      a.stop()
      setAgentServerCreator((req) => {
        created.push(req)
        return Promise.resolve({ ok: true, serverId: 's-new' })
      })
      await c.close()
    }
  })

  it('says so when the connection comes up', async () => {
    setAgentServerCreator((req) => {
      created.push(req)
      return Promise.resolve({ ok: true, serverId: 's1' })
    })
    const a = autoRespond('approved')
    const c = await clientFor('grp-full')
    try {
      const out = await call(c, 'add_server', { name: 'Probe4', host: '10.21.15.96', verify: true })
      expect(out).toContain('Verified')
    } finally {
      a.stop()
      setAgentServerCreator((req) => {
        created.push(req)
        return Promise.resolve({ ok: true, serverId: 's-new' })
      })
      await c.close()
    }
  })

  it('does not dial at all when verify is not asked for', async () => {
    const a = autoRespond('approved')
    const c = await clientFor('grp-full')
    try {
      await call(c, 'add_server', { name: 'Probe2', host: '10.21.15.98' })
      expect(tested).toHaveLength(0)
    } finally {
      a.stop()
      await c.close()
    }
  })
})

describe('one approval writes one server', () => {
  // The bug this was written for: add_server has no server id yet, so it passed
  // the literal 'pending-new-server' as the elevation key and EVERY add in a
  // session shared it. Approve the first and the rest were auto-approved and
  // audited as `approved-earlier` -- which is how one dialog leaves four
  // unwanted connections behind.
  it('asks again for a second add in the same session', async () => {
    const a = autoRespond('approved')
    const c = await clientFor('grp-full')
    try {
      await call(c, 'add_server', { name: 'First', host: '10.0.0.21' })
      await call(c, 'add_server', { name: 'Second', host: '10.0.0.22' })
      expect(created).toHaveLength(2)
      expect(a.count()).toBe(2)
    } finally {
      a.stop()
      await c.close()
    }
  })
})

describe('update_server', () => {
  it('sends only the fields that were passed', async () => {
    const a = autoRespond('approved')
    const c = await clientFor('grp-full')
    try {
      await call(c, 'update_server', { serverName: 'Scanner01', port: 2222 })
      expect(written).toHaveLength(1)
      const req = written[0] as Extract<AgentConfigRequest, { kind: 'server.update' }>
      expect(req.kind).toBe('server.update')
      expect(req.patch).toEqual({ port: 2222 })
      // A port change must not carry a credential wipe with it.
      expect(req.patch.keyPath).toBeUndefined()
      expect(req.patch.password).toBeUndefined()
    } finally {
      a.stop()
      await c.close()
    }
  })

  it('asks even when manageServers is raised to ALLOW', async () => {
    // The gap this closes, and it is only visible on a group an administrator
    // raised by hand: every built-in that grants manageServers seeds it at ASK,
    // so Full Access already prompted and proved nothing.
    //
    // `allow` meant "add servers without asking me", and update_server read it
    // as consent to rewrite the ones already saved -- silently. Repointing is
    // the quieter half of the danger: deleting "Prod DB" is loud and the next
    // call fails, while changing where it points keeps the name, the stored
    // credential and the sidebar entry, and every later use of it goes
    // somewhere new.
    useAllowGroup()
    const a = autoRespond('approved')
    const c = await clientFor(ALLOW_GROUP)
    try {
      await call(c, 'update_server', { serverName: 'Scanner01', host: '10.99.99.99' })
      expect(a.count()).toBe(1)
      expect(written).toHaveLength(1)
      const entry = listAudit().find((e) => e.action.startsWith('Change server'))
      expect(entry?.approval).toBe('approved')
    } finally {
      a.stop()
      await c.close()
    }
  })

  it('is not written at all when the user declines on an ALLOW group', async () => {
    useAllowGroup()
    const a = autoRespond('denied')
    const c = await clientFor(ALLOW_GROUP)
    try {
      const out = await call(c, 'update_server', { serverName: 'Scanner01', host: '10.99.99.99' })
      expect(out).toContain('Denied')
      expect(written).toHaveLength(0)
    } finally {
      a.stop()
      await c.close()
    }
  })

  it('asks even on Full Access, which seeds manageServers at ask', async () => {
    setAssignment({ level: 'workspace', workspaceId: 'ws' }, 'grp-full')
    const a = autoRespond('approved')
    const c = await clientFor('grp-full')
    try {
      await call(c, 'update_server', { serverName: 'Scanner01', host: '10.99.99.99' })
      expect(a.count()).toBe(1)
    } finally {
      a.stop()
      await c.close()
    }
  })

  // One yes covers the connection it was given about, and stops there.
  //
  // This used to ask again for every field. An agent walking a server through
  // two edits -- set the host, then set the jump chain -- put two identical
  // cards in front of an operator who had answered the first one seconds
  // earlier, which is the exact shape that teaches someone to click through a
  // dialog without reading it. The three tests below pin the edges of the
  // narrower grant: same server yes, other server no, other tool no.
  it('does not ask again for a second change to the same server in one session', async () => {
    const a = autoRespond('approved')
    const c = await clientFor('grp-full')
    try {
      await call(c, 'update_server', { serverName: 'Scanner01', port: 2201 })
      await call(c, 'update_server', { serverName: 'Scanner01', port: 2202 })
      expect(a.count()).toBe(1)
      // And the carried one says so, because the audit log is the only place
      // "a human looked at this one" and "a human looked at one like it" stay
      // apart.
      // The log is shared with every test above, so match the two ports this
      // test actually set rather than every change Scanner01 has ever seen.
      const carried = listAudit().filter((e) => /^Change server "Scanner01" \(port to 220[12]\)/.test(e.action))
      // Newest first, and exactly two rows: the carried call writes ONE, saying
      // it was carried. It used to write two -- gate() recorded
      // 'approved-earlier' with `result: 'success'` before the change had run,
      // and the tool then recorded 'approved' on top, which is the audit log
      // claiming a human had looked at a card nobody was shown.
      expect(carried.map((e) => e.approval)).toEqual(['approved-earlier', 'approved'])
    } finally {
      a.stop()
      await c.close()
    }
  })

  it('asks again for a change to a different server', async () => {
    const a = autoRespond('approved')
    const c = await clientFor('grp-full')
    try {
      await call(c, 'update_server', { serverName: 'Scanner01', port: 2201 })
      await call(c, 'update_server', { serverName: 'Scanner01-dup', port: 2202 })
      expect(a.count()).toBe(2)
    } finally {
      a.stop()
      await c.close()
    }
  })

  it('does not let a change approval buy the removal of that same server', async () => {
    // Both are `manageServers`. Keying the memory on the capability alone would
    // have made a yes about repointing a connection into a silent delete of it.
    const a = autoRespond('approved')
    const c = await clientFor('grp-full')
    try {
      await call(c, 'update_server', { serverName: 'Scanner01', port: 2201 })
      await call(c, 'remove_server', { serverName: 'Scanner01' })
      expect(a.count()).toBe(2)
    } finally {
      a.stop()
      await c.close()
    }
  })

  it('does not change anything when the user declines', async () => {
    const a = autoRespond('denied')
    const c = await clientFor('grp-full')
    try {
      const out = await call(c, 'update_server', { serverName: 'Scanner01', host: '10.99.99.99' })
      expect(out).toContain('Denied')
      expect(written).toHaveLength(0)
    } finally {
      a.stop()
      await c.close()
    }
  })

  it('is denied outright under Read Only', async () => {
    setAssignment({ level: 'workspace', workspaceId: 'ws' }, 'grp-read-only')
    const c = await clientFor('grp-read-only')
    try {
      const out = await call(c, 'update_server', { serverName: 'Scanner01', port: 2222 })
      expect(out).toContain('Denied')
      expect(written).toHaveLength(0)
    } finally {
      await c.close()
    }
  })

  it('refuses a rename onto another server, which would make one unaddressable', async () => {
    const c = await clientFor('grp-full')
    try {
      const out = await call(c, 'update_server', { serverName: 'Scanner01', name: 'Bastion' })
      expect(out).toContain('already exists')
      expect(written).toHaveLength(0)
    } finally {
      await c.close()
    }
  })

  it('clears the jump chain on an empty array and leaves it alone when omitted', async () => {
    const a = autoRespond('approved')
    const c = await clientFor('grp-full')
    try {
      await call(c, 'update_server', { serverName: 'Scanner01', jumpHosts: [] })
      const cleared = written[0] as Extract<AgentConfigRequest, { kind: 'server.update' }>
      expect(cleared.patch.route).toEqual([])

      written = []
      await call(c, 'update_server', { serverName: 'Scanner01', port: 22 })
      const untouched = written[0] as Extract<AgentConfigRequest, { kind: 'server.update' }>
      expect(untouched.patch.route).toBeUndefined()
    } finally {
      a.stop()
      await c.close()
    }
  })

  it('refuses to make a server its own jump host', async () => {
    const c = await clientFor('grp-full')
    try {
      const out = await call(c, 'update_server', { serverName: 'Scanner01', jumpHosts: ['Scanner01'] })
      expect(out).toContain('cannot be its own jump host')
    } finally {
      await c.close()
    }
  })

  it('refuses a call that changes nothing rather than asking for approval', async () => {
    const a = autoRespond('approved')
    const c = await clientFor('grp-full')
    try {
      const out = await call(c, 'update_server', { serverName: 'Scanner01' })
      expect(out).toContain('Nothing to change')
      expect(a.count()).toBe(0)
    } finally {
      a.stop()
      await c.close()
    }
  })
})

describe('remove_server', () => {
  it('asks even on Full Access, which grants manageServers outright', async () => {
    // An `allow` on manageServers meant "add servers without asking me". It
    // cannot be read as consent to delete them.
    setAssignment({ level: 'workspace', workspaceId: 'ws' }, 'grp-full')
    const a = autoRespond('approved')
    const c = await clientFor('grp-full')
    try {
      await call(c, 'remove_server', { serverName: 'Scanner01-dup' })
      expect(a.count()).toBe(1)
      const entry = listAudit().find((e) => e.action.startsWith('Remove server'))
      expect(entry?.approval).toBe('approved')
    } finally {
      a.stop()
      await c.close()
    }
  })

  it('asks again for a second removal in the same session', async () => {
    const a = autoRespond('approved')
    const c = await clientFor('grp-full')
    try {
      await call(c, 'remove_server', { serverName: 'Scanner01-dup' })
      await call(c, 'remove_server', { serverName: 'Bastion' })
      expect(a.count()).toBe(2)
    } finally {
      a.stop()
      await c.close()
    }
  })

  it('says what goes dark when the target is a jump host for something else', async () => {
    let because = ''
    const off = onApprovalEvent((e) => {
      if (e.type === 'created') {
        because = e.request.riskReason ?? ''
        respondToApproval(e.request.id, 'denied')
      }
    })
    const c = await clientFor('grp-full')
    try {
      await call(c, 'remove_server', { serverName: 'Bastion' })
      expect(because).toContain('Scanner01')
      expect(because).toContain('way in to')
    } finally {
      off()
      await c.close()
    }
  })

  it('does not delete when the user declines', async () => {
    const a = autoRespond('denied')
    const c = await clientFor('grp-full')
    try {
      const out = await call(c, 'remove_server', { serverName: 'Scanner01' })
      expect(out).toContain('Denied')
      expect(written).toHaveLength(0)
    } finally {
      a.stop()
      await c.close()
    }
  })

  it('is denied outright under Read Only', async () => {
    setAssignment({ level: 'workspace', workspaceId: 'ws' }, 'grp-read-only')
    const c = await clientFor('grp-read-only')
    try {
      const out = await call(c, 'remove_server', { serverName: 'Scanner01' })
      expect(out).toContain('Denied')
      expect(written).toHaveLength(0)
    } finally {
      await c.close()
    }
  })
})

describe('the dedup token', () => {
  it('is equal for two entries that are the same host, port and account', async () => {
    const c = await clientFor('grp-full')
    try {
      const out = await call(c, 'list_servers', { dedup: true })
      const ids = [...out.matchAll(/\[id ([0-9a-f]+)\]/g)].map((m) => m[1])
      expect(ids).toHaveLength(3)
      const lines = out.split('\n')
      const scanner = lines.find((l) => l.includes('Scanner01 '))!
      const dup = lines.find((l) => l.includes('Scanner01-dup'))!
      const bastion = lines.find((l) => l.includes('Bastion'))!
      // Saved twice, once with a capitalised username. One machine.
      expect(scanner.match(/\[id ([0-9a-f]+)\]/)![1]).toBe(dup.match(/\[id ([0-9a-f]+)\]/)![1])
      expect(bastion.match(/\[id ([0-9a-f]+)\]/)![1]).not.toBe(scanner.match(/\[id ([0-9a-f]+)\]/)![1])
    } finally {
      await c.close()
    }
  })

  it('discloses nothing: no host, port or username survives into it', async () => {
    const c = await clientFor('grp-full')
    try {
      const out = await call(c, 'list_servers', { dedup: true })
      expect(out).not.toContain('10.21.15')
      expect(out).not.toContain('root')
      expect(out).not.toMatch(/:22\b/)
    } finally {
      await c.close()
    }
  })

  it('differs between sessions, so it cannot be correlated after the fact', async () => {
    const a = await clientFor('grp-full')
    const b = await clientFor('grp-full')
    try {
      const first = await call(a, 'list_servers', { dedup: true })
      const second = await call(b, 'list_servers', { dedup: true })
      const idOf = (s: string): string => s.match(/\[id ([0-9a-f]+)\]/)![1]
      expect(idOf(first)).not.toBe(idOf(second))
    } finally {
      await a.close()
      await b.close()
    }
  })

  it('is absent unless asked for', async () => {
    const c = await clientFor('grp-full')
    try {
      const out = await call(c, 'list_servers', {})
      expect(out).not.toContain('[id ')
    } finally {
      await c.close()
    }
  })
})
