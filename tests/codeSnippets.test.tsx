// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { snippetFor, CodeSnippetDrawer } from '../src/renderer/src/components/http/dialogs/CodeSnippetDrawer'
import type { HttpRequest } from '../src/shared/apiModel'
import type { HttpRequestSpec } from '../src/shared/httpClient'

// The escaping gate for Generate code (review SEC-M5): a value holding a
// quote, a backslash, a newline, an apostrophe and a command substitution
// must come back out of every language's string literal unchanged.
const V = 'a"b\\c\nd\'e$(touch /tmp/pwn)`id`'
// A header cannot hold a newline (toCurl refuses one), so the header carries the rest.
const H = V.replace('\n', ' ')

const req: HttpRequest = {
  id: 'req_1',
  name: 'x',
  kind: 'http',
  method: 'POST',
  url: 'https://h.example/x',
  headers: [{ id: 'r1', enabled: true, key: 'X-V', value: H }],
  params: [],
  pathParams: [],
  auth: { type: 'none' },
  body: { mode: 'json', text: JSON.stringify({ k: V }) },
  settings: { followRedirects: false, maxRedirects: 0 }
}
const spec: HttpRequestSpec = {
  url: 'https://h.example/x',
  method: 'POST',
  headers: { 'X-V': H, 'Content-Type': 'application/json' },
  body: new TextEncoder().encode(JSON.stringify({ k: V })).buffer as ArrayBuffer,
  via: { kind: 'direct' }
}

/** A double-quoted literal on the line that names `X-V`, decoded. Python and Go escape these as JSON does. */
function literalAfter(code: string, marker: RegExp): string {
  const m = marker.exec(code)
  if (!m) throw new Error(`no literal for ${marker} in:\n${code}`)
  return JSON.parse(m[1]) as string
}

describe('generated code escapes a hostile value', () => {
  it('fetch', async () => {
    const { text } = snippetFor('fetch', req, spec, 'include')
    const calls: unknown[][] = []
    const run = new Function('fetch', `return (async () => { ${text} })()`) as (f: unknown) => Promise<void>
    await run(async (...args: unknown[]) => calls.push(args))
    const [url, init] = calls[0] as [string, { headers: [string, string][]; body: string }]
    expect(url).toBe('https://h.example/x')
    expect(init.headers.find(([k]) => k === 'X-V')?.[1]).toBe(H)
    expect(JSON.parse(init.body).k).toBe(V)
  })

  it('Python requests', () => {
    const { text } = snippetFor('python', req, spec, 'include')
    expect(literalAfter(text, /"X-V": ("(?:[^"\\]|\\.)*")/)).toBe(H)
    expect(literalAfter(text, /"k": ("(?:[^"\\]|\\.)*")/)).toBe(V)
  })

  it('Go', () => {
    const { text } = snippetFor('go', req, spec, 'include')
    expect(literalAfter(text, /Header\.Add\("X-V", ("(?:[^"\\]|\\.)*")\)/)).toBe(H)
  })

  it('HTTPie, through a real shell', () => {
    const { text } = snippetFor('httpie', req, spec, 'include')
    const out = execFileSync('sh', ['-c', `http() { printf '%s\\n' "$@"; cat >/dev/null; }\n${text}`]).toString()
    expect(out).toContain(`X-V:${H}`)
  })

  it('cURL, through a real shell', () => {
    const { text } = snippetFor('curl', req, spec, 'include')
    const out = execFileSync('sh', ['-c', `curl() { printf '%s\\n' "$@"; }\n${text}`]).toString()
    expect(out).toContain(`X-V: ${H}`)
    expect(out).toContain(JSON.stringify({ k: V }))
  })
})

describe('CodeSnippetDrawer', () => {
  const secretReq: HttpRequest = { ...req, headers: [{ id: 'r1', enabled: true, key: 'X-Api-Key', value: 'sk_LIVE' }] }
  const secretSpec: HttpRequestSpec = { ...spec, headers: { 'X-Api-Key': 'sk_LIVE' } }

  it('masks by default in every language, and shows secrets only after the confirm', async () => {
    const resolveSecrets = vi.fn(async () => secretSpec)
    render(<CodeSnippetDrawer request={secretReq} sent={secretSpec} resolveSecrets={resolveSecrets} onClose={() => {}} />)
    for (const lang of ['cURL', 'fetch', 'Python', 'Go', 'HTTPie']) {
      fireEvent.click(screen.getByRole('tab', { name: lang }))
      expect(screen.getByLabelText('Snippet').textContent).not.toContain('sk_LIVE')
    }
    fireEvent.click(screen.getByText('Include secrets…'))
    expect(resolveSecrets).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Show secrets'))
    await waitFor(() => expect(screen.getByLabelText('Snippet').textContent).toContain('sk_LIVE'))
  })

  it('keeps the masked view and says why when secrets cannot be filled in', async () => {
    render(<CodeSnippetDrawer request={secretReq} sent={secretSpec} resolveSecrets={async () => null} onClose={() => {}} />)
    fireEvent.click(screen.getByText('Include secrets…'))
    fireEvent.click(screen.getByText('Show secrets'))
    expect((await screen.findByRole('alert')).textContent).toMatch(/could not be filled in.*vault may be locked/)
    expect(screen.getByLabelText('Snippet').textContent).not.toContain('sk_LIVE')
    expect(screen.getByLabelText('Snippet').textContent).toContain('<secret>')
    // It can be asked again.
    expect(screen.getByText('Include secrets…')).toBeTruthy()
  })
})
