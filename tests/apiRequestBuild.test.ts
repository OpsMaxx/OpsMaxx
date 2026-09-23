import { describe, it, expect } from 'vitest'
import { defaults, type ApiCollectionV2, type HttpRequest, type Row } from '../src/shared/apiModel'
import type { SecretLookup } from '../src/shared/apiSecrets'
import { buildGraphQlSpec, buildHttpSpec, buildWsSpec, type BuildCtx } from '../src/shared/apiRequestBuild'

const SECRET = 's3cr3t-value'
const unlocked: SecretLookup = {
  unlocked: true,
  read: ({ entryId, field }) => (entryId === 'gone' ? null : field === 'username' ? 'vault-user' : SECRET)
}
const locked: SecretLookup = { unlocked: false, read: () => null }

const row = (key: string, value: string, enabled = true): Row => ({ id: `row_${key}`, enabled, key, value })
const req = (over: Partial<HttpRequest> = {}): HttpRequest => ({ ...defaults.http(), url: 'https://api.example.test/x', ...over })
const ctx = (over: Partial<BuildCtx> = {}): BuildCtx => ({
  globals: [],
  vault: unlocked,
  servers: [
    { id: 'srv_1', name: 'bastion', tags: [], target: { serverId: 'srv_1', host: 'h', port: 22, username: 'u', auth: 'agent' } as never }
  ],
  vpns: [{ id: 'vpn_1', name: 'office' }],
  route: { kind: 'direct' },
  requestId: 'rq_1',
  ...over
})
const text = (buf: ArrayBuffer | undefined): string => new TextDecoder().decode(buf)

function ok<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error(`build failed: ${JSON.stringify(r)}`)
  return r as Extract<T, { ok: true }>
}

describe('auth', () => {
  it('Basic with a vault password is base64(user:secret), and sent shows Basic •••', () => {
    const r = ok(buildHttpSpec(req({ auth: { type: 'basic', username: 'alice', password: 'vault:e1#password' } }), ctx()))
    expect(r.spec.headers.Authorization).toBe(`Basic ${btoa(`alice:${SECRET}`)}`)
    expect(r.sent.headers).toContainEqual(['Authorization', 'Basic •••'])
  })

  it('bearer and API key, in a header and in the query, never leak into sent', () => {
    const bearer = ok(buildHttpSpec(req({ auth: { type: 'bearer', token: '{{t}}' } }), ctx({ globals: [{ id: 'v', key: 't', value: 'lit-token', enabled: true }] })))
    expect(bearer.spec.headers.Authorization).toBe('Bearer lit-token')
    expect(JSON.stringify(bearer.sent)).not.toContain('lit-token')

    const header = ok(buildHttpSpec(req({ auth: { type: 'apikey', name: 'X-Custom', value: 'k-literal', in: 'header' } }), ctx()))
    expect(header.spec.headers['X-Custom']).toBe('k-literal')
    expect(header.sent.headers).toContainEqual(['X-Custom', '•••'])

    const query = ok(buildHttpSpec(req({ auth: { type: 'apikey', name: 'apiid', value: 'vault:e1#password', in: 'query' } }), ctx()))
    expect(query.spec.url).toBe(`https://api.example.test/x?apiid=${SECRET}`)
    expect(query.sent.url).toBe('https://api.example.test/x?apiid=•••')
  })

  it('inherit takes the collection auth; with no collection it is none', () => {
    const collection: ApiCollectionV2 = { ...defaults.collection('ws_1', 'C'), auth: { type: 'bearer', token: 'col-token' } }
    expect(ok(buildHttpSpec(req(), ctx({ collection }))).spec.headers.Authorization).toBe('Bearer col-token')
    expect(ok(buildHttpSpec(req(), ctx())).spec.headers.Authorization).toBeUndefined()
  })

  it('an explicit Authorization header beats the auth tab', () => {
    const r = ok(buildHttpSpec(req({ auth: { type: 'bearer', token: 'a' }, headers: [row('authorization', 'Custom x')] }), ctx()))
    expect(r.spec.headers).toEqual({ authorization: 'Custom x' })
  })
})

describe('the vault rule', () => {
  it('resolves urlencoded rows but sends a JSON body reference verbatim', () => {
    const form = ok(buildHttpSpec(req({ method: 'POST', body: { mode: 'urlencoded', rows: [row('pw', 'vault:e1#password'), row('off', 'x', false)] } }), ctx()))
    expect(text(form.spec.body)).toBe(`pw=${SECRET}`)
    const json = ok(buildHttpSpec(req({ method: 'POST', body: { mode: 'json', text: '{"p":"vault:x#password"}' } }), ctx()))
    expect(text(json.spec.body)).toBe('{"p":"vault:x#password"}')
  })

  it('a locked vault is vault-locked and a missing entry is vault-entry-gone', () => {
    const r = buildHttpSpec(req({ headers: [row('X-Token', 'vault:e1#password')] }), ctx({ vault: locked }))
    expect(r).toMatchObject({ ok: false, errorClass: 'vault-locked' })
    const gone = buildHttpSpec(req({ url: 'https://h/?k=vault:gone#password' }), ctx())
    expect(gone).toMatchObject({ ok: false, errorClass: 'vault-entry-gone' })
  })

  it('sent carries no vault value and no sensitive literal', () => {
    const r = ok(
      buildHttpSpec(
        req({
          url: 'https://u:pw-literal@api.example.test/x?token=tok-literal&page=1',
          headers: [row('X-Api-Key', 'key-literal'), row('X-Ref', 'vault:e1#password'), row('Cookie', 'sid=cookie-literal')],
          auth: { type: 'basic', username: 'vault:e1#username', password: 'vault:e1#password' }
        }),
        ctx({ cookieHeader: () => 'jar=jar-literal' })
      )
    )
    const sent = JSON.stringify(r.sent)
    for (const secret of [SECRET, 'vault-user', 'pw-literal', 'tok-literal', 'key-literal', 'cookie-literal', 'jar-literal']) {
      expect(sent, secret).not.toContain(secret)
    }
    expect(r.sent.url).toBe('https://•••@api.example.test/x?token=•••&page=1')
  })
})

describe('routes', () => {
  const kinds = [
    ['http', (c: BuildCtx) => buildHttpSpec(req(), c)],
    ['ws', (c: BuildCtx) => buildWsSpec({ ...defaults.ws(), url: 'wss://h/s' }, c)],
    ['graphql', (c: BuildCtx) => buildGraphQlSpec({ ...defaults.graphql(), url: 'https://h/graphql', query: '{a}' }, c)]
  ] as const

  it.each(kinds)('%s: a missing server or VPN is route-missing, never direct', (_kind, build) => {
    expect(build(ctx({ route: { kind: 'server', serverId: 'srv_gone' } }))).toMatchObject({ ok: false, errorClass: 'route-missing' })
    expect(build(ctx({ route: { kind: 'vpn', vpnProfileId: 'vpn_gone' } }))).toMatchObject({ ok: false, errorClass: 'route-missing' })
  })

  it('maps a server and a VPN to via, routeKey and the Timeline label', () => {
    const s = ok(buildHttpSpec(req(), ctx({ route: { kind: 'server', serverId: 'srv_1' } })))
    expect(s.spec.via).toMatchObject({ kind: 'server', server: { serverId: 'srv_1' } })
    expect([s.routeKey, s.sent.route]).toEqual(['server:srv_1', { key: 'server:srv_1', label: 'bastion' }])
    const v = ok(buildHttpSpec(req(), ctx({ route: { kind: 'vpn', vpnProfileId: 'vpn_1' } })))
    expect([v.spec.via, v.routeKey]).toEqual([{ kind: 'vpn', vpnProfileId: 'vpn_1' }, 'vpn:vpn_1'])
  })
})

describe('templating', () => {
  it('unresolved stops the build unless allowUnresolved', () => {
    const r = req({ url: '{{baseUrl}}/pets/{{id}}', headers: [row('X', '{{h}}')] })
    expect(buildHttpSpec(r, ctx())).toMatchObject({
      ok: false,
      errorClass: 'unresolved-variable',
      unresolved: ['baseUrl', 'id', 'h'],
      message: 'baseUrl, id and h are not defined in globals or this collection'
    })
    const env = { id: 'env_s', workspaceId: 'ws_1', name: 'staging', color: 'blue' as const, production: false, variables: [] }
    expect(buildHttpSpec(req({ url: 'https://h/{{token}}' }), ctx({ env }))).toMatchObject({
      message: 'token is not defined in staging (or its collection or globals)'
    })
    const passed = ok(buildHttpSpec(r, ctx({ allowUnresolved: true })))
    expect(passed.unresolved).toEqual(['baseUrl', 'id', 'h'])
  })

  it('fills path params and takes the query from params when there are any', () => {
    const collection: ApiCollectionV2 = {
      ...defaults.collection('ws_1', 'C'),
      variables: [{ id: 'v', key: 'baseUrl', value: 'https://api.example.test/v1', enabled: true }]
    }
    const r = ok(
      buildHttpSpec(
        req({ url: '{{baseUrl}}/pets/{petId}?ignored=1', pathParams: [row('petId', '4 2')], params: [row('limit', '10'), row('off', '1', false)] }),
        ctx({ collection })
      )
    )
    expect(r.spec.url).toBe('https://api.example.test/v1/pets/4%202?limit=10')
    expect(ok(buildHttpSpec(req({ url: 'https://h/x?a=1' }), ctx())).spec.url).toBe('https://h/x?a=1')
  })

  it('infers the scheme for a bare host', () => {
    expect(ok(buildHttpSpec(req({ url: 'localhost:8080/x' }), ctx())).spec.url).toBe('http://localhost:8080/x')
  })
})

describe('body and content type', () => {
  it('sets Content-Type automatically unless one was given', () => {
    const auto = ok(buildHttpSpec(req({ method: 'POST', body: { mode: 'json', text: '{}' } }), ctx()))
    expect(auto.spec.headers['Content-Type']).toBe('application/json')
    const explicit = ok(buildHttpSpec(req({ method: 'POST', body: { mode: 'json', text: '{}' }, headers: [row('content-type', 'application/vnd.x+json')] }), ctx()))
    expect(explicit.spec.headers).toEqual({ 'content-type': 'application/vnd.x+json' })
  })

  it('sends no body on GET', () => {
    const r = ok(buildHttpSpec(req({ method: 'get', body: { mode: 'text', text: 'x' } }), ctx()))
    expect([r.spec.method, r.spec.body, r.spec.headers['Content-Type']]).toEqual(['GET', undefined, undefined])
  })

  it('the multipart boundary in the header matches the body', () => {
    const bytes = new TextEncoder().encode('FILEBYTES').buffer
    const r = ok(
      buildHttpSpec(
        req({
          method: 'POST',
          body: {
            mode: 'multipart',
            rows: [
              { ...row('field', 'vault:e1#password'), kind: 'text' },
              { ...row('up"load', ''), kind: 'file', fileName: 'a.bin' }
            ]
          }
        }),
        ctx({ fileBytes: (k) => (k === 'row_up"load' ? bytes : null) })
      )
    )
    const boundary = /boundary=(.+)$/.exec(r.spec.headers['Content-Type'])![1]
    const body = text(r.spec.body)
    expect(body.startsWith(`--${boundary}\r\n`)).toBe(true)
    expect(body.endsWith(`--${boundary}--\r\n`)).toBe(true)
    expect(body).toContain(`name="field"\r\n\r\n${SECRET}\r\n`)
    expect(body).toContain('name="up%22load"; filename="a.bin"')
    expect(body).toContain('FILEBYTES')
    expect(r.sent.bodyBytes).toBe(r.spec.body!.byteLength)
  })

  it('a file part with no bytes this session asks for the file again', () => {
    const r = buildHttpSpec(req({ method: 'POST', body: { mode: 'binary', fileName: 'x.bin' } }), ctx())
    expect(r).toMatchObject({ ok: false, errorClass: 'other' })
  })
})

describe('settings and TLS', () => {
  it('maxRedirects is 0 unless following; TLS and the timeout come from the collection', () => {
    const collection: ApiCollectionV2 = { ...defaults.collection('ws_1', 'C'), insecureTls: true, timeoutMs: 5000 }
    const r = ok(buildHttpSpec(req({ settings: { followRedirects: false, maxRedirects: 5 } }), ctx({ collection })))
    expect(r.spec).toMatchObject({ maxRedirects: 0, insecureTls: true, timeoutMs: 5000, requestId: 'rq_1' })
    expect(r.sent.tls).toBe('unverified')
    const ca = ok(buildHttpSpec(req(), ctx({ collection: { ...collection, insecureTls: false, caPem: 'PEM' } })))
    expect([ca.spec.caPem, ca.sent.tls, ca.spec.maxRedirects]).toEqual(['PEM', 'custom-ca', 5])
    expect(ok(buildHttpSpec(req(), ctx())).sent.tls).toBe('verified')
  })
})

// Ported from httpTransportCookies.test.ts: the jar's cookie reaches the spec that crosses IPC.
describe('cookies on an outgoing request', () => {
  it('attaches the route’s jar cookie, keyed by the route', () => {
    const seen: string[] = []
    const r = ok(buildHttpSpec(req(), ctx({ route: { kind: 'server', serverId: 'srv_1' }, cookieHeader: (k, u) => (seen.push(`${k} ${u}`), 'session=abc123') })))
    expect(r.spec.headers.Cookie).toBe('session=abc123')
    expect(seen).toEqual(['server:srv_1 https://api.example.test/x', 'server:srv_1 https://api.example.test/x'])
  })

  it('sends no Cookie header when nothing matches, or with no jar at all', () => {
    expect(ok(buildHttpSpec(req(), ctx({ cookieHeader: () => '' }))).spec.headers.Cookie).toBeUndefined()
    expect(ok(buildHttpSpec(req(), ctx())).spec.headers.Cookie).toBeUndefined()
  })

  it('appends the jar to a typed Cookie header', () => {
    const r = ok(buildHttpSpec(req({ headers: [row('Cookie', 'a=1')] }), ctx({ cookieHeader: () => 'b=2' })))
    expect(r.spec.headers.Cookie).toBe('a=1; b=2')
  })
})

describe('WebSocket and GraphQL', () => {
  it('buildWsSpec puts auth on the upgrade and maps the scheme', () => {
    const r = ok(
      buildWsSpec({ ...defaults.ws(), url: 'https://h/socket', protocols: ['graphql-ws'], auth: { type: 'bearer', token: 'vault:e1#password' } }, ctx())
    )
    expect(r.spec).toMatchObject({ url: 'wss://h/socket', protocols: ['graphql-ws'], headers: { Authorization: `Bearer ${SECRET}` } })
    expect(JSON.stringify(r.sent)).not.toContain(SECRET)
  })

  it('buildGraphQlSpec posts JSON with variables and the operation name', () => {
    const r = ok(
      buildGraphQlSpec(
        { ...defaults.graphql(), url: 'https://h/graphql', query: 'query A { a } query B { b }', variables: '{"id": "{{id}}"}' },
        ctx({ globals: [{ id: 'v', key: 'id', value: '7', enabled: true }] }),
        'B'
      )
    )
    expect(r.spec.method).toBe('POST')
    expect(r.spec.headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(text(r.spec.body))).toEqual({ query: 'query A { a } query B { b }', variables: { id: '7' }, operationName: 'B' })
    expect(buildGraphQlSpec({ ...defaults.graphql(), url: 'https://h', variables: '[1]' }, ctx())).toMatchObject({ ok: false, errorClass: 'other' })
  })
})

describe('WebSocket subprotocols (finalsec M3)', () => {
  it('are templated and vault-resolved, never empty, and masked in sent', () => {
    const r = ok(
      buildWsSpec(
        { ...defaults.ws(), url: 'wss://h/s', protocols: ['graphql-ws', '{{p}}', 'base64url.bearer.authorization.k8s.io.vault:e1#password', '  ', ''] },
        ctx({ globals: [{ id: 'v', key: 'p', value: 'mqtt', enabled: true }] })
      )
    )
    expect(r.spec.protocols).toEqual(['graphql-ws', 'mqtt', `base64url.bearer.authorization.k8s.io.${SECRET}`])
    const shown = r.sent.headers.find(([k]) => k === 'Sec-WebSocket-Protocol')![1]
    // References show as written, never resolved.
    expect(shown).toBe('graphql-ws, {{p}}, base64url.bearer.authorization.•••')
    expect(JSON.stringify(r.sent)).not.toContain(SECRET)
  })

  it('an unresolved subprotocol stops the build', () => {
    expect(buildWsSpec({ ...defaults.ws(), url: 'wss://h/s', protocols: ['{{missing}}'] }, ctx())).toMatchObject({ ok: false, errorClass: 'unresolved-variable' })
  })

  it('sends no protocols key when none are left', () => {
    expect(ok(buildWsSpec({ ...defaults.ws(), url: 'wss://h/s', protocols: [''] }, ctx())).spec).not.toHaveProperty('protocols')
  })
})

describe('the handshake view never shows a resolved subprotocol (finalwire)', () => {
  it('a {{var}} or vault protocol resolving to a short token shows as its reference', () => {
    const r = ok(
      buildWsSpec(
        { ...defaults.ws(), url: 'wss://h/s', protocols: ['{{wsToken}}', 'vault:e1#password', 'x9Tk2'] },
        ctx({ globals: [{ id: 'v', key: 'wsToken', value: 'abc123short', enabled: true }] })
      )
    )
    expect(r.spec.protocols).toEqual(['abc123short', SECRET, 'x9Tk2'])
    const shown = r.sent.headers.find(([k]) => k === 'Sec-WebSocket-Protocol')![1]
    expect(shown).toBe('{{wsToken}}, vault:e1#password, x9Tk2')
    expect(JSON.stringify(r.sent)).not.toContain('abc123short')
    expect(JSON.stringify(r.sent)).not.toContain(SECRET)
  })
})

describe('a literal with a reference glued on is not a reference (L-n2)', () => {
  it('is masked in the sent view, not shown whole', () => {
    const glued = 'eyJhbGciOiJIUzI1NiJ9{{x}}'
    const r = ok(buildWsSpec({ ...defaults.ws(), url: 'wss://h/s', protocols: [glued, '{{x}}'] }, ctx({ globals: [{ id: 'v', key: 'x', value: 'y', enabled: true }] })))
    const shown = r.sent.headers.find(([k]) => k === 'Sec-WebSocket-Protocol')![1]
    expect(shown).toBe('•••, {{x}}')
    expect(JSON.stringify(r.sent)).not.toContain('eyJhbGci')
  })
})
