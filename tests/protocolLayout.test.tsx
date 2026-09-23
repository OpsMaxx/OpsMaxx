// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import type { SplitPaneProps } from '../src/renderer/src/components/common/SplitPane'
import { ProtocolLayout, SplitToggles } from '../src/renderer/src/components/http/ProtocolLayout'
import { useHttp } from '../src/renderer/src/store/http'
import { useApi } from '../src/renderer/src/store/api'
import { useApp } from '../src/renderer/src/store/app'

// SplitPane is B's primitive; this pins what ProtocolLayout hands it, not its drag maths.
vi.mock('../src/renderer/src/components/common/SplitPane', () => ({
  SplitPane: (p: SplitPaneProps) => (
    <div data-testid="split" data-orientation={p.orientation} data-ratio={p.ratio}>
      {p.collapsed === 'a' ? p.collapsedA : p.children[0]}
      <div
        role="separator"
        aria-label={p.label}
        onContextMenu={(e) => {
          e.preventDefault()
          p.onMenu?.({ x: e.clientX, y: e.clientY })
        }}
        onDoubleClick={() => p.defaultRatio !== undefined && p.onRatio(p.defaultRatio)}
      />
      {p.collapsed === 'b' ? p.collapsedB : p.children[1]}
    </div>
  )
}))

function mount(): string {
  const tabId = useHttp.getState().openScratch('http')
  render(
    <ProtocolLayout
      tabId={tabId}
      kind="http"
      bar={<span>URL ROW</span>}
      requestTabs={<span>Params · Auth · Headers</span>}
      requestToolbar={<span>Query parameters</span>}
      request={<span>REQUEST BODY</span>}
      response={
        <div>
          RESPONSE BODY <SplitToggles tabId={tabId} />
        </div>
      }
      requestSummary={<button onClick={() => undefined}>Headers 3</button>}
      responseSummary={<span>● 200 OK · 142 ms</span>}
    />
  )
  return tabId
}

const split = (tabId: string): string | undefined => useHttp.getState().tabs.find((t) => t.id === tabId)?.split

describe('ProtocolLayout', () => {
  it('lays out the §2.2 bands with labelled regions, stacked when narrow', () => {
    mount()
    expect(screen.getByText('URL ROW')).toBeTruthy()
    expect(screen.getByRole('region', { name: 'Request' }).textContent).toContain('REQUEST BODY')
    expect(screen.getByRole('region', { name: 'Response' }).textContent).toContain('RESPONSE BODY')
    // jsdom has no layout: width 0 is below 800, so auto is stacked with the stacked ratio.
    expect(screen.getByTestId('split').dataset).toMatchObject({ orientation: 'vertical', ratio: '0.4' })
  })

  it('collapses the response to a bar that keeps the live status, and restores from it', () => {
    const tabId = mount()
    fireEvent.click(screen.getByRole('button', { name: /^Collapse response/ }))
    expect(split(tabId)).toBe('response-collapsed')
    expect(screen.queryByText('RESPONSE BODY')).toBeNull()
    expect(screen.getByText('● 200 OK · 142 ms')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Show response (Ctrl+J)' }))
    expect(split(tabId)).toBe('normal')
    expect(screen.getByText(/RESPONSE BODY/)).toBeTruthy()
  })

  it('collapses the request to a bar with its summary; a click on the bar restores it', () => {
    const tabId = mount()
    fireEvent.click(screen.getByRole('button', { name: /^Collapse request/ }))
    expect(split(tabId)).toBe('request-collapsed')
    expect(screen.queryByText('REQUEST BODY')).toBeNull()
    expect(screen.getByText('Request')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Headers 3' }))
    expect(split(tabId)).toBe('normal')
  })

  it('names each toggle’s shortcut and reports its state', () => {
    mount()
    const collapse = screen.getByRole('button', { name: 'Collapse response (Ctrl+J)' })
    expect(collapse.getAttribute('aria-pressed')).toBe('false')
    expect(collapse.getAttribute('title')).toBe('Collapse response (Ctrl+J)')
    expect(screen.getByRole('button', { name: 'Collapse request (Ctrl+Shift+J)' })).toBeTruthy()
  })

  it('an error expands a collapsed response by itself', () => {
    const tabId = mount()
    act(() => useHttp.getState().setSplit(tabId, 'response-collapsed'))
    expect(screen.queryByText('RESPONSE BODY')).toBeNull()
    act(() => useHttp.getState().setResponse(tabId, { status: 'error', errorClass: 'dns', message: 'Host not found' }))
    expect(screen.getByText(/RESPONSE BODY/)).toBeTruthy()
  })

  it('puts the production rule on the URL row when the active environment is production', () => {
    mount()
    const row = screen.getByText('URL ROW').parentElement!
    expect(row.className).not.toContain('hc-prod')
    const ws = useApp.getState().activeWorkspaceId
    act(() => {
      useApi.getState().setEnvironment({ id: 'env1', workspaceId: ws, name: 'prod', color: 'rust', production: true, variables: [] })
      useApi.getState().setActiveEnvironment(ws, 'env1')
    })
    expect(row.className).toContain('hc-prod')
  })

  it('a double-click on the splitter restores this protocol’s default ratio', () => {
    mount()
    act(() => useHttp.getState().setPrefs({ ratios: { ...useHttp.getState().prefs.ratios, http: { h: 0.7, v: 0.8 } } }))
    expect(screen.getByTestId('split').dataset.ratio).toBe('0.8')
    fireEvent.doubleClick(screen.getByRole('separator'))
    expect(useHttp.getState().prefs.ratios.http).toEqual({ h: 0.7, v: 0.4 })
  })

  it('opens the Layout menu on a right-click on the splitter', () => {
    mount()
    fireEvent.contextMenu(screen.getByRole('separator'))
    // By text: B's ContextMenu gives radio and checkbox items their own roles.
    const menu = screen.getByRole('menu')
    for (const item of ['Auto', 'Side by side', 'Stacked', 'Sidebar', 'Response', 'Request', 'Cookies…', 'Reset pane sizes']) {
      expect(within(menu).getByText(item)).toBeTruthy()
    }
    fireEvent.click(within(menu).getByText('Stacked'))
    expect(useHttp.getState().prefs.orientation).toBe('vertical')
  })
})
