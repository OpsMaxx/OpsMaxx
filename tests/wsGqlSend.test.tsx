// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildSchema, graphqlSync } from 'graphql'
import { stubBridge } from './setup/renderer'
import { defaults, type Environment, type GraphQlRequest, type Row, type WsRequest } from '../src/shared/apiModel'
import type { HttpRequestSpec } from '../src/shared/httpClient'
import type { WsOpenSpec } from '../src/shared/httpSocket'
import { useApi } from '../src/renderer/src/store/api'
import { useApp } from '../src/renderer/src/store/app'
import { useGqlSchemas } from '../src/renderer/src/store/gqlSchemas'
import { useHttp } from '../src/renderer/src/store/http'
import { useHttpRuntime } from '../src/renderer/src/store/httpRuntime'
import { useWsSessions } from '../src/renderer/src/store/wsSessions'
import { loadGqlSchema, runGql } from '../src/renderer/src/components/http/gql/gqlActions'
import { submitWs } from '../src/renderer/src/components/http/ws/wsActions'

// D's actions against the real send layer (A) and a stubbed bridge: what
// actually goes to main for a WebSocket upgrade and a GraphQL run, and which
// of them the production confirm stops.

const SDL = buildSchema('type Query { country(code: ID!): String } type Mutation { rename(code: ID!): String }')
const row = (key: string, value: string): Row => ({ id: `row_${key}`, enabled: true, key, value })
const prod: Environment = { id: 'env_prod', workspaceId: '', name: 'prod', color: 'rust', production: true, variables: [] }

const bodyOf = (spec: HttpRequestSpec): string =>
  typeof spec.body === 'string' ? spec.body : new TextDecoder().decode(spec.body as ArrayBuffer)

let request: ReturnType<typeof vi.fn>
let open: ReturnType<typeof vi.fn>
const append = vi.fn(async () => {})

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
    cb()
    return 0
  })
  request = vi.fn(async (spec: HttpRequestSpec) => {
    const body = JSON.parse(bodyOf(spec)) as { query: string }
    const answer = JSON.stringify(graphqlSync({ schema: SDL, source: body.query, rootValue: { country: () => 'Brazil' } }))
    return { ok: true, status: 200, statusText: 'OK', headers: {}, body: new TextEncoder().encode(answer).buffer, durationMs: 1 }
  })
  open = vi.fn(async () => ({ ok: true, id: 'sock-1', protocol: '' }))
  stubBridge({
    http: { request, cancel: vi.fn(async () => {}) },
    httpHistory: { append },
    httpSocket: { open, send: vi.fn(async () => ({ ok: true })), close: vi.fn(async () => {}), onEvent: () => () => {} },
    clipboard: { write: vi.fn() }
  })
})

function useProd(): void {
  const ws = useApp.getState().activeWorkspaceId
  useApi.getState().setEnvironment({ ...prod, workspaceId: ws })
  useApi.getState().setActiveEnvironment(ws, prod.id)
}

/** Runs `fn`, declining the production prompt if one appears. Says whether it did. */
async function declining(fn: () => Promise<void>): Promise<boolean> {
  let prompted = false
  const stop = useHttpRuntime.subscribe((s) => {
    if (!s.prompt) return
    prompted = true
    queueMicrotask(() => useHttpRuntime.getState().answer(false, false))
  })
  await fn()
  stop()
  return prompted
}

const gqlTab = (over: Partial<GraphQlRequest> = {}): string =>
  useHttp.getState().openScratch('graphql', {
    ...defaults.graphql(),
    url: 'https://countries.example.test/graphql',
    query: '{ country(code: "BR") }',
    ...over
  })

const wsTab = (over: Partial<WsRequest> = {}): string =>
  useHttp.getState().openScratch('ws', { ...defaults.ws(), url: 'wss://feed.example.test/raw', ...over })

describe('GraphQL through the send layer', () => {
  it('sends the tab’s Auth and Headers with the query', async () => {
    const id = gqlTab({ auth: { type: 'bearer', token: 'tok-123' }, headers: [row('X-Tenant', 'acme')] })
    await runGql(id)
    const spec = request.mock.calls[0][0] as HttpRequestSpec
    const headers = Object.fromEntries(Object.entries(spec.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]))
    expect(headers.authorization).toBe('Bearer tok-123')
    expect(headers['x-tenant']).toBe('acme')
    expect(JSON.parse(bodyOf(spec)).query).toBe('{ country(code: "BR") }')
  })

  it('asks before a mutation to production, and not before a query', async () => {
    useProd()
    const doc = 'query Q { country(code: "BR") }\nmutation M { rename(code: "BR") }'
    const id = gqlTab({ query: doc })
    // Introspection after the first good Run is a request too; count only runs.
    const runs = (): number => request.mock.calls.filter(([spec]) => !bodyOf(spec).includes('__schema')).length
    expect(await declining(() => runGql(id, { operationName: 'Q' }))).toBe(false)
    expect(runs()).toBe(1)
    // By cursor as well as by name: the confirm sits below both.
    expect(await declining(() => runGql(id, { cursor: doc.length - 2 }))).toBe(true)
    expect(runs()).toBe(1)
  })

  it('loads the schema after the first good Run, without touching the response or history', async () => {
    const id = gqlTab()
    await runGql(id)
    const after = useHttp.getState().responses[id]
    await vi.waitFor(() =>
      expect(useGqlSchemas.getState().byKey['https://countries.example.test/graphql|direct']?.status).toBe('ready')
    )
    expect(request).toHaveBeenCalledTimes(2)
    expect(useHttp.getState().responses[id]).toBe(after)
    expect(append).toHaveBeenCalledTimes(1)
  })

  it('introspects on Load schema with the tab’s auth', async () => {
    const id = gqlTab({ auth: { type: 'bearer', token: 'tok-9' } })
    await loadGqlSchema(id)
    const spec = request.mock.calls[0][0] as HttpRequestSpec
    expect(JSON.parse(bodyOf(spec)).query).toContain('__schema')
    expect(Object.values(spec.headers ?? {})).toContain('Bearer tok-9')
    expect(useHttp.getState().responses[id]).toBeUndefined()
    expect(append).not.toHaveBeenCalled()
  })
})

describe('WebSocket through the send layer', () => {
  it('applies Auth and Headers to the upgrade request, with the subprotocols', async () => {
    const id = wsTab({
      auth: { type: 'basic', username: 'ada', password: 'pw' },
      headers: [row('X-Tenant', 'acme')],
      protocols: ['graphql-ws']
    })
    await submitWs(id)
    const spec = open.mock.calls[0][0] as WsOpenSpec
    const headers = Object.fromEntries(Object.entries(spec.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]))
    expect(headers.authorization).toBe(`Basic ${btoa('ada:pw')}`)
    expect(headers['x-tenant']).toBe('acme')
    expect(spec.protocols).toEqual(['graphql-ws'])
    expect(useWsSessions.getState().sessions[id].state).toBe('open')
    // The Handshake tab's view of it is masked.
    expect(JSON.stringify(useWsSessions.getState().sessions[id].sent)).not.toContain(btoa('ada:pw'))
  })

  it('asks before connecting to production, and a decline leaves the tab idle', async () => {
    useProd()
    const id = wsTab()
    expect(await declining(() => submitWs(id))).toBe(true)
    expect(open).not.toHaveBeenCalled()
    expect(useWsSessions.getState().sessions[id].state).toBe('idle')
  })
})
