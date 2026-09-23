import { describe, it, expect } from 'vitest'
import {
  DEFAULT_PREFS,
  defaults,
  isSensitiveName,
  isValidId,
  MAX_PERSISTED_BODY_BYTES,
  newId,
  maskProtocol,
  persistableBody,
  protocolKeptOnSave,
  protocolCarriesCredential,
  routeKeyOf,
  stableId,
  stripLiteralSecrets,
  type ApiCollectionV2,
  type Body,
  type Folder,
  type HttpRequest,
  type HttpSessionV1
} from '../src/shared/apiModel'

// The helpers that landed with the t0 contract, because every stream calls them
// on day one. Stream A extends this file with the stripping cases.

describe('stableId', () => {
  it('is deterministic, valid and sensitive to how the parts are split', () => {
    const id = stableId('req', 'col_1', 'GET', '/pets', '0')
    expect(stableId('req', 'col_1', 'GET', '/pets', '0')).toBe(id)
    expect(id).toMatch(/^req_[0-9a-f]{16}$/)
    expect(isValidId(id)).toBe(true)
    expect(stableId('req', 'ab', 'c')).not.toBe(stableId('req', 'a', 'bc'))
    expect(stableId('req', 'x')).not.toBe(stableId('req', 'y'))
  })
})

describe('isValidId', () => {
  it('accepts the id charset and nothing else', () => {
    expect(isValidId(newId('col'))).toBe(true)
    expect(isValidId('a'.repeat(64))).toBe(true)
    for (const bad of ['', 'a'.repeat(65), 'a b', 'a/b', 'é', 42, null, undefined]) {
      expect(isValidId(bad), String(bad)).toBe(false)
    }
  })

  it('refuses the prototype keys the charset would let through', () => {
    for (const key of ['__proto__', 'constructor', 'prototype']) expect(isValidId(key)).toBe(false)
  })
})

describe('isSensitiveName', () => {
  it('flags credential-bearing names in any case', () => {
    for (const name of ['Authorization', 'Proxy-Authorization', 'Cookie', 'Set-Cookie', 'X-Api-Key', 'api_key', 'password', 'token', 'sig', 'signature', 'X-Amz-Signature', 'X-Amz-Credential', 'X-Amz-Security-Token', 'Ocp-Apim-Subscription-Key', 'x-functions-key', 'client_secret', 'session', 'jwt', 'access_token']) {
      expect(isSensitiveName(name), name).toBe(true)
    }
  })

  it('leaves ordinary headers alone', () => {
    for (const name of ['Accept', 'Content-Type', 'Accept-Encoding', 'User-Agent', 'X-Request-Id']) {
      expect(isSensitiveName(name), name).toBe(false)
    }
  })
})

describe('defaults', () => {
  it('builds each request kind with a fresh valid id', () => {
    const http = defaults.http()
    expect(http).toMatchObject({ kind: 'http', method: 'GET', auth: { type: 'inherit' }, body: { mode: 'none' } })
    expect(http.settings).toEqual({ followRedirects: true, maxRedirects: 5 })
    expect(defaults.ws()).toMatchObject({ kind: 'ws', protocols: [], messages: [] })
    expect(defaults.graphql()).toMatchObject({ kind: 'graphql', query: '', variables: '' })
    expect(isValidId(http.id)).toBe(true)
    expect(defaults.http().id).not.toBe(http.id)
  })

  it('builds a collection that verifies TLS and sends directly', () => {
    const c = defaults.collection('ws_1', 'Pets')
    expect(c).toMatchObject({ version: 2, workspaceId: 'ws_1', name: 'Pets', insecureTls: false, viaServerId: null })
    expect(c.auth).toEqual({ type: 'none' })
    expect(isValidId(c.id)).toBe(true)
  })
})

describe('stripLiteralSecrets', () => {
  const req = (over: Partial<HttpRequest>): HttpRequest => ({ ...defaults.http(), id: 'req_1', ...over })
  const row = (key: string, value: string, i = 0) => ({ id: `row_${i}`, enabled: true, key, value })

  it('keeps references and strips literals in credential slots', () => {
    const kept = ['', '   ', '{{token}}', 'vault:abc#password', 'Bearer {{t}}', 'Basic vault:abc#password', 'Token {{a}}{{b}}']
    for (const token of kept) {
      const { value, stripped } = stripLiteralSecrets(req({ auth: { type: 'bearer', token } }))
      expect(value.auth, token).toEqual({ type: 'bearer', token })
      expect(stripped).toEqual([])
    }
    for (const token of ['eyJhbGc', 'Bearer eyJ…{{x}}', '{{x}}suffix', 'prefix{{x}}', 'vault:abc#password extra']) {
      const { value, stripped } = stripLiteralSecrets(req({ auth: { type: 'bearer', token } }))
      expect(value.auth, token).toEqual({ type: 'bearer', token: '' })
      expect(stripped).toEqual(['auth.token'])
    }
  })

  it('strips basic passwords and API key values but not usernames or key names', () => {
    const basic = stripLiteralSecrets(req({ auth: { type: 'basic', username: 'alice', password: 'hunter2' } }))
    expect(basic.value.auth).toEqual({ type: 'basic', username: 'alice', password: '' })
    const key = stripLiteralSecrets(req({ auth: { type: 'apikey', name: 'X-Api-Key', value: 'abc', in: 'header' } }))
    expect(key.value.auth).toEqual({ type: 'apikey', name: 'X-Api-Key', value: '', in: 'header' })
    expect(key.stripped).toEqual(['auth.value'])
  })

  it('strips Authorization, Proxy-Authorization and Cookie rows, and warns-only on the rest', () => {
    const headers = [
      row('Authorization', 'Bearer abc', 0),
      row('proxy-authorization', 'Basic xyz', 1),
      row('Cookie', 'sid=1', 2),
      row('X-Api-Key', 'literal', 3),
      row('Authorization', 'Bearer {{t}}', 4)
    ]
    const { value, stripped } = stripLiteralSecrets(req({ headers }))
    expect(value.headers.map((h) => h.value)).toEqual(['', '', '', 'literal', 'Bearer {{t}}'])
    expect(value.headers.map((h) => h.key)).toEqual(headers.map((h) => h.key))
    expect(stripped).toEqual(['headers.0.value', 'headers.1.value', 'headers.2.value'])
  })

  it('strips literal URL userinfo everywhere, whole', () => {
    const { value, stripped } = stripLiteralSecrets(req({ url: 'https://u:p@h.example.test/x' }))
    expect(value.url).toBe('https://h.example.test/x')
    expect(stripped).toEqual(['url'])
    // A literal user name goes too: it may be a token (https://ghp_x@github.com).
    expect(stripLiteralSecrets(req({ url: 'https://u:{{pw}}@h/x' })).value.url).toBe('https://h/x')
    expect(stripLiteralSecrets(req({ url: 'https://{{u}}:{{pw}}@h/x' })).value.url).toBe('https://{{u}}:{{pw}}@h/x')
    // Leading whitespace is not a strip.
    expect(stripLiteralSecrets(req({ url: ' https://h/x' })).stripped).toEqual([])

    const c: ApiCollectionV2 = {
      ...defaults.collection('ws_1', 'C'),
      variables: [{ id: 'var_1', key: 'baseUrl', value: 'http://a:b@h', enabled: true }],
      importedFrom: { kind: 'openapi', url: 'https://x:y@spec.example.test/o.json', at: '2026-01-01' },
      auth: { type: 'bearer', token: 'lit' },
      items: [{ kind: 'folder', id: 'fld_1', name: 'F', items: [req({ url: 'https://q:r@h' })] }]
    }
    const out = stripLiteralSecrets(c)
    expect(out.value.variables[0].value).toBe('http://h')
    expect(out.value.importedFrom?.url).toBe('https://spec.example.test/o.json')
    expect(out.value.auth).toEqual({ type: 'bearer', token: '' })
    expect((out.value.items[0] as Folder).items[0]).toMatchObject({ url: 'https://h' })
    expect(out.stripped.sort()).toEqual(['auth.token', 'importedFrom.url', 'items.0.items.0.url', 'variables.0.value'])
  })

  it('records a session tab’s stripped paths relative to its draft', () => {
    const session: HttpSessionV1 = {
      version: 1,
      tabs: [
        { id: 'tab_1', workspaceId: 'ws_1', preview: false, split: 'normal', kind: 'request', draft: req({ auth: { type: 'bearer', token: 'x' } }) },
        { id: 'tab_2', workspaceId: 'ws_1', preview: false, split: 'normal', kind: 'request', draft: req({}), strippedFields: ['old'] }
      ],
      activeTab: Object.create(null),
      sidebarTab: 'collections',
      expanded: [],
      prefs: DEFAULT_PREFS
    }
    const { value, stripped } = stripLiteralSecrets(session)
    expect(value.tabs[0].strippedFields).toEqual(['auth.token'])
    expect(value.tabs[1].strippedFields).toBeUndefined()
    expect(stripped).toEqual(['tabs.0.draft.auth.token'])
  })

  it('does not mutate its input', () => {
    const input = req({ auth: { type: 'bearer', token: 'x' } })
    stripLiteralSecrets(input)
    expect(input.auth).toEqual({ type: 'bearer', token: 'x' })
  })
})

describe('persistableBody', () => {
  it('keeps a body under 256 KiB and empties one over it, keeping the mode', () => {
    const small: Body = { mode: 'json', text: '{"a":1}' }
    expect(persistableBody(small)).toEqual({ body: small, dropped: false })
    const big = 'x'.repeat(MAX_PERSISTED_BODY_BYTES + 1)
    expect(persistableBody({ mode: 'text', text: big })).toEqual({ body: { mode: 'text', text: '' }, dropped: true })
    expect(persistableBody({ mode: 'urlencoded', rows: [{ id: 'r', enabled: true, key: 'k', value: big }] })).toEqual({
      body: { mode: 'urlencoded', rows: [] },
      dropped: true
    })
  })
})

describe('routeKeyOf', () => {
  it('is the jar and cache key for each route kind', () => {
    expect(routeKeyOf({ kind: 'direct' })).toBe('direct')
    expect(routeKeyOf({ kind: 'server', serverId: 'srv_1' })).toBe('server:srv_1')
    expect(routeKeyOf({ kind: 'vpn', vpnProfileId: 'vpn_1' })).toBe('vpn:vpn_1')
  })
})

describe('earlier "not kept" marks survive a save (M1)', () => {
  it('keeps a path while its value is still the mask or empty, and drops it once re-entered or gone', () => {
    const draft = {
      ...defaults.http(),
      headers: [
        { id: 'r0', enabled: true, key: 'X-Api-Key', value: '•••' },
        { id: 'r1', enabled: true, key: 'X-Other', value: 'typed-again' },
        { id: 'r2', enabled: true, key: 'Authorization', value: 'Bearer lit' }
      ]
    }
    const session: HttpSessionV1 = {
      version: 1,
      tabs: [{ id: 'tab_1', workspaceId: 'ws_1', preview: false, split: 'normal', kind: 'request', draft, strippedFields: ['headers.0.value', 'headers.1.value', 'params.9.value'] }],
      activeTab: Object.create(null),
      sidebarTab: 'collections',
      expanded: [],
      prefs: DEFAULT_PREFS
    }
    const { value } = stripLiteralSecrets(session)
    expect(value.tabs[0].strippedFields).toEqual(['headers.0.value', 'headers.2.value'])
  })
})

describe('WebSocket subprotocols (finalsec M3)', () => {
  it('keeps protocol names and references, and strips anything shaped like a credential', () => {
    const ws = {
      ...defaults.ws(),
      protocols: ['graphql-transport-ws', 'v12.stomp', '{{proto}}', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload', 'Bearer abc', 'x'.repeat(41), 'bearer.authorization.k8s.io.tok', 'a.token.b']
    }
    const { value, stripped } = stripLiteralSecrets(ws)
    expect(value.protocols).toEqual(['graphql-transport-ws', 'v12.stomp', '{{proto}}', '', '', '', '', ''])
    expect(stripped).toEqual(['protocols.3', 'protocols.4', 'protocols.5', 'protocols.6', 'protocols.7'])
    expect(maskProtocol('base64url.bearer.authorization.k8s.io.tok')).toBe('base64url.bearer.authorization.•••')
    expect(protocolCarriesCredential('{{proto}}')).toBe(false)
  })
})

describe('the pane warns about exactly what the save drops (finalsec N1)', () => {
  it('strips a name-shaped protocol with a sensitive dot-part, and warn == strip', () => {
    const protocols = [
      'access_token.9f8e7d6c5b4a',
      'token.3f2b1c4d-aaaa-bbbb-cccc-1234567890ab',
      'graphql-ws',
      'mqtt',
      '{{p}}',
      'eyJhbGciOiJIUzI1NiJ9.x.y',
      'base64url.bearer.authorization.k8s.io.tok'
    ]
    const { value } = stripLiteralSecrets({ ...defaults.ws(), protocols })
    expect(value.protocols.slice(0, 2)).toEqual(['', ''])
    // The pane's predicate is !protocolKeptOnSave: stripped exactly when warned.
    protocols.forEach((p, i) => expect(value.protocols[i] === '', p).toBe(!protocolKeptOnSave(p)))
    // And every protocol the pane's credential check flags is among them.
    protocols.filter((p) => protocolCarriesCredential(p)).forEach((p) => expect(protocolKeptOnSave(p), p).toBe(false))
  })
})
