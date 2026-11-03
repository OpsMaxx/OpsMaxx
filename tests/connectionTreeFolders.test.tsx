// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { stubBridge } from './setup/renderer'
import { ConnectionTree } from '../src/renderer/src/components/connections/ConnectionTree'
import { AddServerModal } from '../src/renderer/src/components/connections/AddServerModal'
import { useApp } from '../src/renderer/src/store/app'

/**
 * Adding a connection from inside a folder, and folding Recent.
 *
 * The only add control in the tree was the folder-plus on the Connections
 * header, so a server meant for "Contabo Servers" was saved at the top level
 * and dragged in afterwards.
 */

const base = {
  port: 22,
  username: 'root',
  auth: 'key',
  status: 'offline',
  favorite: false,
  os: 'Linux',
  route: [],
  vpnProfileId: null,
  tags: []
}

function seed(): void {
  const ws = useApp.getState().activeId()
  useApp.setState((s) => ({
    modal: null,
    newServerFolderId: null,
    recentServerIds: ['srv-a'],
    settings: { ...s.settings, recentCollapsed: undefined },
    folders: [
      { id: 'f-prod', workspaceId: ws, name: 'Production', parentId: null, kind: 'server' },
      { id: 'f-eu', workspaceId: ws, name: 'EU', parentId: 'f-prod', kind: 'server' }
    ],
    servers: [{ ...base, id: 'srv-a', workspaceId: ws, folderId: 'f-prod', name: 'api', host: '10.0.0.1' }]
  }) as never)
}

beforeEach(() => {
  stubBridge({
    ssh: { defaultKeys: () => Promise.resolve([]) },
    secrets: { set: () => Promise.resolve(true), get: () => Promise.resolve(null), delete: () => Promise.resolve() }
  })
  seed()
})

const folderRow = (name: string): HTMLElement =>
  screen.getAllByRole('treeitem').find((r) => r.dataset.folder && r.textContent?.includes(name))!

describe('adding a connection inside a folder', () => {
  it('opens the editor with that folder chosen, from the row and without folding it', async () => {
    const u = userEvent.setup()
    render(<ConnectionTree />)
    const prod = folderRow('Production')
    await u.click(within(prod).getByTitle('Add connection here'))
    expect(useApp.getState().modal).toBe('add-server')
    expect(useApp.getState().newServerFolderId).toBe('f-prod')
    expect(prod.getAttribute('aria-expanded')).toBe('true')

    // A subfolder has its own.
    await u.click(within(folderRow('EU')).getByTitle('Add connection here'))
    expect(useApp.getState().newServerFolderId).toBe('f-eu')
  })

  it('is in the folder menu too, for the keyboard', async () => {
    const u = userEvent.setup()
    render(<ConnectionTree />)
    folderRow('Production').focus()
    await u.keyboard('{Shift>}{F10}{/Shift}')
    await u.click(screen.getByText('Add connection here'))
    expect(useApp.getState().newServerFolderId).toBe('f-prod')
  })

  it('saves the new server into that folder', async () => {
    const u = userEvent.setup()
    useApp.getState().openAddServer('f-eu')
    render(<AddServerModal />)
    expect((screen.getByLabelText('Folder') as HTMLSelectElement).value).toBe('f-eu')
    await u.type(screen.getByPlaceholderText('Production API'), 'web')
    await u.type(screen.getByPlaceholderText('10.20.0.10'), '10.0.0.5')
    await u.click(screen.getByText('SSH Agent'))
    const buttons = document.querySelectorAll('.modal-footer button')
    await u.click(buttons[buttons.length - 1] as HTMLButtonElement)
    expect(useApp.getState().servers.find((s) => s.name === 'web')!.folderId).toBe('f-eu')
  })

  it('starts at the top level when opened any other way', () => {
    useApp.getState().openAddServer('f-eu')
    useApp.getState().setModal('add-server')
    render(<AddServerModal />)
    expect((screen.getByLabelText('Folder') as HTMLSelectElement).value).toBe('')
  })
})

describe('Recent', () => {
  it('folds from its header, and the fold is kept in settings', async () => {
    const u = userEvent.setup()
    const { unmount } = render(<ConnectionTree />)
    const header = screen.getByRole('button', { name: 'Recent' })
    expect(header.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('tree', { name: 'Recent' })).toBeTruthy()

    await u.click(header)
    expect(header.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('tree', { name: 'Recent' })).toBeNull()
    expect(useApp.getState().settings.recentCollapsed).toBe(true)
    unmount()

    // Settings are what persist.ts writes, so a restart is a fresh mount.
    render(<ConnectionTree />)
    expect(screen.queryByRole('tree', { name: 'Recent' })).toBeNull()
    screen.getByRole('button', { name: 'Recent' }).focus()
    await u.keyboard('{Enter}')
    expect(screen.getByRole('tree', { name: 'Recent' })).toBeTruthy()
    expect(useApp.getState().settings.recentCollapsed).toBe(false)
  })
})

describe('tag chips on a narrow row', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // jsdom lays nothing out, so a row is given widths: room for two chips
  // beside the name, each chip 50px. Three tags plus a count do not fit.
  it('drops chips into the count rather than cutting one', () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('tree-row') ? 160 : 0
    })
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('tree-row') ? 50 + 50 * this.querySelectorAll('.chip').length : 0
    })
    const ws = useApp.getState().activeId()
    useApp.setState({
      servers: [{ ...base, id: 'srv-t', workspaceId: ws, folderId: null, name: 'tagged', host: '10.0.0.9', tags: ['prod', 'contabo', 'eu'] }]
    } as never)
    render(<ConnectionTree />)
    const row = screen.getAllByRole('treeitem').find((r) => r.textContent?.includes('tagged'))!
    expect([...row.querySelectorAll('.chip')].map((c) => c.textContent)).toEqual(['prod', '+2'])
    expect(row.querySelector('.chip.more')!.getAttribute('title')).toBe('contabo, eu')
  })

  it('shows two and a count when there is room', () => {
    const ws = useApp.getState().activeId()
    useApp.setState({
      servers: [{ ...base, id: 'srv-t', workspaceId: ws, folderId: null, name: 'tagged', host: '10.0.0.9', tags: ['prod', 'contabo', 'eu'] }]
    } as never)
    render(<ConnectionTree />)
    const row = screen.getAllByRole('treeitem').find((r) => r.textContent?.includes('tagged'))!
    expect([...row.querySelectorAll('.chip')].map((c) => c.textContent)).toEqual(['prod', 'contabo', '+1'])
  })
})
