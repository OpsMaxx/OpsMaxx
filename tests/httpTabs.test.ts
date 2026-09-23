import { beforeEach, describe, expect, it } from 'vitest'
import { defaults, type ApiRequest, type HttpRequest, type ResponseState } from '../src/shared/apiModel'
import { isErrorResult, resetHttpForTests, useHttp } from '../src/renderer/src/store/http'
import { useApi } from '../src/renderer/src/store/api'
import { useApp } from '../src/renderer/src/store/app'
import { useWsSessions } from '../src/renderer/src/store/wsSessions'
import { useToasts } from '../src/renderer/src/store/toast'
import { planClose } from '../src/renderer/src/components/http/tabs/closing'
import { badgeFor, tabTitle } from '../src/renderer/src/components/http/tabs/tabMenus'

// store/http, the request-tab strip's rules (§2.9, §2.10, §2.4).

const httpInitial = useHttp.getState()
const apiInitial = useApi.getState()
const WS = useApp.getState().activeWorkspaceId

beforeEach(() => {
  resetHttpForTests()
  useHttp.setState(httpInitial, true)
  useApi.setState(apiInitial, true)
  useWsSessions.setState({ sessions: {} })
  useApp.setState({ activeWorkspaceId: WS })
})

const s = (): ReturnType<typeof useHttp.getState> => useHttp.getState()
const ids = (): string[] => s().tabs.map((t) => t.id)
const active = (): string | null => s().activeTab[WS] ?? null

/** A collection with `n` saved GET requests; returns their ids. */
function collection(n: number): { col: string; reqs: string[] } {
  const col = useApi.getState().createCollection('httpbin')
  const reqs = Array.from({ length: n }, (_, i) => {
    const req: HttpRequest = { ...defaults.http(), name: `r${i}`, url: `https://example.test/${i}` }
    useApi.getState().addItem(col, null, req)
    return req.id
  })
  return { col, reqs }
}

describe('preview tabs', () => {
  it('a preview is replaced by the next preview, in place', () => {
    const { col, reqs } = collection(3)
    const scratch = s().openScratch('http')
    const a = s().openRequest({ collectionId: col, requestId: reqs[0] }, { preview: true })
    const b = s().openRequest({ collectionId: col, requestId: reqs[1] }, { preview: true })
    expect(ids()).toEqual([scratch, b])
    expect(s().tabs[1].preview).toBe(true)
    expect(ids()).not.toContain(a)
    expect(active()).toBe(b)
  })

  it('opening a preview for good pins it, and editing pins it', () => {
    const { col, reqs } = collection(2)
    const a = s().openRequest({ collectionId: col, requestId: reqs[0] }, { preview: true })
    expect(s().openRequest({ collectionId: col, requestId: reqs[0] })).toBe(a)
    expect(s().tabs[0].preview).toBe(false)

    const b = s().openRequest({ collectionId: col, requestId: reqs[1] }, { preview: true })
    s().updateDraft(b, { ...(s().requestFor(b) as ApiRequest), name: 'edited' })
    expect(s().tabs.find((t) => t.id === b)?.preview).toBe(false)
  })

  it('one tab per saved request: opening it again focuses the existing tab', () => {
    const { col, reqs } = collection(2)
    const a = s().openRequest({ collectionId: col, requestId: reqs[0] })
    s().openRequest({ collectionId: col, requestId: reqs[1] })
    expect(s().openRequest({ collectionId: col, requestId: reqs[0] })).toBe(a)
    expect(ids()).toHaveLength(2)
    expect(active()).toBe(a)
  })
})

describe('the ghost tab', () => {
  it('promotes into the strip with the same id and seeds a fresh ghost', () => {
    const ghost = s().ensureGhost(WS)
    expect(ids()).toEqual([])
    s().updateDraft(ghost.id, { ...(ghost.draft as HttpRequest), url: 'https://example.test' })
    expect(ids()).toEqual([ghost.id])
    expect(active()).toBe(ghost.id)
    expect((s().tabs[0].draft as HttpRequest).url).toBe('https://example.test')
    expect(s().ghost[WS].id).not.toBe(ghost.id)
  })

  it('keeps a route chosen before the first keystroke', () => {
    const ghost = s().ensureGhost(WS)
    s().setRoute(ghost.id, { kind: 'server', serverId: 'srv1' })
    const id = s().promoteGhost(WS)
    expect(id).toBe(ghost.id)
    expect(s().tabs[0].route).toEqual({ kind: 'server', serverId: 'srv1' })
  })
})

describe('closing', () => {
  it('a scratch close does not prompt, and the tab goes onto the reopen stack', () => {
    const a = s().openScratch('http')
    s().updateDraft(a, { ...(s().requestFor(a) as HttpRequest), url: 'https://example.test/x' })
    expect(planClose([a]).prompt).toBeNull()
    s().closeTab(a)
    expect(ids()).toEqual([])
    expect(s().closedStack.at(-1)?.tab.id).toBe(a)
  })

  it('a saved tab with edits prompts, and a clean one does not', () => {
    const { col, reqs } = collection(1)
    const a = s().openRequest({ collectionId: col, requestId: reqs[0] })
    expect(planClose([a]).prompt).toBeNull()
    s().updateDraft(a, { ...(s().requestFor(a) as HttpRequest), url: 'https://example.test/changed' })
    expect(s().isDirty(a)).toBe(true)
    expect(planClose([a])).toMatchObject({ dirty: [a], prompt: 'Save changes to “r0”?' })
    // Editing it back is clean again.
    s().updateDraft(a, useApi.getState().findRequest(col, reqs[0])!)
    expect(s().isDirty(a)).toBe(false)
  })

  it('a multi-close asks once for every dirty tab', () => {
    const { col, reqs } = collection(3)
    const tabs = reqs.map((r) => s().openRequest({ collectionId: col, requestId: r }))
    for (const t of tabs) s().updateDraft(t, { ...(s().requestFor(t) as HttpRequest), method: 'POST' })
    const scratch = s().openScratch('http')
    const plan = planClose([...tabs, scratch])
    expect(plan.dirty).toEqual(tabs)
    expect(plan.prompt).toBe('3 tabs have unsaved changes')
  })

  it('a connected WebSocket asks to disconnect', () => {
    const t = s().openScratch('ws')
    useWsSessions.setState({
      sessions: {
        [t]: { state: 'open', version: 0, stats: { sent: 0, received: 0, bytesIn: 0, bytesOut: 0, dropped: 0 } }
      }
    })
    expect(planClose([t]).prompt).toBe('Disconnect and close?')
  })

  it('the successor is the right neighbour, then the left', () => {
    const [a, b, c] = [s().openScratch('http'), s().openScratch('http'), s().openScratch('http')]
    s().activateTab(b)
    s().closeTab(b)
    expect(active()).toBe(c)
    s().closeTab(c)
    expect(active()).toBe(a)
    s().closeTab(a)
    expect(active()).toBeNull()
  })

  it('closing an inactive tab keeps the selection', () => {
    const [a, b] = [s().openScratch('http'), s().openScratch('http')]
    s().closeTab(a)
    expect(active()).toBe(b)
  })

  it('drops the closed tab’s response', () => {
    const a = s().openScratch('http')
    s().setResponse(a, { status: 'sending', startedAt: 1, requestId: 'r' })
    s().closeTab(a)
    expect(s().responses[a]).toBeUndefined()
  })
})

describe('reopen and reorder', () => {
  it('reopens the last closed tab at its index', () => {
    const [a, b, c] = [s().openScratch('http'), s().openScratch('http'), s().openScratch('http')]
    s().closeTab(b)
    expect(s().reopenClosed()).toBe(b)
    expect(ids()).toEqual([a, b, c])
    expect(active()).toBe(b)
    expect(s().reopenClosed()).toBeNull()
  })

  it('reopening a saved request that is open again focuses it instead', () => {
    const { col, reqs } = collection(1)
    const a = s().openRequest({ collectionId: col, requestId: reqs[0] })
    s().closeTab(a)
    const again = s().openRequest({ collectionId: col, requestId: reqs[0] })
    expect(s().reopenClosed()).toBe(again)
    expect(ids()).toEqual([again])
  })

  it('reorders within the workspace strip and leaves other workspaces alone', () => {
    const [a, b, c] = [s().openScratch('http'), s().openScratch('http'), s().openScratch('http')]
    useApp.setState({ activeWorkspaceId: 'ws-other' })
    const other = s().openScratch('http')
    useApp.setState({ activeWorkspaceId: WS })
    s().reorder(a, 2)
    expect(ids()).toEqual([b, c, a, other])
    s().reorder(a, 0)
    expect(ids()).toEqual([a, b, c, other])
  })

  it('duplicates a tab as an unsaved copy beside it', () => {
    const { col, reqs } = collection(1)
    const a = s().openRequest({ collectionId: col, requestId: reqs[0] })
    const copy = s().duplicateTab(a)!
    expect(ids()).toEqual([a, copy])
    const tab = s().tabs[1]
    expect(tab.ref).toBeUndefined()
    expect((tab.draft as HttpRequest).url).toBe('https://example.test/0')
    expect(tab.route).toEqual({ kind: 'direct' })
  })
})

describe('split state', () => {
  it('is per tab, and a new tab takes the last one chosen', () => {
    const a = s().openScratch('http')
    const b = s().openScratch('http')
    s().setSplit(a, 'response-collapsed')
    expect(s().tabs.find((t) => t.id === b)?.split).toBe('normal')
    const c = s().openScratch('http')
    expect(s().tabs.find((t) => t.id === c)?.split).toBe('response-collapsed')
  })

  const done = (status: number): ResponseState => ({
    status: 'done',
    at: 1,
    response: {
      ok: true,
      status,
      statusText: '',
      headers: {},
      body: new ArrayBuffer(0),
      durationMs: 1,
      truncated: false
    },
    sentAs: {
      method: 'GET',
      url: 'https://example.test',
      headers: [],
      route: { key: 'direct', label: 'This machine' },
      tls: 'verified',
      maxRedirects: 5,
      timeoutMs: 30000,
      bodyBytes: 0
    }
  })

  it('an error expands a collapsed response; a success leaves it collapsed', () => {
    const a = s().openScratch('http')
    s().setSplit(a, 'response-collapsed')
    s().setResponse(a, done(200))
    expect(s().tabs[0].split).toBe('response-collapsed')
    s().setResponse(a, done(404))
    expect(s().tabs[0].split).toBe('normal')
    s().setSplit(a, 'response-collapsed')
    s().setResponse(a, { status: 'error', errorClass: 'refused', message: 'Connection refused' })
    expect(s().tabs[0].split).toBe('normal')
  })

  it('cancelling or declining the production confirm is not an error to show', () => {
    expect(isErrorResult({ status: 'error', errorClass: 'aborted', message: '' })).toBe(false)
    expect(isErrorResult({ status: 'error', errorClass: 'prod-declined', message: '' })).toBe(false)
    expect(isErrorResult({ status: 'error', errorClass: 'tls', message: '' })).toBe(true)
  })
})

describe('saving', () => {
  it('saves a saved request in place and becomes clean', () => {
    const { col, reqs } = collection(1)
    const a = s().openRequest({ collectionId: col, requestId: reqs[0] })
    s().updateDraft(a, { ...(s().requestFor(a) as HttpRequest), method: 'DELETE' })
    expect(s().saveInPlace(a)).toBe(true)
    expect((useApi.getState().findRequest(col, reqs[0]) as HttpRequest).method).toBe('DELETE')
    expect(s().isDirty(a)).toBe(false)
  })

  it('a history re-run carries its route and the fields that arrived masked', () => {
    const a = s().openScratch('http', undefined, {
      route: { kind: 'server', serverId: 'srv1' },
      strippedFields: ['headers.row_1.value']
    })
    expect(s().tabs.find((t) => t.id === a)).toMatchObject({
      route: { kind: 'server', serverId: 'srv1' },
      strippedFields: ['headers.row_1.value']
    })
    expect(s().tabs.find((t) => t.id === s().openScratch('http'))?.strippedFields).toBeUndefined()
  })

  it('a scratch tab needs the Save dialog, then becomes the saved request', () => {
    const a = s().openScratch('http', undefined, { route: { kind: 'server', serverId: 'srv1' } })
    expect(s().saveInPlace(a)).toBe(false)
    const { col, reqs } = collection(1)
    s().attachRef(a, { collectionId: col, requestId: reqs[0] })
    expect(s().tabs[0]).toMatchObject({ ref: { collectionId: col, requestId: reqs[0] } })
    expect(s().tabs[0].draft).toBeUndefined()
    expect(s().tabs[0].route).toBeUndefined()
  })
})

describe('session restore', () => {
  it('round-trips tabs, the active tab, splits, prefs and strippedFields', () => {
    const { col, reqs } = collection(1)
    const a = s().openRequest({ collectionId: col, requestId: reqs[0] })
    const b = s().openScratch('graphql')
    s().setSplit(b, 'request-collapsed')
    s().setPrefs({ orientation: 'vertical', wrap: false })
    useHttp.setState({ tabs: s().tabs.map((t) => (t.id === a ? { ...t, strippedFields: ['auth.token'] } : t)) })
    const saved = JSON.parse(JSON.stringify(s().getHttpSession()))

    useHttp.setState(httpInitial, true)
    s().restoreHttpSession(saved)
    expect(ids()).toEqual([a, b])
    expect(active()).toBe(b)
    expect(s().tabs[0].strippedFields).toEqual(['auth.token'])
    expect(s().tabs[1].split).toBe('request-collapsed')
    expect(s().prefs).toMatchObject({ orientation: 'vertical', wrap: false, lastSplit: 'request-collapsed' })
  })

  it('refuses what it cannot render, and never trusts a field’s type', () => {
    s().restoreHttpSession({
      version: 1,
      tabs: [
        { id: 'tab_ok', workspaceId: WS, preview: 'yes', split: 'sideways', kind: 'request', draft: defaults.http() },
        { id: 'tab_empty', workspaceId: WS, kind: 'request' },
        { id: '__proto__', workspaceId: WS, kind: 'environments' },
        { id: 'tab_env', workspaceId: WS, kind: 'environments', strippedFields: ['a', 3] }
      ],
      activeTab: { [WS]: 'tab_empty' },
      prefs: { lastSplit: 'bogus' }
    })
    expect(ids()).toEqual(['tab_ok', 'tab_env'])
    expect(s().tabs[0]).toMatchObject({ preview: false, split: 'normal' })
    expect(s().tabs[1].strippedFields).toEqual(['a'])
    expect(active()).toBeNull()
    expect(s().prefs.lastSplit).toBe('normal')
  })

  it('ignores anything that is not a v1 session', () => {
    s().openScratch('http')
    s().restoreHttpSession({ version: 2, tabs: [] })
    s().restoreHttpSession(null)
    expect(ids()).toHaveLength(1)
  })
})

describe('sidebar and overlay state', () => {
  it('opens Import, optionally as a re-import', () => {
    s().openImport()
    expect(s()).toMatchObject({ overlay: 'import', importTarget: null })
    s().openImport('col_a')
    expect(s()).toMatchObject({ overlay: 'import', importTarget: 'col_a' })
  })

  it('expands and collapses tree nodes without duplicates, and switches the sidebar tab', () => {
    s().setExpanded('col_a', true)
    s().setExpanded('col_a', true)
    s().setExpanded('fld_b', true)
    expect(s().expanded).toEqual(['col_a', 'fld_b'])
    s().setExpanded('col_a', false)
    expect(s().expanded).toEqual(['fld_b'])
    s().setSidebarTab('history')
    expect(s().getHttpSession().sidebarTab).toBe('history')
  })
})

describe('workspace deletion', () => {
  it('takes the workspace’s tabs, ghost, responses and reopen history with it', () => {
    const mine = s().openScratch('http')
    s().ensureGhost(WS)
    useApp.setState({ activeWorkspaceId: 'ws-gone' })
    const doomed = s().openScratch('http')
    s().setResponse(doomed, { status: 'sending', startedAt: 1, requestId: 'r' })
    s().ensureGhost('ws-gone')
    const closed = s().openScratch('http')
    s().closeTab(closed)
    s().onWorkspaceDeleted('ws-gone')
    expect(ids()).toEqual([mine])
    expect(s().activeTab['ws-gone']).toBeUndefined()
    expect(s().ghost['ws-gone']).toBeUndefined()
    expect(s().ghost[WS]).toBeDefined()
    expect(s().responses[doomed]).toBeUndefined()
    expect(s().closedStack).toEqual([])
  })
})

describe('tab titles', () => {
  it('a scratch tab is its method badge beside its last path segment, never the method twice', () => {
    const req: HttpRequest = { ...defaults.http(), method: 'POST', url: 'http://127.0.0.1:9346/users/42?x=1' }
    const tab = {
      id: 'tab_a',
      workspaceId: WS,
      preview: false,
      split: 'normal' as const,
      kind: 'request' as const,
      draft: req
    }
    expect(badgeFor(req)?.text).toBe('POST')
    expect(tabTitle(tab, req)).toBe('/42')
    expect(tabTitle(tab, { ...req, url: '' })).toBe('New request')
    expect(tabTitle({ ...tab, ref: { collectionId: 'c', requestId: 'r' } }, { ...req, name: 'Login' })).toBe('Login')
  })
})

describe('finalwire fixes', () => {
  it('saving a tab whose request was deleted keeps the draft and asks for the Save dialog', () => {
    const { col, reqs } = collection(1)
    const a = s().openRequest({ collectionId: col, requestId: reqs[0] })
    s().updateDraft(a, { ...(s().requestFor(a) as HttpRequest), method: 'PATCH' })
    useApi.getState().deleteItem(col, reqs[0])
    expect(s().saveInPlace(a)).toBe(false)
    expect((s().tabs[0].draft as HttpRequest).method).toBe('PATCH')
  })

  it('deleting a workspace releases its tabs’ WebSocket sessions', () => {
    useApp.setState({ activeWorkspaceId: 'ws-gone' })
    const doomed = s().openScratch('ws')
    useApp.setState({ activeWorkspaceId: WS })
    const kept = s().openScratch('ws')
    const session = {
      state: 'idle' as const,
      version: 0,
      stats: { sent: 0, received: 0, bytesIn: 0, bytesOut: 0, dropped: 0 }
    }
    useWsSessions.setState({ sessions: { [doomed]: session, [kept]: session } })
    s().onWorkspaceDeleted('ws-gone')
    expect(ids()).toEqual([kept])
    // wsSessions' own subscription to the tab list is what forgets it.
    expect(Object.keys(useWsSessions.getState().sessions)).toEqual([kept])
  })

  it('refuses to duplicate a request whose collection holds a change for review, and offers the review', () => {
    const { col, reqs } = collection(1)
    useApi.getState().updateCollection(col, { viaServerId: 'srv1', tlsReview: true })
    const a = s().openRequest({ collectionId: col, requestId: reqs[0] })
    expect(s().duplicateTab(a)).toBeNull()
    expect(ids()).toEqual([a])
    const t = useToasts.getState().toasts.at(-1)!
    expect(t.message).toBe('Review this collection’s changes first.')
    t.action!.run()
    const colTab = s().tabs.find((x) => x.kind === 'collection')!
    expect(s().collectionSection[colTab.id]).toBe('connection')
    // Accepted: the copy is made, with the collection's route.
    useApi.getState().acceptTlsReview(col)
    const copied = s().duplicateTab(a)
    expect(s().tabs.find((x) => x.id === copied)?.route).toEqual({ kind: 'server', serverId: 'srv1' })
  })

  it('a dirty tab with a live socket asks to save and says it will disconnect', () => {
    const { col, reqs } = collection(2)
    const tabs = reqs.map((r) => s().openRequest({ collectionId: col, requestId: r }))
    for (const t of tabs) s().updateDraft(t, { ...(s().requestFor(t) as HttpRequest), method: 'PUT' })
    const open = {
      state: 'open' as const,
      version: 0,
      stats: { sent: 0, received: 0, bytesIn: 0, bytesOut: 0, dropped: 0 }
    }
    useWsSessions.setState({ sessions: { [tabs[0]]: open } })
    expect(planClose([tabs[0]]).prompt).toBe('Save changes to “r0” and disconnect?')
    expect(planClose(tabs).prompt).toBe('2 tabs have unsaved changes, and a WebSocket will disconnect')
  })
})
