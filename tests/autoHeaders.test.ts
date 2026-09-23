import { describe, it, expect } from 'vitest'
import { autoHeadersFor, isOverridden } from '../src/shared/autoHeaders'
import { defaults, type HttpRequest } from '../src/shared/apiModel'

const req = (patch: Partial<HttpRequest>): HttpRequest => ({ ...defaults.http(), url: 'https://api.example.test/x', ...patch })
const names = (h: { name: string }[]): string[] => h.map((x) => x.name)

describe('autoHeadersFor', () => {
  it('a bare GET gets User-Agent and Host, each with a reason', () => {
    const h = autoHeadersFor(req({}), { version: '1.2.3', hasCookies: false })
    expect(names(h)).toEqual(['User-Agent', 'Host'])
    expect(h[0].value).toBe('OpsMaxx/1.2.3')
    expect(h[1]).toMatchObject({ value: 'api.example.test', overridable: false })
    expect(h.every((x) => x.reason.length > 0)).toBe(true)
  })

  it.each([
    ['json', 'application/json'],
    ['xml', 'application/xml'],
    ['text', 'text/plain'],
    ['urlencoded', 'application/x-www-form-urlencoded'],
    ['multipart', 'multipart/form-data; boundary=<generated>'],
    ['binary', 'application/octet-stream']
  ] as const)('a %s body sets Content-Type %s and Content-Length', (mode, type) => {
    const body = (mode === 'json' || mode === 'xml' || mode === 'text'
      ? { mode, text: '' }
      : mode === 'binary'
        ? { mode }
        : { mode, rows: [] }) as HttpRequest['body']
    const h = autoHeadersFor(req({ method: 'POST', body }), { version: '1', hasCookies: false })
    expect(h.find((x) => x.name === 'Content-Type')?.value).toBe(type)
    expect(h.find((x) => x.name === 'Content-Length')?.overridable).toBe(false)
  })

  it('a GET with a body sends none, so gets no Content-Type', () => {
    const h = autoHeadersFor(req({ body: { mode: 'json', text: '{}' } }), { version: '1', hasCookies: false })
    expect(names(h)).not.toContain('Content-Type')
  })

  it('adds Cookie from the jar and Authorization from Auth, masked', () => {
    const h = autoHeadersFor(req({ auth: { type: 'bearer', token: 'eyJsecret' } }), { version: '1', hasCookies: true })
    expect(names(h)).toEqual(['User-Agent', 'Host', 'Cookie', 'Authorization'])
    expect(JSON.stringify(h)).not.toContain('eyJsecret')
  })

  it('an API key in a header is named after the key; in the query it adds no header', () => {
    const inHeader = autoHeadersFor(req({ auth: { type: 'apikey', name: 'X-Api-Key', value: 'k', in: 'header' } }), { version: '1', hasCookies: false })
    expect(inHeader.at(-1)).toMatchObject({ name: 'X-Api-Key', value: '•••' })
    const inQuery = autoHeadersFor(req({ auth: { type: 'apikey', name: 'key', value: 'k', in: 'query' } }), { version: '1', hasCookies: false })
    expect(names(inQuery)).toEqual(['User-Agent', 'Host'])
  })

  it('Inherit shows the collection auth, and says it is inherited', () => {
    const h = autoHeadersFor(req({ auth: { type: 'inherit' } }), {
      version: '1',
      hasCookies: false,
      inheritedAuth: { type: 'basic', username: 'u', password: 'p' }
    })
    expect(h.at(-1)).toMatchObject({ name: 'Authorization', value: 'Basic •••', reason: 'Inherited from the collection' })
  })

  it('an enabled explicit row wins over an overridable header, never over Host', () => {
    const [ua, host] = autoHeadersFor(req({}), { version: '1', hasCookies: false })
    expect(isOverridden(ua, [{ enabled: true, key: 'user-agent' }])).toBe(true)
    expect(isOverridden(ua, [{ enabled: false, key: 'User-Agent' }])).toBe(false)
    expect(isOverridden(host, [{ enabled: true, key: 'Host' }])).toBe(false)
  })
})
