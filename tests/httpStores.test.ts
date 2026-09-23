// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { defaults } from '../src/shared/apiModel'
import { useApi } from '../src/renderer/src/store/api'
import { useHttp } from '../src/renderer/src/store/http'
import { useApp } from '../src/renderer/src/store/app'

// The minimal store implementations the t0 contract ships. Streams A and S own
// the full suites (apiStore.test.ts, httpTabs.test.ts); these pin the few
// behaviours other streams build on from day one.

const ws = (): string => useApp.getState().activeWorkspaceId

describe('store/http', () => {
  it('promotes the ghost with the same id on the first edit', () => {
    useHttp.getState().promoteGhost(ws())
    const ghost = useHttp.getState().ghost[ws()]
    useHttp.getState().updateDraft(ghost.id, { ...defaults.http(), url: 'https://example.test' })
    const s = useHttp.getState()
    expect(s.tabs.at(-1)).toMatchObject({ id: ghost.id, preview: false })
    expect(s.activeTab[ws()]).toBe(ghost.id)
    expect(s.ghost[ws()].id).not.toBe(ghost.id)
  })

  it('replaces the preview tab, focuses right then left on close, and reopens', () => {
    const { openRequest, openScratch, closeTab, reopenClosed } = useHttp.getState()
    const a = openScratch('http')
    openRequest({ collectionId: 'col_1', requestId: 'req_1' }, { preview: true })
    const b = openRequest({ collectionId: 'col_1', requestId: 'req_2' }, { preview: true })
    const c = openScratch('ws')
    expect(useHttp.getState().tabs.map((t) => t.id)).toEqual([a, b, c])

    useHttp.getState().setResponse(b, { status: 'idle' })
    useHttp.setState({ activeTab: { [ws()]: b } })
    closeTab(b)
    expect(useHttp.getState().activeTab[ws()]).toBe(c)
    expect(useHttp.getState().responses[b]).toBeUndefined()
    closeTab(c)
    expect(useHttp.getState().activeTab[ws()]).toBe(a)

    expect(reopenClosed()).toBe(c)
    expect(useHttp.getState().tabs.map((t) => t.id)).toEqual([a, c])
  })

  it('round-trips the session and drops invalid tabs on restore', () => {
    const id = useHttp.getState().openScratch('graphql')
    const session = useHttp.getState().getHttpSession()
    useHttp.getState().restoreHttpSession({
      ...session,
      tabs: [...session.tabs, { id: '__proto__', workspaceId: ws() }],
      activeTab: { ...session.activeTab, bad_ws: 'nope' }
    })
    const s = useHttp.getState()
    expect(s.tabs.map((t) => t.id)).toEqual([id])
    expect(s.activeTab[ws()]).toBe(id)
    expect(s.activeTab.bad_ws).toBeNull()
  })
})

describe('store/api', () => {
  it('deletes an item and the undo restores it at its index', () => {
    const colId = useApi.getState().createCollection('Pets')
    const [r1, r2, r3] = [defaults.http(), defaults.http(), defaults.http()]
    for (const r of [r1, r2, r3]) useApi.getState().addItem(colId, null, r)
    const undo = useApi.getState().deleteItem(colId, r2.id)
    const items = (): string[] => useApi.getState().collections[0].items.map((i) => i.id)
    expect(items()).toEqual([r1.id, r3.id])
    undo()
    expect(items()).toEqual([r1.id, r2.id, r3.id])
  })

  it('refuses to move a folder into itself', () => {
    const colId = useApi.getState().createCollection('Pets')
    useApi.getState().addItem(colId, null, { kind: 'folder', id: 'fld_a', name: 'a', items: [] })
    useApi.getState().moveItem(colId, 'fld_a', colId, 'fld_a', 0)
    expect(useApi.getState().collections[0].items.map((i) => i.id)).toEqual(['fld_a'])
  })
})
