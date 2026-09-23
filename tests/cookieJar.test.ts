import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { jarKey, parseSetCookie, useHttpCookies } from '../src/renderer/src/store/httpCookies'

const jar = () => useHttpCookies.getState()
const NOW = Date.parse('2026-09-23T12:00:00Z')

beforeEach(() => {
  jar().clearAll()
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})
afterEach(() => vi.useRealTimers())

describe('the jar is keyed by route', () => {
  it('a cookie set via server:A for localhost is not sent via direct or server:B', () => {
    jar().store('ws_1', 'server:A', 'http://localhost:8080/login', ['sid=abc; Path=/'])
    expect(jar().headerFor('ws_1', 'server:A', 'http://localhost:8080/me')).toBe('sid=abc')
    expect(jar().headerFor('ws_1', 'direct', 'http://localhost:8080/me')).toBe('')
    expect(jar().headerFor('ws_1', 'server:B', 'http://localhost:8080/me')).toBe('')
    expect(jar().headerFor('ws_2', 'server:A', 'http://localhost:8080/me')).toBe('')
  })
})

describe('Domain', () => {
  it('honours a parent domain the request host is in', () => {
    jar().store('ws_1', 'direct', 'https://a.example.test/', ['d=1; Domain=.example.test'])
    expect(jar().headerFor('ws_1', 'direct', 'https://b.example.test/')).toBe('d=1')
  })

  it('makes Domain=co.uk, an IP literal, a single label or a foreign domain host-only', () => {
    const cases = [
      ['https://a.co.uk/', 'Domain=co.uk', 'https://b.co.uk/'],
      ['http://1.2.3.4/', 'Domain=1.2.3.4', 'http://1.2.3.5/'],
      ['http://a.local/', 'Domain=local', 'http://b.local/'],
      ['https://evil.test/', 'Domain=bank.test', 'https://bank.test/']
    ]
    for (const [from, attr, other] of cases) {
      const c = parseSetCookie(`x=1; ${attr}`, from, NOW)!
      expect(c.hostOnly, attr).toBe(true)
      expect(c.domain).toBe(new URL(from).hostname)
      jar().store('ws_1', 'direct', from, [`x=1; ${attr}`])
      expect(jar().headerFor('ws_1', 'direct', other), attr).toBe('')
      expect(jar().headerFor('ws_1', 'direct', from), attr).toBe('x=1')
    }
  })
})

describe('Secure and Path', () => {
  it('never sends a Secure cookie over http, and ignores one set over http', () => {
    jar().store('ws_1', 'direct', 'https://h.test/', ['s=1; Secure'])
    expect(jar().headerFor('ws_1', 'direct', 'https://h.test/')).toBe('s=1')
    expect(jar().headerFor('ws_1', 'direct', 'http://h.test/')).toBe('')
    expect(parseSetCookie('s=1; Secure', 'http://h.test/', NOW)).toBeNull()
  })

  it('matches paths per RFC 6265 and sends longer paths first', () => {
    jar().store('ws_1', 'direct', 'https://h.test/api/v1/login', ['a=1', 'b=2; Path=/', 'c=3; Path=/api/v1/x'])
    expect(parseSetCookie('a=1', 'https://h.test/api/v1/login', NOW)!.path).toBe('/api/v1')
    expect(jar().headerFor('ws_1', 'direct', 'https://h.test/api/v1/x/y')).toBe('c=3; a=1; b=2')
    expect(jar().headerFor('ws_1', 'direct', 'https://h.test/api/v10')).toBe('b=2')
  })
})

describe('expiry', () => {
  it('reads Expires with its commas, and Max-Age beats it', () => {
    const exp = parseSetCookie('e=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT', 'https://h.test/', NOW)!
    expect(exp.expiresAt).toBe(Date.parse('2026-10-21T07:28:00Z'))
    const both = parseSetCookie('e=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Max-Age=60', 'https://h.test/', NOW)!
    expect(both.expiresAt).toBe(NOW + 60_000)
  })

  it('drops a cookie when it expires, and Max-Age=0 deletes one', () => {
    jar().store('ws_1', 'direct', 'https://h.test/', ['a=1; Max-Age=10', 'b=2'])
    expect(jar().headerFor('ws_1', 'direct', 'https://h.test/')).toBe('a=1; b=2')
    vi.setSystemTime(NOW + 11_000)
    expect(jar().headerFor('ws_1', 'direct', 'https://h.test/')).toBe('b=2')
    jar().store('ws_1', 'direct', 'https://h.test/', ['b=gone; Max-Age=0'])
    expect(jar().headerFor('ws_1', 'direct', 'https://h.test/')).toBe('')
    expect(jar().list()).toEqual([])
  })

  it('an Expires in the past deletes', () => {
    jar().store('ws_1', 'direct', 'https://h.test/', ['a=1'])
    jar().store('ws_1', 'direct', 'https://h.test/', ['a=1; Expires=Thu, 01 Jan 1970 00:00:00 GMT'])
    expect(jar().headerFor('ws_1', 'direct', 'https://h.test/')).toBe('')
  })
})

describe('list, remove and clear', () => {
  it('replaces a cookie in the same slot and supports the popover actions', () => {
    const key = jarKey('ws_1', 'direct')
    jar().store('ws_1', 'direct', 'https://a.test/', ['x=1', 'y=2'])
    jar().store('ws_1', 'direct', 'https://a.test/', ['x=3'])
    jar().store('ws_1', 'direct', 'https://b.test/', ['z=1'])
    expect(jar().list()[0].cookies.map((c) => `${c.name}=${c.value}`)).toEqual(['y=2', 'x=3', 'z=1'])
    jar().remove(key, 'y', 'a.test', '/')
    expect(jar().headerFor('ws_1', 'direct', 'https://a.test/')).toBe('x=3')
    jar().clearDomain(key, 'a.test')
    expect(jar().headerFor('ws_1', 'direct', 'https://a.test/')).toBe('')
    expect(jar().headerFor('ws_1', 'direct', 'https://b.test/')).toBe('z=1')
    jar().clearAll()
    expect(jar().list()).toEqual([])
  })

  it('ignores malformed lines and a hostile workspace id cannot touch the prototype', () => {
    jar().store('__proto__', 'direct', 'https://a.test/', ['novalue', '=x', 'ok=1'])
    expect(jar().headerFor('__proto__', 'direct', 'https://a.test/')).toBe('ok=1')
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(jar().headerFor('ws_1', 'direct', 'not a url')).toBe('')
  })
})
