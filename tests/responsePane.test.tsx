// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { EditorView } from '@codemirror/view'
import { foldedRanges } from '@codemirror/language'
import { stubBridge } from './setup/renderer'

vi.mock('../src/renderer/src/lib/httpSend', () => ({ cancel: vi.fn() }))

import { ResponsePane, HTTP_FIX_EVENT, HTTP_SET_VARIABLE_EVENT, unresolvedInOrigin } from '../src/renderer/src/components/http/response/ResponsePane'
import { ResponseStatus } from '../src/renderer/src/components/http/response/ResponseStatus'
import { useHttp } from '../src/renderer/src/store/http'
import { cancel } from '../src/renderer/src/lib/httpSend'
import { defaults, type ResponseState, type SentView } from '../src/shared/apiModel'
import type { HttpResponseOk } from '../src/shared/httpClient'

const TAB = 'tab_1'
const enc = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer as ArrayBuffer

function ok(body: string | ArrayBuffer, headers: Record<string, string> = {}, patch: Partial<HttpResponseOk> = {}): HttpResponseOk {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? enc(body) : body,
    durationMs: 142,
    truncated: false,
    ...patch
  }
}
const sent: SentView = {
  method: 'GET',
  url: 'https://api.example.test/users/42',
  headers: [
    ['Authorization', 'Bearer •••'],
    ['X-Api-Key', 'literal-key-that-slipped-through'],
    ['Accept', 'application/json']
  ],
  route: { key: 'server:srv_1', label: 'web-01' },
  tls: 'verified',
  maxRedirects: 5,
  timeoutMs: 30000,
  bodyBytes: 0
}

function setup(response: ResponseState, draft = { ...defaults.http(), url: '{{baseUrl}}/users/{{id}}' }, ref?: { collectionId: string; requestId: string }): void {
  useHttp.setState({
    tabs: [{ id: TAB, workspaceId: 'ws_1', preview: false, split: 'normal', kind: 'request', draft, ref }],
    responses: { [TAB]: response }
  })
}
const done = (res: HttpResponseOk): ResponseState => ({ status: 'done', response: res, sentAs: sent, at: 1 })

let write: ReturnType<typeof vi.fn>
let saveResponse: ReturnType<typeof vi.fn>
beforeEach(() => {
  write = vi.fn()
  saveResponse = vi.fn().mockResolvedValue('/home/u/Downloads/users.json')
  stubBridge({ clipboard: { write }, http: { saveResponse } })
})

describe('ResponsePane states', () => {
  it('idle says how to send', () => {
    setup({ status: 'idle' })
    render(<ResponsePane tabId={TAB} />)
    expect(screen.getByText(/Send the request to see the response/)).toBeTruthy()
  })

  it('sending shows the elapsed time and a Cancel that cancels this tab', () => {
    setup({ status: 'sending', startedAt: Date.now(), requestId: 'r1' })
    render(<ResponsePane tabId={TAB} />)
    expect(screen.getByText(/Waiting for response/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^Cancel/ }))
    expect(cancel).toHaveBeenCalledWith(TAB)
  })

  it('done shows status text with its shape, time, size, and the route', () => {
    setup(done(ok('{}', {}, { status: 404, statusText: 'Not Found' })))
    const { container } = render(<ResponsePane tabId={TAB} />)
    expect(screen.getAllByText('404 Not Found').length).toBeGreaterThan(0)
    expect(container.querySelector('.state-dot.is-watch')).toBeTruthy()
    expect(screen.getAllByText('142 ms').length).toBeGreaterThan(0)
    expect(screen.getAllByText('via web-01').length).toBeGreaterThan(0)
    expect(screen.getAllByRole('img', { name: 'Certificate verified' }).length).toBeGreaterThan(0)
  })

  it('an error is shown in the pane with its fix, masked', () => {
    setup({ status: 'error', errorClass: 'dns', message: 'getaddrinfo ENOTFOUND https://u:pw@api.example.test/' })
    render(<ResponsePane tabId={TAB} />)
    const alert = screen.getByRole('alert')
    expect(within(alert).getByText(/Host not found/)).toBeTruthy()
    expect(alert.textContent).not.toContain('u:pw')
    // What main said stays visible under the sentence, with its URL masked.
    expect(within(alert).getByText(/getaddrinfo ENOTFOUND https:\/\/.*•••.*api\.example\.test/)).toBeTruthy()
    const onFix = vi.fn()
    document.addEventListener(HTTP_FIX_EVENT, (e) => onFix((e as CustomEvent).detail))
    fireEvent.click(within(alert).getByRole('button', { name: 'Send from…' }))
    expect(onFix).toHaveBeenCalledWith({ tabId: TAB, action: 'route-menu' })
  })

  it('a declined production confirm shows nothing at all', () => {
    setup({ status: 'error', errorClass: 'prod-declined', message: '' })
    render(<ResponsePane tabId={TAB} />)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('a TLS error in a scratch tab offers a save first; in a collection, a CA', () => {
    setup({ status: 'error', errorClass: 'tls', message: 'self-signed' })
    const { unmount } = render(<ResponsePane tabId={TAB} />)
    expect(screen.getByRole('button', { name: 'Save to a collection to add a CA…' })).toBeTruthy()
    unmount()
    setup({ status: 'error', errorClass: 'tls', message: 'self-signed' }, undefined, { collectionId: 'col_1', requestId: 'req_1' })
    render(<ResponsePane tabId={TAB} />)
    expect(screen.getByRole('button', { name: 'Add a CA for this collection' })).toBeTruthy()
  })
})

describe('unresolved variables (UX-M13)', () => {
  it('offers Add value, and Send anyway only when no unresolved variable is in the origin', () => {
    setup({ status: 'error', errorClass: 'unresolved-variable', message: '`id` is not defined', unresolved: ['id'] })
    const { unmount } = render(<ResponsePane tabId={TAB} />)
    expect(screen.getByRole('button', { name: 'Add value…' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Send anyway' })).toBeTruthy()
    unmount()
    setup({ status: 'error', errorClass: 'unresolved-variable', message: '`baseUrl` is not defined', unresolved: ['baseUrl'] })
    render(<ResponsePane tabId={TAB} />)
    expect(screen.queryByRole('button', { name: 'Send anyway' })).toBeNull()
  })

  it('unresolvedInOrigin reads scheme and host only', () => {
    expect(unresolvedInOrigin('https://{{host}}/a', ['host'])).toBe(true)
    expect(unresolvedInOrigin('{{scheme}}://h/a', ['scheme'])).toBe(true)
    expect(unresolvedInOrigin('https://h/{{id}}?q={{q}}', ['id', 'q'])).toBe(false)
    expect(unresolvedInOrigin('{{baseUrl}}/users', ['baseUrl'])).toBe(true)
  })
})

describe('the body', () => {
  it('HTML defaults to Pretty, highlighted as HTML', () => {
    setup(done(ok('<p>hi</p>', { 'content-type': 'text/html' })))
    render(<ResponsePane tabId={TAB} />)
    expect(screen.getByRole('button', { name: 'Pretty' }).getAttribute('aria-pressed')).toBe('true')
    const lang = screen.getByLabelText('Highlight as') as HTMLSelectElement
    expect(lang.selectedOptions[0].textContent).toBe('Auto (html)')
    expect(screen.getByLabelText('Response body').textContent).toContain('<p>hi</p>')
  })

  it('HTML Preview is a sandbox="" srcdoc iframe with the meta CSP (SEC-L3)', () => {
    setup(done(ok('<form action="https://evil.example/">x</form><script>alert(1)</script>', { 'content-type': 'text/html' })))
    const { container } = render(<ResponsePane tabId={TAB} />)
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    const frame = container.querySelector('iframe')!
    expect(frame.getAttribute('sandbox')).toBe('')
    expect(frame.getAttribute('srcdoc')).toMatch(/^<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">/)
    expect(frame.hasAttribute('src')).toBe(false)
    expect(screen.getByText(/Preview is offline/)).toBeTruthy()
  })

  it('SVG previews through <img>, never inlined', () => {
    setup(done(ok('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', { 'content-type': 'image/svg+xml' })))
    const { container } = render(<ResponsePane tabId={TAB} />)
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    expect(container.querySelector('.hc-body-content svg')).toBeNull()
    expect(container.querySelector('img.hc-preview-img')?.getAttribute('src')).toMatch(/^data:image\/svg\+xml;base64,/)
  })

  it('above 2 MiB, shows the window strip with Save and Copy all', () => {
    setup(done(ok(new Uint8Array(3 * 1024 * 1024).fill(0x61).buffer as ArrayBuffer, { 'content-type': 'text/plain' })))
    render(<ResponsePane tabId={TAB} />)
    expect(screen.getByText(/Showing 2\.0 MiB of 3\.0 MiB/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Copy all' }))
    expect((write.mock.calls[0][0] as string).length).toBe(3 * 1024 * 1024)
  })

  it('a truncated response says so, with Save to file', () => {
    setup(done(ok('{}', {}, { truncated: true })))
    render(<ResponsePane tabId={TAB} />)
    expect(screen.getByText(/Showing the first 32 MB/)).toBeTruthy()
  })

  it('copy and save go through the bridge', async () => {
    setup(done(ok('{"a":1}')))
    render(<ResponsePane tabId={TAB} />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy response' }))
    expect(write).toHaveBeenCalledWith('{"a":1}')
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save response to file' })))
    expect(saveResponse.mock.calls[0][0]).toBe('42.json')
    expect((saveResponse.mock.calls[0][1] as ArrayBuffer).byteLength).toBe(7)
  })

  it('Copy value and Set as variable take the JSON node under the caret', () => {
    setup(done(ok('{"access_token":"eyJ.abc","n":1}')))
    const { container } = render(<ResponsePane tabId={TAB} />)
    const view = EditorView.findFromDOM(container.querySelector('.cm-editor') as HTMLElement)!
    const at = view.state.doc.toString().indexOf('eyJ')
    view.dispatch({ selection: { anchor: at } })
    fireEvent.contextMenu(container.querySelector('.hc-response-panel')!)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy value' }))
    expect(write).toHaveBeenCalledWith('eyJ.abc')

    const onSet = vi.fn()
    document.addEventListener(HTTP_SET_VARIABLE_EVENT, (e) => onSet((e as CustomEvent).detail))
    fireEvent.contextMenu(container.querySelector('.hc-response-panel')!)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Set as variable…' }))
    expect(onSet).toHaveBeenCalledWith({ tabId: TAB, name: 'access_token', value: 'eyJ.abc' })
  })

  it('Fold all and Unfold all act on the editor', () => {
    setup(done(ok('{"a":{"b":[1,2]},"c":{"d":1}}')))
    const { container } = render(<ResponsePane tabId={TAB} />)
    const view = EditorView.findFromDOM(container.querySelector('.cm-editor') as HTMLElement)!
    fireEvent.contextMenu(container.querySelector('.hc-response-panel')!)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Fold all' }))
    expect(foldedRanges(view.state).size).toBeGreaterThan(0)
    fireEvent.contextMenu(container.querySelector('.hc-response-panel')!)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Unfold all' }))
    expect(foldedRanges(view.state).size).toBe(0)
  })
})

describe('headers, cookies, timeline', () => {
  it('counts headers and cookies, and renders server text as text', () => {
    setup(done(ok('{}', { 'x-evil': '<img src=x onerror=alert(1)>' }, { setCookie: ['sid=abc; Path=/; HttpOnly', 'theme=dark'] })))
    const { container } = render(<ResponsePane tabId={TAB} />)
    fireEvent.click(screen.getByRole('tab', { name: /^Headers\s*2/ }))
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy()
    expect(container.querySelector('img')).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: /^Cookies\s*2/ }))
    expect(screen.getByText('sid')).toBeTruthy()
    expect(screen.getByText('httponly')).toBeTruthy()
  })

  it('the Timeline masks sensitive header values, keeping the auth scheme', () => {
    setup(done(ok('{}')))
    render(<ResponsePane tabId={TAB} />)
    fireEvent.click(screen.getByRole('tab', { name: /^Timeline/ }))
    const table = screen.getByRole('table', { name: 'Request headers as sent' })
    expect(table.textContent).toContain('Bearer •••')
    expect(table.textContent).not.toContain('literal-key-that-slipped-through')
    expect(table.textContent).toContain('application/json')
    expect(screen.getByText('web-01')).toBeTruthy()
    expect(screen.getByText('Verified')).toBeTruthy()
  })
})

describe('tab roles', () => {
  it('each response tab controls the panel, and the panel is labelled by the active tab', () => {
    setup(done(ok('{}')))
    render(<ResponsePane tabId={TAB} />)
    const panel = screen.getByRole('tabpanel')
    const active = screen.getByRole('tab', { selected: true })
    expect(active.getAttribute('aria-controls')).toBe(panel.id)
    expect(panel.getAttribute('aria-labelledby')).toBe(active.id)
    fireEvent.click(screen.getByRole('tab', { name: /^Timeline/ }))
    expect(screen.getByRole('tabpanel', { name: /^Timeline/ })).toBeTruthy()
  })
})

describe('announcements and the summary', () => {
  it('announces once per send in a polite live region', () => {
    setup({ status: 'sending', startedAt: Date.now(), requestId: 'r1' })
    const { container } = render(<ResponsePane tabId={TAB} />)
    const live = container.querySelector('[aria-live="polite"]')!
    expect(live.textContent).toBe('')
    act(() => useHttp.getState().setResponse(TAB, done(ok('{}'))))
    expect(live.textContent).toBe('200 OK, 142 milliseconds')
  })

  it('ResponseStatus reads on its own, for the collapsed bar', () => {
    setup(done(ok('{}', {}, { status: 503, statusText: 'Service Unavailable' })))
    const { container } = render(<ResponseStatus tabId={TAB} />)
    expect(container.textContent).toContain('503 Service Unavailable')
    expect(container.querySelector('.state-dot.is-alarm')).toBeTruthy()
  })

  it('the collapse buttons set this tab’s split', () => {
    setup({ status: 'idle' })
    render(<ResponsePane tabId={TAB} />)
    fireEvent.click(screen.getByRole('button', { name: /Collapse response/ }))
    expect(useHttp.getState().tabs[0].split).toBe('response-collapsed')
    fireEvent.click(screen.getByRole('button', { name: /Collapse request/ }))
    expect(useHttp.getState().tabs[0].split).toBe('request-collapsed')
  })
})
