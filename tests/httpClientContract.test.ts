import { describe, it, expect } from 'vitest'
import {
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  clampTimeout,
  methodAllowsBody,
  parseTarget,
  sanitizeHeaders
} from '../src/shared/httpClient'

describe('parseTarget', () => {
  it('splits a URL into what the request line needs', () => {
    const target = parseTarget('https://api.example.com/v1/things?limit=2')
    expect('error' in target).toBe(false)
    if ('error' in target) return
    expect(target.tls).toBe(true)
    expect(target.hostname).toBe('api.example.com')
    expect(target.port).toBe(443)
    expect(target.path).toBe('/v1/things?limit=2')
  })

  it('defaults the port per scheme and keeps an explicit one', () => {
    const plain = parseTarget('http://example.com/')
    const explicit = parseTarget('https://example.com:8443/')
    expect('error' in plain ? null : plain.port).toBe(80)
    expect('error' in explicit ? null : explicit.port).toBe(8443)
  })

  // file: would read this machine's disk through a request the user believes
  // goes to a server, so the scheme check is a security boundary, not tidiness.
  it.each(['file:///etc/passwd', 'ftp://example.com/x', 'javascript:alert(1)'])(
    'refuses %s',
    (url) => {
      const target = parseTarget(url)
      expect('error' in target).toBe(true)
    }
  )

  it('refuses text that is not a URL at all', () => {
    expect('error' in parseTarget('not a url')).toBe(true)
  })
})

describe('sanitizeHeaders', () => {
  it('keeps ordinary headers', () => {
    const { headers, dropped } = sanitizeHeaders({ accept: 'application/json', 'X-Trace': 'abc' })
    expect(headers).toEqual({ accept: 'application/json', 'X-Trace': 'abc' })
    expect(dropped).toEqual([])
  })

  // A caller-supplied Content-Length that disagrees with the body is what
  // request smuggling looks like to some servers, and Host must describe the
  // connection that was actually opened.
  it.each(['content-length', 'Content-Length', 'host', 'Connection', 'Transfer-Encoding'])(
    'drops %s, which the transport sets itself',
    (name) => {
      const { headers, dropped } = sanitizeHeaders({ [name]: 'anything' })
      expect(headers).toEqual({})
      expect(dropped).toEqual([name])
    }
  )

  it('drops a value carrying CR or LF, which would inject a second header', () => {
    const { headers, dropped } = sanitizeHeaders({
      'X-A': 'ok\r\nX-Injected: yes',
      'X-B': 'fine'
    })
    expect(headers).toEqual({ 'X-B': 'fine' })
    expect(dropped).toEqual(['X-A'])
  })

  it('drops a name that is not a token', () => {
    const { dropped } = sanitizeHeaders({ 'bad name': 'x', 'also:bad': 'y' })
    expect(dropped).toEqual(['bad name', 'also:bad'])
  })
})

describe('clampTimeout', () => {
  it('falls back to the default for nothing, zero and nonsense', () => {
    for (const value of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(clampTimeout(value)).toBe(DEFAULT_TIMEOUT_MS)
    }
  })

  it('keeps a sensible value and caps an absurd one', () => {
    expect(clampTimeout(5000)).toBe(5000)
    expect(clampTimeout(MAX_TIMEOUT_MS * 10)).toBe(MAX_TIMEOUT_MS)
  })
})

describe('methodAllowsBody', () => {
  it('matches fetch: GET and HEAD carry none', () => {
    expect(methodAllowsBody('GET')).toBe(false)
    expect(methodAllowsBody('head')).toBe(false)
    expect(methodAllowsBody('POST')).toBe(true)
    expect(methodAllowsBody('DELETE')).toBe(true)
  })
})
