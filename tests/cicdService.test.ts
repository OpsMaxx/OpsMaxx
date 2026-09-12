import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { VaultEntry } from '../src/shared/vault'
import type { CicdConnection, CicdHttp } from '../src/shared/cicd'
import type { HttpRequestSpec, HttpResult } from '../src/shared/httpClient'

/**
 * The main-process half of the CI module — the only part allowed to hold a
 * token.
 *
 * Every assertion here is about a boundary rather than about behaviour an
 * adapter could have tested for itself: the credential goes into the right
 * header and never anywhere else, a route becomes the transport's `via`, and a
 * locked vault says so in its own words instead of arriving as "the CI server
 * is unreachable".
 */

let vaultEntries: VaultEntry[] = []
let vaultUnlocked = true

vi.mock('../src/main/services/secrets', () => ({
  getSecret: () => null,
  setSecret: () => undefined
}))

vi.mock('../src/main/services/vault', () => ({
  vaultStatus: () => ({ exists: true, unlocked: vaultUnlocked, entryCount: vaultEntries.length }),
  vaultList: () => ({ ok: true, entries: vaultEntries })
}))

// Same seam as tests/cicdTransport.test.ts: nothing in this file may reach the
// SSH pool, and the `via: server` assertions are about what would be handed to
// it, not about dialling anything.
vi.mock('../src/main/services/ssh', () => ({
  acquire: vi.fn(),
  release: vi.fn()
}))

const { makeCicdHttp, resolveSecret, authHeaders, viaForConnection, apiRootFor, createCicdAdapter } =
  await import('../src/main/services/cicd/service')
const { createGithubAdapter } = await import('../src/main/services/cicd/github')
const { VAULT_LOCKED } = await import('../src/main/services/credentialResolver')

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SECRET = 'glpat-NOT-A-REAL-TOKEN'

const connection = (over: Partial<CicdConnection> = {}): CicdConnection => ({
  id: 'c1',
  workspaceId: 'w1',
  name: 'Build',
  provider: 'gitlab',
  baseUrl: 'https://gitlab.example.com',
  vaultEntryId: 'v1',
  route: { kind: 'direct' },
  enabled: true,
  ...over
})

const server = {
  id: 's1',
  workspaceId: 'w1',
  name: 'bastion',
  host: '10.0.0.4',
  port: 22,
  username: 'deploy',
  auth: 'key' as const,
  os: 'linux',
  route: [{ host: 'jump.example.com', port: 22, username: 'jump', auth: 'key' as const }],
  vpnProfileId: 'vpn-7'
}

const ok = (status = 200, body = '{}', headers: Record<string, string> = {}): HttpResult => ({
  ok: true,
  status,
  statusText: '',
  headers,
  body: new TextEncoder().encode(body).buffer as ArrayBuffer,
  durationMs: 1,
  truncated: false
})

/** A transport that records what it was asked for and answers `body` every time. */
function wire(conn: CicdConnection, body = '{}', status = 200) {
  const specs: HttpRequestSpec[] = []
  const http = makeCicdHttp(conn, SECRET, {
    request: async (spec) => {
      specs.push(spec)
      return ok(status, body)
    },
    lookupServer: (id) => (id === server.id ? server : null)
  })
  return { specs, http }
}

beforeEach(() => {
  vaultUnlocked = true
  vaultEntries = [
    {
      id: 'v1',
      name: 'CI token',
      kind: 'key',
      url: '',
      username: '',
      password: SECRET,
      notes: '',
      tags: [],
      fields: [],
      createdAt: '',
      updatedAt: ''
    }
  ]
})

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

describe('the credential lands in the right header', () => {
  it('sends Jenkins HTTP Basic, username and token together', async () => {
    const conn = connection({ provider: 'jenkins', username: 'ops', baseUrl: 'https://ci.example.com/jenkins' })
    const { specs, http } = wire(conn)
    await http({ method: 'GET', path: '/api/json' })

    const value = specs[0].headers.Authorization
    expect(value.startsWith('Basic ')).toBe(true)
    expect(Buffer.from(value.slice('Basic '.length), 'base64').toString('utf8')).toBe(`ops:${SECRET}`)
  })

  it('refuses a Jenkins connection with no username rather than sending half a credential', () => {
    expect(() => authHeaders(connection({ provider: 'jenkins' }), SECRET)).toThrow(/username/i)
  })

  it('sends GitLab PRIVATE-TOKEN, not a Bearer', async () => {
    const { specs, http } = wire(connection())
    await http({ method: 'GET', path: '/user' })
    expect(specs[0].headers['PRIVATE-TOKEN']).toBe(SECRET)
    expect(specs[0].headers.Authorization).toBeUndefined()
  })

  it('sends GitHub a Bearer token', async () => {
    const { specs, http } = wire(connection({ provider: 'github', baseUrl: 'https://github.com' }))
    await http({ method: 'GET', path: '/user' })
    expect(specs[0].headers.Authorization).toBe(`Bearer ${SECRET}`)
  })

  it('wins over an adapter header of the same name', async () => {
    const { specs, http } = wire(connection())
    await http({ method: 'GET', path: '/user', headers: { 'PRIVATE-TOKEN': 'whatever-the-adapter-said' } })
    expect(specs[0].headers['PRIVATE-TOKEN']).toBe(SECRET)
  })

  it('never reaches the adapter', async () => {
    // The adapter is driven for real, through a `CicdHttp` that records every
    // request it makes. `CicdAdapter` is a read interface over a port main has
    // already authenticated; if a token ever showed up in one of these it would
    // mean an adapter could log it, put it in an error message, or send it
    // somewhere main did not choose.
    const conn = connection({ provider: 'github', baseUrl: 'https://github.com' })
    const specs: HttpRequestSpec[] = []
    const real = makeCicdHttp(conn, SECRET, {
      request: async (spec) => {
        specs.push(spec)
        return ok(200, JSON.stringify({ workflow_runs: [] }))
      }
    })
    const seen: Parameters<CicdHttp>[0][] = []
    const recorder: CicdHttp = async (req) => {
      seen.push(req)
      return real(req)
    }

    const adapter = createGithubAdapter(recorder, { connectionId: conn.id, baseUrl: conn.baseUrl })
    await adapter.listRuns('acme/app#.github/workflows/ci.yml', 5)

    expect(seen.length).toBeGreaterThan(0)
    expect(JSON.stringify(seen)).not.toContain(SECRET)
    // …and it did reach the wire, so this is not passing because nothing ran.
    expect(specs[0].headers.Authorization).toBe(`Bearer ${SECRET}`)
  })
})

describe('resolving the secret', () => {
  it('reads the vault entry the connection points at', () => {
    expect(resolveSecret(connection())).toBe(SECRET)
  })

  it('propagates a locked vault as its own failure, not as an unreachable server', () => {
    vaultUnlocked = false
    // The distinction is the point: `VAULT_LOCKED` is the token the renderer
    // matches on to offer an unlock, and it survives Electron flattening the
    // error across IPC. A generic "could not read" would send the user to check
    // whether Jenkins is up.
    expect(() => resolveSecret(connection())).toThrow(VAULT_LOCKED)
  })

  it('says the entry is empty rather than pretending the vault is locked', () => {
    vaultEntries = []
    const err = (() => {
      try {
        resolveSecret(connection())
        return null
      } catch (e) {
        return e as Error
      }
    })()
    expect(err?.message).toContain('no longer holds a credential')
    expect(err?.message).not.toContain(VAULT_LOCKED)
  })
})

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

describe('routes become a transport via', () => {
  it('maps direct', () => {
    expect(viaForConnection(connection(), () => null)).toEqual({ kind: 'direct' })
  })

  it('maps a bare VPN, which is the case direct cannot reach', () => {
    const via = viaForConnection(connection({ route: { kind: 'vpn', vpnProfileId: 'vpn-3' } }), () => null)
    expect(via).toEqual({ kind: 'vpn', vpnProfileId: 'vpn-3' })
  })

  it('maps a server, carrying the whole chain acquire() needs', () => {
    const via = viaForConnection(connection({ route: { kind: 'server', serverId: 's1' } }), (id) =>
      id === 's1' ? server : null
    )
    expect(via.kind).toBe('server')
    if (via.kind !== 'server') return
    expect(via.server.serverId).toBe('s1')
    expect(via.server.serverName).toBe('bastion')
    expect(via.server.host).toBe('10.0.0.4')
    // The jump chain and the profile travel with the target; nothing here dials
    // anything, because `acquire()` already knows how.
    expect(via.server.hops).toEqual(server.route)
    expect(via.server.vpnProfileId).toBe('vpn-7')
  })

  it('names the route, not the CI server, when the saved server is gone', () => {
    expect(() =>
      viaForConnection(connection({ route: { kind: 'server', serverId: 'missing' } }), () => null)
    ).toThrow(/routes through a saved server/)
  })

  it('reaches the transport on a real request', async () => {
    const { specs, http } = wire(connection({ route: { kind: 'server', serverId: 's1' } }))
    await http({ method: 'GET', path: '/user' })
    expect(specs[0].via.kind).toBe('server')
  })
})

// ---------------------------------------------------------------------------
// Request shape
// ---------------------------------------------------------------------------

describe('the request it builds', () => {
  it('resolves the API root through the adapter that owns the rule', () => {
    expect(apiRootFor(connection({ provider: 'github', baseUrl: 'https://github.com' }))).toBe(
      'https://api.github.com'
    )
    // GHES appends a path; github.com moves HOST. One builder always gets this
    // branch wrong, so there is exactly one and it lives in the adapter.
    expect(apiRootFor(connection({ provider: 'github', baseUrl: 'https://ghe.corp/orgs/acme' }))).toBe(
      'https://ghe.corp/api/v3'
    )
    expect(apiRootFor(connection({ provider: 'gitlab', baseUrl: 'https://gitlab.example.com/' }))).toBe(
      'https://gitlab.example.com/api/v4'
    )
    // Jenkins keeps whatever context path its admin chose.
    expect(
      apiRootFor(connection({ provider: 'jenkins', baseUrl: 'https://ci.example.com/jenkins/' }))
    ).toBe('https://ci.example.com/jenkins')
  })

  it('passes a private CA and the explicit insecure flag through', async () => {
    const { specs, http } = wire(connection({ caPem: '-----BEGIN CERTIFICATE-----', insecureTls: true }))
    await http({ method: 'GET', path: '/user' })
    expect(specs[0].caPem).toBe('-----BEGIN CERTIFICATE-----')
    expect(specs[0].insecureTls).toBe(true)
  })

  it('does not set insecureTls unless the connection did', async () => {
    const { specs, http } = wire(connection())
    await http({ method: 'GET', path: '/user' })
    expect(specs[0].insecureTls).toBeUndefined()
  })

  it('turns followRedirect into a redirect budget, and otherwise into none', async () => {
    const conn = connection({ provider: 'github', baseUrl: 'https://github.com' })
    const { specs, http } = wire(conn)
    // GitHub's log blob is a 302 to a signed URL on another origin that 401s if
    // an Authorization header follows it. `httpClient` strips credentials on a
    // cross-origin hop, which is what makes this safe to offer at all.
    await http({ method: 'GET', path: '/repos/a/b/actions/jobs/1/logs', followRedirect: true })
    await http({ method: 'GET', path: '/user' })
    expect(specs[0].maxRedirects).toBe(3)
    expect(specs[1].maxRedirects).toBe(0)
  })

  it('joins the path onto the API root', async () => {
    const { specs, http } = wire(connection())
    await http({ method: 'GET', path: '/projects/1/pipelines' })
    expect(specs[0].url).toBe('https://gitlab.example.com/api/v4/projects/1/pipelines')
  })

  it('turns a transport failure into a throw, not a fake response', async () => {
    const http = makeCicdHttp(connection(), SECRET, {
      request: async () => ({ ok: false, error: 'getaddrinfo ENOTFOUND gitlab.example.com' })
    })
    await expect(http({ method: 'GET', path: '/user' })).rejects.toThrow(/ENOTFOUND/)
  })

  it('hands the adapter the status and body it was answered with', async () => {
    const http = makeCicdHttp(connection(), SECRET, {
      request: async () => ok(404, '{"message":"404 Project Not Found"}', { etag: 'W/"a"' })
    })
    const res = await http({ method: 'GET', path: '/projects/9' })
    expect(res.status).toBe(404)
    expect(res.headers.etag).toBe('W/"a"')
    expect(JSON.parse(res.body).message).toBe('404 Project Not Found')
  })

  it('builds an adapter of the connection’s own provider', () => {
    const adapter = createCicdAdapter(connection({ provider: 'jenkins', username: 'ops' }), SECRET, {
      request: async () => ok()
    })
    expect(adapter.provider).toBe('jenkins')
    expect(adapter.capabilities().logMode).toBe('live')
  })
})
