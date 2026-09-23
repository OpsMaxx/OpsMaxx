// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { defaults } from '../src/shared/apiModel'
import { RouteChip } from '../src/renderer/src/components/http/RouteChip'
import { TlsChip } from '../src/renderer/src/components/http/TlsChip'
import { useHttp } from '../src/renderer/src/store/http'
import { useApi } from '../src/renderer/src/store/api'
import { useApp } from '../src/renderer/src/store/app'
import type { Server } from '../src/renderer/src/types'
import type { MenuEntry } from '../src/renderer/src/components/connections/ContextMenu'

// B extends ContextMenu with sections and radios; this stands in for it so the
// entries the chip builds are what is asserted, whatever B's markup becomes.
vi.mock('../src/renderer/src/components/connections/ContextMenu', () => ({
  ContextMenu: ({ entries, onClose }: { entries: MenuEntry[]; onClose: () => void }) => (
    <div role="menu">
      {entries.map((e, i) => (
        <div key={i}>
          {e.section && <div>{e.section}</div>}
          <button aria-checked={e.checked} onClick={() => (e.onClick?.(), onClose())}>
            {e.label}
          </button>
        </div>
      ))}
    </div>
  )
}))

// The URL row's two chips (§2.11): where a request is sent from, and the
// owning collection's certificate mode.

const ws = (): string => useApp.getState().activeWorkspaceId

function servers(): void {
  const mk = (id: string, name: string): Server => ({ id, workspaceId: ws(), name, tags: [] }) as unknown as Server
  useApp.setState({ servers: [mk('srv1', 'web-01'), mk('srv2', 'bastion')] })
}

function savedTab(patch: Partial<ReturnType<typeof defaults.collection>> = {}): { tabId: string; col: string } {
  const col = useApi.getState().createCollection('httpbin')
  useApi.getState().updateCollection(col, patch)
  const req = defaults.http()
  useApi.getState().addItem(col, null, req)
  return { tabId: useHttp.getState().openRequest({ collectionId: col, requestId: req.id }), col }
}

describe('RouteChip', () => {
  it('a scratch request picks its own route', () => {
    servers()
    const tabId = useHttp.getState().openScratch('http')
    render(<RouteChip tabId={tabId} compact={false} />)
    const chip = screen.getByRole('button', { name: 'Route: This machine' })
    fireEvent.click(chip)
    const menu = screen.getByRole('menu')
    expect(within(menu).getByText('Send from')).toBeTruthy()
    expect(within(menu).getByText('This machine').getAttribute('aria-checked')).toBe('true')
    fireEvent.click(within(menu).getByText('web-01'))
    expect(useHttp.getState().tabs[0].route).toEqual({ kind: 'server', serverId: 'srv1' })
    expect(screen.getByRole('button', { name: 'Route: web-01' })).toBeTruthy()
  })

  it('a saved request shows its collection’s route, and changing it says whom it affects', () => {
    servers()
    const { tabId, col } = savedTab({ viaServerId: 'srv2' })
    render(<RouteChip tabId={tabId} compact={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'Route: bastion · from collection' }))
    const menu = screen.getByRole('menu')
    expect(within(menu).getByText('Changes it for every request in httpbin')).toBeTruthy()
    fireEvent.click(within(menu).getByText('This machine'))
    expect(useApi.getState().collections.find((c) => c.id === col)?.viaServerId).toBeNull()
    expect(useHttp.getState().tabs[0].route).toBeUndefined()
  })

  it('a removed server is named as removed, never as This machine', () => {
    servers()
    const { tabId } = savedTab({ viaServerId: 'srv-gone' })
    render(<RouteChip tabId={tabId} compact />)
    const chip = screen.getByRole('button', { name: 'Route: Server removed. Requests will not be sent' })
    expect(chip.className).toContain('hc-chip-danger')
    expect(chip.textContent).toBe('')
  })

  it('a request whose collection was deleted reads as such, and offers to save it somewhere', () => {
    const { tabId, col } = savedTab()
    act(() => useApi.setState({ collections: useApi.getState().collections.filter((c) => c.id !== col) }))
    render(<RouteChip tabId={tabId} compact={false} />)
    const chip = screen.getByRole('button', {
      name: 'Route: Collection removed. Requests will not be sent until it is saved to a collection'
    })
    expect(chip.className).toContain('hc-chip-danger')
    expect(chip.textContent).toContain('Collection removed')
    expect(chip.textContent).not.toContain('Server removed')
    fireEvent.click(chip)
    expect(useHttp.getState().overlay).toBe('save')
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('works on the ghost before the first keystroke', () => {
    const ghost = useHttp.getState().ensureGhost(ws())
    servers()
    render(<RouteChip tabId={ghost.id} compact={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'Route: This machine' }))
    fireEvent.click(within(screen.getByRole('menu')).getByText('bastion'))
    expect(useHttp.getState().ghost[ws()].route).toEqual({ kind: 'server', serverId: 'srv2' })
  })
})

describe('TlsChip', () => {
  it('is a danger chip whenever the collection skips verification, even compact', () => {
    const { tabId } = savedTab({ insecureTls: true })
    const { rerender } = render(<TlsChip tabId={tabId} compact={false} />)
    const label = 'Certificate verification is off for this collection (httpbin)'
    expect(screen.getByRole('button', { name: label }).textContent).toBe('TLS unverified')
    rerender(<TlsChip tabId={tabId} compact />)
    const compact = screen.getByRole('button', { name: label })
    expect(compact.className).toContain('hc-chip-danger')
    expect(compact.textContent).toBe('')
  })

  it('opens the collection on its Connection section', () => {
    const { tabId, col } = savedTab({ insecureTls: true })
    render(<TlsChip tabId={tabId} compact={false} />)
    fireEvent.click(screen.getByRole('button', { name: /verification is off/ }))
    const tab = useHttp.getState().tabs.find((t) => t.kind === 'collection')!
    expect(tab.ref).toEqual({ collectionId: col })
    expect(useHttp.getState().collectionSection[tab.id]).toBe('connection')
  })

  it('a custom CA is a quieter chip that is also never hidden', () => {
    const { tabId } = savedTab({ caPem: '-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----' })
    render(<TlsChip tabId={tabId} compact />)
    expect(screen.getByRole('button', { name: /custom CA from httpbin/ }).className).toContain('hc-chip-info')
  })

  it('a certificate change from another device is flagged on the request tab until it is reviewed', () => {
    const { tabId, col } = savedTab({ insecureTls: true, tlsReview: true })
    const { rerender } = render(<TlsChip tabId={tabId} compact={false} />)
    const label = 'Connection settings for httpbin changed on another device — Review'
    const chip = screen.getByRole('button', { name: label })
    expect(chip.textContent).toBe('Review TLS change')
    expect(chip.className).toContain('hc-chip-danger')
    rerender(<TlsChip tabId={tabId} compact />)
    fireEvent.click(screen.getByRole('button', { name: label }))
    const colTab = useHttp.getState().tabs.find((t) => t.kind === 'collection')!
    expect(colTab.ref).toEqual({ collectionId: col })
    expect(useHttp.getState().collectionSection[colTab.id]).toBe('connection')
    // Accepted: back to the collection's ordinary chip.
    act(() => useApi.getState().clearTlsReview(col))
    expect(screen.getByRole('button', { name: /verification is off/ })).toBeTruthy()
  })

  it('flags a pending review even when the change turned nothing off', () => {
    const { tabId } = savedTab({ tlsReview: true })
    render(<TlsChip tabId={tabId} compact />)
    expect(screen.getByRole('button', { name: /changed on another device/ })).toBeTruthy()
  })

  it('a scratch request always verifies, so it has no chip', () => {
    const tabId = useHttp.getState().openScratch('http')
    const { container } = render(<TlsChip tabId={tabId} compact={false} />)
    expect(container.textContent).toBe('')
  })
})
