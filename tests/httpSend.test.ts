// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { stubBridge } from './setup/renderer'
import { defaults, type Environment, type HttpRequest } from '../src/shared/apiModel'
import type { HistoryEntry } from '../src/shared/httpHistory'
import { useApi } from '../src/renderer/src/store/api'
import { MASKED } from '../src/shared/httpHistory'
import { useApp } from '../src/renderer/src/store/app'
import { useHttp } from '../src/renderer/src/store/http'
import { useHttpCookies } from '../src/renderer/src/store/httpCookies'
import { useHttpRuntime } from '../src/renderer/src/store/httpRuntime'
import { useVault } from '../src/renderer/src/store/vault'
import { useWsSessions } from '../src/renderer/src/store/wsSessions'
import {
  cancel,
  confirmIfProduction,
  copyAsCurl,
  introspect,
  liveSpecFor,
  maskedSentFor,
  openSocket,
  operationType,
  requestFromHistory,
  runGraphQl,
  send,
  sendAgainFromHistory,
  sendWsMessage
} from '../src/renderer/src/lib/httpSend'

const ws = (): string => useApp.getState().activeWorkspaceId
const prod: Environment = { id: 'env_prod', workspaceId: '', name: 'prod', color: 'rust', production: true, variables: [] }
const dev: Environment = { ...prod, id: 'env_dev', name: 'dev', production: false }

let request: ReturnType<typeof vi.fn>
let clipboard: ReturnType<typeof vi.fn>
beforeEach(() => {
  request = vi.fn(async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: {},
    setCookie: ['sid=1; Path=/'],
    body: new ArrayBuffer(0),
    durationMs: 3,
    truncated: false,
    finalUrl: 'https://api.example.test/x'
  }))
  clipboard = vi.fn()
  stubBridge({
    http: { request, cancel: vi.fn(async () => {}) },
    httpHistory: { append: vi.fn(async () => {}) },
    clipboard: { write: clipboard }
  })
})

function useEnv(env: Environment | null): void {
  const api = useApi.getState()
  if (env) api.setEnvironment({ ...env, workspaceId: ws() })
  api.setActiveEnvironment(ws(), env?.id ?? null)
}

function scratch(over: Partial<HttpRequest> = {}): string {
  return useHttp.getState().openScratch('http', { ...defaults.http(), url: 'https://api.example.test/x', ...over })
}

/** Runs `fn` and answers the production prompt, if one appears, with `answer`. */
async function withAnswer(answer: boolean, fn: () => Promise<void>, dontAsk = false): Promise<boolean> {
  let prompted = false
  const unsub = useHttpRuntime.subscribe((s) => {
    if (s.prompt) {
      prompted = true
      queueMicrotask(() => useHttpRuntime.getState().answer(answer, dontAsk))
    }
  })
  await fn()
  unsub()
  return prompted
}

describe('the production confirm, in the send layer', () => {
  it('prompts for DELETE from send on a production environment; declining sends nothing', async () => {
    useEnv(prod)
    const tab = scratch({ method: 'DELETE' })
    expect(await withAnswer(false, () => send(tab))).toBe(true)
    expect(request).not.toHaveBeenCalled()
    expect(useHttp.getState().responses[tab]).toMatchObject({ status: 'error', errorClass: 'prod-declined' })

    expect(await withAnswer(true, () => send(tab))).toBe(true)
    expect(request).toHaveBeenCalledTimes(1)
    expect(useHttp.getState().responses[tab]).toMatchObject({ status: 'done' })
  })

  it('does not prompt for GET, or anything outside production', async () => {
    useEnv(prod)
    expect(await withAnswer(false, () => send(scratch({ method: 'GET' })))).toBe(false)
    useEnv(dev)
    expect(await withAnswer(false, () => send(scratch({ method: 'DELETE' })))).toBe(false)
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('treats a server tagged prod as production', async () => {
    const server = { id: 'srv_p', name: 'bastion-prod', tags: ['Production'] }
    expect(
      await withAnswer(false, async () => {
        expect(await confirmIfProduction({ method: 'PUT', environment: null, server })).toBe(false)
      })
    ).toBe(true)
    expect(useHttpRuntime.getState().prompt).toBeNull()
  })

  it('names the target and the route in the prompt', async () => {
    const pending = confirmIfProduction({ method: 'delete', environment: prod, server: null, via: 'bastion-prod' })
    expect(useHttpRuntime.getState().prompt).toEqual({
      action: 'DELETE',
      target: 'prod',
      via: 'bastion-prod',
      skipLabel: "Don't ask again this session for DELETE on prod"
    })
    useHttpRuntime.getState().answer(true, false)
    expect(await pending).toBe(true)
  })

  it('"don\'t ask again" is keyed per (environment, method)', async () => {
    const ctx = { environment: prod, server: null }
    expect(await withAnswer(true, () => confirmIfProduction({ ...ctx, method: 'DELETE' }).then(() => {}), true)).toBe(true)
    expect(await withAnswer(false, () => confirmIfProduction({ ...ctx, method: 'DELETE' }).then(() => {}))).toBe(false)
    expect(await withAnswer(false, () => confirmIfProduction({ ...ctx, method: 'POST' }).then(() => {}))).toBe(true)
    const otherEnv = { ...prod, id: 'env_prod2', name: 'prod-eu' }
    expect(await withAnswer(false, () => confirmIfProduction({ environment: otherEnv, server: null, method: 'DELETE' }).then(() => {}))).toBe(true)
  })

  it('a GraphQL query does not prompt and a mutation does', async () => {
    useEnv(prod)
    const tab = useHttp.getState().openScratch('graphql', {
      ...defaults.graphql(),
      url: 'https://api.example.test/graphql',
      query: 'query Q { a } mutation M { b }'
    })
    expect(await withAnswer(false, () => runGraphQl(tab, 'Q'))).toBe(false)
    expect(await withAnswer(false, () => runGraphQl(tab, 'M'))).toBe(true)
    expect(request).toHaveBeenCalledTimes(1)
    expect(operationType('{ a }')).toBe('query')
    expect(operationType('mutation { a }')).toBe('mutation')
    expect(operationType('mutation {{ broken')).toBe('mutation')
  })

  it('sendWsMessage prompts before the socket sends', async () => {
    useEnv(prod)
    const wsSend = vi.fn(async () => {})
    useWsSessions.setState({ send: wsSend })
    const tab = useHttp.getState().openScratch('ws', { ...defaults.ws(), url: 'wss://api.example.test/s' })
    expect(await withAnswer(false, () => sendWsMessage(tab, 'hi'))).toBe(true)
    expect(wsSend).not.toHaveBeenCalled()
    expect(await withAnswer(true, () => sendWsMessage(tab, 'hi'))).toBe(true)
    expect(wsSend).toHaveBeenCalledWith(tab, 'hi')
  })

  it('openSocket confirms before connecting, and a decline never reaches wsSessions.connect', async () => {
    useEnv(prod)
    const connect = vi.fn(async () => {})
    const fail = vi.fn()
    useWsSessions.setState({ connect, fail })
    const tab = useHttp.getState().openScratch('ws', { ...defaults.ws(), url: 'wss://api.example.test/s' })
    expect(await withAnswer(false, () => openSocket(tab))).toBe(true)
    expect(connect).not.toHaveBeenCalled()
    // A decline is recorded as 'prod-declined', the state an HTTP send records.
    expect(fail).toHaveBeenCalledWith(tab, expect.objectContaining({ errorClass: 'prod-declined' }))
    expect(await withAnswer(true, () => openSocket(tab))).toBe(true)
    expect(connect).toHaveBeenCalledWith(tab, expect.objectContaining({ url: 'wss://api.example.test/s' }), expect.objectContaining({ method: 'GET' }))
  })

  it('the history re-run prompts too, and a deleted server is route-missing with no send', async () => {
    useEnv(prod)
    const entry: HistoryEntry = {
      id: 'h1',
      at: 0,
      kind: 'http',
      request: { ...defaults.http(), method: 'DELETE', url: 'https://api.example.test/x' },
      route: { kind: 'direct' },
      routeLabel: 'This machine'
    }
    expect(await withAnswer(false, () => sendAgainFromHistory(entry))).toBe(true)
    expect(request).not.toHaveBeenCalled()

    expect(await withAnswer(true, () => sendAgainFromHistory({ ...entry, route: { kind: 'server', serverId: 'srv_gone' } }))).toBe(false)
    expect(request).not.toHaveBeenCalled()
    const tab = useHttp.getState().tabs.at(-1)!
    expect(tab.route).toEqual({ kind: 'server', serverId: 'srv_gone' })
    expect(useHttp.getState().responses[tab.id]).toMatchObject({ status: 'error', errorClass: 'route-missing' })
  })
})

describe('send', () => {
  it('stores the response cookies in the route’s jar and passes the requestId', async () => {
    const tab = scratch()
    await send(tab)
    const spec = request.mock.calls[0][0]
    expect(spec.requestId).toMatch(/^req_/)
    expect(useHttpCookies.getState().headerFor(ws(), 'direct', 'https://api.example.test/y')).toBe('sid=1')
    expect(useHttp.getState().responses[tab]).toMatchObject({ status: 'done', sentAs: { method: 'GET' } })
  })

  it('shows a build failure without sending', async () => {
    const tab = scratch({ url: '{{nope}}/x' })
    await send(tab)
    expect(request).not.toHaveBeenCalled()
    expect(useHttp.getState().responses[tab]).toMatchObject({ status: 'error', errorClass: 'unresolved-variable', unresolved: ['nope'] })
  })

  it('cancel aborts in main and ignores the late result', async () => {
    let finish: (v: unknown) => void = () => {}
    request.mockImplementationOnce(() => new Promise((r) => (finish = r)))
    const tab = scratch()
    const sending = send(tab)
    await vi.waitFor(() => expect(useHttp.getState().responses[tab]).toMatchObject({ status: 'sending' }))
    const requestId = request.mock.calls[0][0].requestId
    cancel(tab)
    expect((window.opsmaxx.http as unknown as { cancel: ReturnType<typeof vi.fn> }).cancel).toHaveBeenCalledWith(requestId)
    finish({ ok: true, status: 200, statusText: 'OK', headers: {}, body: new ArrayBuffer(0), durationMs: 1, truncated: false })
    await sending
    expect(useHttp.getState().responses[tab]).toMatchObject({ status: 'error', errorClass: 'aborted' })
  })

  it('an ABORTED transport error is aborted, and anything else is classified', async () => {
    request.mockResolvedValueOnce({ ok: false, error: 'aborted', code: 'ABORTED' })
    const tab = scratch()
    await send(tab)
    expect(useHttp.getState().responses[tab]).toMatchObject({ status: 'error', errorClass: 'aborted' })
    request.mockResolvedValueOnce({ ok: false, error: 'getaddrinfo ENOTFOUND x', code: 'ENOTFOUND' })
    await send(tab)
    // The raw error is kept; the response pane words it from the class and masks it.
    expect(useHttp.getState().responses[tab]).toMatchObject({ status: 'error', code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND x' })
  })
})

describe('Send anyway', () => {
  it('allowUnresolved sends with the {{vars}} left in', async () => {
    const tab = scratch({ url: 'https://api.example.test/{{nope}}' })
    await send(tab, { allowUnresolved: true })
    expect(request.mock.calls[0][0].url).toBe('https://api.example.test/{{nope}}')
  })
})

describe('introspect', () => {
  const gqlTab = (over = {}): string =>
    useHttp.getState().openScratch('graphql', { ...defaults.graphql(), url: 'https://api.example.test/graphql', query: 'mutation M { x }', ...over })

  it('runs the given query with the tab’s auth, and touches no response, history, jar or prompt', async () => {
    useEnv(prod)
    request.mockResolvedValueOnce({ ok: true, status: 400, statusText: 'Bad', headers: {}, setCookie: ['sid=2'], body: new TextEncoder().encode('{"errors":[]}').buffer, durationMs: 1, truncated: false })
    const tab = gqlTab({ auth: { type: 'bearer', token: 't' }, variables: '{bad json' })
    expect(await withAnswer(false, async () => {
      expect(await introspect(tab, '{ __schema { types { name } } }')).toEqual({ ok: true, status: 400, text: '{"errors":[]}' })
    })).toBe(false)
    const spec = request.mock.calls[0][0]
    expect(JSON.parse(new TextDecoder().decode(spec.body))).toEqual({ query: '{ __schema { types { name } } }' })
    expect(spec.headers.Authorization).toBe('Bearer t')
    expect(useHttp.getState().responses[tab]).toBeUndefined()
    expect(useHttpCookies.getState().list()).toEqual([])
    expect(window.opsmaxx.httpHistory.append).not.toHaveBeenCalled()
  })

  it('reports a build or transport failure with URLs masked', async () => {
    expect(await introspect(gqlTab({ url: '{{nope}}' }), '{a}')).toMatchObject({ ok: false, errorClass: 'unresolved-variable' })
    request.mockResolvedValueOnce({ ok: false, error: 'connect ECONNREFUSED https://u:pw@h.example.test/x?token=abc', code: 'ECONNREFUSED' })
    const r = await introspect(gqlTab(), '{a}')
    expect(r).toMatchObject({ ok: false })
    expect(JSON.stringify(r)).not.toContain('pw')
    expect(JSON.stringify(r)).not.toContain('abc')
  })
})

describe('copyAsCurl', () => {
  it('mask copies no secret, even with the vault locked', async () => {
    const tab = scratch({ auth: { type: 'bearer', token: 'vault:e1#password' }, headers: [{ id: 'r', enabled: true, key: 'X-Api-Key', value: 'literal-key' }] })
    expect(await copyAsCurl(tab, { secrets: 'mask' })).toBe(true)
    const text = clipboard.mock.calls[0][0] as string
    expect(text).toMatch(/^curl /)
    expect(text).toContain('https://api.example.test/x')
    expect(text).not.toContain('literal-key')
    expect(request).not.toHaveBeenCalled()
  })

  it('include resolves vault references now, and a locked vault copies nothing', async () => {
    const tab = scratch({ auth: { type: 'bearer', token: 'vault:e1#password' } })
    expect(await copyAsCurl(tab, { secrets: 'include' })).toBe(false)
    expect(clipboard).not.toHaveBeenCalled()
    useVault.setState({ unlocked: true, entries: [{ id: 'e1', username: 'u', password: 'real-secret' }] as never })
    expect(await copyAsCurl(tab, { secrets: 'include' })).toBe(true)
    expect(clipboard.mock.calls[0][0]).toContain('Authorization: Bearer real-secret')
  })

  it('has nothing to copy for a WebSocket', async () => {
    expect(await copyAsCurl(useHttp.getState().openScratch('ws'), { secrets: 'mask' })).toBe(false)
  })
})

describe('Send again from history (M-a)', () => {
  const masked = (over: Partial<HttpRequest> = {}): HistoryEntry => ({
    id: 'h1',
    at: 0,
    kind: 'http',
    request: {
      ...defaults.http(),
      url: 'https://api.example.test/x',
      headers: [{ id: 'row_1', enabled: true, key: 'X-Api-Key', value: MASKED }],
      ...over
    },
    route: { kind: 'direct' },
    routeLabel: 'This machine'
  })

  it('re-runs the saved request when it still exists, never the redacted copy', async () => {
    const col = useApi.getState().createCollection('C')
    const saved = { ...defaults.http(), id: 'req_saved', url: 'https://api.example.test/x', headers: [{ id: 'row_1', enabled: true, key: 'X-Api-Key', value: 'real-key' }] }
    useApi.getState().addItem(col, null, saved)
    await sendAgainFromHistory({ ...masked(), requestRef: { collectionId: col, requestId: 'req_saved' } })
    expect(request.mock.calls[0][0].headers['X-Api-Key']).toBe('real-key')
  })

  it('refuses to send a masked value, and marks it not kept, until it is re-entered', async () => {
    await sendAgainFromHistory({ ...masked(), requestRef: { collectionId: 'col_gone', requestId: 'req_gone' } })
    expect(request).not.toHaveBeenCalled()
    const tab = useHttp.getState().tabs.at(-1)!
    expect(tab.strippedFields).toEqual(['headers.0.value'])
    expect(useHttp.getState().responses[tab.id]).toMatchObject({ status: 'error', message: 'Enter the values that were not kept' })
    const draft = tab.draft as HttpRequest
    useHttp.setState((s) => ({ tabs: s.tabs.map((t) => (t.id === tab.id ? { ...t, draft: { ...draft, headers: [{ ...draft.headers[0], value: 'typed-again' }] } } : t)) }))
    await send(tab.id)
    expect(request.mock.calls[0][0].headers['X-Api-Key']).toBe('typed-again')
  })

  it('requestFromHistory finds every masked value, and gives a fresh id', () => {
    const entry = masked({
      url: `https://${MASKED}@h/x?token=${MASKED}`,
      params: [{ id: 'p', enabled: true, key: 'sig', value: MASKED }],
      pathParams: [{ id: 'pp', enabled: true, key: 'id', value: '1' }],
      auth: { type: 'basic', username: 'u', password: MASKED },
      body: { mode: 'urlencoded', rows: [{ id: 'b', enabled: true, key: 'password', value: MASKED }] }
    })
    const { request: req, strippedFields } = requestFromHistory(entry)
    expect(strippedFields).toEqual(['url', 'headers.0.value', 'auth.password', 'params.0.value', 'body.rows.0.value'])
    expect(req.id).not.toBe(entry.request.id)
    const gql = requestFromHistory({ ...entry, kind: 'graphql', request: { ...defaults.graphql(), variables: `{"token":"${MASKED}"}` } })
    expect(gql.strippedFields).toEqual(['variables'])
    expect(requestFromHistory({ ...entry, request: { ...defaults.http(), url: 'https://h/{{v}}' } }).strippedFields).toEqual([])
  })
})

describe('raw errors are URL-masked before they are stored (L-d)', () => {
  it('masks a rejected invoke and an unclassified error', async () => {
    request.mockRejectedValueOnce(new Error('boom at https://u:pw@h.example.test/x?token=abc'))
    const tab = scratch()
    await send(tab)
    const state = JSON.stringify(useHttp.getState().responses[tab])
    expect(state).not.toContain('pw@')
    expect(state).not.toContain('token=abc')
  })
})

describe('liveSpecFor', () => {
  it('is what send would hand main, vault resolved, with nothing sent and no prompt', async () => {
    useEnv(prod)
    useVault.setState({ unlocked: true, entries: [{ id: 'e1', username: 'u', password: 'real-secret' }] as never })
    useHttpCookies.getState().store(ws(), 'direct', 'https://api.example.test/', ['sid=1'])
    const tab = scratch({ method: 'DELETE', auth: { type: 'bearer', token: 'vault:e1#password' } })
    let spec: Awaited<ReturnType<typeof liveSpecFor>> = null
    expect(await withAnswer(false, async () => void (spec = await liveSpecFor(tab)))).toBe(false)
    expect(spec).toMatchObject({ method: 'DELETE', url: 'https://api.example.test/x', headers: { Authorization: 'Bearer real-secret', Cookie: 'sid=1' }, via: { kind: 'direct' } })
    expect(request).not.toHaveBeenCalled()
    expect(useHttp.getState().responses[tab]).toBeUndefined()
  })

  it('is null on a locked vault, an unresolved variable, a missing route, or a WebSocket', async () => {
    expect(await liveSpecFor(scratch({ auth: { type: 'bearer', token: 'vault:e1#password' } }))).toBeNull()
    expect(await liveSpecFor(scratch({ url: 'https://{{nope}}/x' }))).toBeNull()
    const gone = useHttp.getState().openScratch('http', { ...defaults.http(), url: 'https://h/x' }, { route: { kind: 'server', serverId: 'srv_gone' } })
    expect(await liveSpecFor(gone)).toBeNull()
    expect(await liveSpecFor(useHttp.getState().openScratch('ws'))).toBeNull()
  })
})

describe('maskedSentFor', () => {
  it('masks a bearer, works with the vault locked, keeps {{vars}}, and sends nothing', () => {
    const tab = scratch({ url: 'https://api.example.test/{{v}}', auth: { type: 'bearer', token: 'vault:e1#password' } })
    const sent = maskedSentFor(tab)!
    expect(sent.headers).toContainEqual(['Authorization', 'Bearer •••'])
    expect(sent.url).toBe('https://api.example.test/{{v}}')
    const literal = maskedSentFor(scratch({ auth: { type: 'bearer', token: 'lit-token' } }))!
    expect(JSON.stringify(literal)).not.toContain('lit-token')
    expect(request).not.toHaveBeenCalled()
    expect(useHttpRuntime.getState().prompt).toBeNull()
  })

  it('is null for a WebSocket tab or a missing route', () => {
    expect(maskedSentFor(useHttp.getState().openScratch('ws'))).toBeNull()
    const gone = useHttp.getState().openScratch('http', { ...defaults.http(), url: 'https://h/x' }, { route: { kind: 'server', serverId: 'srv_gone' } })
    expect(maskedSentFor(gone)).toBeNull()
  })
})

describe('final wiring (M2, M3, m2, m9)', () => {
  const server = (id: string, workspaceId: string, over: Record<string, unknown> = {}) =>
    ({ id, workspaceId, name: `srv ${id}`, tags: [], host: 'h', port: 22, username: 'u', auth: { kind: 'agent' }, route: [], ...over }) as never

  it('a route to another workspace’s server is route-missing, never that server', async () => {
    useApp.setState({ servers: [server('srv_other', 'ws_other')] })
    const tab = useHttp.getState().openScratch('http', { ...defaults.http(), url: 'https://h/x' }, { route: { kind: 'server', serverId: 'srv_other' } })
    await send(tab)
    expect(request).not.toHaveBeenCalled()
    expect(useHttp.getState().responses[tab]).toMatchObject({ status: 'error', errorClass: 'route-missing' })
  })

  it('a malformed server is reported, not thrown, and other servers are never resolved', async () => {
    useApp.setState({ servers: [server('srv_bad', ws(), { route: undefined }), server('srv_bad2', ws(), { route: undefined })] })
    const direct = scratch()
    await send(direct)
    expect(request).toHaveBeenCalledTimes(1)
    const tab = useHttp.getState().openScratch('http', { ...defaults.http(), url: 'https://h/x' }, { route: { kind: 'server', serverId: 'srv_bad' } })
    await expect(send(tab)).resolves.toBeUndefined()
    expect(useHttp.getState().responses[tab]).toMatchObject({ status: 'error', errorClass: 'route-missing', message: expect.stringContaining('srv srv_bad') })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('sending pins a preview tab', async () => {
    const col = useApi.getState().createCollection('C')
    useApi.getState().addItem(col, null, { ...defaults.http(), id: 'req_p', url: 'https://api.example.test/x' })
    const tab = useHttp.getState().openRequest({ collectionId: col, requestId: 'req_p' }, { preview: true })
    expect(useHttp.getState().tabs.find((t) => t.id === tab)?.preview).toBe(true)
    await send(tab)
    expect(useHttp.getState().tabs.find((t) => t.id === tab)?.preview).toBe(false)
  })

  it('connecting a socket pins a preview tab too', async () => {
    useWsSessions.setState({ connect: vi.fn(async () => {}) })
    const col = useApi.getState().createCollection('C')
    useApi.getState().addItem(col, null, { ...defaults.ws(), id: 'req_w', url: 'wss://api.example.test/s' })
    const tab = useHttp.getState().openRequest({ collectionId: col, requestId: 'req_w' }, { preview: true })
    await openSocket(tab)
    expect(useHttp.getState().tabs.find((t) => t.id === tab)?.preview).toBe(false)
  })

  it('closing a tab aborts its request in main and drops its file bytes', async () => {
    let finish: (v: unknown) => void = () => {}
    request.mockImplementationOnce(() => new Promise((r) => (finish = r)))
    const tab = scratch()
    useHttpRuntime.getState().setFile(tab, 'body', { name: 'a.bin', bytes: new ArrayBuffer(4) })
    const sending = send(tab)
    await vi.waitFor(() => expect(useHttpRuntime.getState().inflight[tab]).toBeDefined())
    const requestId = useHttpRuntime.getState().inflight[tab]
    useHttp.getState().closeTab(tab)
    expect((window.opsmaxx.http as unknown as { cancel: ReturnType<typeof vi.fn> }).cancel).toHaveBeenCalledWith(requestId)
    expect(useHttpRuntime.getState().files[tab]).toBeUndefined()
    finish({ ok: true, status: 200, statusText: 'OK', headers: {}, body: new ArrayBuffer(0), durationMs: 1, truncated: false })
    await sending
    expect(useHttp.getState().responses[tab]).toBeUndefined()
  })

  it('the WS send prompt names the route, like connect', async () => {
    useEnv(prod)
    useApp.setState({ vpns: [{ id: 'vpn_1', workspaceId: ws(), name: 'office', autoStart: false, spec: {} } as never] })
    useWsSessions.setState({ send: vi.fn(async () => {}) })
    const tab = useHttp.getState().openScratch('ws', { ...defaults.ws(), url: 'wss://h/s' }, { route: { kind: 'vpn', vpnProfileId: 'vpn_1' } })
    const pending = sendWsMessage(tab, 'hi')
    await vi.waitFor(() => expect(useHttpRuntime.getState().prompt).toMatchObject({ via: 'office' }))
    useHttpRuntime.getState().answer(false, false)
    await pending
  })
})

describe('finalsec: cookies, methods, keys, routes, review, protocols', () => {
  const ok = (over: Record<string, unknown> = {}) => ({ ok: true, status: 200, statusText: 'OK', headers: {}, setCookie: ['sid=9'], body: new ArrayBuffer(0), durationMs: 1, truncated: false, ...over })

  it('stores cookies against the URL that answered (M1)', async () => {
    request.mockResolvedValueOnce(ok({ finalUrl: 'https://login.example.test/done' }))
    await send(scratch())
    expect(useHttpCookies.getState().headerFor(ws(), 'direct', 'https://login.example.test/')).toBe('sid=9')
    expect(useHttpCookies.getState().headerFor(ws(), 'direct', 'https://api.example.test/')).toBe('')
  })

  it('falls back to the requested URL when main reports no finalUrl (M1)', async () => {
    request.mockResolvedValueOnce(ok({ finalUrl: undefined }))
    await send(scratch())
    expect(useHttpCookies.getState().headerFor(ws(), 'direct', 'https://api.example.test/')).toBe('sid=9')
  })

  it('files cookies from a hop that dropped the route in the direct jar, not the route’s (M1)', async () => {
    useApp.setState({ vpns: [{ id: 'vpn_1', workspaceId: ws(), name: 'office', autoStart: false, spec: {} } as never] })
    const routed = () => useHttp.getState().openScratch('http', { ...defaults.http(), url: 'https://internal.example.test/login' }, { route: { kind: 'vpn', vpnProfileId: 'vpn_1' } })
    request.mockResolvedValueOnce(ok({ finalUrl: 'https://sso.example.test/cb', routeDropped: true }))
    await send(routed())
    expect(useHttpCookies.getState().headerFor(ws(), 'direct', 'https://sso.example.test/')).toBe('sid=9')
    expect(useHttpCookies.getState().headerFor(ws(), 'vpn:vpn_1', 'https://sso.example.test/')).toBe('')
    request.mockResolvedValueOnce(ok({ finalUrl: 'https://internal.example.test/home', setCookie: ['in=1'] }))
    await send(routed())
    expect(useHttpCookies.getState().headerFor(ws(), 'vpn:vpn_1', 'https://internal.example.test/')).toBe('in=1')
  })

  it('records the tab’s workspace on the history entry', async () => {
    await send(scratch())
    const entry = (window.opsmaxx.httpHistory as unknown as { append: ReturnType<typeof vi.fn> }).append.mock.calls[0][0]
    expect(entry.workspaceId).toBe(ws())
  })

  it('prompts for every method but GET, HEAD and OPTIONS on production (L6)', async () => {
    for (const method of ['PURGE', 'MOVE', 'LOCK', 'MKCOL', 'CUSTOM']) {
      expect(await withAnswer(false, () => confirmIfProduction({ method, environment: prod, server: null }).then(() => {})), method).toBe(true)
    }
    for (const method of ['GET', 'head', 'OPTIONS']) {
      expect(await withAnswer(false, () => confirmIfProduction({ method, environment: prod, server: null }).then(() => {})), method).toBe(false)
    }
  })

  it('"don\'t ask again" keys on both when the environment and the server are production (L7)', async () => {
    const prodServer = { id: 'srv_p', name: 'bastion-prod', tags: ['prod'] }
    const otherServer = { id: 'srv_q', name: 'bastion-2', tags: ['production'] }
    await withAnswer(true, () => confirmIfProduction({ method: 'DELETE', environment: prod, server: prodServer }).then(() => {}), true)
    expect(Object.keys(useHttpRuntime.getState().skip)).toEqual(['env:env_prod+server:srv_p|DELETE'])
    expect(await withAnswer(false, () => confirmIfProduction({ method: 'DELETE', environment: prod, server: prodServer }).then(() => {}))).toBe(false)
    expect(await withAnswer(false, () => confirmIfProduction({ method: 'DELETE', environment: prod, server: otherServer }).then(() => {}))).toBe(true)
    expect(await withAnswer(false, () => confirmIfProduction({ method: 'DELETE', environment: prod, server: null }).then(() => {}))).toBe(true)
  })

  it('a draft whose collection is gone is route-missing, never direct (L1)', async () => {
    const col = useApi.getState().createCollection('C')
    useApi.getState().addItem(col, null, { ...defaults.http(), id: 'req_g', url: 'https://localhost:8080/admin', auth: { type: 'bearer', token: 't' } })
    const tab = useHttp.getState().openRequest({ collectionId: col, requestId: 'req_g' })
    useHttp.getState().updateDraft(tab, { ...defaults.http(), id: 'req_g', url: 'https://localhost:8080/admin', auth: { type: 'bearer', token: 't' } })
    useApi.setState({ collections: [] })
    await send(tab)
    expect(request).not.toHaveBeenCalled()
    expect(useHttp.getState().responses[tab]).toMatchObject({ errorClass: 'route-missing', message: 'The collection this request belonged to no longer exists.' })
  })

  it('refuses every send while a synced connection change awaits review (M2, I1)', async () => {
    const col = useApi.getState().createCollection('C')
    useApi.getState().addItem(col, null, { ...defaults.http(), id: 'req_r', url: 'https://api.example.test/x' })
    useApi.getState().updateCollection(col, { insecureTls: true, tlsReview: true })
    const tab = useHttp.getState().openRequest({ collectionId: col, requestId: 'req_r' })
    await send(tab)
    expect(request).not.toHaveBeenCalled()
    expect(useHttp.getState().responses[tab]).toMatchObject({ message: "Review this collection's connection changes" })
    useApi.getState().clearTlsReview(col)
    await send(tab)
    expect(request.mock.calls[0][0]).toMatchObject({ insecureTls: true })
  })

  it('refuses a stripped subprotocol until it is re-entered (M3)', async () => {
    const connect = vi.fn(async () => {})
    useWsSessions.setState({ connect, fail: vi.fn() })
    const tab = useHttp.getState().openScratch('ws', { ...defaults.ws(), url: 'wss://h/s', protocols: ['graphql-ws', ''] }, { strippedFields: ['protocols.1'] })
    await openSocket(tab)
    expect(connect).not.toHaveBeenCalled()
    const entry = requestFromHistory({ id: 'h', at: 0, kind: 'ws', request: { ...defaults.ws(), protocols: ['mqtt', MASKED] }, route: { kind: 'direct' }, routeLabel: '' })
    expect(entry.strippedFields).toEqual(['protocols.1'])
  })
})

describe('re-review: closed tabs and environment review (N2, N3)', () => {
  it('sends nothing when the tab closed while the production prompt was up', async () => {
    useEnv(prod)
    const tab = scratch({ method: 'DELETE' })
    const sending = send(tab)
    await vi.waitFor(() => expect(useHttpRuntime.getState().prompt).not.toBeNull())
    useHttp.getState().closeTab(tab)
    useHttpRuntime.getState().answer(true, false)
    await sending
    expect(request).not.toHaveBeenCalled()
    expect(useHttp.getState().responses[tab]).toBeUndefined()
  })

  it('opens no socket, and reports nothing, for a tab closed during the prompt', async () => {
    useEnv(prod)
    const connect = vi.fn(async () => {})
    const fail = vi.fn()
    useWsSessions.setState({ connect, fail })
    const tab = useHttp.getState().openScratch('ws', { ...defaults.ws(), url: 'wss://h/s' })
    const opening = openSocket(tab)
    await vi.waitFor(() => expect(useHttpRuntime.getState().prompt).not.toBeNull())
    useHttp.getState().closeTab(tab)
    useHttpRuntime.getState().answer(true, false)
    await opening
    expect(connect).not.toHaveBeenCalled()
    expect(fail).not.toHaveBeenCalled()
  })

  it('refuses while the active environment or the globals await review, until accepted', async () => {
    useEnv(dev)
    useApi.setState({ envReview: ['env_dev'] })
    const tab = scratch()
    await send(tab)
    expect(request).not.toHaveBeenCalled()
    expect(useHttp.getState().responses[tab]).toMatchObject({ message: "Review this environment's changes" })
    useApi.getState().acceptEnvReview('env_dev')
    useApi.setState({ envReview: [`globals:${ws()}`] })
    await send(tab)
    expect(request).not.toHaveBeenCalled()
    useApi.getState().acceptEnvReview(`globals:${ws()}`)
    await send(tab)
    expect(request).toHaveBeenCalledTimes(1)
  })
})
