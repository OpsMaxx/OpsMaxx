// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { stubBridge } from './setup/renderer'
import type { WsEvent, WsOpenResult } from '../src/shared/httpSocket'
import type { WsRequest } from '../src/shared/apiModel'
import { useHttp } from '../src/renderer/src/store/http'
import { useWsSessions } from '../src/renderer/src/store/wsSessions'
import { openSocket, sendWsMessage } from '../src/renderer/src/lib/httpSend'
import { WsRequestPane } from '../src/renderer/src/components/http/ws/WsRequestPane'
import { MessageLog, INITIAL_VIEW } from '../src/renderer/src/components/http/ws/MessageLog'
import { submitWs } from '../src/renderer/src/components/http/ws/wsActions'

// The WebSocket tab (§2.12). Other streams' pieces are still stubs at this
// point, so each is replaced by the smallest stand-in that exposes the props
// this pane passes it: the assertions are about what the pane does with them.

vi.mock('../src/renderer/src/components/http/ProtocolLayout', async (actual) => ({
  ...(await actual<object>()),
  ProtocolLayout: (p: Record<string, ReactNode>) => (
    <div>
      <div data-testid="bar">{p.bar}</div>
      <div data-testid="request-tabs">{p.requestTabs}</div>
      <div data-testid="request-toolbar">{p.requestToolbar}</div>
      <div data-testid="request">{p.request}</div>
      <div data-testid="response">{p.response}</div>
      <div data-testid="response-summary">{p.responseSummary}</div>
    </div>
  )
}))
vi.mock('../src/renderer/src/components/common/CodeEditor', () => ({
  CodeEditor: (p: { value: string; onChange?: (v: string) => void; onSubmit?: () => void; ariaLabel: string }) => (
    <textarea
      aria-label={p.ariaLabel}
      value={p.value}
      onChange={(e) => p.onChange?.(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) p.onSubmit?.()
      }}
    />
  )
}))
vi.mock('../src/renderer/src/components/http/fields/VariableInput', () => ({
  VariableInput: (p: { value: string; onChange: (v: string) => void; ariaLabel: string }) => (
    <input aria-label={p.ariaLabel} value={p.value} onChange={(e) => p.onChange(e.target.value)} />
  )
}))
const stand = vi.hoisted(
  () => (name: string) => (p: { readOnly?: boolean; showDescription?: boolean; onShowDescription?: (on: boolean) => void }) => (
    <div data-testid={name} data-readonly={String(!!p.readOnly)} data-description={String(!!p.showDescription)}>
      {p.onShowDescription && <button onClick={() => p.onShowDescription!(!p.showDescription)}>Toggle description</button>}
    </div>
  )
)
vi.mock('../src/renderer/src/components/common/KeyValueTable', () => ({ KeyValueTable: stand('params-table') }))
vi.mock('../src/renderer/src/components/http/request/AuthEditor', async (actual) => ({
  ...(await actual<object>()),
  AuthEditor: stand('auth-editor')
}))
vi.mock('../src/renderer/src/components/http/request/HeadersEditor', () => ({ HeadersEditor: stand('headers-editor') }))
// Stream A's send layer, as it is specified: build, confirm, then hand the
// socket to the store. The spec here is what buildWsSpec would produce.
vi.mock('../src/renderer/src/lib/httpSend', async () => {
  const { useHttp } = await import('../src/renderer/src/store/http')
  const { useWsSessions } = await import('../src/renderer/src/store/wsSessions')
  return {
    openSocket: vi.fn(async (tabId: string) => {
      const req = useHttp.getState().tabs.find((t) => t.id === tabId)!.draft as WsRequest
      await useWsSessions.getState().connect(tabId, { url: req.url, protocols: req.protocols, via: { kind: 'direct' } })
    }),
    sendWsMessage: vi.fn((tabId: string, text: string) => useWsSessions.getState().send(tabId, text))
  }
})

let emit: (event: WsEvent) => void
let openResult: WsOpenResult
const bridge = {
  open: vi.fn(async () => openResult),
  send: vi.fn(async () => ({ ok: true as const })),
  close: vi.fn(async () => {}),
  onEvent: vi.fn((_id: string, cb: (e: WsEvent) => void) => {
    emit = cb
    return () => {}
  })
}
const clipboard = { write: vi.fn() }
const K8S = 'base64url.bearer.authorization.k8s.io.ZXlKaGJHY2lPaUp'

beforeEach(() => {
  vi.clearAllMocks()
  openResult = { ok: true, id: 'sock-1', protocol: '' }
  // Flush synchronously: the rAF batching has its own test in wsRing.test.ts.
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
    cb()
    return 0
  })
  stubBridge({ httpSocket: bridge, clipboard, http: { saveResponse: vi.fn(async () => null) } })
})

function newWsTab(url = 'wss://echo.example.test/raw'): string {
  const id = useHttp.getState().openScratch('ws')
  const tab = useHttp.getState().tabs.find((t) => t.id === id)!
  useHttp.getState().updateDraft(id, { ...(tab.draft as WsRequest), url })
  return id
}

const draftOf = (id: string): WsRequest => useHttp.getState().tabs.find((t) => t.id === id)!.draft as WsRequest

const incoming = (data: string): WsEvent => ({ type: 'frame', frame: { direction: 'incoming', opcode: 'text', data, at: Date.now() } })
const outgoing = (data: string): WsEvent => ({ type: 'frame', frame: { direction: 'outgoing', opcode: 'text', data, at: Date.now() } })

async function connected(id: string): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /^Connect$/ }))
  })
  expect(useWsSessions.getState().sessions[id].state).toBe('open')
}

const rows = (): HTMLElement[] => within(screen.getByRole('listbox', { name: 'Messages' })).queryAllByRole('option')

describe('connect and disconnect', () => {
  it('runs idle → connecting → open → closing → closed, through the send layer', async () => {
    const id = newWsTab()
    render(<WsRequestPane tabId={id} />)
    expect(screen.getAllByText('Not connected').length).toBeGreaterThan(0)

    await connected(id)
    expect(openSocket).toHaveBeenCalledWith(id)
    expect(bridge.open).toHaveBeenCalledWith(expect.objectContaining({ url: 'wss://echo.example.test/raw' }))
    expect(screen.getByRole('button', { name: /Disconnect/ })).toBeTruthy()
    expect(screen.getAllByText(/^Connected · 00:00:0\d · 0 msgs$/).length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('button', { name: /Disconnect/ }))
    expect(bridge.close).toHaveBeenCalledWith('sock-1')
    expect(useWsSessions.getState().sessions[id].state).toBe('closing')

    act(() => emit({ type: 'close', code: 1000, reason: '', wasClean: true }))
    expect(screen.getAllByText('Disconnected (1000)').length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: /^Connect$/ })).toBeTruthy()
  })

  it('shows an abnormal close as an error with Reconnect, and opens a collapsed response', async () => {
    const id = newWsTab()
    render(<WsRequestPane tabId={id} />)
    await connected(id)
    act(() => useHttp.getState().setSplit(id, 'response-collapsed'))

    act(() => emit({ type: 'close', code: 1006, reason: 'gone', wasClean: false }))
    expect(screen.getAllByText('Closed (1006) · gone').length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeTruthy()
    expect(useHttp.getState().tabs.find((t) => t.id === id)!.split).toBe('normal')
  })

  it('names the socket cap rather than showing main’s sentence', async () => {
    openResult = { ok: false, error: 'That is 16 open sockets, which is as many as OpsMaxx will hold. Close one first.' }
    const id = newWsTab()
    render(<WsRequestPane tabId={id} />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Connect$/ }))
    })
    expect(useWsSessions.getState().sessions[id].failure?.class).toBe('socket-cap')
    expect(screen.getAllByText('16 WebSockets are open, the most OpsMaxx allows').length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: 'Disconnect idle sockets…' })).toBeTruthy()
  })

  it('shows a declined production confirm as plain "not connected", not as an error', () => {
    const id = newWsTab()
    useHttp.getState().setSplit(id, 'response-collapsed')
    render(<WsRequestPane tabId={id} />)
    act(() => useWsSessions.getState().fail(id, { errorClass: 'prod-declined', message: 'Not connected.' }))
    expect(useWsSessions.getState().sessions[id].state).toBe('idle')
    const status = screen.getAllByText('Not connected — production confirm declined')[0]
    expect(status.className).not.toContain('is-failure')
    expect(screen.queryByRole('button', { name: 'Reconnect' })).toBeNull()
    expect(rows().some((r) => r.className.includes('is-error'))).toBe(false)
    expect(useHttp.getState().tabs.find((t) => t.id === id)!.split).toBe('response-collapsed')
    expect(screen.getByRole('button', { name: /^Connect$/ })).toBeTruthy()
  })

  it('refuses to connect on a bridge older than the window, and says to restart', async () => {
    stubBridge({ clipboard })
    const id = newWsTab()
    render(<WsRequestPane tabId={id} />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Connect$/ }))
    })
    expect(useWsSessions.getState().sessions[id].failure?.class).toBe('bridge-stale')
  })
})

describe('fix buttons', () => {
  const fixes: string[] = []
  const onFix = (e: Event): void => {
    fixes.push((e as CustomEvent<{ action: string }>).detail.action)
  }
  beforeEach(() => {
    fixes.length = 0
    document.addEventListener('hc-fix', onFix)
    return () => document.removeEventListener('hc-fix', onFix)
  })

  const failWith = (id: string, errorClass: 'route-missing' | 'tls' | 'unresolved-variable', message: string, unresolved?: string[]): void =>
    act(() => useWsSessions.getState().fail(id, { errorClass, message, unresolved }))

  it('hands route-missing to the workbench’s route menu', () => {
    const id = newWsTab()
    render(<WsRequestPane tabId={id} />)
    failWith(id, 'route-missing', 'That server was removed')
    fireEvent.click(screen.getByRole('button', { name: 'Choose where to send from' }))
    expect(fixes).toEqual(['route-menu'])
  })

  it('offers a CA, through a save first for a scratch tab, and never switches verification off', () => {
    const id = newWsTab()
    render(<WsRequestPane tabId={id} />)
    failWith(id, 'tls', 'self-signed certificate')
    fireEvent.click(screen.getByRole('button', { name: 'Save to a collection to add a CA…' }))
    expect(fixes).toEqual(['save-then-ca'])
    expect(screen.queryByRole('button', { name: /verif/i })).toBeNull()
  })

  it('hands the review refusals to the workbench', () => {
    const id = newWsTab()
    render(<WsRequestPane tabId={id} />)
    act(() => useWsSessions.getState().fail(id, { errorClass: 'other', message: "Review this environment's changes" }))
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))
    act(() => useWsSessions.getState().fail(id, { errorClass: 'other', message: "Review this collection's connection changes" }))
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))
    expect(fixes).toEqual(['review-env', 'review-collection'])
  })

  it('offers a restart on a stale bridge', async () => {
    stubBridge({ clipboard })
    const id = newWsTab()
    render(<WsRequestPane tabId={id} />)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /^Connect$/ })))
    fireEvent.click(screen.getByRole('button', { name: 'Restart OpsMaxx…' }))
    expect(fixes).toEqual(['restart'])
  })

  it('offers Add value, and Connect anyway unless the variable is in the host', async () => {
    const id = newWsTab('wss://{{host}}/feed?t={{token}}')
    render(<WsRequestPane tabId={id} />)
    failWith(id, 'unresolved-variable', '`token` is not defined', ['token'])
    fireEvent.click(screen.getByRole('button', { name: 'Add value…' }))
    expect(fixes).toEqual(['add-variable'])
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Connect anyway' })))
    expect(openSocket).toHaveBeenCalledWith(id, { allowUnresolved: true })

    failWith(id, 'unresolved-variable', '`host` is not defined', ['host'])
    expect(screen.queryByRole('button', { name: 'Connect anyway' })).toBeNull()
  })
})

describe('the upgrade request', () => {
  it('locks Params, Auth, Headers and Settings while connected', async () => {
    const id = newWsTab()
    render(<WsRequestPane tabId={id} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Params' }))
    expect(screen.getByTestId('params-table').dataset.readonly).toBe('false')

    await connected(id)
    expect(screen.getByTestId('params-table').dataset.readonly).toBe('true')
    expect(screen.getByText(/Disconnect to edit/)).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: 'Auth' }))
    expect(screen.getByTestId('auth-editor').dataset.readonly).toBe('true')
    fireEvent.click(screen.getByRole('tab', { name: 'Headers' }))
    expect(screen.getByTestId('headers-editor').dataset.readonly).toBe('true')
    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }))
    expect((screen.getByLabelText('Subprotocols') as HTMLInputElement).readOnly).toBe(true)
    // And the URL is shown, not editable: it is what the socket was opened to.
    expect(screen.getByLabelText('WebSocket URL').tagName).toBe('SPAN')
  })

  it('takes subprotocols as a comma list, and sends them with the upgrade', async () => {
    const id = newWsTab()
    render(<WsRequestPane tabId={id} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }))
    fireEvent.change(screen.getByLabelText('Subprotocols'), { target: { value: 'graphql-ws, v2.json,' } })
    expect(draftOf(id).protocols).toEqual(['graphql-ws', 'v2.json'])
    expect((screen.getByLabelText('Subprotocols') as HTMLInputElement).value).toBe('graphql-ws, v2.json,')

    await connected(id)
    expect(bridge.open).toHaveBeenCalledWith(expect.objectContaining({ protocols: ['graphql-ws', 'v2.json'] }))
  })

  it('says which subprotocol the last save did not keep, and takes a paste for it', async () => {
    const id = newWsTab()
    const tab = useHttp.getState().tabs.find((t) => t.id === id)!
    act(() =>
      useHttp.setState((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === id ? { ...t, draft: { ...(tab.draft as WsRequest), protocols: ['v1', ''] }, strippedFields: ['protocols.1'] } : t
        )
      }))
    )
    stubBridge({ httpSocket: bridge, clipboard: { ...clipboard, read: vi.fn(async () => K8S) } })
    render(<WsRequestPane tabId={id} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }))
    expect(screen.getByText(/Not kept from last session: subprotocol 2 carried a credential/)).toBeTruthy()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Paste' })))
    expect(draftOf(id).protocols).toEqual(['v1', K8S])
    expect(screen.queryByText(/Not kept from last session/)).toBeNull()
    // Now it holds a literal credential, which will not be saved either.
    expect(screen.getByText(/looks like a credential rather than a protocol name\. Not saved/)).toBeTruthy()
  })

  it('warns about exactly the subprotocols the save drops', () => {
    const id = newWsTab()
    render(<WsRequestPane tabId={id} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }))
    const warned = (value: string): boolean => {
      fireEvent.change(screen.getByLabelText('Subprotocols'), { target: { value } })
      return screen.queryByText(/Not saved: kept for this session only/) !== null
    }
    // Protocol names and references are kept, so no warning.
    expect(warned('graphql-transport-ws, v12.stomp, mqtt')).toBe(false)
    expect(warned('{{proto}}')).toBe(false)
    // A JWT-shaped value or anything else that is not a name is dropped, credential-shaped or not.
    expect(warned('eyJhbGciOiJIUzI1NiJ9abcdefghijklmnop')).toBe(true)
    expect(warned('not a name!')).toBe(true)
    expect(warned(K8S)).toBe(true)
  })

  it('offers a variable for a credential subprotocol, and masks it in the Handshake tab and the log', async () => {
    openResult = { ok: true, id: 'sock-1', protocol: K8S }
    const id = newWsTab()
    render(<WsRequestPane tabId={id} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }))
    fireEvent.change(screen.getByLabelText('Subprotocols'), { target: { value: `channel.k8s.io, ${K8S}` } })
    const asked: unknown[] = []
    const on = (e: Event): number => asked.push((e as CustomEvent).detail)
    document.addEventListener('hc-set-variable', on)
    fireEvent.click(screen.getByRole('button', { name: 'Set as variable…' }))
    document.removeEventListener('hc-set-variable', on)
    expect(asked).toEqual([{ tabId: id, name: 'subprotocol', value: K8S }])

    await connected(id)
    fireEvent.click(screen.getByRole('tab', { name: 'Handshake' }))
    const handshake = document.querySelector('.hc-ws-handshake')!.textContent!
    expect(handshake).not.toContain('ZXlKaGJHY2lPaUp')
    expect(handshake).toContain('base64url.bearer.authorization.•••')
    expect(screen.getByRole('tab', { name: 'Messages' })).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: 'Messages' }))
    expect(rows().some((r) => r.textContent?.includes('ZXlKaGJHY2lPaUp'))).toBe(false)
  })

  it('never shows a raw token the server echoed back as its subprotocol', async () => {
    openResult = { ok: true, id: 'sock-1', protocol: 'eyJhbGciOiJIUzI1NiJ9abcdefghijklmnop' }
    const id = newWsTab()
    const { container } = render(<WsRequestPane tabId={id} />)
    await connected(id)
    expect(rows().some((r) => r.textContent?.includes('Connected · subprotocol •••'))).toBe(true)
    fireEvent.click(screen.getByRole('tab', { name: 'Handshake' }))
    expect(screen.getByText('Subprotocol: •••')).toBeTruthy()
    expect(container.textContent).not.toContain('eyJhbGciOiJIUzI1NiJ9')
  })

  it('shows the subprotocol the server chose on the Handshake tab', async () => {
    openResult = { ok: true, id: 'sock-1', protocol: 'graphql-ws' }
    const id = newWsTab()
    render(<WsRequestPane tabId={id} />)
    await connected(id)
    expect(rows().some((r) => r.textContent?.includes('Connected · subprotocol graphql-ws'))).toBe(true)
    fireEvent.click(screen.getByRole('tab', { name: 'Handshake' }))
    expect(screen.getByText('Subprotocol: graphql-ws')).toBeTruthy()
  })
})

describe('structure', () => {
  it('labels each tab panel by its tab', () => {
    const id = newWsTab()
    render(<WsRequestPane tabId={id} />)
    fireEvent.click(screen.getByRole('tab', { name: /Params/ }))
    const tab = screen.getByRole('tab', { name: /Params/ })
    const panel = document.getElementById(tab.getAttribute('aria-controls')!)!
    expect(panel.getAttribute('role')).toBe('tabpanel')
    expect(panel.getAttribute('aria-labelledby')).toBe(tab.id)
    expect(within(panel).getByTestId('params-table')).toBeTruthy()
    const messages = screen.getByRole('tab', { name: 'Messages' })
    expect(document.getElementById(messages.getAttribute('aria-controls')!)!.getAttribute('aria-labelledby')).toBe(messages.id)
  })

  it('shows the Description column by the shared preference, and sets it', () => {
    const id = newWsTab()
    render(<WsRequestPane tabId={id} />)
    fireEvent.click(screen.getByRole('tab', { name: /Params/ }))
    expect(screen.getByTestId('params-table').dataset.description).toBe('false')
    fireEvent.click(screen.getByRole('button', { name: 'Toggle description' }))
    expect(useHttp.getState().prefs.kvDescriptions).toBe(true)
    expect(screen.getByTestId('params-table').dataset.description).toBe('true')
  })
})

describe('the composer', () => {
  it('connects on ⌘↵ while disconnected, and says "Connect to send"', async () => {
    const id = newWsTab()
    render(<WsRequestPane tabId={id} />)
    expect((screen.getByRole('button', { name: 'Connect to send' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'hello' } })
    await act(async () => {
      fireEvent.keyDown(screen.getByRole('textbox', { name: 'Message' }), { key: 'Enter', metaKey: true })
    })
    expect(openSocket).toHaveBeenCalledWith(id)
    expect(sendWsMessage).not.toHaveBeenCalled()
  })

  it('sends on ⌘↵ while connected and never disconnects', async () => {
    const id = newWsTab()
    render(<WsRequestPane tabId={id} />)
    await connected(id)
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: '{"op":"sub"}' } })
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        fireEvent.keyDown(screen.getByRole('textbox', { name: 'Message' }), { key: 'Enter', metaKey: true })
      })
    }
    expect(sendWsMessage).toHaveBeenCalledTimes(3)
    expect(sendWsMessage).toHaveBeenCalledWith(id, '{"op":"sub"}')
    expect(bridge.send).toHaveBeenCalledWith('sock-1', '{"op":"sub"}')
    expect(bridge.close).not.toHaveBeenCalled()
    expect(useWsSessions.getState().sessions[id].state).toBe('open')
    // The message stays, because the next one is usually a small edit of it.
    expect((screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement).value).toBe('{"op":"sub"}')
  })

  it('empties the composer after a send when "Clear on send" is on', async () => {
    const id = newWsTab()
    render(<WsRequestPane tabId={id} />)
    await connected(id)
    fireEvent.click(screen.getByLabelText(/Clear on send/))
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'ping' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Send/ }))
    })
    expect(sendWsMessage).toHaveBeenCalledWith(id, 'ping')
    expect((screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement).value).toBe('')
  })

  it('says a message with a literal credential is sent as typed, and says nothing for a reference', () => {
    const id = newWsTab()
    render(<WsRequestPane tabId={id} />)
    const box = screen.getByRole('textbox', { name: 'Message' })
    fireEvent.change(box, { target: { value: '{"op":"auth","token":"eyJhbGciOi"}' } })
    expect(screen.getByRole('note').textContent).toBe('token looks like a credential. It is sent to the server as typed.')
    // Nothing is saved, so the note must not claim it is.
    expect(screen.getByRole('note').textContent).not.toMatch(/saved|synced|history/i)
    fireEvent.change(box, { target: { value: '{"op":"auth","token":"{{token}}"}' } })
    expect(screen.queryByRole('note')).toBeNull()
  })

  it('does the same from the http-send hotkey, which calls submitWs', async () => {
    const id = newWsTab()
    render(<WsRequestPane tabId={id} />)
    await connected(id)
    act(() => useWsSessions.getState().setComposer(id, { text: 'x' }))
    await act(() => submitWs(id))
    expect(sendWsMessage).toHaveBeenCalledWith(id, 'x')
    expect(useWsSessions.getState().sessions[id].state).toBe('open')
  })
})

describe('the log', () => {
  it('shows direction as text, filters, and searches', async () => {
    const id = newWsTab()
    render(<WsRequestPane tabId={id} />)
    await connected(id)
    act(() => {
      emit(outgoing('{"op":"subscribe"}'))
      emit(incoming('{"topic":"alpha"}'))
      emit(incoming('{"topic":"beta"}'))
    })
    expect(rows().map((r) => r.querySelector('.hc-ws-dir')!.textContent!.trim())).toEqual([
      'System',
      'System',
      'Sent',
      'Received',
      'Received'
    ])

    fireEvent.change(screen.getByLabelText('Filter messages'), { target: { value: 'in' } })
    expect(rows()).toHaveLength(2)
    fireEvent.change(screen.getByLabelText('Search messages'), { target: { value: 'BETA' } })
    expect(rows()).toHaveLength(1)
    expect(rows()[0].textContent).toContain('{"topic":"beta"}')
  })

  it('renders a frame as text, never as markup', async () => {
    const id = newWsTab()
    const { container } = render(<WsRequestPane tabId={id} />)
    await connected(id)
    act(() => emit(incoming('<img src=x onerror="window.pwned=1"><b>bold</b>')))
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('b')).toBeNull()
    expect(screen.getByText(/<img src=x/)).toBeTruthy()
  })

  it('pauses on request and counts what arrives in a "↓ N new" pill', async () => {
    const id = newWsTab()
    render(<WsRequestPane tabId={id} />)
    await connected(id)
    fireEvent.click(screen.getByRole('button', { name: 'Pause auto-scroll' }))
    act(() => {
      emit(incoming('one'))
      emit(incoming('two'))
    })
    const pill = screen.getByRole('button', { name: /2 new/ })
    fireEvent.click(pill)
    expect(screen.queryByRole('button', { name: /new$/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Pause auto-scroll' })).toBeTruthy()
  })

  it('pauses by itself when the user scrolls up', async () => {
    const id = newWsTab()
    render(<WsRequestPane tabId={id} />)
    await connected(id)
    const list = screen.getByRole('listbox', { name: 'Messages' })
    Object.defineProperty(list, 'scrollHeight', { value: 2000, configurable: true })
    Object.defineProperty(list, 'clientHeight', { value: 200, configurable: true })
    list.scrollTop = 100
    fireEvent.scroll(list)
    expect(screen.getByRole('button', { name: 'Resume auto-scroll' })).toBeTruthy()
    act(() => emit(incoming('later')))
    expect(screen.getByRole('button', { name: /1 new/ })).toBeTruthy()
  })

  it('clears the log without touching the connection', async () => {
    const id = newWsTab()
    render(<WsRequestPane tabId={id} />)
    await connected(id)
    act(() => emit(incoming('a')))
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Clear log' })))
    expect(rows()).toHaveLength(0)
    expect(useWsSessions.getState().sessions[id].state).toBe('open')
  })

  it('puts the detail beside the rows when the pane is wide, and under them when not', async () => {
    const id = newWsTab()
    await act(() => openSocket(id))
    act(() => emit(incoming('{"a":1}')))
    const view = { view: INITIAL_VIEW, onView: () => {}, onLoadIntoComposer: () => {} }

    const { unmount } = render(<MessageLog tabId={id} width={600} {...view} />)
    fireEvent.click(rows().at(-1)!)
    expect(screen.getByRole('region', { name: 'Message detail' }).className).toContain('is-right')
    // Pretty by default, and Esc closes it.
    expect(screen.getByRole('region', { name: 'Message detail' }).textContent).toContain('"a": 1')
    fireEvent.keyDown(screen.getByRole('region', { name: 'Message detail' }), { key: 'Escape' })
    expect(screen.queryByRole('region', { name: 'Message detail' })).toBeNull()
    unmount()

    render(<MessageLog tabId={id} width={559} {...view} />)
    fireEvent.click(rows().at(-1)!)
    expect(screen.getByRole('region', { name: 'Message detail' }).className).toContain('is-below')
  })

  it('resends a sent row through the send layer, and only while connected', async () => {
    const id = newWsTab()
    render(<WsRequestPane tabId={id} />)
    await connected(id)
    act(() => emit(outgoing('again')))
    fireEvent.contextMenu(rows().at(-1)!)
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Resend' }))
    })
    expect(sendWsMessage).toHaveBeenCalledWith(id, 'again')

    act(() => emit({ type: 'close', code: 1000, reason: '', wasClean: true }))
    fireEvent.contextMenu(rows().find((r) => r.textContent?.includes('again'))!)
    expect((screen.getByRole('menuitem', { name: 'Resend' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('offers pretty JSON only for JSON, and copies through the bridge', async () => {
    const id = newWsTab()
    render(<WsRequestPane tabId={id} />)
    await connected(id)
    act(() => emit(incoming('plain')))
    fireEvent.contextMenu(rows().at(-1)!)
    expect((screen.getByRole('menuitem', { name: 'Copy as pretty JSON' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy message' }))
    expect(clipboard.write).toHaveBeenCalledWith('plain')
  })
})

describe('accessibility', () => {
  it('announces the connection state in the live region, and never a frame', async () => {
    const id = newWsTab()
    render(<WsRequestPane tabId={id} />)
    await connected(id)
    act(() => emit(incoming('secret-looking frame body')))
    const live = screen.getByRole('status')
    expect(live.getAttribute('aria-live')).toBe('polite')
    expect(live.textContent).toBe('WebSocket connected')
    act(() => emit({ type: 'close', code: 1001, reason: 'bye', wasClean: true }))
    expect(live.textContent).toBe('WebSocket closed, code 1001')
  })
})

describe('lifetime', () => {
  it('keeps the socket when the tab is switched away, and closes it with the tab', async () => {
    const id = newWsTab()
    const { unmount } = render(<WsRequestPane tabId={id} />)
    await connected(id)
    unmount()
    act(() => emit(incoming('while away')))
    expect(useWsSessions.getState().sessions[id].state).toBe('open')
    expect(bridge.close).not.toHaveBeenCalled()

    render(<WsRequestPane tabId={id} />)
    expect(rows().some((r) => r.textContent?.includes('while away'))).toBe(true)

    act(() => useHttp.getState().closeTab(id))
    expect(bridge.close).toHaveBeenCalledWith('sock-1')
    expect(useWsSessions.getState().sessions[id]).toBeUndefined()
    expect(useWsSessions.getState().ringFor(id)).toHaveLength(0)
  })

  it('frees the ring, session and composer when the tab closes after the server already closed', async () => {
    const id = newWsTab()
    render(<WsRequestPane tabId={id} />)
    await connected(id)
    act(() => {
      useWsSessions.getState().setComposer(id, { text: 'draft' })
      emit(incoming('a'))
      emit({ type: 'close', code: 1006, reason: '', wasClean: false })
    })
    expect(useWsSessions.getState().ringFor(id).length).toBeGreaterThan(0)
    act(() => useHttp.getState().closeTab(id))
    expect(useWsSessions.getState().ringFor(id)).toHaveLength(0)
    expect(useWsSessions.getState().sessions[id]).toBeUndefined()
    expect(useWsSessions.getState().composers[id]).toBeUndefined()
    // Nothing to close: the server already had.
    expect(bridge.close).not.toHaveBeenCalled()
  })

  it('frees them after a failed connect too', async () => {
    openResult = { ok: false, error: 'connect ECONNREFUSED 127.0.0.1:9', code: 'ECONNREFUSED' }
    const id = newWsTab()
    render(<WsRequestPane tabId={id} />)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /^Connect$/ })))
    expect(useWsSessions.getState().sessions[id].state).toBe('error')
    act(() => useHttp.getState().closeTab(id))
    expect(useWsSessions.getState().sessions[id]).toBeUndefined()
    expect(useWsSessions.getState().ringFor(id)).toHaveLength(0)
  })

  it('closes a socket whose tab went while the handshake was in flight', async () => {
    let finish!: (r: WsOpenResult) => void
    bridge.open.mockImplementationOnce(() => new Promise<WsOpenResult>((r) => (finish = r)))
    const id = newWsTab()
    const pending = useWsSessions.getState().connect(id, { url: 'ws://x.test/', via: { kind: 'direct' } })
    useHttp.getState().closeTab(id)
    finish({ ok: true, id: 'late', protocol: '' })
    await pending
    expect(bridge.close).toHaveBeenCalledWith('late')
    expect(bridge.onEvent).not.toHaveBeenCalled()
  })
})
