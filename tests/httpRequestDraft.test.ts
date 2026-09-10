import { describe, it, expect } from 'vitest'
import {
  buildHeaders,
  buildUrl,
  bodyFor,
  emptyDraft,
  guessContentType,
  hasContentType,
  joinUrl,
  prettyBody,
  type KeyValueRow
} from '../src/shared/httpRequestDraft'

/**
 * The request a person is composing.
 *
 * Pure and tested away from the DOM because this is the part that has to be
 * right: joining a base to a path, appending parameters to a URL that may
 * already carry some, and deciding whether a body is legal at all. Each has an
 * obvious implementation that is wrong at exactly one edge.
 */

const row = (key: string, value: string, enabled = true): KeyValueRow => ({
  id: key,
  enabled,
  key,
  value
})

describe('joining a base URL to a path', () => {
  it('does not double or lose the slash', () => {
    expect(joinUrl('https://h', '/v1')).toBe('https://h/v1')
    expect(joinUrl('https://h/', '/v1')).toBe('https://h/v1')
    expect(joinUrl('https://h', 'v1')).toBe('https://h/v1')
    expect(joinUrl('https://h/', 'v1')).toBe('https://h/v1')
  })

  /**
   * The base's own path is kept. Somebody who put `/api` in the base meant it
   * to apply to every request, and dropping it sends each one to the wrong
   * place with nothing on screen explaining why.
   */
  it('keeps a path that is part of the base', () => {
    expect(joinUrl('https://h/api', '/v1/users')).toBe('https://h/api/v1/users')
  })

  // How somebody sends one request elsewhere without editing the collection.
  it('lets an absolute URL win outright', () => {
    expect(joinUrl('https://h/api', 'https://other.example/x')).toBe('https://other.example/x')
    expect(joinUrl('https://h/api', 'http://other.example/x')).toBe('http://other.example/x')
  })

  it('copes with either half being empty', () => {
    expect(joinUrl('', '/v1')).toBe('/v1')
    expect(joinUrl('https://h', '')).toBe('https://h')
  })
})

describe('the query string', () => {
  it('appends the enabled rows', () => {
    const d = { ...emptyDraft('GET', '/x'), params: [row('a', '1'), row('b', '2')] }
    expect(buildUrl('https://h', d)).toBe('https://h/x?a=1&b=2')
  })

  it('leaves out rows that are off or unnamed', () => {
    const d = {
      ...emptyDraft('GET', '/x'),
      params: [row('a', '1'), row('b', '2', false), row('', 'no key')]
    }
    expect(buildUrl('https://h', d)).toBe('https://h/x?a=1')
  })

  /**
   * Appended, not replacing. An `?api_key=…` already on the base URL is a real
   * way to configure a collection, and dropping it sends an unauthenticated
   * request that fails for a reason nothing on screen explains.
   */
  it('keeps a query the base or path already carried', () => {
    const d = { ...emptyDraft('GET', '/x?api_key=k'), params: [row('q', 'london')] }
    expect(buildUrl('https://h', d)).toBe('https://h/x?api_key=k&q=london')
  })

  it('encodes keys and values', () => {
    const d = { ...emptyDraft('GET', '/x'), params: [row('a b', 'c&d=e')] }
    expect(buildUrl('https://h', d)).toBe('https://h/x?a%20b=c%26d%3De')
  })

  // A fragment stays at the end, where it belongs — a query appended after it
  // would be part of the fragment and never sent.
  it('puts the parameters before a fragment', () => {
    const d = { ...emptyDraft('GET', '/x#top'), params: [row('a', '1')] }
    expect(buildUrl('https://h', d)).toBe('https://h/x?a=1#top')
  })

  it('changes nothing when there are no parameters', () => {
    expect(buildUrl('https://h', emptyDraft('GET', '/x'))).toBe('https://h/x')
  })
})

describe('headers', () => {
  it('takes the enabled rows, trimming the names', () => {
    const d = { ...emptyDraft(), headers: [row(' X-Key ', 'v'), row('off', 'x', false)] }
    expect(buildHeaders(d)).toEqual({ 'X-Key': 'v' })
  })

  it('recognises a content type in any casing', () => {
    expect(hasContentType({ 'content-type': 'application/json' })).toBe(true)
    expect(hasContentType({ 'Content-Type': 'application/json' })).toBe(true)
    expect(hasContentType({ Accept: 'application/json' })).toBe(false)
  })
})

describe('the body', () => {
  /**
   * GET and HEAD carry none — fetch itself throws on the attempt. Kept in the
   * draft rather than cleared: switching GET → POST → GET while writing a
   * payload must not silently destroy it.
   */
  it('is not sent on a method that cannot carry one', () => {
    expect(bodyFor({ ...emptyDraft('GET'), body: '{"a":1}' })).toBeNull()
    expect(bodyFor({ ...emptyDraft('HEAD'), body: '{"a":1}' })).toBeNull()
  })

  it('is sent on one that can', () => {
    expect(bodyFor({ ...emptyDraft('POST'), body: '{"a":1}' })).toBe('{"a":1}')
    expect(bodyFor({ ...emptyDraft('PUT'), body: 'x' })).toBe('x')
  })

  it('is absent when it is only whitespace', () => {
    expect(bodyFor({ ...emptyDraft('POST'), body: '   \n ' })).toBeNull()
  })

  it('guesses a type from the shape, for the header nobody added', () => {
    expect(guessContentType(' {"a":1} ')).toBe('application/json')
    expect(guessContentType('[1,2]')).toBe('application/json')
    expect(guessContentType('<x/>')).toBe('application/xml')
    expect(guessContentType('hello')).toBe('text/plain')
  })
})

describe('showing a response', () => {
  it('pretty-prints JSON', () => {
    expect(prettyBody('{"a":1}')).toBe('{\n  "a": 1\n}')
  })

  /**
   * The ORIGINAL text on any parse failure. A truncated response is still
   * worth reading, and replacing it with a complaint about invalid JSON hides
   * the bytes that explain what went wrong.
   */
  it('leaves anything it cannot parse exactly as it arrived', () => {
    expect(prettyBody('{"a":1')).toBe('{"a":1')
    expect(prettyBody('plain text')).toBe('plain text')
    expect(prettyBody('<html></html>')).toBe('<html></html>')
  })
})
