// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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
  it('is three named trees holding only rows, with exactly one tab stop between them', () => {
    seed()
    render(<ConnectionTree />)
    const trees = screen.getAllByRole('tree')
    expect(trees.map((t) => t.getAttribute('aria-label'))).toEqual(['Favorites', 'Connections', 'Recent'])
    // A tree may own only rows and groups. The Connections header — a drop
    // target with a "New folder" button — sits between trees, not in one.
    for (const t of trees) expect(t.querySelector('button, .tree-section-label')).toBeNull()
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
    const conns = screen.getByRole('tree', { name: 'Connections' })
    expect(within(conns).queryAllByRole('treeitem').some((r) => r.textContent?.includes('api'))).toBe(false)
    await u.keyboard('{ArrowRight}')
    expect(document.activeElement!.getAttribute('aria-expanded')).toBe('true')
    await u.keyboard('{ArrowRight}')
    expect(focused()).toContain('api')
    // Down from the last connection crosses into Recent: one keyboard model.
    await u.keyboard('{End}')
    expect(within(screen.getByRole('tree', { name: 'Recent' })).getAllByRole('treeitem').at(-1)).toBe(
      document.activeElement
    )
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

  it('reaches Recent rows too: Enter opens, Shift+F10 gives the menu', async () => {
    const { openServer } = seed()
    render(<ConnectionTree />)
    const recent = within(screen.getByRole('tree', { name: 'Recent' })).getAllByRole('treeitem')
    expect(recent.map((r) => r.textContent)).toEqual(['api', 'bastion', 'cache'])
    recent[0].focus()
    await userEvent.keyboard('{Enter}')
    expect(openServer).toHaveBeenCalledWith('srv-a')
    await userEvent.keyboard('{Shift>}{F10}{/Shift}')
    expect(screen.getByRole('menu').textContent).toContain('Connect')
  })

  it('leaves Ctrl, Cmd and Alt chords to the app', () => {
    seed()
    render(<ConnectionTree />)
    const cache = rows().find((r) => r.textContent?.includes('cache'))!
    cache.focus()
    const ev = new KeyboardEvent('keydown', { key: 'ArrowUp', ctrlKey: true, bubbles: true, cancelable: true })
    cache.dispatchEvent(ev)
    expect(document.activeElement).toBe(cache)
    expect(ev.defaultPrevented).toBe(false)
  })

  it('keeps focus in the tree when the focused row is deleted', async () => {
    seed()
    render(<ConnectionTree />)
    const cache = rows().find((r) => r.textContent?.includes('cache') && r.getAttribute('aria-level'))!
    cache.focus()
    await act(async () => {
      useApp.setState((st) => ({ servers: st.servers.filter((sv) => sv.id !== 'srv-c') }))
    })
    expect(document.activeElement?.getAttribute('role')).toBe('treeitem')
  })

  it('does not open the row menu from inside a folder being renamed', () => {
    seed()
    render(<ConnectionTree />)
    const folder = rows().find((r) => r.textContent?.includes('Production'))!
    fireEvent.doubleClick(folder)
    fireEvent.contextMenu(folder.querySelector('input')!)
    expect(screen.queryByRole('menu')).toBeNull()
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
    const tree = screen.getByRole('tree', { name: 'Connections' })
    const names = within(tree).getAllByRole('treeitem').map((r) => r.textContent)
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

describe('the stylesheet behind a row', () => {
  const css = readFileSync(join(__dirname, '..', 'src', 'renderer', 'src', 'styles', 'global.css'), 'utf8')
  const rule = (selector: string): string => {
    // At a line start, so `.db-schema .tree-row .label` does not answer for it.
    const i = css.lastIndexOf(`\n${selector} {`)
    expect(i, `${selector} has no rule`).toBeGreaterThan(-1)
    return css.slice(i, css.indexOf('}', i))
  }

  it.each(['online', 'idle', 'offline', 'connecting', 'error'])(
    'gives .status-dot.%s a rule of its own',
    (state) => {
      rule(`.status-dot.${state}`)
    }
  )

  it('lets tag chips shrink before the name does', () => {
    const chip = rule('.tree-row .chip')
    expect(chip).toMatch(/min-width:\s*0/)
    expect(chip).toMatch(/text-overflow:\s*ellipsis/)
    expect(chip).not.toMatch(/flex:\s*none/)
    expect(rule('.tree-row .label')).toMatch(/flex:\s*1 0 6ch/)
  })
})
