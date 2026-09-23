// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaults, type ApiCollectionV2 } from '../src/shared/apiModel'
import type { HistoryEntry } from '../src/shared/httpHistory'
import { useApi } from '../src/renderer/src/store/api'
import { useApp } from '../src/renderer/src/store/app'
import { useHttp } from '../src/renderer/src/store/http'
import { stubBridge } from './setup/renderer'
import { HistoryList, groupByDay, dayLabel } from '../src/renderer/src/components/http/sidebar/HistoryList'

vi.mock('../src/renderer/src/lib/httpSend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/renderer/src/lib/httpSend')>()),
  sendAgainFromHistory: vi.fn(async () => {})
}))
import { send, sendAgainFromHistory } from '../src/renderer/src/lib/httpSend'

const NOW = new Date(2026, 8, 23, 15, 0).getTime()
const HOUR = 3600_000

function entry(id: string, at: number, extra: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id,
    at,
    kind: 'http',
    request: { ...defaults.http(), id: `req_${id}`, url: `https://api.example/${id}` },
    route: { kind: 'direct' },
    routeLabel: 'This machine',
    response: { status: 200, statusText: 'OK', durationMs: 5, size: 10 },
    ...extra
  }
}

function bridge(entries: HistoryEntry[]): { list: ReturnType<typeof vi.fn>; clear: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> } {
  const list = vi.fn(async () => entries)
  const clear = vi.fn(async () => {})
  const remove = vi.fn(async () => {})
  stubBridge({ httpHistory: { list, clear, remove, append: vi.fn() }, clipboard: { write: vi.fn() } })
  return { list, clear, remove }
}

const menuLabels = (): string[] => screen.getAllByRole('menuitem').map((m) => m.firstChild?.textContent ?? '')

describe('history grouping', () => {
  it('groups by local day: Today, Yesterday, then the date', () => {
    expect(dayLabel(NOW - HOUR, NOW)).toBe('Today')
    expect(dayLabel(NOW - 20 * HOUR, NOW)).toBe('Yesterday')
    const groups = groupByDay([entry('a', NOW - HOUR), entry('b', NOW - 2 * HOUR), entry('c', NOW - 20 * HOUR), entry('d', NOW - 80 * HOUR)], NOW)
    expect(groups.map((g) => [g.label, g.entries.length])).toEqual([
      ['Today', 2],
      ['Yesterday', 1],
      [new Date(NOW - 80 * HOUR).toLocaleDateString(), 1]
    ])
  })
})

describe('HistoryList', () => {
  it('lists entries and says so when there are none', async () => {
    bridge([])
    render(<HistoryList query="" />)
    expect(await screen.findByText(/Requests you send appear here/)).toBeTruthy()
  })

  it('offers Open request only while the saved request still exists', async () => {
    const ws = useApp.getState().activeWorkspaceId
    const col: ApiCollectionV2 = { ...defaults.collection(ws, 'c'), id: 'col_a', items: [{ ...defaults.http(), id: 'req_live' }] }
    useApi.setState({ collections: [col] })
    bridge([
      entry('live', Date.now(), { requestRef: { collectionId: 'col_a', requestId: 'req_live' } }),
      entry('gone', Date.now() - 1000, { requestRef: { collectionId: 'col_a', requestId: 'req_gone' } })
    ])
    render(<HistoryList query="" />)
    fireEvent.contextMenu(await screen.findByText('https://api.example/live'))
    expect(menuLabels()).toEqual([
      'Send again', 'Open request', 'Open as new request', 'Save to collection…', 'Copy as cURL', 'Copy URL', 'Delete entry'
    ])
    await userEvent.keyboard('{Escape}')
    fireEvent.contextMenu(screen.getByText('https://api.example/gone'))
    expect(menuLabels()).not.toContain('Open request')
  })

  it('clears all history from the header, after a confirm', async () => {
    const { clear } = bridge([entry('a', Date.now())])
    render(<HistoryList query="" />)
    await screen.findByText('https://api.example/a')
    await userEvent.click(screen.getByLabelText('History options'))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Clear all history…' }))
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Clear history' }))
    expect(clear).toHaveBeenCalledOnce()
    await waitFor(() => expect(screen.queryByText('https://api.example/a')).toBeNull())
  })

  it('passes the filter to main as a substring query', async () => {
    const { list } = bridge([])
    render(<HistoryList query="users" />)
    await waitFor(() => expect(list).toHaveBeenCalledWith({ limit: 50, before: undefined, query: 'users', workspaceId: useApp.getState().activeWorkspaceId }))
  })

  it('says when history is kept for this session only', async () => {
    stubBridge({ httpHistory: { list: vi.fn(async () => []), sealed: vi.fn(async () => false) } })
    render(<HistoryList query="" />)
    expect((await screen.findByRole('note')).textContent).toMatch(/this session only/)
  })

  it('says when history cannot be read, with Retry', async () => {
    stubBridge({ httpHistory: { list: vi.fn(async () => Promise.reject(new Error('x'))) } })
    render(<HistoryList query="" />)
    expect((await screen.findByRole('alert')).textContent).toContain('Could not read history')
  })
})

describe('history re-run keeps the route (historyRerun)', () => {
  it('sends again through the send layer, which refuses a removed route', async () => {
    const gone = entry('srv', Date.now(), { route: { kind: 'server', serverId: 'srv_deleted' }, routeLabel: 'web-01' })
    bridge([gone])
    render(<HistoryList query="" />)
    fireEvent.contextMenu(await screen.findByText('https://api.example/srv'))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Send again' }))
    expect(sendAgainFromHistory).toHaveBeenCalledWith(gone)
  })

  it('opens as a new request on the same route id, never falling back to direct', async () => {
    const gone = entry('srv2', Date.now(), { route: { kind: 'server', serverId: 'srv_deleted' }, routeLabel: 'web-01' })
    bridge([gone])
    render(<HistoryList query="" />)
    fireEvent.contextMenu(await screen.findByText('https://api.example/srv2'))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Open as new request' }))
    const tab = useHttp.getState().tabs[0]
    expect(tab.ref).toBeUndefined()
    expect(tab.route).toEqual({ kind: 'server', serverId: 'srv_deleted' })
    expect(tab.draft?.url).toBe('https://api.example/srv2')
  })
})

describe('history never sends a masked value as a credential (M-a)', () => {
  it('marks masked fields on the new tab, and the send refuses until they are re-entered', async () => {
    const masked = entry('sec', Date.now(), {
      request: {
        ...defaults.http(),
        id: 'req_sec',
        url: 'https://api.example/sec',
        headers: [
          { id: 'row_a', enabled: true, key: 'Authorization', value: '•••' },
          { id: 'row_b', enabled: true, key: 'Accept', value: 'application/json' }
        ]
      }
    })
    const request = vi.fn(async () => ({ ok: true }))
    stubBridge({
      httpHistory: { list: vi.fn(async () => [masked]), sealed: vi.fn(async () => true) },
      http: { request },
      clipboard: { write: vi.fn() }
    })
    render(<HistoryList query="" />)
    fireEvent.contextMenu(await screen.findByText('https://api.example/sec'))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Open as new request' }))
    const tab = useHttp.getState().tabs[0]
    expect(tab.strippedFields).toEqual(['headers.0.value'])
    expect(tab.draft?.id).not.toBe('req_sec')
    await send(tab.id)
    expect(request).not.toHaveBeenCalled()
    expect(useHttp.getState().responses[tab.id]).toMatchObject({ status: 'error', message: 'Enter the values that were not kept' })
  })
})

describe('history is per workspace (M2)', () => {
  it('asks main for this workspace only, and asks again when the workspace changes', async () => {
    const { list } = bridge([])
    const here = useApp.getState().activeWorkspaceId
    render(<HistoryList query="" />)
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ workspaceId: here })))
    act(() => useApp.setState({ activeWorkspaceId: 'ws_other' }))
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ workspaceId: 'ws_other' })))
  })
})
