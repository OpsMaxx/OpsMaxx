import { describe, it, expect, beforeEach, vi } from 'vitest'
import { existsSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, safeStorage } from 'electron'
import type { ApiRequest, HttpRequest, GraphQlRequest, Row, WsRequest } from '../src/shared/apiModel'
import type { HistoryEntry } from '../src/shared/httpHistory'

// Which keyring this machine has is the whole question, so it is a knob.
const keyring = { available: true, backend: null as string | null }
vi.mock('../src/main/services/secretsBackend', () => ({
  secretsAvailable: () => keyring.available,
  secretsBackend: () => keyring.backend
}))

const {
  appendHistory,
  clearHistory,
  historySealed,
  listHistory,
  pruneHistory,
  removeHistory,
  resetHttpHistoryForTests
} = await import('../src/main/services/httpHistory')
const { toHistoryEntry, sanitizeHistoryEntry, maskHistoryUrl } = await import('../src/shared/httpHistory')

// A seal that is not the identity, so "the file holds no plaintext" means
// something. Anything starting "BAD" refuses to open, the way a line sealed
// under a reset keychain does.
safeStorage.encryptString = (s: string) => Buffer.from(Buffer.from(s, 'utf8').map((b) => b ^ 0x5a))
safeStorage.decryptString = (b: Buffer) => {
  const plain = Buffer.from(b.map((x) => x ^ 0x5a)).toString('utf8')
  if (plain.startsWith('BAD')) throw new Error('cannot decrypt')
  return plain
}

const dir = app.getPath('userData')
const FILE = join(dir, 'opsmaxx-http-history.jsonl')
const DAY = 24 * 60 * 60 * 1000

const row = (key: string, value: string): Row => ({ id: `row_${key.replace(/\W/g, '')}`, enabled: true, key, value })

const httpReq = (over: Partial<HttpRequest> = {}): HttpRequest => ({
  id: 'req_1',
  name: 'List orders',
  kind: 'http',
  method: 'GET',
  url: 'https://api.example.com/orders',
  headers: [],
  params: [],
  pathParams: [],
  auth: { type: 'none' },
  body: { mode: 'none' },
  settings: { followRedirects: true, maxRedirects: 5 },
  ...over
})

const sent = {
  method: 'GET',
  url: '',
  headers: [] as [string, string][],
  route: { key: 'direct' as const, label: 'This machine' },
  tls: 'verified' as const,
  maxRedirects: 5,
  timeoutMs: 30000,
  bodyBytes: 0
}
const done = {
  status: 'done' as const,
  response: {
    ok: true as const,
    status: 200,
    statusText: 'OK',
    headers: { 'Content-Type': 'application/json' },
    body: new ArrayBuffer(12),
    durationMs: 40,
    truncated: false
  },
  sentAs: sent,
  at: 0
}
const ctx = { route: { kind: 'server' as const, serverId: 'srv_1' }, routeLabel: 'bastion' }

const entryFor = (req: ApiRequest, at = Date.now()): HistoryEntry =>
  toHistoryEntry(req, sent, done, { ...ctx, now: at })

/** Every line of the file, opened. */
function sealedPlaintext(): string {
  if (!existsSync(FILE)) return ''
  return readFileSync(FILE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => safeStorage.decryptString(Buffer.from(JSON.parse(l).enc, 'base64')))
    .join('\n')
}

// ---------------------------------------------------------------- SEC-H1

const SECRET = /SECRET_/
const secretHeaders = [
  row('X-Api-Key', 'SECRET_APIKEY'),
  row('Authorization', 'Basic SECRET_BASIC'),
  row('Cookie', 'session=SECRET_COOKIE'),
  row('Ocp-Apim-Subscription-Key', 'SECRET_OCP'),
  row('Accept', 'application/json')
]
const secretUrl =
  'https://u:SECRET_USERINFO@h.example/p?access_token=SECRET_AT&sig=SECRET_SIG&X-Amz-Signature=SECRET_AMZ&key=SECRET_KEY&page=2'
const fixture: ApiRequest[] = [
  httpReq({
    method: 'POST',
    url: secretUrl,
    headers: secretHeaders,
    params: [row('access_token', 'SECRET_PARAM'), row('page', '2')],
    body: { mode: 'json', text: '{"a":{"password":"SECRET_JSON"},"n":1}' }
  }),
  httpReq({
    method: 'POST',
    body: { mode: 'urlencoded', rows: [row('user', 'alice'), row('password', 'SECRET_FORM')] },
    auth: { type: 'basic', username: 'alice', password: 'SECRET_AUTH' }
  }),
  {
    id: 'req_gql',
    name: 'login',
    kind: 'graphql',
    url: 'https://h.example/graphql',
    headers: [],
    auth: { type: 'bearer', token: 'SECRET_BEARER' },
    query: 'mutation { login }',
    variables: '{"token":"SECRET_GQL"}',
    settings: {}
  } satisfies GraphQlRequest,
  // finalsec M3: a subprotocol can carry a bearer token.
  {
    id: 'req_ws',
    name: 'exec',
    kind: 'ws',
    url: 'wss://k8s.example/api/v1/exec',
    headers: [],
    auth: { type: 'none' },
    params: [],
    protocols: ['base64url.bearer.authorization.k8s.io.SECRET_K8S', 'v4.channel.k8s.io'],
    messages: [{ id: 'msg_1', name: 'auth', format: 'json', text: '{"token":"SECRET_FRAME"}' }]
  } satisfies WsRequest,
  // finalsec L5: a credential whose name is data, and one inline in a query.
  httpReq({ method: 'POST', body: { mode: 'json', text: '[{"name":"password","value":"SECRET_NV"},{"key":"api_key","val":"SECRET_KV"}]' } }),
  {
    id: 'req_gql2',
    name: 'inline',
    kind: 'graphql',
    url: 'https://h.example/graphql',
    headers: [],
    auth: { type: 'none' },
    query: 'mutation { login(user: "alice", password: "SECRET_GQLQ", input: { apiKey: "SECRET_OBJ", token: $t }) { ok } }',
    variables: '',
    settings: {}
  } satisfies GraphQlRequest
]

beforeEach(() => {
  keyring.available = true
  keyring.backend = null
  clearHistory()
  resetHttpHistoryForTests()
})

describe('structural redaction (SEC-H1)', () => {
  it('leaves no secret in toHistoryEntry, the sealed plaintext, or list', () => {
    for (const req of fixture) {
      const e = entryFor(req)
      expect(JSON.stringify(e)).not.toMatch(SECRET)
      expect(appendHistory(e)).toBe(true)
    }
    expect(sealedPlaintext()).not.toMatch(SECRET)
    // The renderer's half keeps what is not a credential. (Main's redactPatterns
    // pass then takes the rest of a query after `access_token=`: a text rule
    // cannot tell where a value ends, and it errs towards the secret.)
    expect(entryFor(fixture[0]).request.url).toContain('page=2')
    const listed = listHistory({ limit: 50 })
    expect(listed).toHaveLength(fixture.length)
    expect(JSON.stringify(listed)).not.toMatch(SECRET)
  })

  it('re-applies it in main to a raw entry the renderer never redacted', () => {
    for (const req of fixture) {
      const raw = { ...entryFor(httpReq()), kind: req.kind, request: req, extra: 'SECRET_EXTRA' }
      expect(appendHistory(raw)).toBe(true)
    }
    expect(sealedPlaintext()).not.toMatch(SECRET)
    expect(JSON.stringify(listHistory({ limit: 50 }))).not.toMatch(SECRET)
  })

  it('keeps a query readable while masking its inline credentials, and drops one it cannot parse', () => {
    const e = entryFor(fixture.at(-1)!)
    const q = (e.request as GraphQlRequest).query
    expect(q).toContain('user: "alice"')
    expect(q).toContain('password: "•••"')
    expect(q).toContain('token: $t')
    const broken = entryFor({ ...(fixture.at(-1) as GraphQlRequest), query: 'mutation { login(password: "SECRET_X"' })
    expect(broken.bodyOmitted).toBe('unparseable')
    expect(JSON.stringify(broken)).not.toMatch(SECRET)
  })

  it.each([
    [' https://u:SECRET_A@h.example/x', ' https://•••@h.example/x'],
    ['https://u:SECRET_B@ss@h.example/x', 'https://•••@h.example/x'],
    ['https://ghp_SECRET_C@github.com/o/r', 'https://•••@github.com/o/r'],
    ['https://{{u}}:vault:abc#password@h.example/x', 'https://{{u}}:vault:abc#password@h.example/x']
  ])('masks the whole userinfo of %j unless it is a reference (L4)', (url, masked) => {
    expect(maskHistoryUrl(url)).toBe(masked)
  })

  it('masks a subprotocol by the save strip\'s rule: names and references kept, credentials not', () => {
    const protocols = [
      '{{proto}}',
      'graphql-transport-ws',
      'v4.channel.k8s.io',
      'base64url.bearer.authorization.k8s.io.SECRET_T',
      'eyJhbGciOiJIUzI1NiJ9SECRETSECRETSECRET'
    ]
    const ws = { ...(fixture[3] as WsRequest), protocols }
    expect((entryFor(ws).request as WsRequest).protocols).toEqual([
      '{{proto}}',
      'graphql-transport-ws',
      'v4.channel.k8s.io',
      '•••',
      '•••'
    ])
  })

  it('masks a name/value pair whatever the case of its keys', () => {
    const e = entryFor(
      httpReq({ method: 'POST', body: { mode: 'json', text: '[{"Name":"token","Value":"SECRET_UC"},{"KEY":"Password","VAL":"SECRET_UC2"}]' } })
    )
    expect(JSON.stringify(e)).not.toMatch(SECRET)
    expect((e.request as HttpRequest).body).toMatchObject({ mode: 'json', text: expect.stringContaining('"Name": "token"') })
  })

  it('keeps references, so Send again still authenticates', () => {
    const e = entryFor(
      httpReq({
        url: 'https://{{u}}:{{p}}@h/x?token={{t}}',
        headers: [row('Authorization', 'Bearer {{token}}'), row('X-Api-Key', 'vault:abc#password')]
      })
    )
    const req = e.request as HttpRequest
    expect(req.headers.map((h) => h.value)).toEqual(['Bearer {{token}}', 'vault:abc#password'])
    expect(req.url).toBe('https://{{u}}:{{p}}@h/x?token={{t}}')
    // A literal glued to a reference is still a literal.
    const glued = entryFor(httpReq({ headers: [row('Authorization', 'Bearer eyJabc{{x}}')] }))
    expect((glued.request as HttpRequest).headers[0].value).toBe('•••')
  })

  it('omits bodies it cannot walk, and caps the ones it can', () => {
    expect(entryFor(httpReq({ body: { mode: 'json', text: '{nope' } })).bodyOmitted).toBe('unparseable')
    expect(entryFor(httpReq({ body: { mode: 'xml', text: '<p>SECRET_X</p>' } })).bodyOmitted).toBe('not-stored')
    const big = JSON.stringify({ a: 'x'.repeat(20 * 1024) })
    expect(entryFor(httpReq({ body: { mode: 'json', text: big } })).bodyOmitted).toBe('too-large')
  })

  it('keeps the route id and the response metadata, never the body', () => {
    const e = entryFor(httpReq())
    expect(e.route).toEqual({ kind: 'server', serverId: 'srv_1' })
    expect(e.response).toEqual({ status: 200, statusText: 'OK', durationMs: 40, size: 12, contentType: 'application/json' })
  })

  it('rejects what is not an entry, and an entry over 64 KiB', () => {
    expect(sanitizeHistoryEntry('nope')).toBeNull()
    expect(appendHistory({ request: { kind: 'ftp' } })).toBe(false)
    const huge = httpReq({ headers: Array.from({ length: 200 }, (_, i) => row(`X-H${i}`, 'v'.repeat(1000))) })
    expect(appendHistory(entryFor(huge))).toBe(false)
  })
})

describe('sealing (SEC-H2)', () => {
  it('round-trips through the seal, and the file holds no plaintext', () => {
    appendHistory(entryFor(httpReq()))
    expect(readFileSync(FILE, 'utf8')).not.toContain('api.example.com')
    resetHttpHistoryForTests()
    expect(listHistory({ limit: 10 })[0].request.url).toBe('https://api.example.com/orders')
  })

  it.each([
    ['no keyring', { available: false, backend: null }],
    ['basic_text', { available: true, backend: 'basic_text' }]
  ])('%s: no file, and the session still has its entries', (_name, state) => {
    Object.assign(keyring, state)
    expect(historySealed()).toBe(false)
    appendHistory(entryFor(httpReq()))
    expect(existsSync(FILE)).toBe(false)
    expect(listHistory({ limit: 10 })).toHaveLength(1)
  })
})

describe('entry hygiene', () => {
  it('clamps a future timestamp to now, in the renderer and in main', () => {
    const future = Date.now() + 365 * DAY
    expect(entryFor(httpReq(), future).at).toBeLessThanOrEqual(Date.now())
    expect(sanitizeHistoryEntry({ ...entryFor(httpReq()), at: future })!.at).toBeLessThanOrEqual(Date.now())
  })

  it('refuses a second entry with an id already kept, so the file never holds it twice', () => {
    const e = entryFor(httpReq())
    expect(appendHistory(e)).toBe(true)
    expect(appendHistory({ ...e, request: { ...e.request, name: 'changed' } })).toBe(false)
    expect(readFileSync(FILE, 'utf8').trim().split('\n')).toHaveLength(1)
  })

  it('is gone after Delete all data, and a later remove cannot write it back', async () => {
    const { deleteAllData } = await import('../src/main/services/backup')
    appendHistory(entryFor(httpReq({ name: 'a' })))
    appendHistory(entryFor(httpReq({ name: 'b' })))
    deleteAllData()
    removeHistory('hst_nothing')
    appendHistory(entryFor(httpReq({ name: 'c' })))
    removeHistory(listHistory({ limit: 10 })[0].id)
    expect(readdirSync(dir).filter((n) => n.startsWith('opsmaxx-http-history'))).toEqual([])
    expect(listHistory({ limit: 10 })).toEqual([])
  })
})

describe('retention', () => {
  it('prunes a 31-day-old entry even among the newest 100', () => {
    const now = Date.now()
    appendHistory(entryFor(httpReq({ name: 'old' }), now - 31 * DAY))
    for (let i = 0; i < 5; i++) appendHistory(entryFor(httpReq({ name: `new${i}` }), now - i))
    pruneHistory(now)
    expect(listHistory({ limit: 100 }).map((e) => e.request.name)).not.toContain('old')
    resetHttpHistoryForTests()
    expect(listHistory({ limit: 100 })).toHaveLength(5)
  })

  it('drops a corrupt or undecryptable line, and rewrites the file without it', () => {
    appendHistory(entryFor(httpReq({ name: 'good' })))
    const bad = safeStorage.encryptString('BAD sealed under another keychain').toString('base64')
    writeFileSync(FILE, `${readFileSync(FILE, 'utf8')}not json\n{"t":"x","enc":"e"}\n{"t":1,"enc":"${bad}"}\n`)
    resetHttpHistoryForTests()
    expect(listHistory({ limit: 10 }).map((e) => e.request.name)).toEqual(['good'])
    expect(readFileSync(FILE, 'utf8').trim().split('\n')).toHaveLength(1)
  })

  it('clear leaves no opsmaxx-http-history* file behind', () => {
    appendHistory(entryFor(httpReq()))
    writeFileSync(`${FILE}.tmp`, 'leftover')
    clearHistory()
    expect(readdirSync(dir).filter((n) => n.startsWith('opsmaxx-http-history'))).toEqual([])
    expect(listHistory({ limit: 10 })).toEqual([])
  })

  it('remove takes one entry out of memory and off disk', () => {
    const a = entryFor(httpReq({ name: 'a' }))
    appendHistory(a)
    appendHistory(entryFor(httpReq({ name: 'b' })))
    removeHistory(a.id)
    resetHttpHistoryForTests()
    expect(listHistory({ limit: 10 }).map((e) => e.request.name)).toEqual(['b'])
  })
})

describe('the file path', () => {
  it('refuses a symlink planted at it', () => {
    const target = join(dir, 'elsewhere.txt')
    writeFileSync(target, '')
    rmSync(FILE, { force: true })
    symlinkSync(target, FILE)
    appendHistory(entryFor(httpReq()))
    expect(readFileSync(target, 'utf8')).toBe('')
    expect(listHistory({ limit: 10 })).toHaveLength(1)
    rmSync(FILE, { force: true })
  })
})

describe('workspaces', () => {
  it('records the workspace, and main keeps only a valid id', () => {
    const e = toHistoryEntry(httpReq(), sent, done, { ...ctx, workspaceId: 'ws_a' })
    expect(e.workspaceId).toBe('ws_a')
    expect(sanitizeHistoryEntry(e)!.workspaceId).toBe('ws_a')
    expect(sanitizeHistoryEntry({ ...e, workspaceId: '__proto__' })!.workspaceId).toBeUndefined()
  })

  it('filters a page by workspace in main, older entries shown only when they name nothing', () => {
    const now = Date.now()
    const direct = { route: { kind: 'direct' as const }, routeLabel: 'This machine' }
    appendHistory(toHistoryEntry(httpReq({ name: 'a1' }), sent, done, { ...ctx, workspaceId: 'ws_a', now: now - 1 }))
    appendHistory(toHistoryEntry(httpReq({ name: 'b1' }), sent, done, { ...ctx, workspaceId: 'ws_b', now: now - 2 }))
    appendHistory(toHistoryEntry(httpReq({ name: 'old-direct' }), sent, done, { ...direct, now: now - 3 }))
    appendHistory(toHistoryEntry(httpReq({ name: 'old-routed' }), sent, done, { ...ctx, now: now - 4 }))
    const names = (ws?: string): string[] => listHistory({ limit: 1, workspaceId: ws }).map((e) => e.request.name)
    expect(names('ws_a')).toEqual(['a1'])
    expect(listHistory({ limit: 10, workspaceId: 'ws_b' }).map((e) => e.request.name)).toEqual(['b1', 'old-direct'])
    expect(listHistory({ limit: 10 })).toHaveLength(4)
    // A page of one is still full when the newest entry belongs elsewhere.
    expect(names('ws_b')).toEqual(['b1'])
  })
})

describe('list', () => {
  it('matches a case-insensitive substring, never a RegExp, and pages by `before`', () => {
    const now = Date.now()
    appendHistory(entryFor(httpReq({ name: 'a', url: 'https://h/Orders/(a+)+$' }), now - 2))
    appendHistory(entryFor(httpReq({ name: 'b', url: 'https://h/users' }), now - 1))
    expect(listHistory({ limit: 10, query: 'ORDERS' })).toHaveLength(1)
    expect(listHistory({ limit: 10, query: '(a+)+$' })).toHaveLength(1)
    expect(listHistory({ limit: 10, query: '.*' })).toHaveLength(0)
    const first = listHistory({ limit: 1 })
    expect(first[0].request.url).toBe('https://h/users')
    expect(listHistory({ limit: 10, before: first[0].at })[0].request.url).toContain('Orders')
  })
})
