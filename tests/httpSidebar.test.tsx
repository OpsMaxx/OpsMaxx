// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaults, type HttpTabState } from '../src/shared/apiModel'
import { useApi } from '../src/renderer/src/store/api'
import { useApp } from '../src/renderer/src/store/app'
import { useHttp } from '../src/renderer/src/store/http'
import { stubBridge } from './setup/renderer'
import { HttpSidebar } from '../src/renderer/src/components/http/HttpSidebar'
import { VariablesPopover, referencedVariables } from '../src/renderer/src/components/http/env/VariablesPopover'

describe('HttpSidebar', () => {
  it('shows the header, an empty state, and makes a collection ready to rename', async () => {
    render(<HttpSidebar />)
    expect(screen.getByRole('heading', { name: 'Collections (formerly APIs)' })).toBeTruthy()
    expect(screen.getByText('No collections yet')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'New collection' }))
    expect(useApi.getState().collections.map((c) => c.name)).toEqual(['New collection'])
    expect(document.activeElement).toBe(screen.getByLabelText('Rename New collection'))
  })

  it('switches to History, which reads main', async () => {
    const list = vi.fn(async () => [])
    stubBridge({ httpHistory: { list } })
    render(<HttpSidebar />)
    await userEvent.click(screen.getByRole('tab', { name: 'History' }))
    expect(useHttp.getState().sidebarTab).toBe('history')
    expect(await screen.findByText(/History stays on this device/)).toBeTruthy()
    expect(list).toHaveBeenCalled()
  })

  it('opens a scratch tab from + New', async () => {
    render(<HttpSidebar />)
    await userEvent.click(screen.getByRole('button', { name: 'New' }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'New WebSocket' }))
    expect(useHttp.getState().tabs[0].draft?.kind).toBe('ws')
  })

  it('asks the workbench to open Import', async () => {
    render(<HttpSidebar />)
    await userEvent.click(screen.getByRole('button', { name: 'Import' }))
    expect([useHttp.getState().overlay, useHttp.getState().importTarget]).toEqual(['import', null])
  })
})

describe('VariablesPopover', () => {
  it('lists each variable a request uses, where it resolves, and where to add a missing one', async () => {
    const ws = useApp.getState().activeWorkspaceId
    expect(referencedVariables({ url: '{{baseUrl}}/x/{{ id }}', h: '{{baseUrl}}' })).toEqual(['baseUrl', 'id'])
    useApi.getState().setGlobals(ws, [{ id: 'var_1', key: 'baseUrl', value: 'https://g.example', enabled: true }])
    // scopeChain is stream A's; stand in for it with the same layering.
    useApi.setState({
      scopeChainFor: (tab: HttpTabState) => ({
        layers: [{ scope: 'global', name: 'Globals', variables: useApi.getState().workspace.globals[tab.workspaceId] ?? [] }]
      })
    } as never)
    const tabId = useHttp.getState().openScratch('http', { ...defaults.http(), url: '{{baseUrl}}/{{token}}' })
    render(<VariablesPopover tabId={tabId} anchor={new DOMRect(0, 0, 10, 10)} onClose={() => {}} />)
    expect((screen.getByLabelText('Value of baseUrl, from global') as HTMLInputElement).value).toBe('https://g.example')
    expect(screen.getByText('Not defined. Add to:')).toBeTruthy()
    // A scratch tab has no collection to add to.
    expect(screen.queryByRole('button', { name: 'collection' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'global' }))
    expect(useApi.getState().workspace.globals[ws].map((v) => v.key)).toEqual(['baseUrl', 'token'])
  })
})

describe('Recover old data (M7)', () => {
  it('is offered only while there is pre-upgrade data, and recovers into new collections', async () => {
    const { unmount } = render(<HttpSidebar />)
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull()
    unmount()
    const recoverLegacy = vi.fn(() => ['col_r'])
    useApi.setState({ legacy: { apiCollections: [] }, recoverLegacy } as never)
    render(<HttpSidebar />)
    await userEvent.click(screen.getByRole('button', { name: 'More' }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Recover old data…' }))
    expect(recoverLegacy).toHaveBeenCalledOnce()
  })
})
