// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { stubBridge } from './setup/renderer'
import { ImportDialog } from '../src/renderer/src/components/http/dialogs/ImportDialog'
import { withoutCredentials } from '../src/shared/apiUrl'
import { useApi } from '../src/renderer/src/store/api'
import { useHttp } from '../src/renderer/src/store/http'
import { defaults, type HttpRequest } from '../src/shared/apiModel'

const SPEC = JSON.stringify({
  openapi: '3.0.0',
  info: { title: 'Pets <img src=x onerror=alert(1)>', version: '1' },
  servers: [{ url: '/v1' }],
  paths: {
    '/pets': { get: { tags: ['pets'], responses: {} }, post: { tags: ['pets'], responses: { '200': { $ref: 'https://evil.example/r' } } } }
  }
})

const ok = (text: string) => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  headers: {},
  body: new TextEncoder().encode(text).buffer,
  durationMs: 1,
  truncated: false
})

describe('ImportDialog', () => {
  it('previews a cURL command and opens it in a new tab', () => {
    const onClose = vi.fn()
    render(<ImportDialog onClose={onClose} />)
    fireEvent.change(screen.getByLabelText('cURL command'), {
      target: { value: "curl -X POST https://h.example/items -H 'X-A: 1' -k" }
    })
    expect(screen.getByLabelText('Preview').textContent).toContain('POST https://h.example/items')
    expect(screen.getByLabelText('Notes').textContent).toMatch(/skipped certificate checks/)
    fireEvent.click(screen.getByText('Open in new tab'))
    const tab = useHttp.getState().tabs.at(-1)
    expect((tab?.draft as HttpRequest).url).toBe('https://h.example/items')
    expect(onClose).toHaveBeenCalled()
  })

  it('fetches a spec over http:request, reports it as text, and creates a collection', async () => {
    const request = vi.fn(async () => ok(SPEC))
    stubBridge({ http: { request } })
    render(<ImportDialog onClose={() => {}} initialTab="openapi" />)
    fireEvent.change(screen.getByLabelText('OpenAPI URL'), { target: { value: 'https://u:pw@specs.example/api.json' } })
    fireEvent.click(screen.getByText('Fetch'))
    const report = await screen.findByLabelText('Import report')
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ method: 'GET', via: { kind: 'direct' } }))
    expect(report.textContent).toContain('2 requests in 1 folders')
    expect(report.textContent).toContain('1 external references not followed')
    expect(report.textContent).toContain('https://specs.example/v1')
    // The title is text, never markup.
    expect(document.querySelector('img')).toBeNull()
    fireEvent.click(screen.getByText('Create collection'))
    const col = useApi.getState().collections.at(-1)!
    expect(col.importedFrom).toMatchObject({ kind: 'openapi', url: 'https://specs.example/api.json' })
    expect(col.variables).toEqual([expect.objectContaining({ key: 'baseUrl', value: 'https://specs.example/v1' })])
    expect(col.items).toHaveLength(1)
  })

  it('keeps only the basename of a picked file', async () => {
    stubBridge({ http: { chooseSpecFile: async () => ({ name: 'api.json', text: SPEC }) } })
    render(<ImportDialog onClose={() => {}} initialTab="openapi" />)
    fireEvent.click(screen.getByText('Choose a file…'))
    await screen.findByLabelText('Import report')
    fireEvent.click(screen.getByText('Create collection'))
    const col = useApi.getState().collections.at(-1)!
    expect(col.importedFrom).toMatchObject({ fileName: 'api.json' })
    expect(JSON.stringify(col)).not.toContain('/Users/someone')
  })

  it('replaces a collection only after a confirm', async () => {
    const id = useApi.getState().createCollection('Old')
    useApi.getState().replaceItems(id, [{ ...defaults.http(), id: 'req_old' }])
    stubBridge({ http: { request: async () => ok(SPEC) } })
    render(<ImportDialog onClose={() => {}} reimportInto={id} />)
    fireEvent.change(screen.getByLabelText('OpenAPI URL'), { target: { value: 'https://specs.example/api.json' } })
    fireEvent.click(screen.getByText('Fetch'))
    fireEvent.click(await screen.findByText('Re-import into Old'))
    const before = useApi.getState().collections.find((c) => c.id === id)!.items
    expect(before.map((i) => i.id)).toEqual(['req_old'])
    fireEvent.click(screen.getByText('Replace'))
    await waitFor(() => expect(useApi.getState().collections.find((c) => c.id === id)!.items).toHaveLength(1))
    expect(useApi.getState().collections.find((c) => c.id === id)!.items[0].kind).toBe('folder')
  })

  it('offers to choose a file-imported collection\'s file again, first', async () => {
    const id = useApi.getState().createCollection('Billing')
    useApi.getState().updateCollection(id, {
      importedFrom: { kind: 'openapi', fileName: 'billing.yaml', at: '' },
      needsReimport: true
    })
    const chooseSpecFile = vi.fn(async () => ({ name: 'billing.yaml', text: SPEC }))
    stubBridge({ http: { chooseSpecFile } })
    render(<ImportDialog onClose={() => {}} reimportInto={id} />)
    const again = screen.getByRole('button', { name: 'Choose billing.yaml again…' })
    // File mode first: the file button comes before the URL field, and has focus.
    expect(again.compareDocumentPosition(screen.getByLabelText('OpenAPI URL')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(document.activeElement).toBe(again)
    expect(screen.getByText(/imported from billing\.yaml/).textContent).toMatch(/choose it again/)
    expect(screen.queryByText('Choose a file…')).toBeNull()
    fireEvent.click(again)
    fireEvent.click(await screen.findByText('Re-import into Billing'))
    fireEvent.click(screen.getByText('Replace'))
    const col = useApi.getState().collections.find((c) => c.id === id)!
    expect(chooseSpecFile).toHaveBeenCalled()
    expect(col.needsReimport).toBe(false)
    expect(col.items).toHaveLength(1)
    expect(col.importedFrom).toMatchObject({ fileName: 'billing.yaml' })
  })

  it('shows no file hint for a collection imported from a URL', () => {
    const id = useApi.getState().createCollection('Web')
    useApi.getState().updateCollection(id, { importedFrom: { kind: 'openapi', url: 'https://h/o.json', at: '' } })
    render(<ImportDialog onClose={() => {}} reimportInto={id} />)
    expect(screen.queryByText(/again…/)).toBeNull()
    expect((screen.getByLabelText('OpenAPI URL') as HTMLInputElement).value).toBe('https://h/o.json')
  })

  it('keeps no credential in importedFrom.url, which syncs', () => {
    expect(withoutCredentials('https://u:p@h/o.json?access_token=T&v=2&sig=S#x')).toBe('https://h/o.json?v=2#x')
    expect(withoutCredentials('https://h/o.json?api_key=K')).toBe('https://h/o.json')
  })

  it('shows a spec file main refused', async () => {
    stubBridge({ http: { chooseSpecFile: async () => ({ error: 'That file is larger than 32 MiB.' }) } })
    render(<ImportDialog onClose={() => {}} initialTab="openapi" />)
    fireEvent.click(screen.getByText('Choose a file…'))
    expect((await screen.findByRole('alert')).textContent).toContain('larger than 32 MiB')
  })

  it('shows a transport failure', async () => {
    stubBridge({ http: { request: async () => ({ ok: false, error: 'getaddrinfo ENOTFOUND specs.example' }) } })
    render(<ImportDialog onClose={() => {}} initialTab="openapi" />)
    fireEvent.change(screen.getByLabelText('OpenAPI URL'), { target: { value: 'https://specs.example/x' } })
    fireEvent.click(screen.getByText('Fetch'))
    expect((await screen.findByRole('alert')).textContent).toContain('ENOTFOUND')
  })
})
