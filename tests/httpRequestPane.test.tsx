// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { stubBridge } from './setup/renderer'

// Real components throughout. The send is stubbed, since it would reach main,
// and so is the vault dialog, whose own flows are B's moveToVault.test.tsx.
vi.mock('../src/renderer/src/lib/httpSend', () => ({
  send: vi.fn().mockResolvedValue(undefined),
  cancel: vi.fn(),
  maskedSentFor: vi.fn().mockReturnValue(null),
  liveSpecFor: vi.fn().mockResolvedValue({
    url: 'https://api.example.test/x', method: 'GET', headers: { Authorization: 'Bearer live-secret' }, via: { kind: 'direct' }
  })
}))
vi.mock('../src/renderer/src/components/http/dialogs/MoveToVaultDialog', () => ({
  MoveToVaultDialog: (p: { defaultName: string; value: string; onMoved(ref: string): void }) => (
    <div role="dialog" aria-label={p.defaultName}>
      <button onClick={() => p.onMoved('vault:ent_1#password')}>Move {p.value}</button>
    </div>
  )
}))

import { HttpRequestPane } from '../src/renderer/src/components/http/request/HttpRequestPane'
import { HTTP_FIX_EVENT } from '../src/renderer/src/components/http/response/ResponsePane'
import { switchBodyMode } from '../src/renderer/src/components/http/request/BodyEditor'
import { useHttp } from '../src/renderer/src/store/http'
import { useApi } from '../src/renderer/src/store/api'
import { useVault } from '../src/renderer/src/store/vault'
import { liveSpecFor, maskedSentFor, send } from '../src/renderer/src/lib/httpSend'
import { defaults, type ApiCollectionV2, type HttpRequest } from '../src/shared/apiModel'

const TAB = 'tab_1'
const WS = 'ws_1'
const req = (patch: Partial<HttpRequest> = {}): HttpRequest => ({ ...defaults.http(), id: 'req_1', url: 'https://h/x', ...patch })
const draft = (): HttpRequest => useHttp.getState().tabs[0].draft as HttpRequest

function setup(
  r: HttpRequest,
  ref?: { collectionId: string; requestId: string },
  strippedFields?: string[],
  split: 'normal' | 'request-collapsed' = 'normal'
): void {
  useHttp.setState({ tabs: [{ id: TAB, workspaceId: WS, preview: false, split, kind: 'request', draft: r, ref, strippedFields }] })
}
const tab = (name: RegExp) => within(screen.getByRole('tablist', { name: 'Request' })).getByRole('tab', { name })
const dotOf = (t: HTMLElement): string => t.querySelector('[class*="hc-tab-dot--"]')?.className.match(/hc-tab-dot--(\w+)/)?.[1] ?? ''

beforeEach(() => {
  stubBridge({ clipboard: { read: vi.fn(), write: vi.fn() }, http: { chooseBodyFile: vi.fn().mockResolvedValue({ name: 'photo.png', bytes: new ArrayBuffer(3) }) } })
  vi.mocked(send).mockClear()
})

describe('request tabs', () => {
  it('counts enabled rows with a name only, and hides a zero count', () => {
    setup(req({
      params: [
        { id: 'a', enabled: true, key: 'limit', value: '1' },
        { id: 'b', enabled: false, key: 'off', value: '1' },
        { id: 'c', enabled: true, key: '', value: '' }
      ],
      headers: []
    }))
    render(<HttpRequestPane tabId={TAB} />)
    expect(tab(/^Params/).textContent).toBe('Params1')
    expect(tab(/^Headers/).textContent).toBe('Headers')
  })

  it('the request panel is labelled by the active tab it is controlled by', () => {
    setup(req())
    render(<HttpRequestPane tabId={TAB} />)
    const panel = document.getElementById(`${TAB}-req-panel`)!
    expect(tab(/^Params/).getAttribute('aria-controls')).toBe(panel.id)
    expect(panel.getAttribute('aria-labelledby')).toBe(tab(/^Params/).id)
    fireEvent.click(tab(/^Headers/))
    expect(panel.getAttribute('aria-labelledby')).toBe(tab(/^Headers/).id)
  })

  it('marks Auth when set, and a problem tab with the red dot', () => {
    setup(req({ auth: { type: 'bearer', token: 'literal' }, headers: [{ id: 'h', enabled: true, key: 'X', value: '{{missing}}' }], body: { mode: 'json', text: '{bad' }, method: 'POST' }))
    render(<HttpRequestPane tabId={TAB} />)
    expect(dotOf(tab(/^Auth/))).toBe('set')
    expect(dotOf(tab(/^Headers/))).toBe('problem')
    expect(dotOf(tab(/^Body/))).toBe('problem')
    expect(dotOf(tab(/^Params/))).toBe('')
  })

  it('the collapsed request bar restores the pane and opens the clicked tab', () => {
    setup(req(), undefined, undefined, 'request-collapsed')
    render(<HttpRequestPane tabId={TAB} />)
    expect(screen.queryByRole('tablist', { name: 'Request' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /^Settings/ }))
    expect(useHttp.getState().tabs[0].split).toBe('normal')
    expect(screen.getByText('Follow redirects')).toBeTruthy()
  })
})

describe('fixes the REST pane owns', () => {
  const fix = (action: string): void => {
    act(() => {
      document.querySelector('.hc-request-panel')!.dispatchEvent(new CustomEvent(HTTP_FIX_EVENT, { bubbles: true, detail: { tabId: TAB, action } }))
    })
  }

  it('Raise the timeout opens Settings', () => {
    setup(req())
    render(<HttpRequestPane tabId={TAB} />)
    fix('raise-timeout')
    expect(screen.getByText('Timeout (seconds)')).toBeTruthy()
  })

  it('Retry with http:// rewrites the scheme and sends', () => {
    setup(req({ url: 'https://127.0.0.1:9346/x' }))
    render(<HttpRequestPane tabId={TAB} />)
    fix('retry-http')
    expect(draft().url).toBe('http://127.0.0.1:9346/x')
    expect(send).toHaveBeenCalledWith(TAB)
  })

  it('Send anyway sends with unresolved variables allowed', () => {
    setup(req())
    render(<HttpRequestPane tabId={TAB} />)
    fix('send-anyway')
    expect(send).toHaveBeenCalledWith(TAB, { allowUnresolved: true })
  })

  it('Choose another vault entry opens Auth when the dead reference is in this request’s auth', () => {
    useVault.setState({ entries: [] })
    setup(req({ auth: { type: 'bearer', token: 'vault:gone_1#password' } }))
    render(<HttpRequestPane tabId={TAB} />)
    const reached = vi.fn()
    document.addEventListener(HTTP_FIX_EVENT, reached)
    fix('choose-vault')
    expect(reached).not.toHaveBeenCalled()
    expect(tab(/^Auth/).getAttribute('aria-selected')).toBe('true')
    document.removeEventListener(HTTP_FIX_EVENT, reached)
  })

  it('a dead reference held by a variable goes on to the workbench', () => {
    useVault.setState({ entries: [{ id: 'ent_ok' } as never] })
    setup(req({ auth: { type: 'bearer', token: 'vault:ent_ok#password' } }))
    render(<HttpRequestPane tabId={TAB} />)
    const reached = vi.fn()
    document.addEventListener(HTTP_FIX_EVENT, reached)
    fix('choose-vault')
    expect(reached).toHaveBeenCalledTimes(1)
    expect(tab(/^Params/).getAttribute('aria-selected')).toBe('true')
    document.removeEventListener(HTTP_FIX_EVENT, reached)
  })

  it('anything else bubbles on to the workbench', () => {
    setup(req())
    render(<HttpRequestPane tabId={TAB} />)
    const seen = vi.fn()
    document.addEventListener(HTTP_FIX_EVENT, seen)
    fix('route-menu')
    expect(seen).toHaveBeenCalledTimes(1)
  })
})

describe('Body', () => {
  const openBody = (): void => {
    fireEvent.click(tab(/^Body/))
  }

  it('switching mode keeps text between text modes and rows between form modes', () => {
    expect(switchBodyMode({ mode: 'json', text: '{}' }, 'xml')).toEqual({ mode: 'xml', text: '{}' })
    const rows = [{ id: 'r', enabled: true, key: 'a', value: '1' }]
    expect(switchBodyMode({ mode: 'urlencoded', rows }, 'multipart')).toEqual({ mode: 'multipart', rows: [{ ...rows[0], kind: 'text' }] })
    expect(switchBodyMode({ mode: 'multipart', rows: [{ ...rows[0], kind: 'file', fileName: 'f' }] }, 'urlencoded')).toEqual({ mode: 'urlencoded', rows })
  })

  it('the body type picker sits in the toolbar and Beautify formats JSON', () => {
    setup(req({ method: 'POST', body: { mode: 'json', text: '{"a":1}' } }))
    render(<HttpRequestPane tabId={TAB} />)
    openBody()
    fireEvent.click(screen.getByRole('button', { name: 'Beautify' }))
    expect(draft().body).toEqual({ mode: 'json', text: '{\n  "a": 1\n}' })
    fireEvent.change(screen.getByLabelText('Body type'), { target: { value: 'text' } })
    expect(draft().body).toEqual({ mode: 'text', text: '{\n  "a": 1\n}' })
  })

  it('says a vault: reference in a JSON body is sent verbatim (SEC-M2)', () => {
    setup(req({ method: 'POST', body: { mode: 'json', text: '{"p":"vault:ent_1#password"}' } }))
    render(<HttpRequestPane tabId={TAB} />)
    openBody()
    expect(screen.getByText(/is sent as written, not resolved/)).toBeTruthy()
  })

  it('invalid JSON is flagged but not blocked', () => {
    setup(req({ method: 'POST', body: { mode: 'json', text: '{' } }))
    render(<HttpRequestPane tabId={TAB} />)
    openBody()
    expect(screen.getByText(/Not valid JSON/)).toBeTruthy()
  })

  it('a binary body keeps only the file name; after a restart it asks for the file again', async () => {
    setup(req({ method: 'PUT', body: { mode: 'binary', fileName: 'old.bin' } }))
    render(<HttpRequestPane tabId={TAB} />)
    openBody()
    expect(screen.getByRole('button', { name: /Choose the file again/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Choose the file again/ }))
    await vi.waitFor(() => expect(draft().body).toEqual({ mode: 'binary', fileName: 'photo.png' }))
  })

  it('GET says its body is not sent', () => {
    setup(req({ method: 'GET', body: { mode: 'json', text: '{}' } }))
    render(<HttpRequestPane tabId={TAB} />)
    openBody()
    expect(screen.getByText('GET requests are sent without a body.')).toBeTruthy()
  })
})

describe('Settings', () => {
  const col = (patch: Partial<ApiCollectionV2>): ApiCollectionV2 => ({ ...defaults.collection(WS, 'httpbin'), id: 'col_1', ...patch })

  it('clamps max redirects to 0–10 and stores the timeout in ms', () => {
    setup(req())
    render(<HttpRequestPane tabId={TAB} />)
    fireEvent.click(tab(/^Settings/))
    fireEvent.change(screen.getByLabelText('Max redirects'), { target: { value: '99' } })
    expect(draft().settings.maxRedirects).toBe(10)
    fireEvent.change(screen.getByLabelText('Timeout (seconds)'), { target: { value: '45' } })
    expect(draft().settings.timeoutMs).toBe(45000)
  })

  it('names the certificate mode of the owning collection', () => {
    useApi.setState({ collections: [col({ insecureTls: true })] })
    setup(req(), { collectionId: 'col_1', requestId: 'req_1' })
    render(<HttpRequestPane tabId={TAB} />)
    fireEvent.click(tab(/^Settings/))
    expect(screen.getByText(/Certificates: NOT verified \(collection httpbin\)/)).toBeTruthy()
  })

  it('a custom CA is named as such', () => {
    useApi.setState({ collections: [col({ caPem: '-----BEGIN CERTIFICATE-----' })] })
    setup(req(), { collectionId: 'col_1', requestId: 'req_1' })
    render(<HttpRequestPane tabId={TAB} />)
    fireEvent.click(tab(/^Settings/))
    expect(screen.getByText(/verified with a custom CA from collection httpbin/)).toBeTruthy()
  })
})

describe('Auth in the pane', () => {
  it('a saved request inherits by name, and a stripped token is flagged', () => {
    useApi.setState({ collections: [{ ...defaults.collection(WS, 'httpbin'), id: 'col_1', auth: { type: 'bearer', token: '{{t}}' } }] })
    setup(req({ auth: { type: 'bearer', token: '' } }), { collectionId: 'col_1', requestId: 'req_1' }, ['auth.token'])
    render(<HttpRequestPane tabId={TAB} />)
    fireEvent.click(tab(/^Auth/))
    expect(screen.getByText(/Not kept from last session/)).toBeTruthy()
  })
})

describe('Move to vault (UX-M14)', () => {
  it('moves a literal token into the vault and swaps the field to the reference', () => {
    useApi.setState({ collections: [{ ...defaults.collection(WS, 'httpbin'), id: 'col_1' }] })
    setup(req({ auth: { type: 'bearer', token: 'eyJliteral' } }), { collectionId: 'col_1', requestId: 'req_1' })
    render(<HttpRequestPane tabId={TAB} />)
    fireEvent.click(tab(/^Auth/))
    fireEvent.click(screen.getByRole('button', { name: 'Move to vault…' }))
    expect(screen.getByRole('dialog', { name: 'httpbin · token' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Move eyJliteral' }))
    expect(draft().auth).toEqual({ type: 'bearer', token: 'vault:ent_1#password' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('does the same for a literal credential header, from its row menu', () => {
    setup(req({ headers: [{ id: 'h1', enabled: true, key: 'X-Api-Key', value: 'k-literal' }] }))
    render(<HttpRequestPane tabId={TAB} />)
    fireEvent.click(tab(/^Headers/))
    fireEvent.click(screen.getByRole('button', { name: /^Actions for X-Api-Key/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move to vault…' }))
    fireEvent.click(screen.getByRole('button', { name: 'Move k-literal' }))
    expect(draft().headers[0].value).toBe('vault:ent_1#password')
  })
})

describe('Generate code (T16)', () => {
  const sent = {
    method: 'GET', url: 'https://api.example.test/x', headers: [['Authorization', 'Bearer •••']] as [string, string][],
    route: { key: 'direct' as const, label: 'This machine' }, tls: 'verified' as const, maxRedirects: 5, timeoutMs: 30000, bodyBytes: 0
  }
  const doneResponse = {
    status: 'done' as const, at: 1, sentAs: sent,
    response: { ok: true as const, status: 200, statusText: 'OK', headers: {}, body: new ArrayBuffer(0), durationMs: 1, truncated: false }
  }

  it('the toolbar toggle is kept in prefs.codeOpen; with nothing buildable or sent, it says so', () => {
    vi.mocked(maskedSentFor).mockReturnValue(null)
    setup(req())
    render(<HttpRequestPane tabId={TAB} />)
    fireEvent.click(screen.getByRole('button', { name: 'Generate code' }))
    expect(useHttp.getState().prefs.codeOpen).toBe(true)
    expect(screen.getByText(/Nothing to generate yet/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Generate code' }))
    expect(useHttp.getState().prefs.codeOpen).toBe(false)
  })

  it('generates from the masked build before any send', () => {
    vi.mocked(maskedSentFor).mockReturnValue({ ...sent, url: 'https://built.example.test/now' })
    setup(req())
    useHttp.setState({ prefs: { ...useHttp.getState().prefs, codeOpen: true } })
    render(<HttpRequestPane tabId={TAB} />)
    expect(maskedSentFor).toHaveBeenCalledWith(TAB)
    expect(screen.getByLabelText('Snippet').textContent).toContain('https://built.example.test/now')
  })

  it('falls back to the masked last send, and shows live secrets only after the confirm', async () => {
    vi.mocked(maskedSentFor).mockReturnValue(null)
    setup(req({ auth: { type: 'bearer', token: 'live-secret' } }))
    useHttp.setState({ responses: { [TAB]: doneResponse }, prefs: { ...useHttp.getState().prefs, codeOpen: true } })
    render(<HttpRequestPane tabId={TAB} />)
    const snippet = (): string => screen.getByLabelText('Snippet').textContent ?? ''
    expect(snippet()).toContain('https://api.example.test/x')
    expect(snippet()).not.toContain('live-secret')
    fireEvent.click(screen.getByRole('button', { name: 'Include secrets…' }))
    expect(liveSpecFor).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Show secrets' }))
    await vi.waitFor(() => expect(snippet()).toContain('live-secret'))
    expect(liveSpecFor).toHaveBeenCalledWith(TAB)
    fireEvent.click(screen.getByRole('button', { name: 'Close code' }))
    expect(useHttp.getState().prefs.codeOpen).toBe(false)
  })
})

