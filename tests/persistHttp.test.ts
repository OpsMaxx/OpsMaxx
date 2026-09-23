// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { defaults, MAX_COLLECTIONS_BYTES, type ApiCollectionV2, type HttpRequest } from '../src/shared/apiModel'
import { useApi } from '../src/renderer/src/store/api'
import { useApp } from '../src/renderer/src/store/app'
import { useHttp } from '../src/renderer/src/store/http'
import { useToasts } from '../src/renderer/src/store/toast'
import {
  apiSaveFields,
  applyExternalApi,
  hydrateApi,
  subscribeApiPersistence
} from '../src/renderer/src/store/persistHttp'

const files = import.meta.glob<string>('./fixtures/apiWorkspace/*.json', { eager: true, query: '?raw', import: 'default' })
const fixture = (name: string) =>
  JSON.parse(files[`./fixtures/apiWorkspace/${name}.json`]) as { apiCollections: unknown; apiWorkspace: unknown }

const ws = (): string => useApp.getState().activeWorkspaceId
const collection = (over: Partial<ApiCollectionV2> = {}): ApiCollectionV2 => ({ ...defaults.collection(ws(), 'C'), ...over })
const request = (over: Partial<HttpRequest> = {}): HttpRequest => ({ ...defaults.http(), ...over })

describe('hydrateApi', () => {
  it('migrates v1 to v2, keeps the legacy blob scrubbed, and raises the report', () => {
    const f = fixture('v1-cookies-proxy')
    hydrateApi({ apiCollections: f.apiCollections, apiWorkspace: f.apiWorkspace })
    const s = useApi.getState()
    expect(s.collections[0]).toMatchObject({ version: 2, id: 'api-c-1' })
    expect(JSON.stringify(s.legacy)).not.toContain('cookie-secret')
    expect(JSON.stringify(s.legacy)).not.toContain('x-scalar-active-proxy')
    expect(s.report).toMatchObject({ collections: 1, dropped: ['cookies', 'proxy', 'tabs'] })
  })

  it('loads v2 as it is, keeps an existing legacy stash, raises no report, and restores the session', () => {
    const c = collection({ items: [request({ name: 'kept' })] })
    const restore = vi.spyOn(useHttp.getState(), 'restoreHttpSession')
    const session = { version: 1 }
    hydrateApi({ apiCollections: [c], apiWorkspace: { version: 2, environments: [], activeEnvironment: {}, globals: {} }, apiWorkspaceLegacy: { old: true }, httpSession: session })
    expect(useApi.getState().collections).toEqual([c])
    expect(useApi.getState().legacy).toEqual({ old: true })
    expect(useApi.getState().report).toBeNull()
    expect(restore).toHaveBeenCalledWith(session)
  })
})

describe('apiSaveFields, the one choke point', () => {
  it('a literal Authorization set straight into store state is absent from the save', () => {
    const req = request({
      headers: [{ id: 'row_1', enabled: true, key: 'Authorization', value: 'Bearer literal-secret' }],
      auth: { type: 'bearer', token: 'another-literal' }
    })
    useApi.setState({ collections: [collection({ auth: { type: 'basic', username: 'u', password: 'pw-literal' }, items: [req] })] })
    const tab = useHttp.getState().openScratch('http', { ...req, url: 'https://u:tab-secret@h.example.test' })
    const saved = JSON.stringify(apiSaveFields())
    for (const secret of ['literal-secret', 'another-literal', 'pw-literal', 'tab-secret']) expect(saved).not.toContain(secret)
    const savedTab = apiSaveFields().httpSession.tabs.find((t) => t.id === tab)!
    expect(savedTab.strippedFields).toEqual(['headers.0.value', 'url', 'auth.token'])
    // The live store still holds what the user typed; only the save is stripped.
    expect(JSON.stringify(useApi.getState().collections)).toContain('literal-secret')
  })

  it('an over-cap save is refused, the last good save kept, and the user told', () => {
    const small = collection({ name: 'small' })
    useApi.setState({ collections: [small] })
    const good = apiSaveFields().apiCollections
    expect(good.map((c) => c.name)).toEqual(['small'])
    const huge = collection({ name: 'huge', description: 'x'.repeat(MAX_COLLECTIONS_BYTES) })
    useApi.setState({ collections: [small, huge] })
    expect(apiSaveFields().apiCollections).toEqual(good)
    expect(useToasts.getState().toasts.at(-1)).toMatchObject({ kind: 'error' })
  })

  it('caps a persisted body at 256 KiB, and marks a session draft’s body not kept', () => {
    const big = request({ method: 'POST', body: { mode: 'text', text: 'b'.repeat(300 * 1024) } })
    useApi.setState({ collections: [collection({ items: [big] })] })
    const tab = useHttp.getState().openScratch('http', big)
    const fields = apiSaveFields()
    expect((fields.apiCollections[0].items[0] as HttpRequest).body).toEqual({ mode: 'text', text: '' })
    expect(fields.httpSession.tabs.find((t) => t.id === tab)?.strippedFields).toEqual(['body'])
  })
})

describe('subscribeApiPersistence', () => {
  it('a store/api change arms the 400 ms timer and marks the backup dirty', () => {
    const soon400 = vi.fn()
    const soon2000 = vi.fn()
    useApp.getState().setSettings({ backupDirty: false })
    const stop = subscribeApiPersistence(soon400, soon2000)
    useApi.getState().createCollection('New')
    expect(soon400).toHaveBeenCalledTimes(1)
    expect(soon2000).not.toHaveBeenCalled()
    expect(useApp.getState().settings.backupDirty).toBe(true)
    stop()
  })

  it('an httpSession change arms the 2,000 ms timer and does not mark the backup dirty', () => {
    const soon400 = vi.fn()
    const soon2000 = vi.fn()
    useApp.getState().setSettings({ backupDirty: false })
    const stop = subscribeApiPersistence(soon400, soon2000)
    useHttp.getState().openScratch('http')
    expect(soon2000).toHaveBeenCalled()
    expect(soon400).not.toHaveBeenCalled()
    expect(useApp.getState().settings.backupDirty).toBe(false)
    stop()
  })

  it('beforeunload flushes, and unsubscribing stops everything', () => {
    const now = vi.fn()
    const stop = subscribeApiPersistence(vi.fn(), vi.fn(), now)
    window.dispatchEvent(new Event('beforeunload'))
    expect(now).toHaveBeenCalledTimes(1)
    stop()
    window.dispatchEvent(new Event('beforeunload'))
    expect(now).toHaveBeenCalledTimes(1)
  })
})

describe('applyExternalApi', () => {
  it('raises tlsReview when insecureTls goes false→true or the CA changes, and strips what arrives', () => {
    const a = collection({ id: 'col_a', insecureTls: false })
    const b = collection({ id: 'col_b', caPem: 'OLD' })
    const c = collection({ id: 'col_c' })
    useApi.setState({ collections: [a, b, c] })
    applyExternalApi({
      apiCollections: [
        { ...a, insecureTls: true },
        { ...b, caPem: 'NEW' },
        { ...c, name: 'renamed', auth: { type: 'bearer', token: 'synced-literal' } }
      ]
    })
    const [na, nb, nc] = useApi.getState().collections
    expect([na.tlsReview, nb.tlsReview, nc.tlsReview]).toEqual([true, true, undefined])
    expect(nc).toMatchObject({ name: 'renamed', auth: { type: 'bearer', token: '' } })
  })

  it('sets nothing when nothing changed, so no save or sync follows', () => {
    const c = collection()
    useApi.setState({ collections: [c] })
    const before = useApi.getState()
    const listener = vi.fn()
    const stop = useApi.subscribe(listener)
    applyExternalApi({ apiCollections: [structuredClone(c)], apiWorkspace: structuredClone(before.workspace) })
    expect(listener).not.toHaveBeenCalled()
    stop()
  })

  it('keeps this device’s v2 record over an older device’s v1 copy, and migrates a new v1 one', () => {
    const mine = collection({ id: 'api-mudwj912-0', items: [request({ name: 'v2 edit' })] })
    useApi.setState({ collections: [mine] })
    const f = fixture('v1-two-workspaces') as { apiCollections: { id: string }[]; apiWorkspace: unknown }
    applyExternalApi({ apiCollections: [{ ...f.apiCollections[0], id: mine.id }, f.apiCollections[1]], apiWorkspace: f.apiWorkspace })
    const [first, second] = useApi.getState().collections
    expect(first).toBe(mine)
    expect(second).toMatchObject({ version: 2, id: f.apiCollections[1].id })
    expect(second.items.length).toBeGreaterThan(0)
  })

  it('merges environments from a v1 blob by name, and replaces from a v2 one', () => {
    const f = fixture('v1-environments')
    hydrateApi({ apiCollections: f.apiCollections, apiWorkspace: f.apiWorkspace })
    const workspace = useApi.getState().workspace
    applyExternalApi({ apiWorkspace: f.apiWorkspace })
    expect(useApi.getState().workspace).toBe(workspace)
    applyExternalApi({ apiWorkspace: { version: 2, environments: [], activeEnvironment: {}, globals: {} } })
    expect(useApi.getState().workspace.environments).toEqual([])
  })
})

const CERT = '-----BEGIN CERTIFICATE-----\nMIIBcert\n-----END CERTIFICATE-----'
const KEY = '-----BEGIN PRIVATE KEY-----\nMIIEkey\n-----END PRIVATE KEY-----'

describe('certificate settings from outside (L-a, L-b)', () => {
  it('a brand-new synced collection that skips verification or trusts a CA is reviewed', () => {
    useApi.setState({ collections: [] })
    applyExternalApi({
      apiCollections: [collection({ id: 'col_new1', insecureTls: true }), collection({ id: 'col_new2', caPem: CERT }), collection({ id: 'col_new3' })]
    })
    expect(useApi.getState().collections.map((c) => c.tlsReview)).toEqual([true, true, undefined])
  })

  it('keeps only certificate blocks, and drops a CA that carries a private key', () => {
    useApi.setState({ collections: [] })
    applyExternalApi({
      apiCollections: [collection({ id: 'col_k', caPem: `${CERT}\n${KEY}` }), collection({ id: 'col_c', caPem: `junk before\n${CERT}\njunk after` })]
    })
    const [withKey, withJunk] = useApi.getState().collections
    expect(withKey.caPem).toBeUndefined()
    expect(withJunk.caPem).toBe(`${CERT}\n`)
    useApi.setState({ collections: [collection({ caPem: KEY })] })
    expect(JSON.stringify(apiSaveFields())).not.toContain('PRIVATE KEY')
  })

  it('a hydrated CA with a key is dropped before anything can send with it', () => {
    hydrateApi({ apiCollections: [collection({ id: 'col_h', caPem: KEY })], apiWorkspace: { version: 2, environments: [], activeEnvironment: {}, globals: {} } })
    expect(useApi.getState().collections[0].caPem).toBeUndefined()
  })
})

describe('the over-cap fallback after an upgrade', () => {
  it('is the migrated v2 data, never the raw v1 records', () => {
    const f = fixture('v1-hand-written')
    hydrateApi({ apiCollections: f.apiCollections, apiWorkspace: f.apiWorkspace })
    const huge = collection({ name: 'huge', description: 'x'.repeat(MAX_COLLECTIONS_BYTES) })
    useApi.setState((s) => ({ collections: [...s.collections, huge] }))
    const saved = apiSaveFields().apiCollections
    expect(saved.map((c) => c.version)).toEqual([2])
    expect(saved[0].id).toBe('api-mudwj912-0')
  })
})

describe('older builds can read what is saved (v0.51.x, and a rollback)', () => {
  // The v0.51.3 ApiCollection type, and the fields its components read
  // without a guard (WsConsole/GraphQlConsole: baseUrl.trim(); HttpView:
  // viaServerId !== null; ApiSidebar and HttpView: name).
  function assertV1Shape(c: Record<string, unknown>): void {
    expect(typeof c.id).toBe('string')
    expect(typeof c.workspaceId).toBe('string')
    expect(typeof c.name).toBe('string')
    expect(typeof c.baseUrl).toBe('string')
    expect(c.specUrl === null || typeof c.specUrl === 'string').toBe(true)
    expect(c.specPath === null || typeof c.specPath === 'string').toBe(true)
    expect(c.viaServerId === null || typeof c.viaServerId === 'string').toBe(true)
    expect(typeof c.insecureTls).toBe('boolean')
    expect(Array.isArray(c.endpoints)).toBe(true)
    expect(() => (c.baseUrl as string).trim()).not.toThrow()
  }

  it('a collection created in the new client carries every v1 field, baseUrl from its variable', () => {
    const id = useApi.getState().createCollection('Fresh')
    useApi.getState().updateCollection(id, { variables: [{ id: 'var_b', key: 'baseUrl', value: 'https://api.example.test/v1', enabled: true }] })
    const [saved] = apiSaveFields().apiCollections
    assertV1Shape(saved as unknown as Record<string, unknown>)
    expect(saved).toMatchObject({ baseUrl: 'https://api.example.test/v1', specUrl: null, viaServerId: null, endpoints: [] })
  })

  it('one with no baseUrl variable gets an empty string, and a carried v1 baseUrl is kept as it was', () => {
    useApi.getState().createCollection('Bare')
    const f = fixture('v1-openapi-switched-server')
    hydrateApi({ apiCollections: f.apiCollections, apiWorkspace: f.apiWorkspace })
    useApi.getState().createCollection('Bare')
    const saved = apiSaveFields().apiCollections
    saved.forEach((c) => assertV1Shape(c as unknown as Record<string, unknown>))
    // Changing a carried baseUrl would make an old client rebuild that document and drop its edits.
    expect(saved[0].baseUrl).toBe('http://127.0.0.1:18081')
    expect(saved[1].baseUrl).toBe('')
  })

  it('a record arriving by sync without the v1 fields gets them too', () => {
    useApi.setState({ collections: [] })
    const { baseUrl: _b, specUrl: _s, specPath: _p, endpoints: _e, ...bare } = collection({ id: 'col_sync' })
    applyExternalApi({ apiCollections: [bare] })
    assertV1Shape(useApi.getState().collections[0] as unknown as Record<string, unknown>)
  })
})

describe('an unchanged sync after the v1 fields were added', () => {
  it('causes no setState whether the store record has the v1 fields or not', () => {
    const bare = collection({ id: 'col_same' })
    useApi.setState({ collections: [bare] })
    const listener = vi.fn()
    const stop = useApi.subscribe(listener)
    applyExternalApi({ apiCollections: apiSaveFields().apiCollections })
    applyExternalApi({ apiCollections: [structuredClone(bare)] })
    expect(listener).not.toHaveBeenCalled()
    stop()
  })
})

describe('tlsReview is this device’s own (M6)', () => {
  it('is never saved or synced, and never comes from an incoming record', () => {
    useApi.setState({ collections: [] })
    applyExternalApi({ apiCollections: [collection({ id: 'col_r', tlsReview: true })] })
    expect(useApi.getState().collections[0].tlsReview).toBeUndefined()
    useApi.setState({ collections: [collection({ id: 'col_s', tlsReview: true })] })
    const fields = apiSaveFields()
    expect(fields.apiCollections[0]).not.toHaveProperty('tlsReview')
    expect(fields.apiLocal.tlsReview).toEqual(['col_s'])
  })

  it('an own edit echoed back by sync does not raise "changed on another device"', () => {
    const c = collection({ id: 'col_own' })
    useApi.setState({ collections: [c] })
    useApi.getState().updateCollection('col_own', { insecureTls: true })
    applyExternalApi({ apiCollections: apiSaveFields().apiCollections })
    expect(useApi.getState().collections[0].tlsReview).toBeUndefined()
  })

  it('one device’s Review does not clear another’s, and the flag survives a restart here', () => {
    const c = collection({ id: 'col_b', insecureTls: true, tlsReview: true })
    useApi.setState({ collections: [c] })
    applyExternalApi({ apiCollections: [{ ...c, tlsReview: false, name: 'renamed elsewhere' }] })
    expect(useApi.getState().collections[0]).toMatchObject({ name: 'renamed elsewhere', tlsReview: true })
    const saved = apiSaveFields()
    hydrateApi({ apiCollections: saved.apiCollections, apiWorkspace: saved.apiWorkspace, apiLocal: saved.apiLocal })
    expect(useApi.getState().collections[0].tlsReview).toBe(true)
  })
})

describe('the upgrade report outlives the upgrade session (M7)', () => {
  it('is saved device-only until dismissed, and restored on the next launch', () => {
    const f = fixture('v1-openapi-edited')
    hydrateApi({ apiCollections: f.apiCollections, apiWorkspace: f.apiWorkspace })
    const report = useApi.getState().report!
    const saved = apiSaveFields()
    expect(saved.apiLocal.report).toEqual(report)
    useApi.setState({ report: null })
    hydrateApi({ apiCollections: saved.apiCollections, apiWorkspace: saved.apiWorkspace, apiWorkspaceLegacy: saved.apiWorkspaceLegacy, apiLocal: saved.apiLocal })
    expect(useApi.getState().report).toEqual(report)
    expect(useApi.getState().hasLegacy()).toBe(true)
    useHttp.getState().dismissBanner(report.id)
    expect(apiSaveFields().apiLocal.report).toBeNull()
  })

  it('ignores a malformed apiLocal', () => {
    hydrateApi({ apiCollections: [], apiLocal: { version: 1, report: { id: 1 }, tlsReview: ['__proto__', 'ok_1'] } })
    expect(useApi.getState().report).toBeNull()
    expect(useApi.getState().hasLegacy()).toBe(false)
  })
})

describe('finalsec: connection review triggers and the VPN baseUrl (I1, L10)', () => {
  const reviewed = (before: Partial<ApiCollectionV2>, after: Partial<ApiCollectionV2>): boolean | undefined => {
    const c = collection({ id: 'col_x', ...before })
    useApi.setState({ collections: [c] })
    applyExternalApi({ apiCollections: [{ ...c, ...after }] })
    return useApi.getState().collections[0].tlsReview
  }

  it('a synced route change or a new host raises the review; a same-host edit does not', () => {
    const items = [request({ id: 'req_1', url: 'https://api.example.test/a' })]
    expect(reviewed({ items }, { viaServerId: 'srv_9' })).toBe(true)
    expect(reviewed({ items }, { vpnProfileId: 'vpn_9' })).toBe(true)
    expect(reviewed({ items }, { items: [request({ id: 'req_1', url: 'https://evil.example.test/a' })] })).toBe(true)
    expect(reviewed({ items }, { variables: [{ id: 'v', key: 'baseUrl', value: 'http://10.0.0.9', enabled: true }] })).toBe(true)
    expect(reviewed({ items }, { items: [request({ id: 'req_1', url: 'https://api.example.test/b' })], name: 'renamed' })).toBeUndefined()
  })

  it('writes an empty v1 baseUrl while the collection goes through a VPN', () => {
    useApi.setState({ collections: [collection({ id: 'col_v', vpnProfileId: 'vpn_1', baseUrl: 'http://10.0.0.5' }), collection({ id: 'col_d', baseUrl: 'http://10.0.0.6' })] })
    expect(apiSaveFields().apiCollections.map((c) => c.baseUrl)).toEqual(['', 'http://10.0.0.6'])
  })
})

describe('synced variable changes are reviewed (finalsec N2)', () => {
  it('any collection variable change is a connection change, not only baseUrl', () => {
    const c = collection({ id: 'col_v', variables: [{ id: 'v', key: 'apiHost', value: 'api.example.test', enabled: true }] })
    useApi.setState({ collections: [c] })
    applyExternalApi({ apiCollections: [{ ...c, variables: [{ id: 'v', key: 'apiHost', value: 'evil.example.test', enabled: true }] }] })
    expect(useApi.getState().collections[0].tlsReview).toBe(true)
  })

  it('a changed or new environment, and changed globals, raise a device-only review that survives a restart', () => {
    const env = { id: 'env_p', workspaceId: 'ws_a', name: 'prod', color: 'rust' as const, production: true, variables: [{ id: 'v', key: 'baseUrl', value: 'https://api.example.test', enabled: true }] }
    const base = { version: 2 as const, environments: [env], activeEnvironment: Object.create(null), globals: Object.create(null) }
    useApi.setState({ workspace: base, envReview: [] })
    applyExternalApi({ apiWorkspace: structuredClone(base) })
    expect(useApi.getState().envReview).toEqual([])
    const moved = { ...base, environments: [{ ...env, variables: [{ ...env.variables[0], value: 'https://evil.example.test' }] }, { ...env, id: 'env_new', name: 'new' }], globals: { ws_a: [{ id: 'g', key: 'k', value: 'v', enabled: true }] } }
    applyExternalApi({ apiWorkspace: moved })
    expect(useApi.getState().envReview).toEqual(['env_p', 'env_new', 'globals:ws_a'])
    const saved = apiSaveFields()
    expect(saved.apiLocal.envReview).toEqual(['env_p', 'env_new', 'globals:ws_a'])
    useApi.setState({ envReview: [] })
    hydrateApi({ apiCollections: saved.apiCollections, apiWorkspace: saved.apiWorkspace, apiLocal: saved.apiLocal })
    expect(useApi.getState().envReview).toEqual(['env_p', 'env_new', 'globals:ws_a'])
  })

  it('accepting a review saves without marking the backup dirty', () => {
    const soon400 = vi.fn()
    useApi.setState({ envReview: ['env_x'] })
    useApp.getState().setSettings({ backupDirty: false })
    const stop = subscribeApiPersistence(soon400, vi.fn())
    useApi.getState().acceptEnvReview('env_x')
    expect(soon400).toHaveBeenCalledTimes(1)
    expect(useApp.getState().settings.backupDirty).toBe(false)
    stop()
  })
})

describe('a production flag changed by sync is reviewed', () => {
  it('holds the environment until accepted when production goes true to false', () => {
    const env = { id: 'env_p2', workspaceId: 'ws_a', name: 'prod', color: 'rust' as const, production: true, variables: [] }
    const base = { version: 2 as const, environments: [env], activeEnvironment: Object.create(null), globals: Object.create(null) }
    useApi.setState({ workspace: base, envReview: [] })
    applyExternalApi({ apiWorkspace: { ...base, environments: [{ ...env, production: false }] } })
    expect(useApi.getState().envReview).toEqual(['env_p2'])
  })
})
