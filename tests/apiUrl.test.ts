import { describe, it, expect } from 'vitest'
import {
  ensureScheme,
  fillPathParams,
  graphqlUrlFor,
  maskUrl,
  maskUserinfo,
  withoutCredentials,
  pathParamNames,
  splitUrl,
  withParams,
  wsUrlFor
} from '../src/shared/apiUrl'

const row = (key: string, value: string, enabled = true) => ({ id: `row_${key}`, enabled, key, value })

describe('query sync', () => {
  it('splits a query into enabled, decoded rows and drops the fragment', () => {
    const { base, query } = splitUrl('https://h/p?a=1&b=x%20y&c&d=e+f#frag')
    expect(base).toBe('https://h/p')
    expect(query.map((r) => [r.key, r.value, r.enabled])).toEqual([
      ['a', '1', true],
      ['b', 'x y', true],
      ['c', '', true],
      ['d', 'e f', true]
    ])
    expect(splitUrl('https://h/p').query).toEqual([])
    expect(splitUrl('https://h/p?bad=%E0%A4%A').query[0].value).toBe('%E0%A4%A')
  })

  it('writes only enabled rows, encodes what would break the query, and keeps templates', () => {
    const rows = [row('a', '1'), row('off', 'x', false), row('q', 'a b&c=d#e'), row('t', '{{token}}'), row('k=', '')]
    expect(withParams('https://h/p?old=1#frag', rows)).toBe('https://h/p?a=1&q=a%20b%26c=d%23e&t={{token}}&k%3D#frag')
    expect(withParams('https://h/p?old=1', [])).toBe('https://h/p')
  })

  it('round-trips through split and join', () => {
    const url = 'https://h/p?a=1&b=x%20y&t={{t}}'
    expect(withParams(url, splitUrl(url).query)).toBe(url)
  })

  it('does not mistake the # of a vault reference for a fragment', () => {
    const url = 'https://h/p?k=vault:abc#password'
    expect(splitUrl(url).query[0].value).toBe('vault:abc#password')
    expect(withParams(url, splitUrl(url).query)).toBe(url)
  })
})

describe('path params', () => {
  it('finds :id and {id} in the path only, once each, and never {{var}}', () => {
    expect(pathParamNames('https://h:8080/users/:id/posts/{postId}/:id')).toEqual(['id', 'postId'])
    expect(pathParamNames('{{baseUrl}}/pets/{petId}')).toEqual(['petId'])
    expect(pathParamNames('{{base}}/x/{{notAParam}}')).toEqual([])
    expect(pathParamNames('https://h/a?x=:no')).toEqual([])
  })

  it('fills them encoded and leaves unknown ones', () => {
    expect(fillPathParams('https://h:8080/users/:id/{other}', { id: 'a/b' })).toBe('https://h:8080/users/a%2Fb/{other}')
    expect(fillPathParams('{{baseUrl}}/pets/{petId}?q=1', { petId: '42' })).toBe('{{baseUrl}}/pets/42?q=1')
  })
})

describe('ensureScheme', () => {
  it('infers http for private hosts and https for public ones', () => {
    for (const host of ['localhost:3000/x', 'api.localhost', '127.0.0.1', '10.0.0.5', '172.16.1.1', '172.31.0.1', '192.168.1.10:8080', 'myhost', 'svc.internal/x', '[::1]:80', 'u@localhost']) {
      expect(ensureScheme(host), host).toEqual({ url: `http://${host}`, scheme: 'http', inferred: true })
    }
    for (const host of ['example.com', 'api.example.com/v1', '172.32.0.1', '8.8.8.8']) {
      expect(ensureScheme(host), host).toEqual({ url: `https://${host}`, scheme: 'https', inferred: true })
    }
  })

  it('leaves an explicit scheme or a template alone', () => {
    expect(ensureScheme('http://example.com')).toEqual({ url: 'http://example.com', scheme: 'http', inferred: false })
    expect(ensureScheme('{{baseUrl}}/x')).toMatchObject({ url: '{{baseUrl}}/x', inferred: false })
  })
})

describe('maskUrl', () => {
  it('masks userinfo and sensitive query values only', () => {
    expect(maskUrl('https://u:p@h/x?access_token=abc&page=2&sig=zz&X-Amz-Signature=q&key=k#f')).toBe(
      'https://•••@h/x?access_token=•••&page=2&sig=•••&X-Amz-Signature=•••&key=•••#f'
    )
    expect(maskUrl('https://h/x')).toBe('https://h/x')
  })
})

// Ported from httpConsoleUrls.test.ts, which keeps testing the old consoles until cutover.
describe('wsUrlFor', () => {
  it('maps the http schemes onto the ws ones, keeping a path', () => {
    expect(wsUrlFor('https://api.example.test')).toBe('wss://api.example.test')
    expect(wsUrlFor('http://127.0.0.1:8080')).toBe('ws://127.0.0.1:8080')
    expect(wsUrlFor('https://h/api')).toBe('wss://h/api')
    expect(wsUrlFor('wss://h/socket')).toBe('wss://h/socket')
  })

  it('does not guess at something it does not recognise', () => {
    expect(wsUrlFor('')).toBe('')
    expect(wsUrlFor('not a url')).toBe('not a url')
  })
})

describe('graphqlUrlFor', () => {
  it('suggests /graphql only when the base has no path', () => {
    expect(graphqlUrlFor('https://api.example.test')).toBe('https://api.example.test/graphql')
    expect(graphqlUrlFor('https://api.example.test/')).toBe('https://api.example.test/graphql')
    expect(graphqlUrlFor('https://h/v2/graph')).toBe('https://h/v2/graph')
  })

  it('does not throw on a base that is not a URL yet', () => {
    expect(graphqlUrlFor('')).toBe('')
    expect(graphqlUrlFor('typing...')).toBe('typing...')
  })
})

describe('withoutCredentials', () => {
  it('drops userinfo and credential-named query params, keeping the rest and the fragment', () => {
    expect(withoutCredentials('https://u:p@h/o.json?access_token=a&v=1&sig=s#x')).toBe('https://h/o.json?v=1#x')
    expect(withoutCredentials('https://h/o.json?token=a')).toBe('https://h/o.json')
    expect(withoutCredentials('https://h/o.json')).toBe('https://h/o.json')
  })
})

describe('maskUserinfo', () => {
  it('masks the whole userinfo, split at the LAST @ of the authority', () => {
    expect(maskUserinfo('https://u:p@ss@host.example.test/x', '•••')).toBe('https://•••@host.example.test/x')
    expect(maskUserinfo('https://u:p@host/a@b?c=d@e#f@g', '•••')).toBe('https://•••@host/a@b?c=d@e#f@g')
  })

  it('trims leading whitespace, and catches a token used as the user name', () => {
    expect(maskUserinfo('  https://u:p@host/x', '•••')).toBe('https://•••@host/x')
    expect(maskUserinfo('https://ghp_TOKEN@github.com/o/r', '•••')).toBe('https://•••@github.com/o/r')
    expect(maskUserinfo('wss://user:pw@h/socket', '•••')).toBe('wss://•••@h/socket')
  })

  it('keeps reference-only userinfo, and an empty mask removes it with its @', () => {
    expect(maskUserinfo('https://{{user}}:{{pass}}@h/x', '•••')).toBe('https://{{user}}:{{pass}}@h/x')
    expect(maskUserinfo('https://u:p@h/x', '')).toBe('https://h/x')
    expect(maskUserinfo('https://h/x', '•••')).toBe('https://h/x')
    expect(maskUserinfo('{{baseUrl}}/x', '•••')).toBe('{{baseUrl}}/x')
  })
})

describe('one userinfo parser for maskUrl and withoutCredentials', () => {
  it('handles a leading space, an @ in the password and a token as the user name', () => {
    expect(maskUrl(' https://u:p@h/x')).toBe('https://•••@h/x')
    expect(maskUrl('https://u:p@ss@h/x')).toBe('https://•••@h/x')
    expect(maskUrl('https://ghp_X@github.com/o')).toBe('https://•••@github.com/o')
    expect(withoutCredentials(' https://u:p@h/x')).toBe('https://h/x')
    expect(withoutCredentials('https://u:p@ss@h/x')).toBe('https://h/x')
    expect(withoutCredentials('https://ghp_X@github.com/o')).toBe('https://github.com/o')
  })

  it('does not end the authority at the # of a vault reference', () => {
    expect(maskUserinfo('https://u:vault:abc#password@h/x', '•••')).toBe('https://•••@h/x')
    expect(maskUserinfo('https://vault:abc#username:vault:abc#password@h/x', '•••')).toBe('https://vault:abc#username:vault:abc#password@h/x')
  })
})
