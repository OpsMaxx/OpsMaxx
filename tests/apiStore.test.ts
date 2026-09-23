// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { defaults, type Environment, type Folder, type HttpRequest, type Item } from '../src/shared/apiModel'
import { useApi } from '../src/renderer/src/store/api'
import { useApp } from '../src/renderer/src/store/app'

// store/api's actions, which replace apiCollectionEditing.test.ts at cutover.

const api = () => useApi.getState()
const ws = (): string => useApp.getState().activeWorkspaceId
const req = (id: string, name = id): HttpRequest => ({ ...defaults.http(), id, name })
const folder = (id: string, items: Item[] = []): Folder => ({ kind: 'folder', id, name: id, items })
const items = (colId: string): Item[] => api().collections.find((c) => c.id === colId)!.items
const ids = (list: Item[]): unknown[] => list.map((i) => (i.kind === 'folder' ? [i.id, ids(i.items)] : i.id))

function seed(): string {
  const col = api().createCollection('Pets', { kind: 'server', serverId: 'srv_1' })
  api().addItem(col, null, folder('fld_a', [req('req_1'), req('req_2')]))
  api().addItem(col, null, req('req_3'))
  api().addItem(col, 'fld_a', req('req_0'), 0)
  return col
}

describe('collections and items', () => {
  it('creates a collection in the active workspace with the scratch route', () => {
    const col = api().createCollection('Pets', { kind: 'vpn', vpnProfileId: 'vpn_1' })
    expect(api().collectionsIn(ws()).map((c) => c.id)).toEqual([col])
    expect(api().collections[0]).toMatchObject({ name: 'Pets', vpnProfileId: 'vpn_1', viaServerId: null, insecureTls: false })
    expect(api().collectionsIn('ws_other')).toEqual([])
  })

  it('adds at an index, updates, renames and finds', () => {
    const col = seed()
    expect(ids(items(col))).toEqual([['fld_a', ['req_0', 'req_1', 'req_2']], 'req_3'])
    api().updateRequest(col, 'req_1', { ...req('ignored'), url: 'https://h/x' })
    expect(api().findRequest(col, 'req_1')).toMatchObject({ id: 'req_1', url: 'https://h/x' })
    api().renameItem(col, 'fld_a', 'Renamed')
    expect(items(col)[0].name).toBe('Renamed')
    expect(api().findRequest(col, 'fld_a')).toBeNull()
    api().updateCollection(col, { name: 'Pets 2', insecureTls: true })
    expect(api().collections[0]).toMatchObject({ name: 'Pets 2', insecureTls: true })
  })

  it('moves within and across collections, and refuses to move a folder into itself', () => {
    const col = seed()
    const other = api().createCollection('Other')
    api().moveItem(col, 'req_3', col, 'fld_a', 1)
    expect(ids(items(col))).toEqual([['fld_a', ['req_0', 'req_3', 'req_1', 'req_2']]])
    api().addItem(col, 'fld_a', folder('fld_b'))
    api().moveItem(col, 'fld_a', col, 'fld_b', 0)
    api().moveItem(col, 'fld_a', col, 'fld_a', 0)
    expect(ids(items(col))[0]).toEqual(['fld_a', ['req_0', 'req_3', 'req_1', 'req_2', ['fld_b', []]]])
    api().moveItem(col, 'req_0', other, null, 0)
    expect(ids(items(other))).toEqual(['req_0'])
  })

  it('duplicates with fresh ids beside the original', () => {
    const col = seed()
    const copy = api().duplicateItem(col, 'fld_a')!
    const dup = items(col)[1] as Folder
    expect(dup).toMatchObject({ id: copy, name: 'fld_a copy' })
    expect(dup.items.map((i) => i.id)).not.toContain('req_0')
    expect(dup.items).toHaveLength(3)
    expect(api().duplicateItem(col, 'missing')).toBeNull()
  })

  it('delete-undo restores the subtree at its original index', () => {
    const col = seed()
    const undo = api().deleteItem(col, 'req_1')
    expect(ids(items(col))).toEqual([['fld_a', ['req_0', 'req_2']], 'req_3'])
    undo()
    expect(ids(items(col))).toEqual([['fld_a', ['req_0', 'req_1', 'req_2']], 'req_3'])
    const undoFolder = api().deleteItem(col, 'fld_a')
    expect(ids(items(col))).toEqual(['req_3'])
    undoFolder()
    expect(ids(items(col))).toEqual([['fld_a', ['req_0', 'req_1', 'req_2']], 'req_3'])
    expect(api().deleteItem(col, 'missing')).toBeTypeOf('function')
  })

  it('replaces items on re-import and clears tlsReview', () => {
    const col = seed()
    api().updateCollection(col, { tlsReview: true })
    api().replaceItems(col, [req('req_new')])
    api().clearTlsReview(col)
    expect(api().collections[0]).toMatchObject({ items: [{ id: 'req_new' }], tlsReview: false })
    api().updateCollection(col, { tlsReview: true })
    api().acceptTlsReview(col)
    expect(api().collections[0].tlsReview).toBe(false)
  })

  it('the effective route is the collection’s for a saved request and the tab’s for scratch', () => {
    const col = seed()
    const tab = { id: 'tab_1', workspaceId: ws(), preview: false, split: 'normal' as const, kind: 'request' as const }
    expect(api().effectiveRoute({ ...tab, ref: { collectionId: col, requestId: 'req_1' } })).toEqual({ kind: 'server', serverId: 'srv_1' })
    expect(api().effectiveRoute({ ...tab, route: { kind: 'vpn', vpnProfileId: 'v' } })).toEqual({ kind: 'vpn', vpnProfileId: 'v' })
    expect(api().effectiveRoute(tab)).toEqual({ kind: 'direct' })
  })
})

describe('environments and globals', () => {
  const env = (id: string, name: string): Environment => ({ id, workspaceId: ws(), name, color: 'blue', production: false, variables: [{ id: 'var_1', key: 'k', value: 'v', enabled: true }] })

  it('sets, duplicates, activates per workspace, and clears the active one on delete', () => {
    api().setEnvironment(env('env_1', 'dev'))
    api().setEnvironment({ ...env('env_1', 'dev'), name: 'dev2' })
    expect(api().workspace.environments.map((e) => e.name)).toEqual(['dev2'])
    const copy = api().duplicateEnvironment('env_1')!
    expect(api().workspace.environments[1]).toMatchObject({ id: copy, name: 'dev2 copy' })
    expect(api().workspace.environments[1].variables[0].id).not.toBe('var_1')
    api().setActiveEnvironment(ws(), 'env_1')
    api().setActiveEnvironment('ws_other', copy)
    api().deleteEnvironment('env_1')
    expect(api().workspace.activeEnvironment[ws()]).toBeNull()
    expect(api().workspace.activeEnvironment['ws_other']).toBe(copy)
    expect(api().duplicateEnvironment('missing')).toBeNull()
  })

  it('builds the scope chain for a tab from globals, its collection and the active environment', () => {
    const col = seed()
    api().updateCollection(col, { variables: [{ id: 'var_c', key: 'c', value: '1', enabled: true }] })
    api().setGlobals(ws(), [{ id: 'var_g', key: 'g', value: '1', enabled: true }])
    api().setEnvironment(env('env_1', 'dev'))
    api().setActiveEnvironment(ws(), 'env_1')
    const chain = api().scopeChainFor({ id: 'tab_1', workspaceId: ws(), preview: false, split: 'normal', kind: 'request', ref: { collectionId: col } })
    expect(chain.layers.map((l) => l.scope)).toEqual(['global', 'collection', 'environment'])
    expect(Object.getPrototypeOf(api().workspace.globals)).toBeNull()
  })

  it('onWorkspaceDeleted removes that workspace’s collections, environments and globals only', () => {
    seed()
    api().setEnvironment(env('env_1', 'dev'))
    api().setEnvironment({ ...env('env_2', 'other'), workspaceId: 'ws_keep' })
    api().setGlobals(ws(), [])
    api().setGlobals('ws_keep', [])
    api().setActiveEnvironment(ws(), 'env_1')
    api().onWorkspaceDeleted(ws())
    expect(api().collections).toEqual([])
    expect(api().workspace.environments.map((e) => e.id)).toEqual(['env_2'])
    expect(Object.keys(api().workspace.globals)).toEqual(['ws_keep'])
    expect(Object.hasOwn(api().workspace.activeEnvironment, ws())).toBe(false)
  })
})

describe('recoverLegacy', () => {
  const legacy = {
    version: 1,
    apiCollections: [{ id: 'api-1', workspaceId: 'ws-default', name: 'Old', specUrl: null, specPath: null, baseUrl: 'http://127.0.0.1:1/api' }],
    apiWorkspace: { version: 1, meta: { 'x-scalar-environments': { dev: { variables: [] } } }, documents: {}, sourceKeys: {} }
  }

  it('brings back a missing collection as is, and a present one beside it, once', () => {
    useApi.setState({ legacy })
    expect(api().recoverLegacy()).toEqual(['api-1'])
    expect(api().collections.map((c) => c.name)).toEqual(['Old'])
    const [copy] = api().recoverLegacy()
    expect(api().collections.find((c) => c.id === copy)?.name).toBe('Old (recovered)')
    expect(api().recoverLegacy()).toEqual([])
    expect(api().collections).toHaveLength(2)
    expect(api().workspace.environments.map((e) => e.name)).toEqual(['dev'])
  })

  it('does nothing with no legacy blob', () => {
    expect(api().recoverLegacy()).toEqual([])
    expect(api().collections).toEqual([])
  })
})
