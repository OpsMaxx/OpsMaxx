import { describe, it, expect } from 'vitest'
import { scratchDocument, scratchOriginOf, scratchPathOf } from '../src/shared/apiScratch'
import type { ApiEndpoint } from '../src/shared/apiScratch'

/**
 * The document a collection builds when it imports no OpenAPI description.
 *
 * Reported as four things at once — no way to send a request, no way to craft
 * one manually, no way to add or remove endpoints, no way to create a blank
 * project — and all four were one cause. The client is spec-driven, and a
 * collection with no spec got a SYNTHETIC one: a single path off the base URL
 * with all seven methods stubbed. Nothing ever wrote paths back, so there was
 * no way to name a second path and therefore nothing to add, remove or aim a
 * request at.
 */

const ep = (method: string, path: string, summary?: string): ApiEndpoint => ({
  method,
  path,
  ...(summary ? { summary } : {})
})

const pathsOf = (doc: Record<string, unknown>): Record<string, Record<string, unknown>> =>
  doc.paths as Record<string, Record<string, unknown>>

describe('a collection with no endpoints yet', () => {
  /**
   * The fallback, and why it stays: a brand-new scratch collection has to be
   * usable the moment it is created. An empty document renders an empty
   * screen with no obvious next step.
   */
  it('stubs every method on the base URL path, so it works immediately', () => {
    const doc = scratchDocument('Testing', 'http://localhost:9090/metrics', [])
    const paths = pathsOf(doc)
    expect(Object.keys(paths)).toEqual(['/metrics'])
    expect(Object.keys(paths['/metrics']).sort()).toEqual(
      ['delete', 'get', 'head', 'options', 'patch', 'post', 'put'].sort()
    )
  })

  // The URL somebody was about to curl usually carries a path. Dropping it
  // sends the first request somewhere they never asked for, and the 404 looks
  // like the service is broken.
  it('keeps the path from the base URL rather than opening on /', () => {
    expect(scratchPathOf('http://host:9090/metrics')).toBe('/metrics')
    expect(scratchPathOf('http://host:9090')).toBe('/')
    expect(scratchPathOf('not a url')).toBe('/')
  })

  it('serves the origin, since the path rides on the operation', () => {
    expect(scratchOriginOf('http://host:9090/metrics')).toBe('http://host:9090')
    expect(scratchOriginOf('nonsense')).toBe('nonsense')
  })
})

describe('a collection with hand-written endpoints', () => {
  it('builds the document from them, not from the base URL', () => {
    const doc = scratchDocument('API', 'https://api.example.com', [
      ep('get', '/v1/users'),
      ep('post', '/v1/users')
    ])
    const paths = pathsOf(doc)
    expect(Object.keys(paths)).toEqual(['/v1/users'])
    // One path item holding two operations, which is what an OpenAPI path is.
    expect(Object.keys(paths['/v1/users']).sort()).toEqual(['get', 'post'])
  })

  it('keeps separate paths separate', () => {
    const doc = scratchDocument('API', 'https://api.example.com', [
      ep('get', '/health'),
      ep('get', '/v1/users'),
      ep('delete', '/v1/users/1')
    ])
    expect(Object.keys(pathsOf(doc)).sort()).toEqual(['/health', '/v1/users', '/v1/users/1'])
  })

  it('does not stub methods the user did not ask for', () => {
    const doc = scratchDocument('API', 'https://api.example.com', [ep('get', '/only')])
    expect(Object.keys(pathsOf(doc)['/only'])).toEqual(['get'])
  })

  it('accepts a path written without its leading slash', () => {
    const doc = scratchDocument('API', 'https://api.example.com', [ep('get', 'v1/users')])
    expect(Object.keys(pathsOf(doc))).toEqual(['/v1/users'])
  })

  it("uses the user's summary where they gave one", () => {
    const doc = scratchDocument('API', 'https://api.example.com', [
      ep('get', '/v1/users', 'List every user'),
      ep('get', '/health')
    ])
    const paths = pathsOf(doc)
    expect((paths['/v1/users'].get as { summary: string }).summary).toBe('List every user')
    // And a readable default where they did not.
    expect((paths['/health'].get as { summary: string }).summary).toBe('GET /health')
  })

  /**
   * A body on GET is how a client ends up sending one, which some servers
   * reject outright — so it is offered only where it means something.
   */
  it('offers a request body only where one is meaningful', () => {
    const doc = scratchDocument('API', 'https://api.example.com', [
      ep('get', '/a'),
      ep('post', '/b'),
      ep('put', '/c'),
      ep('patch', '/d'),
      ep('delete', '/e')
    ])
    const paths = pathsOf(doc)
    expect(paths['/a'].get).not.toHaveProperty('requestBody')
    expect(paths['/e'].delete).not.toHaveProperty('requestBody')
    expect(paths['/b'].post).toHaveProperty('requestBody')
    expect(paths['/c'].put).toHaveProperty('requestBody')
    expect(paths['/d'].patch).toHaveProperty('requestBody')
  })

  // The client sends to the document's server, and the collection's base URL
  // is what the user chose over whatever a description declares.
  it('sends to the collection base URL, as an origin', () => {
    const doc = scratchDocument('API', 'https://api.example.com/ignored', [ep('get', '/v1/x')])
    expect(doc.servers).toEqual([{ url: 'https://api.example.com' }])
  })

  it('declares no server at all when there is no base URL', () => {
    const doc = scratchDocument('API', '', [ep('get', '/v1/x')])
    expect(doc).not.toHaveProperty('servers')
  })

  it('is a valid OpenAPI 3.1 document either way', () => {
    for (const eps of [[], [ep('get', '/x')]]) {
      const doc = scratchDocument('T', 'https://h', eps)
      expect(doc.openapi).toBe('3.1.0')
      expect(doc.info).toEqual({ title: 'T', version: '1.0.0' })
    }
  })

  // Every operation needs a distinct operationId, or the client keys two of
  // them to one entry and the second becomes unreachable.
  it('gives every operation its own id', () => {
    const doc = scratchDocument('API', 'https://h', [
      ep('get', '/a'),
      ep('post', '/a'),
      ep('get', '/b')
    ])
    const ids: string[] = []
    for (const item of Object.values(pathsOf(doc))) {
      for (const op of Object.values(item)) ids.push((op as { operationId: string }).operationId)
    }
    expect(new Set(ids).size).toBe(ids.length)
  })
})
