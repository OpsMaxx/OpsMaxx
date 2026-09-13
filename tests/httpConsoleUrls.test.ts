import { describe, it, expect } from 'vitest'
import { wsUrlFor } from '../src/renderer/src/components/http/WsConsole'
import { graphqlUrlFor } from '../src/renderer/src/components/http/GraphQlConsole'

/**
 * Where the WebSocket and GraphQL panes start from.
 *
 * Both derive a first URL from the collection's base so the field is not
 * empty, and both have to leave alone anything the user was deliberate about.
 * Pure functions, exported from the components so they can be checked without
 * mounting either one.
 */

describe('wsUrlFor', () => {
  it('maps the http schemes onto the ws ones', () => {
    expect(wsUrlFor('https://api.example.test')).toBe('wss://api.example.test')
    expect(wsUrlFor('http://127.0.0.1:8080')).toBe('ws://127.0.0.1:8080')
  })

  it('keeps a path, because a socket usually lives on one', () => {
    expect(wsUrlFor('https://h/api')).toBe('wss://h/api')
  })

  it('leaves a URL that is already a WebSocket alone', () => {
    expect(wsUrlFor('wss://h/socket')).toBe('wss://h/socket')
  })

  it('does not guess at something it does not recognise', () => {
    expect(wsUrlFor('')).toBe('')
    expect(wsUrlFor('not a url')).toBe('not a url')
  })
})

describe('graphqlUrlFor', () => {
  it('suggests the conventional path when the base has none', () => {
    expect(graphqlUrlFor('https://api.example.test')).toBe('https://api.example.test/graphql')
    expect(graphqlUrlFor('https://api.example.test/')).toBe('https://api.example.test/graphql')
  })

  it('leaves a base that already names a path exactly as it is', () => {
    // Somebody who typed a path meant it.
    expect(graphqlUrlFor('https://h/v2/graph')).toBe('https://h/v2/graph')
  })

  it('does not throw on a base that is not a URL yet', () => {
    expect(graphqlUrlFor('')).toBe('')
    expect(graphqlUrlFor('typing...')).toBe('typing...')
  })
})
