// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { CookiesPopover } from '../src/renderer/src/components/http/CookiesPopover'
import { useHttpCookies, type StoredCookie } from '../src/renderer/src/store/httpCookies'
import { useApp } from '../src/renderer/src/store/app'
import type { Server } from '../src/renderer/src/types'

// The cookie jar view (§2.17). The jar's rules are A's (cookieJar.test.ts);
// this is the view: grouping, the delete controls, and what it does not show.

const cookie = (name: string, domain: string, patch: Partial<StoredCookie> = {}): StoredCookie => ({
  name,
  value: 'SECRET-VALUE',
  domain,
  hostOnly: true,
  path: '/',
  secure: false,
  httpOnly: true,
  createdAt: 1,
  ...patch
})

function seed(): { remove: ReturnType<typeof vi.fn>; clearDomain: ReturnType<typeof vi.fn>; clearAll: ReturnType<typeof vi.fn> } {
  const ws = useApp.getState().activeWorkspaceId
  useApp.setState({ servers: [{ id: 'srv1', workspaceId: ws, name: 'web-01', tags: [] } as unknown as Server] })
  const actions = { remove: vi.fn(), clearDomain: vi.fn(), clearAll: vi.fn() }
  useHttpCookies.setState({
    ...actions,
    jars: {
      [`${ws}|direct`]: [cookie('sid', 'example.test'), cookie('theme', 'example.test'), cookie('a', 'other.test')],
      [`${ws}|server:srv1`]: [cookie('sid', 'localhost', { secure: true })],
      'ws-other|direct': [cookie('elsewhere', 'example.test')]
    }
  })
  return actions
}

describe('CookiesPopover', () => {
  it('groups this workspace’s cookies by route, then domain, and never shows a value', () => {
    seed()
    render(<CookiesPopover onClose={() => undefined} />)
    const direct = screen.getByRole('region', { name: 'This machine' })
    expect(within(direct).getByText('example.test')).toBeTruthy()
    expect(within(direct).getByText('other.test')).toBeTruthy()
    const viaServer = screen.getByRole('region', { name: 'Through web-01' })
    expect(within(viaServer).getByText('localhost')).toBeTruthy()
    expect(document.body.textContent).not.toContain('SECRET-VALUE')
    expect(document.body.textContent).not.toContain('elsewhere')
    expect(document.body.textContent).toContain('Cookies are kept until OpsMaxx quits.')
  })

  it('deletes one cookie, clears a domain, and clears the jar', () => {
    const ws = useApp.getState().activeWorkspaceId
    const { remove, clearDomain, clearAll } = seed()
    render(<CookiesPopover onClose={() => undefined} />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete cookie theme for example.test' }))
    expect(remove).toHaveBeenCalledWith(`${ws}|direct`, 'theme', 'example.test', '/')
    fireEvent.click(within(screen.getByRole('region', { name: 'Through web-01' })).getByRole('button', { name: 'Clear domain' }))
    expect(clearDomain).toHaveBeenCalledWith(`${ws}|server:srv1`, 'localhost')
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }))
    expect(clearAll).toHaveBeenCalledOnce()
  })

  it('says so when the jar is empty', () => {
    render(<CookiesPopover onClose={() => undefined} />)
    expect(screen.getByText(/No cookies yet/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Clear all' })).toBeNull()
  })
})
