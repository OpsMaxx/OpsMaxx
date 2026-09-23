// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { useRef, useState } from 'react'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaults, type ApiCollectionV2, type HttpRequest, type Id } from '../src/shared/apiModel'
import { useApi } from '../src/renderer/src/store/api'
import { useApp } from '../src/renderer/src/store/app'
import { useHttp } from '../src/renderer/src/store/http'
import { useToasts } from '../src/renderer/src/store/toast'
import { stubBridge } from './setup/renderer'
import { CollectionTree } from '../src/renderer/src/components/http/sidebar/CollectionTree'
import { collectionMenu, folderMenu, requestMenu, type TreeActions } from '../src/renderer/src/components/http/sidebar/treeMenus'

const req = (id: string, name: string, method = 'GET'): HttpRequest => ({ ...defaults.http(), id, name, method, url: `https://api.example/${id}` })

function seed(): void {
  const ws = useApp.getState().activeWorkspaceId
  const c: ApiCollectionV2 = {
    ...defaults.collection(ws, 'httpbin'),
    id: 'col_a',
    items: [
      req('req_get', 'Get user'),
      { kind: 'folder', id: 'fld_admin', name: 'admin', items: [req('req_del', 'Remove user', 'DELETE')] },
      req('req_login', 'Login', 'POST')
    ]
  }
  const d: ApiCollectionV2 = { ...defaults.collection(ws, 'countries'), id: 'col_b', items: [] }
  useApi.setState({ collections: [c, d] })
  useHttp.setState({ expanded: ['col_a'] })
}

function Harness({ query = '' }: { query?: string }): React.JSX.Element {
  const [renaming, setRenaming] = useState<Id | null>(null)
  const undo = useRef<(() => void)[]>([])
  return (
    <CollectionTree query={query} renaming={renaming} setRenaming={setRenaming} undo={undo} onNewCollection={() => {}} onImport={() => {}} />
  )
}

const item = (name: RegExp | string): HTMLElement => screen.getByRole('treeitem', { name: typeof name === 'string' ? new RegExp(name) : name })
const names = (): string[] => screen.getAllByRole('treeitem').map((t) => t.querySelector('.hc-tree-name')?.textContent ?? '')
const items = (colId = 'col_a'): string[] =>
  useApi.getState().collections.find((c) => c.id === colId)!.items.map((i) => i.name)
const labels = (entries: { label: string; separator?: boolean }[]): string[] => entries.map((e) => (e.separator ? '—' : e.label))

describe('CollectionTree', () => {
  it('is a tree of treeitems with levels and aria-expanded', () => {
    seed()
    render(<Harness />)
    expect(screen.getByRole('tree', { name: 'Collections' })).toBeTruthy()
    expect(names()).toEqual(['httpbin', 'Get user', 'admin', 'Login', 'countries'])
    expect(item('httpbin').getAttribute('aria-expanded')).toBe('true')
    expect(item('admin').getAttribute('aria-expanded')).toBe('false')
    expect(item('Get user').getAttribute('aria-expanded')).toBeNull()
    expect(item('Get user').getAttribute('aria-level')).toBe('2')
    expect(item('httpbin').tabIndex).toBe(0)
    expect(item('Get user').tabIndex).toBe(-1)
  })

  it('moves with the arrows and opens and closes containers', async () => {
    seed()
    render(<Harness />)
    item('httpbin').focus()
    await userEvent.keyboard('{ArrowDown}{ArrowDown}')
    expect(document.activeElement).toBe(item('admin'))
    await userEvent.keyboard('{ArrowRight}')
    expect(names()).toContain('Remove user')
    await userEvent.keyboard('{ArrowRight}')
    expect(document.activeElement).toBe(item('Remove user'))
    await userEvent.keyboard('{ArrowLeft}')
    expect(document.activeElement).toBe(item('admin'))
    await userEvent.keyboard('{ArrowLeft}')
    expect(names()).not.toContain('Remove user')
    await userEvent.keyboard('{End}')
    expect(document.activeElement).toBe(item('countries'))
    await userEvent.keyboard('{Home}')
    expect(document.activeElement).toBe(item('httpbin'))
  })

  it('opens a preview tab on Enter and a pinned one on Mod+Enter', async () => {
    seed()
    render(<Harness />)
    item('Get user').focus()
    await userEvent.keyboard('{Enter}')
    expect(useHttp.getState().tabs.map((t) => [t.ref?.requestId, t.preview])).toEqual([['req_get', true]])
    await userEvent.keyboard('{Control>}{Enter}{/Control}')
    expect(useHttp.getState().tabs.map((t) => [t.ref?.requestId, t.preview])).toEqual([['req_get', false]])
  })

  it('deletes with Mod+Backspace and Delete, never plain Backspace, and Mod+Z undoes', async () => {
    seed()
    render(<Harness />)
    item('Get user').focus()
    await userEvent.keyboard('{Backspace}')
    expect(items()).toEqual(['Get user', 'admin', 'Login'])
    await userEvent.keyboard('{Control>}{Backspace}{/Control}')
    expect(items()).toEqual(['admin', 'Login'])
    expect(document.activeElement).toBe(item('admin'))
    await userEvent.keyboard('{Delete}')
    expect(items()).toEqual(['Login'])
    await userEvent.keyboard('{Control>}z{/Control}')
    expect(items()).toEqual(['admin', 'Login'])
    await userEvent.keyboard('{Control>}z{/Control}')
    expect(items()).toEqual(['Get user', 'admin', 'Login'])
  })

  it('gives each delete its own toast, whose Undo does not undo twice', async () => {
    seed()
    render(<Harness />)
    item('Get user').focus()
    await userEvent.keyboard('{Delete}')
    await userEvent.keyboard('{Delete}')
    const toasts = useToasts.getState().toasts
    expect(toasts.map((t) => t.key)).toEqual(['http-tree-delete-req_get', 'http-tree-delete-fld_admin'])
    act(() => toasts[0].action!.run())
    act(() => toasts[0].action!.run())
    expect(items()).toEqual(['Get user', 'Login'])
  })

  it('asks before deleting a collection, then offers undo', async () => {
    seed()
    render(<Harness />)
    item('httpbin').focus()
    await userEvent.keyboard('{Delete}')
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText(/Its 3 requests/)).toBeTruthy()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete collection' }))
    expect(useApi.getState().collections.map((c) => c.id)).toEqual(['col_b'])
    act(() => useToasts.getState().toasts.at(-1)!.action!.run())
    expect(useApi.getState().collections.map((c) => c.id)).toEqual(['col_a', 'col_b'])
  })

  it('moves a request to another collection with Move to…', async () => {
    seed()
    render(<Harness />)
    fireEvent.contextMenu(item('Login'))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Move to…' }))
    await userEvent.click(screen.getByLabelText('countries'))
    await userEvent.click(screen.getByRole('button', { name: 'Move' }))
    expect(items('col_a')).toEqual(['Get user', 'admin'])
    expect(items('col_b')).toEqual(['Login'])
  })

  it('renames inline with F2', async () => {
    seed()
    render(<Harness />)
    item('Login').focus()
    await userEvent.keyboard('{F2}')
    const input = screen.getByLabelText('Rename Login')
    await userEvent.clear(input)
    await userEvent.type(input, 'Sign in{Enter}')
    expect(items()).toContain('Sign in')
    expect(document.activeElement).toBe(item('Sign in'))
  })

  it('duplicates with Mod+D', async () => {
    seed()
    render(<Harness />)
    item('Login').focus()
    await userEvent.keyboard('{Control>}d{/Control}')
    expect(items()).toEqual(['Get user', 'admin', 'Login', 'Login copy'])
  })

  it('filters by name and URL, opening folders with a match', () => {
    seed()
    render(<Harness query="req_del" />)
    expect(names()).toEqual(['httpbin', 'admin', 'Remove user'])
  })
})

describe('tree menus (§2.6)', () => {
  const a = new Proxy({}, { get: () => vi.fn() }) as unknown as TreeActions
  const c = { ...defaults.collection('ws_1', 'x'), id: 'col_x' }

  it('collection row', () => {
    expect(labels(collectionMenu(c, a))).toEqual([
      'New HTTP request', 'New WebSocket', 'New GraphQL request', 'New folder', '—',
      'Open collection settings', 'Rename', 'Duplicate', '—', 'Delete collection…'
    ])
    expect(labels(collectionMenu({ ...c, importedFrom: { kind: 'openapi', url: 'u', at: 't' } }, a))).toContain('Re-import from OpenAPI…')
  })

  it('folder row', () => {
    expect(labels(folderMenu('col_x', 'fld_x', a))).toEqual([
      'New HTTP request', 'New WebSocket', 'New GraphQL request', 'New folder', '—', 'Rename', 'Duplicate', '—', 'Delete folder'
    ])
  })

  it('request row, with cURL disabled for WebSocket', () => {
    const r = req('req_x', 'x')
    expect(labels(requestMenu('col_x', r, a))).toEqual([
      'Open', 'Open in new tab', '—', 'Rename', 'Duplicate', 'Move to…', '—', 'Copy as cURL', 'Copy URL', '—', 'Delete'
    ])
    const ws = requestMenu('col_x', { ...defaults.ws(), id: 'req_w' }, a)
    expect(ws.find((e) => e.label === 'Copy as cURL')?.disabled).toBe(true)
    expect(requestMenu('col_x', r, a).find((e) => e.label === 'Rename')?.shortcut).toBe('F2')
  })
})

describe('Copy as cURL from a tree row', () => {
  it('asks for redirects only when the request follows them', async () => {
    const curl = await import('../src/shared/curl')
    const spy = vi.spyOn(curl, 'toCurl')
    const { copyAsCurl } = await import('../src/renderer/src/components/http/sidebar/treeMenus')
    copyAsCurl({ ...req('r1', 'a'), settings: { followRedirects: false, maxRedirects: 5 } })
    copyAsCurl({ ...req('r2', 'b'), settings: { followRedirects: true, maxRedirects: 3 } })
    expect(spy.mock.calls.map((c) => (c[1] as { maxRedirects: number }).maxRedirects)).toEqual([0, 3])
    expect(spy.mock.results.map((r) => (r.value as { text: string }).text.includes('-L'))).toEqual([false, true])
  })
})

describe('final wiring (M5, m8)', () => {
  it('moves an open request and its tab follows', async () => {
    seed()
    useHttp.getState().setExpanded('fld_admin', true)
    const tabId = useHttp.getState().openRequest({ collectionId: 'col_a', requestId: 'req_del' }, { preview: false })
    render(<Harness />)
    fireEvent.contextMenu(item('Remove user'))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Move to…' }))
    await userEvent.click(screen.getByLabelText('countries'))
    await userEvent.click(screen.getByRole('button', { name: 'Move' }))
    expect(useHttp.getState().tabs.find((t) => t.id === tabId)?.ref).toEqual({ collectionId: 'col_b', requestId: 'req_del' })
  })

  it('copies a closed request with its collection’s route and certificate settings', async () => {
    seed()
    const curl = await import('../src/shared/curl')
    const spy = vi.spyOn(curl, 'toCurl')
    stubBridge({ clipboard: { write: vi.fn() } })
    useApp.setState({ servers: [{ id: 'srv_1', name: 'web-01', workspaceId: useApp.getState().activeWorkspaceId, tags: [] }] } as never)
    useApi.getState().updateCollection('col_a', { insecureTls: true, viaServerId: 'srv_1' })
    const { copyAsCurl } = await import('../src/renderer/src/components/http/sidebar/treeMenus')
    await copyAsCurl(req('req_get', 'Get user'), { collectionId: 'col_a' })
    const sent = spy.mock.lastCall![1] as { tls: string; route: { key: string; label: string } }
    expect([sent.tls, sent.route]).toEqual(['unverified', { key: 'server:srv_1', label: 'web-01' }])
    expect((spy.mock.results.at(-1)!.value as { text: string }).text).toContain('-k')
  })

  it('copies an open request through the send layer, so inherited auth is in it', async () => {
    seed()
    const write = vi.fn()
    stubBridge({ clipboard: { write } })
    useApi.getState().updateCollection('col_a', { auth: { type: 'bearer', token: 'literal-secret' } })
    const r = { ...req('req_get', 'Get user'), auth: { type: 'inherit' as const } }
    useApi.getState().updateRequest('col_a', 'req_get', r)
    useHttp.getState().openRequest({ collectionId: 'col_a', requestId: 'req_get' }, { preview: false })
    const { copyAsCurl } = await import('../src/renderer/src/components/http/sidebar/treeMenus')
    await copyAsCurl(r, { collectionId: 'col_a' })
    const text = write.mock.lastCall![0] as string
    expect(text).toMatch(/Authorization/i)
    expect(text).not.toContain('literal-secret')
  })
})

describe('duplicating a collection (N3)', () => {
  it('carries a pending certificate review over to the copy', async () => {
    seed()
    useApi.getState().updateCollection('col_a', { insecureTls: true, tlsReview: true })
    const { duplicateCollection } = await import('../src/renderer/src/components/http/sidebar/CollectionTree')
    const id = duplicateCollection('col_a')!
    const copy = useApi.getState().collections.find((c) => c.id === id)!
    expect([copy.insecureTls, copy.tlsReview]).toEqual([true, true])
    useApi.getState().updateCollection('col_b', { tlsReview: false })
    const plainId = duplicateCollection('col_b')
    const plain = useApi.getState().collections.find((c) => c.id === plainId)!
    expect(plain.tlsReview).toBeFalsy()
  })
})
