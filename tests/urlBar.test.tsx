// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { EditorView } from '@codemirror/view'
import { stubBridge } from './setup/renderer'

// Everything here is real (A's URL helpers, E's cURL parser, B's primitives,
// S's chips) except the send itself, which would reach main.
vi.mock('../src/renderer/src/lib/httpSend', () => ({ send: vi.fn().mockResolvedValue(undefined), cancel: vi.fn() }))

import { UrlBar, HTTP_COMMAND_EVENT } from '../src/renderer/src/components/http/request/UrlBar'
import { ParamsEditor } from '../src/renderer/src/components/http/request/ParamsEditor'
import { syncFromParams, syncFromUrl, withResolvedScheme } from '../src/renderer/src/components/http/request/requestModel'
import { useHttp } from '../src/renderer/src/store/http'
import { useApi } from '../src/renderer/src/store/api'
import { useToasts } from '../src/renderer/src/store/toast'
import { send } from '../src/renderer/src/lib/httpSend'
import { defaults, type HttpRequest, type HttpTabState } from '../src/shared/apiModel'

const TAB = 'tab_1'
const WS = 'ws_1'
const req = (patch: Partial<HttpRequest> = {}): HttpRequest => ({ ...defaults.http(), id: 'req_1', ...patch })
const url = (): HTMLElement => screen.getByRole('textbox', { name: 'URL' })
function typeUrl(text: string): void {
  const view = EditorView.findFromDOM(url())!
  act(() => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, userEvent: 'input.type' }))
}
const draft = (): HttpRequest => useHttp.getState().tabs.find((t) => t.id === TAB)!.draft as HttpRequest

function setup(r: HttpRequest, tab: Partial<HttpTabState> = {}): void {
  useHttp.setState({
    tabs: [{ id: TAB, workspaceId: WS, preview: false, split: 'normal', kind: 'request', draft: r, ...tab }],
    activeTab: { [WS]: TAB }
  })
}

let write: ReturnType<typeof vi.fn>
beforeEach(() => {
  write = vi.fn()
  stubBridge({ clipboard: { write, read: vi.fn().mockResolvedValue('') }, http: { saveResponse: vi.fn() } })
  vi.mocked(send).mockClear()
})

describe('URL ↔ params', () => {
  it('typing a query fills the params; disabled rows stay out of the URL and keep their place', () => {
    const start = req({ url: 'https://h/x?a=1', params: [{ id: 'p1', enabled: true, key: 'a', value: '1' }, { id: 'p2', enabled: false, key: 'off', value: 'v' }] })
    const next = syncFromUrl(start, 'https://h/x?a=2&b=3')
    expect(next.params).toEqual([
      { id: 'p1', enabled: true, key: 'a', value: '2' },
      { id: 'p2', enabled: false, key: 'off', value: 'v' },
      expect.objectContaining({ enabled: true, key: 'b', value: '3' })
    ])
    const back = syncFromParams(next, next.params.map((p) => (p.key === 'b' ? { ...p, enabled: false } : p)))
    expect(back.url).toBe('https://h/x?a=2')
  })

  it('path params follow :id and {id}, keeping values of names that survive', () => {
    const start = req({ url: 'https://h/users/:id', pathParams: [{ id: 'pp', enabled: true, key: 'id', value: '42' }] })
    const next = syncFromUrl(start, 'https://h/users/:id/posts/{postId}')
    expect(next.pathParams.map((p) => [p.key, p.value])).toEqual([['id', '42'], ['postId', '']])
    expect(next.pathParams[0].id).toBe('pp')
  })

  it('the URL field and the params table stay in step through the UI', () => {
    setup(req({ url: 'https://h/x' }))
    render(<UrlBar tabId={TAB} />)
    typeUrl('https://h/x?limit=10')
    expect(draft().params.map((p) => [p.key, p.value])).toEqual([['limit', '10']])
    render(<ParamsEditor req={draft()} onChange={(r) => useHttp.getState().updateDraft(TAB, r)} chain={{ layers: [] }} />)
    fireEvent.click(screen.getByLabelText('Enable limit'))
    expect(draft().url).toBe('https://h/x')
    expect(draft().params[0].enabled).toBe(false)
  })
})

describe('UrlBar', () => {
  it('offers every method including TRACE, and changes it', () => {
    setup(req())
    render(<UrlBar tabId={TAB} />)
    const picker = screen.getByLabelText('Method') as HTMLSelectElement
    expect([...picker.options].map((o) => o.value)).toEqual(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE'])
    fireEvent.change(picker, { target: { value: 'TRACE' } })
    expect(draft().method).toBe('TRACE')
  })

  it('renders the route chip, and the TLS chip for a collection that skips verification', () => {
    useApi.setState({ collections: [{ ...defaults.collection(WS, 'lab'), id: 'col_1', insecureTls: true }] })
    setup(req(), { ref: { collectionId: 'col_1', requestId: 'req_1' } })
    render(<UrlBar tabId={TAB} />)
    expect(document.querySelector('[data-hc-route-chip]')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Certificate verification is off for this collection/ })).toBeTruthy()
  })

  it('writes the inferred scheme back into the URL, then sends', async () => {
    setup(req({ url: 'localhost:8080/x?a=1', params: [{ id: 'p1', enabled: true, key: 'a', value: '1' }] }))
    render(<UrlBar tabId={TAB} />)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Send' })))
    expect(draft().url).toBe('http://localhost:8080/x?a=1')
    expect(send).toHaveBeenCalledWith(TAB)
  })

  it('leaves a written scheme and a {{template}} alone', () => {
    expect(withResolvedScheme('https://h/x')).toBe('https://h/x')
    expect(withResolvedScheme('{{baseUrl}}/x')).toBe('{{baseUrl}}/x')
    expect(withResolvedScheme('api.example.test/x')).toBe('https://api.example.test/x')
  })

  it('the ghost row promotes into a real tab, same id, on the first keystroke', () => {
    const ghost: HttpTabState = { id: 'tab_ghost', workspaceId: WS, preview: false, split: 'normal', kind: 'request', draft: req() }
    useHttp.setState({ tabs: [], ghost: { [WS]: ghost } })
    render(<UrlBar tabId="tab_ghost" ghost />)
    typeUrl('h')
    const s = useHttp.getState()
    expect(s.tabs.map((t) => t.id)).toEqual(['tab_ghost'])
    expect((s.tabs[0].draft as HttpRequest).url).toBe('h')
  })

  it('the Send menu hands Copy as cURL to the workbench', () => {
    setup(req())
    render(<UrlBar tabId={TAB} />)
    const seen: unknown[] = []
    document.addEventListener(HTTP_COMMAND_EVENT, (e) => seen.push((e as CustomEvent).detail))
    fireEvent.click(screen.getByRole('button', { name: 'More Send options' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /^Copy as cURL\b(?! \()/ }))
    fireEvent.click(screen.getByRole('button', { name: 'More Send options' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /with secrets/ }))
    expect(seen).toEqual([
      { tabId: TAB, command: 'copy-curl' },
      { tabId: TAB, command: 'copy-curl-secrets' }
    ])
  })
})

describe('cURL paste (UX-M12)', () => {
  const paste = (text: string): void => {
    fireEvent.paste(url(), { clipboardData: { getData: () => text } })
  }

  it('replaces a scratch draft in place, with Undo', () => {
    setup(req({ url: 'https://old.example.test' }))
    render(<UrlBar tabId={TAB} />)
    paste(`curl -k -X POST https://curl.example.test/x -H 'Accept: text/plain'`)
    expect(draft()).toMatchObject({ id: 'req_1', method: 'POST', url: 'https://curl.example.test/x' })
    expect(draft().headers.map((h) => [h.key, h.value])).toEqual([['Accept', 'text/plain']])
    const toast = useToasts.getState().toasts.at(-1)!
    expect(toast.message).toContain('Imported from cURL')
    expect(toast.message).toMatch(/certificate checks/)
    act(() => toast.action!.run())
    expect(draft().url).toBe('https://old.example.test')
  })

  it('opens a new tab for a saved request, and can replace it instead', () => {
    setup(req({ url: 'https://saved.example.test' }), { ref: { collectionId: 'col_1', requestId: 'req_1' } })
    render(<UrlBar tabId={TAB} />)
    paste('curl https://curl.example.test/x')
    const tabs = useHttp.getState().tabs
    expect(tabs).toHaveLength(2)
    expect((tabs[1].draft as HttpRequest).url).toBe('https://curl.example.test/x')
    expect(draft().url).toBe('https://saved.example.test')
    const toast = useToasts.getState().toasts.at(-1)!
    expect(toast.action!.label).toBe('Replace this request instead')
    act(() => toast.action!.run())
    expect(useHttp.getState().tabs).toHaveLength(1)
    expect(draft()).toMatchObject({ id: 'req_1', url: 'https://curl.example.test/x' })
  })

  it('ordinary text is pasted as text', () => {
    setup(req())
    render(<UrlBar tabId={TAB} />)
    paste('https://plain.example.test')
    expect(useHttp.getState().tabs).toHaveLength(1)
    expect(useToasts.getState().toasts).toHaveLength(0)
  })
})
