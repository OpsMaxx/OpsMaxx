import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import {
  isSnapshot,
  mergeIncoming,
  migrateApiState,
  nearestHostColor,
  scrubLegacy
} from '../src/shared/apiMigration'
import { MAX_COLLECTIONS_BYTES, type ApiCollectionV2, type HttpRequest, type Item } from '../src/shared/apiModel'

// Pure: no network and no filesystem. Both are made to throw for the whole
// file, and the fixtures arrive through import.meta.glob rather than fs.
vi.mock('node:fs', () => {
  throw new Error('migration must not touch the filesystem')
})
vi.mock('fs', () => {
  throw new Error('migration must not touch the filesystem')
})
beforeAll(() =>
  vi.stubGlobal('fetch', () => {
    throw new Error('migration must not touch the network')
  })
)
afterAll(() => vi.unstubAllGlobals())

type Fixture = { apiCollections: unknown; apiWorkspace: unknown; activeWorkspaceId?: string }
// Raw text through JSON.parse, as the data arrives from disk: a JSON module
// would be an object literal, where a "__proto__" key sets the prototype
// instead of being the own key a hostile file actually delivers.
const files = import.meta.glob<string>('./fixtures/apiWorkspace/*.json', { eager: true, query: '?raw', import: 'default' })
const fixture = (name: string): Fixture => JSON.parse(files[`./fixtures/apiWorkspace/${name}.json`]) as Fixture
const CAPTURED = [
  'v1-start-empty',
  'v1-hand-written',
  'v1-openapi-edited',
  'v1-openapi-switched-server',
  'v1-openapi-content-type',
  'v1-environments',
  'v1-two-workspaces',
  'v1-shed-spec'
]
const ALL = Object.keys(files).map((k) => k.replace(/^.*\/(.*)\.json$/, '$1'))
const run = (f: Fixture) => migrateApiState(f.apiCollections, f.apiWorkspace, { activeWorkspaceId: f.activeWorkspaceId ?? 'ws-default' })

function requests(items: Item[]): HttpRequest[] {
  return items.flatMap((i) => (i.kind === 'folder' ? requests(i.items) : i.kind === 'http' ? [i] : []))
}
const pathOf = (url: string): string => url.replace(/^\{\{baseUrl\}\}/, '').split('?')[0]
const byId = (cols: ApiCollectionV2[], id: string): ApiCollectionV2 => cols.find((c) => c.id === id)!

/** Every (method, path) v0.51.3 would have shown for this collection. */
function expectedOperations(c: Record<string, unknown>, workspace: unknown): string[] {
  const docs = isSnapshot(workspace) ? (workspace.documents as Record<string, { paths?: Record<string, Record<string, unknown>> }>) : {}
  const doc = Object.hasOwn(docs, c.id as string) ? docs[c.id as string] : undefined
  if (doc?.paths) {
    return Object.entries(doc.paths).flatMap(([path, item]) =>
      // A path item that is only a $ref to itself has no operations to lose.
      Object.keys(item).filter((m) => ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'].includes(m)).map((m) => `${m.toUpperCase()} ${path}`)
    )
  }
  const endpoints = (c.endpoints as { method: string; path: string }[] | undefined) ?? []
  if (endpoints.length) return endpoints.map((e) => `${e.method.toUpperCase()} ${e.path.startsWith('/') ? e.path : `/${e.path}`}`)
  return [`GET ${new URL(c.baseUrl as string).pathname}`]
}

describe('zero loss over every fixture', () => {
  it.each(ALL.filter((n) => n !== 'v1-hostile-ids'))('%s: every (method, path) survives, except needsReimport', (name) => {
    const f = fixture(name)
    const out = run(f)
    for (const c of f.apiCollections as Record<string, unknown>[]) {
      const migrated = byId(out.collections, c.id as string)
      if (migrated.needsReimport) {
        // Stated explicitly: a spec-backed collection with no saved document
        // (never opened, or shed by the v1 snapshot cap) keeps its spec URL
        // and is re-imported; it has nothing local to lose.
        expect(migrated.items, name).toEqual([])
        expect(c.specUrl || c.specPath, name).toBeTruthy()
        continue
      }
      const got = requests(migrated.items).map((r) => `${r.method} ${pathOf(r.url)}`).sort()
      expect(got, `${name} ${c.id}`).toEqual(expectedOperations(c, f.apiWorkspace).sort())
    }
  })

  it('the shed-spec capture is the needsReimport case', () => {
    const out = run(fixture('v1-shed-spec'))
    expect(out.collections[0]).toMatchObject({ needsReimport: true, importedFrom: { kind: 'openapi', url: 'http://127.0.0.1:18081/big.json' } })
    expect(out.report.needsReimport).toEqual([{ id: out.collections[0].id, name: 'Big API' }])
  })
})

describe('determinism and idempotence', () => {
  it.each(ALL)('%s: two independent runs are deep-equal, and the input is not mutated', (name) => {
    const f = fixture(name)
    const before = structuredClone(f)
    expect(run(f)).toEqual(run(fixture(name)))
    expect(f).toEqual(before)
  })

  it.each(ALL)('%s: migrating the output again changes nothing', (name) => {
    const first = run(fixture(name))
    const again = migrateApiState(first.collections, first.workspace, { activeWorkspaceId: 'ws-default' })
    expect(again.collections).toEqual(first.collections)
    expect(again.workspace).toEqual(first.workspace)
    expect(again.legacy).toBeNull()
    expect(again.report).toMatchObject({ collections: 0, requests: 0, environments: 0, needsReimport: [], baseUrlCollisions: [] })
  })

  it('every id is stable and valid', () => {
    const out = run(fixture('v1-openapi-edited'))
    const reqs = requests(out.collections[0].items)
    expect(reqs.every((r) => /^req_[0-9a-f]{16}$/.test(r.id))).toBe(true)
    expect(out.collections[0].items.every((i) => i.kind !== 'folder' || /^fld_[0-9a-f]{16}$/.test(i.id))).toBe(true)
  })
})

describe('Scalar’s edits are honoured', () => {
  it('x-scalar-selected-server wins over servers[0], which wins over the v1 baseUrl', () => {
    expect(run(fixture('v1-openapi-switched-server')).collections[0].variables).toEqual([
      expect.objectContaining({ key: 'baseUrl', value: 'http://127.0.0.1:18081/v2' })
    ])
    expect(run(fixture('v1-openapi-edited')).collections[0].variables[0].value).toBe('http://127.0.0.1:18081/v1')
  })

  it('x-scalar-selected-content-type picks the body mode and its example', () => {
    const order = requests(run(fixture('v1-openapi-content-type')).collections[0].items).find((r) => r.url.endsWith('/store/order'))!
    expect(order.body).toMatchObject({ mode: 'urlencoded', rows: [{ key: 'petId', value: '42' }, { key: 'quantity', value: '1' }] })
    const untouched = requests(run(fixture('v1-openapi-edited')).collections[0].items).find((r) => r.url.endsWith('/store/order'))!
    expect(untouched.body.mode).toBe('json')
  })

  it('x-disabled and edited examples come through, and the URL follows', () => {
    const list = requests(run(fixture('v1-openapi-edited')).collections[0].items).find((r) => r.method === 'GET' && pathOf(r.url) === '/pets')!
    expect(list.params.map((p) => [p.key, p.value, p.enabled])).toEqual([
      ['limit', '25', true],
      ['status', 'available', false]
    ])
    expect(list.url).toBe('{{baseUrl}}/pets?limit=25')

    const hand = requests(run(fixture('v1-hand-written')).collections[0].items)[0]
    expect(hand).toMatchObject({ method: 'POST', body: { mode: 'json', text: '{"a":1}' } })
    expect(hand.headers.map((h) => [h.key, h.value, h.enabled])).toEqual([['X-Trace', 'abc', true]])
    expect(hand.params.map((p) => [p.key, p.value, p.enabled])).toEqual([['debug', '1', false]])
  })

  it('x-scalar-order orders folders and the operations inside a tag', () => {
    const f = fixture('v1-openapi-edited') as { apiWorkspace: { documents: Record<string, Record<string, unknown>> } } & Fixture
    const doc = Object.values(f.apiWorkspace.documents)[0]
    ;(doc['x-scalar-order'] as string[]).reverse()
    const pets = (doc.tags as { name: string; 'x-scalar-order': string[] }[]).find((t) => t.name === 'pets')!
    pets['x-scalar-order'].reverse()
    const items = run(f).collections[0].items
    expect(items.map((i) => i.name)).toEqual(['store', 'pets'])
    const petsFolder = items[1] as Extract<Item, { kind: 'folder' }>
    expect(requests(petsFolder.items).map((r) => `${r.method} ${pathOf(r.url)}`)).toEqual(['GET /pets/{petId}', 'POST /pets', 'GET /pets'])
  })

  it('x-scalar-* keys seen in the fixtures and not used, with the decision for each', () => {
    // Recorded here because the spec asks every other key to carry a decision.
    //   x-scalar-active-document       which document was open: session state, dropped.
    //   x-scalar-active-proxy          always null in 0.51.3; scrubbed from legacy (SEC-M3).
    //   x-scalar-original-document-hash, x-scalar-is-dirty, x-original-oas-version, x-ext-urls:
    //                                  Scalar bookkeeping with no v2 meaning, dropped.
    //   x-scalar-original-source-url   the spec URL; used only to resolve a relative server.
    //   x-scalar-navigation            the derived sidebar tree; rebuilt from items, dropped.
    //   x-scalar-disable-parameters    named by the plan, absent from every capture; not read.
    const seen = new Set<string>()
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk)
      else if (v && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) {
          if (k.startsWith('x-')) seen.add(k)
          walk(x)
        }
      }
    }
    CAPTURED.forEach((n) => walk(fixture(n)))
    expect([...seen].sort()).toEqual([
      'x-disabled',
      'x-ext-urls',
      'x-original-oas-version',
      'x-scalar-active-document',
      'x-scalar-active-environment',
      'x-scalar-active-proxy',
      'x-scalar-environments',
      'x-scalar-is-dirty',
      'x-scalar-navigation',
      'x-scalar-order',
      'x-scalar-original-document-hash',
      'x-scalar-original-source-url',
      'x-scalar-selected-content-type',
      'x-scalar-selected-server'
    ])
  })
})

describe('collections', () => {
  it('keeps id, workspace, route and TLS, and carries the v1 fields as deprecated', () => {
    const out = run(fixture('v1-not-a-snapshot'))
    const file = byId(out.collections, 'api-file-1')
    expect(file).toMatchObject({
      version: 2,
      workspaceId: 'ws-default',
      name: 'File spec',
      viaServerId: 'srv-1',
      insecureTls: true,
      auth: { type: 'none' },
      needsReimport: true,
      importedFrom: { kind: 'openapi', fileName: 'petstore.yaml' },
      baseUrl: 'https://u:secret@api.example.test',
      // No local path in a synced record: the file's name is in importedFrom.
      specPath: null
    })
    // No baseUrl variable while it waits on re-import: v1's value was only the
    // spec URL's origin, and it would override the servers the import reads.
    expect(file.variables).toEqual([])
    // A converted collection's variable has no userinfo.
    const hand = migrateApiState(
      [{ id: 'h1', workspaceId: 'ws-default', name: 'H', baseUrl: 'https://u:secret@api.example.test/v1' }],
      null,
      { activeWorkspaceId: 'ws-default' }
    ).collections[0]
    expect(hand.variables).toEqual([{ id: expect.stringMatching(/^var_/), key: 'baseUrl', value: 'https://api.example.test', enabled: true }])
  })

  it('a workspace that is not a snapshot migrates collections without documents and keeps it in legacy', () => {
    const f = fixture('v1-not-a-snapshot')
    const out = run(f)
    expect(out.workspace.environments).toEqual([])
    expect(byId(out.collections, 'api-hand-1').items.map((i) => (i as HttpRequest).url)).toEqual(['{{baseUrl}}/users', '{{baseUrl}}/users/{id}'])
    expect(out.legacy).toEqual({ version: 1, apiCollections: f.apiCollections, apiWorkspace: f.apiWorkspace })
  })

  it('a cyclic document terminates', () => {
    const out = run(fixture('v1-cyclic-doc'))
    expect(requests(out.collections[0].items).map((r) => `${r.method} ${pathOf(r.url)}`)).toEqual(['POST /node'])
    // And a real object cycle, which JSON cannot express.
    const doc: Record<string, unknown> = { openapi: '3.1.1', paths: { '/a': { get: { summary: 'a' } } } }
    doc.self = doc
    ;(doc.paths as Record<string, Record<string, unknown>>)['/a'].get = { summary: 'a', loop: doc }
    const cyc = migrateApiState([{ id: 'c1', workspaceId: 'ws-default', name: 'C', baseUrl: 'http://h' }], { version: 1, meta: {}, documents: { c1: doc }, sourceKeys: {} }, { activeWorkspaceId: 'ws-default' })
    expect(requests(cyc.collections[0].items).map((r) => r.method)).toEqual(['GET'])
    expect(cyc.legacy).toBeNull()
  })
})

describe('the 4 MiB cap', () => {
  it('sheds the largest spec-derived collections until the rest fits, never a hand-written one', () => {
    const paths: Record<string, unknown> = {}
    for (let i = 0; i < 2400; i++) paths[`/r${i}`] = { get: { summary: `op ${i}`, description: 'd'.repeat(2048) } }
    const big = { id: 'big', workspaceId: 'ws-default', name: 'Big', specUrl: 'http://127.0.0.1/big.json', specPath: null, baseUrl: 'http://127.0.0.1' }
    const hand = { id: 'hand', workspaceId: 'ws-default', name: 'Hand', specUrl: null, specPath: null, baseUrl: 'http://127.0.0.1/api', endpoints: [{ method: 'GET', path: '/x' }] }
    const small = { id: 'small', workspaceId: 'ws-default', name: 'Small', specUrl: 'http://127.0.0.1/s.json', specPath: null, baseUrl: 'http://127.0.0.1' }
    const out = migrateApiState([small, big, hand], {
      version: 1,
      meta: {},
      documents: { big: { openapi: '3.1.1', paths }, small: { openapi: '3.1.1', paths: { '/s': { get: {} } } } },
      sourceKeys: {}
    }, { activeWorkspaceId: 'ws-default' })
    expect(new TextEncoder().encode(JSON.stringify(out.collections)).length).toBeLessThanOrEqual(MAX_COLLECTIONS_BYTES)
    expect(out.report.shedForCap).toEqual(['big'])
    expect(byId(out.collections, 'big')).toMatchObject({ items: [], needsReimport: true })
    expect(requests(byId(out.collections, 'small').items)).toHaveLength(1)
    expect(requests(byId(out.collections, 'hand').items)).toHaveLength(1)
    expect(out.report.needsReimport).toContainEqual({ id: 'big', name: 'Big' })
  })
})

describe('environments', () => {
  it('one environment per name for each workspace that owns a collection, prod flagged and active', () => {
    const out = run(fixture('v1-environments'))
    const envs = out.workspace.environments
    expect(envs.map((e) => [e.workspaceId, e.name, e.production, e.color])).toEqual([
      ['ws-default', 'dev', false, 'blue'],
      ['ws-default', 'prod', true, 'blue']
    ])
    const prod = envs[1]
    expect(prod.variables.find((v) => v.key === 'token')?.value).toBe('vault:v-mudwrxlw-0#password')
    expect(out.workspace.activeEnvironment['ws-default']).toBe(prod.id)
    expect(Object.getPrototypeOf(out.workspace.activeEnvironment)).toBeNull()
    expect(Object.getPrototypeOf(out.workspace.globals)).toBeNull()
    expect(out.report.environments).toBe(2)
  })

  it('reports an environment baseUrl that disagrees with a migrated collection (UX-M16)', () => {
    const out = run(fixture('v1-environments'))
    expect(out.report.baseUrlCollisions).toEqual([
      { collectionId: 'api-mudws9xd-0', environment: 'dev', value: 'http://127.0.0.1:18080/api' },
      { collectionId: 'api-mudws9xd-0', environment: 'prod', value: 'https://api.example.test' }
    ])
  })

  it('copies environments into every owning workspace, with distinct ids', () => {
    const f = fixture('v1-two-workspaces') as Fixture & { apiWorkspace: { meta: Record<string, unknown> } }
    f.apiWorkspace.meta['x-scalar-environments'] = { dev: { color: '#30a47d', variables: [{ name: 'k', value: { default: 'v' } }] } }
    const envs = run(f).workspace.environments
    expect(envs.map((e) => [e.workspaceId, e.name, e.color, e.variables[0].value])).toEqual([
      ['ws-default', 'dev', 'jade', 'v'],
      ['ws-mudwtzz2-1', 'dev', 'jade', 'v']
    ])
    expect(envs[0].id).not.toBe(envs[1].id)
  })

  it('maps a colour to the nearest host colour', () => {
    expect(['#5c96d0', '#ff00ff', '#30a47d', '#cc7755', 'junk', undefined].map(nearestHostColor)).toEqual(['blue', 'violet', 'jade', 'rust', 'blue', 'blue'])
  })
})

describe('hostile input (SEC-M7)', () => {
  it('rejects prototype and invalid ids, reports them, and pollutes nothing', () => {
    const out = run(fixture('v1-hostile-ids'))
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(Object.prototype).not.toHaveProperty('polluted')
    expect(out.collections.map((c) => c.id)).toEqual(['ok-2'])
    expect(out.collections[0]).toMatchObject({ viaServerId: null, insecureTls: false })
    expect(out.report.rejected.map((r) => `${r.kind}:${r.id}`)).toEqual([
      'collection:__proto__',
      'collection:constructor',
      'workspace:prototype',
      'collection:has space',
      'collection:not an object',
      'collection:null',
      'collection:ok-2',
      'environment:__proto__',
      'environment:constructor'
    ])
    expect(out.workspace.environments.map((e) => e.name)).toEqual(['prod'])
    // The active environment named a rejected one, so nothing is active.
    expect(Object.keys(out.workspace.activeEnvironment)).toEqual([])
    // Rejected records are kept in legacy, not lost.
    expect(JSON.stringify(out.legacy)).toContain('"id":"__proto__"')
  })
})

describe('a malformed v2 record', () => {
  it('is rejected rather than passed through', () => {
    const out = migrateApiState([{ version: 2, id: 'col_1', workspaceId: 'ws-default', items: 'nope', variables: [], auth: {} }], null, { activeWorkspaceId: 'ws-default' })
    expect(out.collections).toEqual([])
    expect(out.report.rejected).toEqual([{ kind: 'collection', id: 'col_1', reason: 'Not a valid v2 collection.' }])
  })
})

describe('legacy (SEC-M3)', () => {
  it('keeps no cookies and no proxy, and reports what was dropped', () => {
    const out = run(fixture('v1-cookies-proxy'))
    const text = JSON.stringify(out.legacy)
    expect(text).not.toContain('x-scalar-cookies')
    expect(text).not.toContain('cookie-secret')
    expect(text).not.toContain('x-scalar-active-proxy')
    expect(text).toContain('api-c-1')
    expect(out.report.dropped).toEqual(['cookies', 'proxy', 'tabs'])
    expect(scrubLegacy(null)).toBeNull()
  })

  it('is null when there was nothing v1 to migrate', () => {
    expect(migrateApiState([], null, { activeWorkspaceId: 'ws-default' }).legacy).toBeNull()
    expect(migrateApiState('junk', 42, { activeWorkspaceId: 'ws-default' })).toMatchObject({ collections: [], legacy: null })
  })
})

describe('mergeIncoming (ARCH-M12)', () => {
  it('returns the same reference when a v1 blob brings nothing new', () => {
    const f = fixture('v1-environments')
    const v2 = run(f).workspace
    expect(mergeIncoming(v2, f.apiWorkspace, { activeWorkspaceId: 'ws-default' })).toBe(v2)
    expect(mergeIncoming(v2, v2, { activeWorkspaceId: 'ws-default' })).toBe(v2)
    expect(mergeIncoming(v2, 'junk', { activeWorkspaceId: 'ws-default' })).toBe(v2)
  })

  it('adds environments by (workspace, name) and never deletes or overwrites', () => {
    const f = fixture('v1-environments') as Fixture & { apiWorkspace: { meta: Record<string, Record<string, unknown>> } }
    const v2 = run(f).workspace
    f.apiWorkspace.meta['x-scalar-environments'].staging = { variables: [] }
    f.apiWorkspace.meta['x-scalar-environments'].prod = { variables: [{ name: 'baseUrl', value: 'https://changed.example.test' }] }
    const merged = mergeIncoming(v2, f.apiWorkspace, { activeWorkspaceId: 'ws-default' })
    expect(merged).not.toBe(v2)
    expect(merged.environments.map((e) => e.name)).toEqual(['dev', 'prod', 'staging'])
    expect(merged.environments[1]).toBe(v2.environments[1])
  })
})

describe('spec sources keep no credential and no path (L-c)', () => {
  it('strips userinfo and credential query params from the spec URL, and keeps only a basename', () => {
    const out = migrateApiState(
      [
        { id: 'u1', workspaceId: 'ws-default', name: 'U', specUrl: 'https://u:pw@h.example.test/o.json?access_token=tok&v=2', specPath: null, baseUrl: '' },
        { id: 'u2', workspaceId: 'ws-default', name: 'B', specUrl: 'https://h.example.test/o.json', specPath: '/home/someone/o.json', baseUrl: '' }
      ],
      null,
      { activeWorkspaceId: 'ws-default' }
    )
    const [u1, u2] = out.collections
    expect(u1.importedFrom?.url).toBe('https://h.example.test/o.json?v=2')
    expect(u1.specUrl).toBe('https://h.example.test/o.json?v=2')
    expect(JSON.stringify(out.collections)).not.toMatch(/tok|pw@|home\/someone/)
    expect(u2.specPath).toBe('o.json')
  })
})
