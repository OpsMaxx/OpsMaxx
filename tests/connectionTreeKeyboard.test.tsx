// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { stubBridge } from './setup/renderer'
import { ConnectionTree } from '../src/renderer/src/components/connections/ConnectionTree'
import { useApp } from '../src/renderer/src/store/app'
import { useFleet } from '../src/renderer/src/store/fleet'

/**
 * The connection tree, driven without a mouse.
 *
 * Every row was a div with an onClick, so the sidebar — the way into every
 * server — could not be reached from the keyboard at all. These walk it the way
 * a keyboard user does: Tab in, arrows through, Enter to open, Shift+F10 for the
 * menu a right-click gives.
 */

const base = {
  port: 22,
  username: 'root',
  auth: 'key',
  status: 'offline',
  favorite: false,
  os: 'Linux',
  route: [],
  vpnProfileId: null
}

function seed(): { openServer: ReturnType<typeof vi.fn> } {
  const ws = useApp.getState().activeId()
  const openServer = vi.fn()
  useApp.setState({
    openServer,
    folders: [{ id: 'f-prod', workspaceId: ws, name: 'Production', parentId: null, kind: 'server' }],
    servers: [
      { ...base, id: 'srv-a', workspaceId: ws, folderId: 'f-prod', name: 'api', host: '10.0.0.1', tags: ['prod', 'eu', 'db'], status: 'online' },
      { ...base, id: 'srv-b', workspaceId: ws, folderId: null, name: 'bastion', host: '10.0.0.2', tags: [], favorite: true, status: 'connecting' },
      { ...base, id: 'srv-c', workspaceId: ws, folderId: null, name: 'cache', host: '10.0.0.3', tags: ['redis'], status: 'idle' }
    ]
  } as never)
  return { openServer }
}

const rows = (): HTMLElement[] => screen.getAllByRole('treeitem')
const focused = (): string => (document.activeElement as HTMLElement).textContent ?? ''

beforeEach(() => {
  stubBridge({})
})

describe('connection tree keyboard', () => {
  it('is a tree with exactly one tab stop, and folders say whether they are open', () => {
    seed()
    render(<ConnectionTree />)
    expect(screen.getByRole('tree')).toBeTruthy()
    expect(rows().filter((r) => r.tabIndex === 0)).toHaveLength(1)
    const folder = rows().find((r) => r.textContent?.includes('Production'))!
    expect(folder.getAttribute('aria-expanded')).toBe('true')
  })

  it('moves with the arrows, Home and End, and collapses and expands folders', async () => {
    seed()
    render(<ConnectionTree />)
    const u = userEvent.setup()
    await u.tab() // the search box
    await u.tab()
    // Favorites first: bastion.
    expect(focused()).toContain('bastion')
    await u.keyboard('{ArrowDown}')
    expect(focused()).toContain('Production')
    await u.keyboard('{ArrowDown}')
    expect(focused()).toContain('api')
    // Left from a child goes to its folder; Left again collapses it.
    await u.keyboard('{ArrowLeft}')
    expect(focused()).toContain('Production')
    await u.keyboard('{ArrowLeft}')
    expect(document.activeElement!.getAttribute('aria-expanded')).toBe('false')
    expect(rows().some((r) => r.textContent?.includes('api'))).toBe(false)
    await u.keyboard('{ArrowRight}')
    expect(document.activeElement!.getAttribute('aria-expanded')).toBe('true')
    await u.keyboard('{ArrowRight}')
    expect(focused()).toContain('api')
    await u.keyboard('{End}')
    expect(focused()).toContain('cache')
    await u.keyboard('{Home}')
    expect(focused()).toContain('bastion')
    // The roving tab stop follows focus.
    expect(rows().filter((r) => r.tabIndex === 0)).toEqual([document.activeElement])
  })

  it('opens a server on Enter, the same as a click', async () => {
    const { openServer } = seed()
    render(<ConnectionTree />)
    const cache = rows().find((r) => r.textContent?.includes('cache'))!
    cache.focus()
    await userEvent.keyboard('{Enter}')
    expect(openServer).toHaveBeenCalledWith('srv-c')
  })

  it('opens the context menu on Shift+F10 and on the ContextMenu key, with focus inside it', async () => {
    seed()
    render(<ConnectionTree />)
    const cache = rows().find((r) => r.textContent?.includes('cache'))!
    cache.focus()
    await userEvent.keyboard('{Shift>}{F10}{/Shift}')
    const menu = screen.getByRole('menu')
    expect(menu.textContent).toContain('Connect')
    expect(menu.contains(document.activeElement)).toBe(true)
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).toBeNull()

    fireEvent.keyDown(cache, { key: 'ContextMenu' })
    expect(screen.getByRole('menu').textContent).toContain('Edit server')
  })

  it('leaves a folder being renamed to its input', async () => {
    seed()
    render(<ConnectionTree />)
    const folder = rows().find((r) => r.textContent?.includes('Production'))!
    fireEvent.doubleClick(folder)
    const input = folder.querySelector('input')!
    input.focus()
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(input)
  })
})

describe('what a row shows', () => {
  it('gives each status its own shape class and a label, not only a colour', () => {
    seed()
    render(<ConnectionTree />)
    const dots = screen.getAllByRole('img').filter((el) => el.classList.contains('status-dot'))
    const labels = new Set(dots.map((d) => d.getAttribute('aria-label')))
    expect(labels).toEqual(new Set(['Connected', 'Connecting', 'Idle']))
    // Distinct state classes are what global.css hangs the shapes on.
    expect(new Set(dots.map((d) => d.className)).size).toBe(3)
  })

  it('draws tags as chips, at most two and then a count', () => {
    seed()
    render(<ConnectionTree />)
    const api = rows().find((r) => r.textContent?.includes('api'))!
    const chips = [...api.querySelectorAll('.chip')].map((c) => c.textContent)
    expect(chips).toEqual(['prod', 'eu', '+1'])
  })

  it('finds a server by one of its tags', async () => {
    seed()
    render(<ConnectionTree />)
    await userEvent.type(screen.getByPlaceholderText('Search connections…'), 'redis')
    const names = rows().map((r) => r.textContent)
    expect(names.some((n) => n?.includes('cache'))).toBe(true)
    expect(names.some((n) => n?.includes('api'))).toBe(false)
  })

  it('draws a distro icon from sampled facts, and nothing for an unknown one', () => {
    seed()
    useFleet.setState({
      facts: {
        'srv-a': { facts: { distroId: 'ubuntu' } as never, at: 1 },
        'srv-c': { facts: { distroId: 'other' } as never, at: 1 }
      }
    })
    render(<ConnectionTree />)
    expect(screen.getAllByRole('img', { name: 'Ubuntu' })).toHaveLength(1)
    const cache = rows().find((r) => r.textContent?.includes('cache'))!
    expect(cache.querySelector('.distro')).toBeNull()
  })
})
