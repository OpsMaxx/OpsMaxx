// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { defaults, type HttpRequest, type Id } from '../src/shared/apiModel'
import { HttpWorkbench } from '../src/renderer/src/components/http/HttpWorkbench'
import { httpHotkey, useHttp } from '../src/renderer/src/store/http'
import { useApi } from '../src/renderer/src/store/api'
import { useApp } from '../src/renderer/src/store/app'
import { useToasts } from '../src/renderer/src/store/toast'
import { requestClose } from '../src/renderer/src/components/http/tabs/closing'
import * as httpSend from '../src/renderer/src/lib/httpSend'
import { stubBridge } from './setup/renderer'
import { askProduction, useHttpRuntime } from '../src/renderer/src/store/httpRuntime'

// The workbench root (§2.9, §2.10): ghost, surfaces, close prompt, keys, fixes.

vi.mock('../src/renderer/src/lib/httpSend', () => ({
  send: vi.fn(async () => undefined),
  cancel: vi.fn(),
  runGraphQl: vi.fn(async () => undefined),
  openSocket: vi.fn(async () => undefined),
  sendWsMessage: vi.fn(async () => undefined),
  confirmIfProduction: vi.fn(async () => true),
  sendAgainFromHistory: vi.fn(async () => undefined),
  copyAsCurl: vi.fn(async () => true)
}))

// C's pane is a stub today; this one is the smallest real pane: a URL field in ProtocolLayout's bar.
vi.mock('../src/renderer/src/components/http/request/HttpRequestPane', async () => {
  const { ProtocolLayout } = await vi.importActual<typeof import('../src/renderer/src/components/http/ProtocolLayout')>(
    '../src/renderer/src/components/http/ProtocolLayout'
  )
  const { useHttp: store } = await vi.importActual<typeof import('../src/renderer/src/store/http')>(
    '../src/renderer/src/store/http'
  )
  function Url({ tabId }: { tabId: Id }): React.JSX.Element {
    const url = store((s) => (s.requestFor(tabId) as HttpRequest | null)?.url ?? '')
    return (
      <input
        aria-label="URL"
        data-hc-url
        value={url}
        onChange={(e) =>
          store
            .getState()
            .updateDraft(tabId, { ...(store.getState().requestFor(tabId) as HttpRequest), url: e.target.value })
        }
      />
    )
  }
  return {
    HttpRequestPane: ({ tabId }: { tabId: Id }) => (
      <ProtocolLayout
        tabId={tabId}
        kind="http"
        bar={<Url tabId={tabId} />}
        requestTabs={null}
        request={null}
        response={<div>RESPONSE</div>}
        requestSummary={null}
        responseSummary={null}
      />
    )
  }
})

const ws = (): string => useApp.getState().activeWorkspaceId
const nextFrame = (): Promise<void> => act(() => new Promise<void>((r) => requestAnimationFrame(() => r())))

beforeEach(() => useApp.setState({ activity: 'http' }))

describe('HttpWorkbench', () => {
  it('opens on a live, focused URL row with the ways in below it', async () => {
    render(<HttpWorkbench />)
    await nextFrame()
    expect(screen.getByText('Send a request')).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByLabelText('URL'))
    expect(useHttp.getState().tabs).toEqual([])
    expect(screen.getByRole('tablist', { name: 'Request tabs' }).children).toHaveLength(0)
  })

  it('promotes the ghost on the first keystroke without remounting the URL field', async () => {
    render(<HttpWorkbench />)
    await nextFrame()
    const field = screen.getByLabelText('URL')
    const ghost = useHttp.getState().ghost[ws()].id
    fireEvent.change(field, { target: { value: 'h' } })
    expect(useHttp.getState().tabs.map((t) => t.id)).toEqual([ghost])
    expect(screen.getByLabelText('URL')).toBe(field)
    expect(document.activeElement).toBe(field)
    expect(screen.queryByText('Send a request')).toBeNull()
    expect(screen.getByRole('tab').getAttribute('aria-selected')).toBe('true')
  })

  it('pastes into the ghost when nothing editable has focus', async () => {
    render(<HttpWorkbench />)
    await nextFrame()
    ;(document.activeElement as HTMLElement).blur()
    useApp.setState({ activity: 'http' })
    const paste = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
    Object.defineProperty(paste, 'clipboardData', { value: { getData: () => ' https://example.test/get ' } })
    act(() => void document.dispatchEvent(paste))
    expect((useHttp.getState().tabs[0].draft as HttpRequest).url).toBe('https://example.test/get')
  })

  it('registers its keys while mounted, and only then', () => {
    const { unmount } = render(<HttpWorkbench />)
    expect(httpHotkey('http-send')).toBeTypeOf('function')
    unmount()
    expect(httpHotkey('http-send')).toBeUndefined()
  })

  it('asks before closing a saved request with edits, once for all of them', () => {
    const col = useApi.getState().createCollection('httpbin')
    const req = { ...defaults.http(), name: 'r0' }
    useApi.getState().addItem(col, null, req)
    render(<HttpWorkbench />)
    act(() => {
      const t = useHttp.getState().openRequest({ collectionId: col, requestId: req.id })
      useHttp.getState().updateDraft(t, { ...req, method: 'DELETE' })
      requestClose([t])
    })
    expect(screen.getByText('Save changes to “r0”?')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Don’t save' }))
    expect(useHttp.getState().tabs).toEqual([])
    expect(useHttp.getState().pendingClose).toBeNull()
  })

  it('Save all keeps a tab it could not save open, and takes it to the Save dialog', () => {
    const col = useApi.getState().createCollection('httpbin')
    const [r0, r1] = [
      { ...defaults.http(), name: 'r0' },
      { ...defaults.http(), name: 'r1' }
    ]
    useApi.getState().addItem(col, null, r0)
    useApi.getState().addItem(col, null, r1)
    render(<HttpWorkbench />)
    let tabs: string[] = []
    act(() => {
      tabs = [r0, r1].map((r) => useHttp.getState().openRequest({ collectionId: col, requestId: r.id }))
      tabs.forEach((t, i) => useHttp.getState().updateDraft(t, { ...[r0, r1][i], method: 'PUT' }))
      useApi.getState().deleteItem(col, r1.id)
      requestClose(tabs)
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save all' }))
    expect(useHttp.getState().tabs.map((t) => t.id)).toEqual([tabs[1]])
    expect((useHttp.getState().tabs[0].draft as HttpRequest).method).toBe('PUT')
    expect(useHttp.getState().overlay).toBe('save')
    expect(useHttp.getState().activeTab[useApp.getState().activeWorkspaceId]).toBe(tabs[1])
  })

  it('saves a request whose collection was deleted as sending from this machine, never a removed server', () => {
    const col = useApi.getState().createCollection('gone')
    const req = { ...defaults.http(), name: 'orphan' }
    useApi.getState().addItem(col, null, req)
    render(<HttpWorkbench />)
    let tab = ''
    act(() => {
      tab = useHttp.getState().openRequest({ collectionId: col, requestId: req.id })
      useHttp.getState().updateDraft(tab, { ...req, url: 'https://example.test/kept' })
      useApi.setState({ collections: [] })
      useHttp.getState().setOverlay('save')
    })
    expect(screen.getByText('This machine')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/removed server/i)
    // The dialog's second field is the new collection's name (no collection is left to pick).
    fireEvent.change(within(screen.getByRole('dialog')).getAllByRole('textbox')[1], { target: { value: 'rescued' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    const saved = useApi.getState().collections.find((c) => c.name === 'rescued')!
    expect(saved.viaServerId).toBeNull()
    expect(saved.vpnProfileId ?? null).toBeNull()
    expect(useHttp.getState().tabs.find((t) => t.id === tab)?.ref?.collectionId).toBe(saved.id)
  })

  it('closes a scratch tab without asking, and offers it back', () => {
    render(<HttpWorkbench />)
    act(() => requestClose([useHttp.getState().openScratch('http')]))
    expect(useHttp.getState().tabs).toEqual([])
    const t = useToasts.getState().toasts.at(-1)!
    expect(t.message).toBe('Closed · Reopen (Ctrl+Shift+Z)')
    act(() => t.action!.run())
    expect(useHttp.getState().tabs).toHaveLength(1)
  })

  it('Esc cancels a request in flight, unless something is open over the workbench', () => {
    render(<HttpWorkbench />)
    act(() => {
      const t = useHttp.getState().openScratch('http')
      useHttp.getState().setResponse(t, { status: 'sending', startedAt: 1, requestId: 'r1' })
    })
    const menu = document.body.appendChild(document.createElement('div'))
    menu.setAttribute('role', 'menu')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(httpSend.cancel).not.toHaveBeenCalled()
    menu.remove()
    // Behind another activity the view stays mounted; Esc there is not the HTTP client's.
    useApp.setState({ activity: 'connections' })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(httpSend.cancel).not.toHaveBeenCalled()
    useApp.setState({ activity: 'http' })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(httpSend.cancel).toHaveBeenCalledWith(useHttp.getState().tabs[0].id)
  })

  it('does not take focus while another activity is showing', async () => {
    useApp.setState({ activity: 'connections' })
    const other = document.body.appendChild(document.createElement('input'))
    other.focus()
    render(<HttpWorkbench />)
    await nextFrame()
    expect(document.activeElement).toBe(other)
    other.remove()
  })

  it('returns focus to the tab after a rename', async () => {
    render(<HttpWorkbench />)
    act(() => void useHttp.getState().openScratch('http'))
    const tab = screen.getByRole('tab')
    fireEvent.keyDown(tab, { key: 'F2' })
    const input = screen.getByRole('textbox', { name: 'Tab name' })
    fireEvent.change(input, { target: { value: 'Login' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await nextFrame()
    expect((useHttp.getState().tabs[0].draft as HttpRequest).name).toBe('Login')
    expect(document.activeElement).toBe(screen.getByRole('tab'))
  })

  it('handles the error fixes that act outside the response pane', () => {
    const col = useApi.getState().createCollection('internal')
    const req = defaults.http()
    useApi.getState().addItem(col, null, req)
    render(<HttpWorkbench />)
    let tab = ''
    act(() => void (tab = useHttp.getState().openRequest({ collectionId: col, requestId: req.id })))
    const fix = (action: string): void =>
      act(() => {
        document
          .querySelector('.hc-surface')!
          .dispatchEvent(new CustomEvent('hc-fix', { bubbles: true, detail: { tabId: tab, action } }))
      })
    fix('add-ca')
    const colTab = useHttp.getState().tabs.find((t) => t.kind === 'collection')!
    expect(useHttp.getState().collectionSection[colTab.id]).toBe('connection')
    fix('add-variable')
    expect(useHttp.getState().overlay).toBe('env')
    act(() => useHttp.getState().setOverlay(null))
    fix('choose-vault')
    expect(useHttp.getState().overlay).toBe('env')
  })

  it('opens where synced changes are reviewed, for the review fixes', () => {
    const col = useApi.getState().createCollection('synced')
    const req = defaults.http()
    useApi.getState().addItem(col, null, req)
    render(<HttpWorkbench />)
    let tab = ''
    act(() => void (tab = useHttp.getState().openRequest({ collectionId: col, requestId: req.id })))
    const fix = (action: string): void =>
      act(() => {
        document
          .querySelector('.hc-surface')!
          .dispatchEvent(new CustomEvent('hc-fix', { bubbles: true, detail: { tabId: tab, action } }))
      })
    fix('review-collection')
    const colTab = useHttp.getState().tabs.find((t) => t.kind === 'collection')!
    expect(colTab.ref?.collectionId).toBe(col)
    expect(useHttp.getState().collectionSection[colTab.id]).toBe('connection')
    act(() => useHttp.getState().activateTab(tab))
    fix('review-env')
    const active = useHttp.getState().tabs.find((t) => t.id === useHttp.getState().activeTab[useApp.getState().activeWorkspaceId])
    expect(active?.kind).toBe('environments')
  })

  it('shows a deleted saved request as gone, with a way to close it', () => {
    render(<HttpWorkbench />)
    act(() => void useHttp.getState().openRequest({ collectionId: 'col_gone', requestId: 'req_gone' }))
    expect(screen.getByText('This request no longer exists')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Close tab' }))
    expect(useHttp.getState().tabs).toEqual([])
  })

  it('asks the production question the send layer raises, and passes the answer back', async () => {
    render(<HttpWorkbench />)
    let answer: Promise<boolean> = Promise.resolve(false)
    act(() => {
      answer = askProduction(
        {
          action: 'DELETE',
          target: 'prod',
          via: 'bastion-prod',
          skipLabel: 'Don’t ask again this session for DELETE on prod'
        },
        'prod|DELETE'
      )
    })
    expect(screen.getByText('Send DELETE to production (prod, via bastion-prod)?')).toBeTruthy()
    fireEvent.click(screen.getByLabelText(/Don’t ask again/))
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await expect(answer).resolves.toBe(true)
    expect(useHttpRuntime.getState()).toMatchObject({ prompt: null, skip: { 'prod|DELETE': true } })
  })

  it('hosts Set as variable…, Copy as cURL and Import from the URL row', () => {
    render(<HttpWorkbench />)
    const surface = document.querySelector('.hc-surface')!
    act(() => {
      surface.dispatchEvent(
        new CustomEvent('hc-set-variable', {
          bubbles: true,
          detail: { tabId: 'tab_x', name: 'access_token', value: 'v' }
        })
      )
    })
    expect(screen.getByText('Set as variable')).toBeTruthy()
    const tab = useHttp.getState().openScratch('http', { ...defaults.http(), url: 'https://example.test/get' })
    const command = (c: string): void =>
      act(
        () =>
          void surface.dispatchEvent(
            new CustomEvent('hc-command', { bubbles: true, detail: { tabId: tab, command: c } })
          )
      )
    command('copy-curl')
    expect(httpSend.copyAsCurl).toHaveBeenLastCalledWith(tab, { secrets: 'mask' })
    // With secrets only after its own confirm.
    command('copy-curl-secrets')
    expect(httpSend.copyAsCurl).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Copy with secrets' }))
    expect(httpSend.copyAsCurl).toHaveBeenLastCalledWith(tab, { secrets: 'include' })
    act(() => {
      surface.dispatchEvent(
        new CustomEvent('hc-command', { bubbles: true, detail: { tabId: tab, command: 'import-curl' } })
      )
    })
    expect(useHttp.getState()).toMatchObject({ overlay: 'import', importTarget: null })
  })

  it('opens B’s Save dialog for the active scratch tab', () => {
    render(<HttpWorkbench />)
    act(() => {
      useHttp.getState().openScratch('http')
      useHttp.getState().setOverlay('save')
    })
    expect(screen.getByText('Save request')).toBeTruthy()
  })

  it('Recover old data… re-runs the migration from the legacy copy', () => {
    const recoverLegacy = vi.fn(() => ['col_r'])
    useApi.setState({
      recoverLegacy,
      report: {
        id: 'm',
        collections: 1,
        requests: 1,
        environments: 0,
        needsReimport: [],
        dropped: [],
        rejected: [],
        baseUrlCollisions: [],
        shedForCap: []
      }
    })
    render(<HttpWorkbench />)
    fireEvent.click(screen.getByRole('button', { name: 'Recover old data…' }))
    expect(recoverLegacy).toHaveBeenCalledOnce()
    expect(useToasts.getState().toasts.at(-1)?.message).toBe('Recovered 1 collection from before the upgrade.')
  })

  it('a restart saves what is pending before it relaunches', async () => {
    const order: string[] = []
    stubBridge({
      data: { save: vi.fn(async () => void order.push('save')) },
      backup: { relaunch: vi.fn(async () => void order.push('relaunch')) }
    })
    render(<HttpWorkbench />)
    act(() => {
      document
        .querySelector('.hc-surface')!
        .dispatchEvent(new CustomEvent('hc-fix', { bubbles: true, detail: { tabId: 'tab_x', action: 'restart' } }))
    })
    await vi.waitFor(() => expect(order).toEqual(['save', 'relaunch']))
  })
})
