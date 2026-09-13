import { describe, it, expect } from 'vitest'
import {
  apiPathOf,
  baseOriginOf,
  basePathOf,
  documentForCollection,
  firstOperationOf
} from '../src/shared/apiCollectionImport'

/**
 * Turning a saved collection into the document the client drives.
 *
 * This runs ONCE per collection, on the way in, and after it the document is
 * the source of truth — so a mistake here is not a rendering glitch, it is the
 * user's saved requests arriving wrong or not arriving at all.
 */

describe('apiPathOf', () => {
  it('adds the leading slash a hand-edited record may be missing', () => {
    expect(apiPathOf('v1/users')).toBe('/v1/users')
  })

  it('leaves a well-formed path alone, template braces included', () => {
    expect(apiPathOf('/v1/users/{id}')).toBe('/v1/users/{id}')
  })

  it('trims, because the value came from a text field', () => {
    expect(apiPathOf('  /a  ')).toBe('/a')
  })
})

describe('splitting a base URL', () => {
  it('keeps a path the user pasted', () => {
    expect(basePathOf('http://host:9090/metrics')).toBe('/metrics')
    expect(baseOriginOf('http://host:9090/metrics')).toBe('http://host:9090')
  })

  it('treats a bare origin as the root', () => {
    expect(basePathOf('https://api.example.test')).toBe('/')
  })

  it('does not throw on something that is not a URL yet', () => {
    // The field is typed into, so it is briefly nonsense on the way to being
    // right. Throwing here would take the whole view down mid-keystroke.
    expect(basePathOf('not a url')).toBe('/')
    expect(baseOriginOf('not a url')).toBe('not a url')
  })
})

describe('documentForCollection', () => {
  it('lands an endpoint-less collection on the path from its base URL', () => {
    const doc = documentForCollection({ name: 'Prom', baseUrl: 'http://host:9090/metrics' })

    // The origin is the server and the path is the operation, so the first
    // request goes where the user pasted rather than to `/`.
    expect(doc.servers).toEqual([{ url: 'http://host:9090' }])
    expect(Object.keys(doc.paths as object)).toEqual(['/metrics'])
    expect(firstOperationOf(doc)).toEqual({ path: '/metrics', method: 'get' })
  })

  it('stubs exactly one method, not seven', () => {
    const doc = documentForCollection({ name: 'X', baseUrl: 'https://h' })
    const item = (doc.paths as Record<string, object>)['/']
    // The seven-method stub existed only to work around a method control that
    // was a label. It is a control now, so the extra six are dead weight that
    // showed up as six phantom operations in the sidebar.
    expect(Object.keys(item)).toEqual(['get'])
  })

  it('keeps the base URL whole when there are endpoints under it', () => {
    const doc = documentForCollection({
      name: 'Api',
      baseUrl: 'https://h/api',
      endpoints: [{ method: 'get', path: '/users' }]
    })
    // `/api` in the base was meant to apply to every request, so it stays on
    // the server rather than being dropped.
    expect(doc.servers).toEqual([{ url: 'https://h/api' }])
    expect(Object.keys(doc.paths as object)).toEqual(['/users'])
  })

  it('collapses two methods on one path into a single path item', () => {
    const doc = documentForCollection({
      name: 'Api',
      baseUrl: 'https://h',
      endpoints: [
        { method: 'get', path: '/users' },
        { method: 'post', path: '/users' }
      ]
    })
    const paths = doc.paths as Record<string, Record<string, unknown>>
    expect(Object.keys(paths)).toEqual(['/users'])
    expect(Object.keys(paths['/users']).sort()).toEqual(['get', 'post'])
  })

  it('normalises a stored path that lost its slash', () => {
    const doc = documentForCollection({
      name: 'Api',
      baseUrl: 'https://h',
      endpoints: [{ method: 'get', path: 'v1/users' }]
    })
    // A backup or a hand edit can hold this. Left alone, the client would be
    // told to open an operation the document does not contain.
    expect(Object.keys(doc.paths as object)).toEqual(['/v1/users'])
  })

  it('carries a summary through, and invents one when there is none', () => {
    const doc = documentForCollection({
      name: 'Api',
      baseUrl: 'https://h',
      endpoints: [
        { method: 'get', path: '/a', summary: 'List the As' },
        { method: 'get', path: '/b' }
      ]
    })
    const paths = doc.paths as Record<string, Record<string, { summary: string }>>
    expect(paths['/a'].get.summary).toBe('List the As')
    expect(paths['/b'].get.summary).toBe('GET /b')
  })

  it('uppercases nothing and lowercases the method, as OpenAPI requires', () => {
    const doc = documentForCollection({
      name: 'Api',
      baseUrl: 'https://h',
      endpoints: [{ method: 'POST', path: '/a' }]
    })
    expect(Object.keys((doc.paths as Record<string, object>)['/a'])).toEqual(['post'])
  })

  it('gives each operation an id that does not move when a sibling is deleted', () => {
    const both = documentForCollection({
      name: 'Api',
      baseUrl: 'https://h',
      endpoints: [
        { method: 'get', path: '/a' },
        { method: 'get', path: '/b' }
      ]
    })
    const onlyB = documentForCollection({
      name: 'Api',
      baseUrl: 'https://h',
      endpoints: [{ method: 'get', path: '/b' }]
    })
    const idOf = (doc: Record<string, unknown>, path: string): unknown =>
      (doc.paths as Record<string, Record<string, { operationId: string }>>)[path].get.operationId

    // History and tabs key on this. A counter-derived id would re-point every
    // saved reference the moment something above it was removed.
    expect(idOf(both, '/b')).toBe(idOf(onlyB, '/b'))
  })
})

describe('firstOperationOf', () => {
  it('picks the first endpoint the user wrote, not an arbitrary one', () => {
    const doc = documentForCollection({
      name: 'Api',
      baseUrl: 'https://h',
      endpoints: [
        { method: 'delete', path: '/z' },
        { method: 'get', path: '/a' }
      ]
    })
    expect(firstOperationOf(doc)).toEqual({ path: '/z', method: 'delete' })
  })

  it('ignores path-item keys that are not operations', () => {
    // `summary`, `description`, `servers` and `parameters` are all legal on a
    // path item. Landing on one of them lands on something unsendable.
    const doc = {
      paths: { '/a': { summary: 'not an operation', parameters: [], get: { operationId: 'g' } } }
    }
    expect(firstOperationOf(doc)).toEqual({ path: '/a', method: 'get' })
  })

  it('returns null for a document with no operations at all', () => {
    expect(firstOperationOf({ paths: {} })).toBeNull()
    expect(firstOperationOf({})).toBeNull()
  })
})
