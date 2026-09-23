import { describe, it, expect } from 'vitest'
import { buildClientSchema, graphqlSync, buildSchema, parse, validate, getIntrospectionQuery } from 'graphql'
import {
  INTROSPECTION_QUERY,
  introspectionQuery,
  isDepthOrComplexityError,
  buildGraphQlBody,
  parseVariables,
  readGraphQlResponse,
  renderTypeRef,
  usefulTypes
} from '../src/shared/graphql'

/**
 * GraphQL over HTTP, in the two places it differs from a POST.
 *
 * The important block is the last one: a GraphQL error arrives with HTTP 200,
 * and reporting that as a success is the single thing that makes a generic
 * HTTP client wrong for GraphQL.
 */

describe('variables', () => {
  it('treats an empty editor as no variables at all', () => {
    // Not `{}`: some servers reject a `variables` key that is present but
    // empty on a query that takes none.
    expect(parseVariables('')).toEqual({ ok: true })
    expect(parseVariables('   \n ')).toEqual({ ok: true })
  })

  it('parses an object', () => {
    expect(parseVariables('{"id": 1}')).toEqual({ ok: true, variables: { id: 1 } })
  })

  it('reports a syntax error rather than sending nothing', () => {
    const result = parseVariables('{"id": }')
    expect(result.ok).toBe(false)
  })

  it('refuses a top-level array or scalar, with a reason', () => {
    // Sending `[1,2]` produces a server error that talks about the query
    // rather than about the thing that is actually wrong.
    for (const bad of ['[1,2]', '"hello"', '42', 'null']) {
      const result = parseVariables(bad)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toMatch(/JSON object/)
    }
  })
})

describe('the request body', () => {
  it('carries the query alone when there is nothing else', () => {
    expect(JSON.parse(buildGraphQlBody({ query: '{a}' }))).toEqual({ query: '{a}' })
  })

  it('carries variables as an object, not as a string', () => {
    const body = JSON.parse(buildGraphQlBody({ query: '{a}', variables: { id: 1 } }))
    // The most common way a query fails for a reason the error does not
    // explain is a stringified `variables`.
    expect(body.variables).toEqual({ id: 1 })
    expect(typeof body.variables).toBe('object')
  })

  it('names the operation only when there is one to name', () => {
    expect(JSON.parse(buildGraphQlBody({ query: '{a}' })).operationName).toBeUndefined()
    expect(JSON.parse(buildGraphQlBody({ query: '{a}', operationName: 'Q' })).operationName).toBe('Q')
  })
})

describe('reading the response', () => {
  /**
   * The reason this module exists.
   */
  it('reports a 200 carrying errors as a FAILURE', () => {
    const read = readGraphQlResponse(200, JSON.stringify({ errors: [{ message: 'Not authorised' }] }))
    expect(read.ok).toBe(false)
    expect(read.response?.errors?.[0].message).toBe('Not authorised')
  })

  it('reports a partial success as a failure but keeps the data', () => {
    // GraphQL allows both. The errors are the part needing attention, so the
    // verdict follows them — and `data` is still handed back to be rendered.
    const read = readGraphQlResponse(
      200,
      JSON.stringify({ data: { me: null }, errors: [{ message: 'me failed' }] })
    )
    expect(read.ok).toBe(false)
    expect(read.response?.data).toEqual({ me: null })
  })

  it('reports a clean 200 as a success', () => {
    const read = readGraphQlResponse(200, JSON.stringify({ data: { me: { id: 1 } } }))
    expect(read.ok).toBe(true)
  })

  it('treats an empty errors array as no errors', () => {
    expect(readGraphQlResponse(200, JSON.stringify({ data: {}, errors: [] })).ok).toBe(true)
  })

  it('is not fooled into success by a non-2xx with data', () => {
    expect(readGraphQlResponse(500, JSON.stringify({ data: {} })).ok).toBe(false)
  })

  it('says so when the endpoint did not answer with JSON', () => {
    // Usually an HTML error page from a proxy in front of the endpoint.
    const read = readGraphQlResponse(200, '<html>Bad Gateway</html>')
    expect(read.ok).toBe(false)
    expect(read.parseError).toMatch(/not JSON/)
  })

  it('mentions the status when a non-2xx answered with non-JSON', () => {
    expect(readGraphQlResponse(502, '<html/>').parseError).toMatch(/502/)
  })

  it('refuses a JSON body that is not an object', () => {
    expect(readGraphQlResponse(200, '[1,2]').parseError).toMatch(/JSON object/)
  })
})

describe('rendering a schema', () => {
  it('writes a field type the way a schema does', () => {
    expect(
      renderTypeRef({
        kind: 'NON_NULL',
        ofType: { kind: 'LIST', ofType: { kind: 'NON_NULL', ofType: { kind: 'OBJECT', name: 'Thing' } } }
      })
    ).toBe('[Thing!]!')
  })

  it('renders a plain type and copes with an absent one', () => {
    expect(renderTypeRef({ kind: 'SCALAR', name: 'String' })).toBe('String')
    expect(renderTypeRef(undefined)).toBe('')
  })

  it('hides the introspection machinery and the built-in scalars', () => {
    // Every schema carries a few dozen `__`-prefixed types describing
    // introspection itself. Listing them buries the handful somebody wants.
    const types = usefulTypes([
      { kind: 'OBJECT', name: '__Schema' },
      { kind: 'SCALAR', name: 'String' },
      { kind: 'SCALAR', name: 'ID' },
      { kind: 'OBJECT', name: 'User' }
    ])
    expect(types.map((t) => t.name)).toEqual(['User'])
  })

  it('sorts by name so the list is scannable', () => {
    const types = usefulTypes([
      { kind: 'OBJECT', name: 'Zebra' },
      { kind: 'OBJECT', name: 'Apple' }
    ])
    expect(types.map((t) => t.name)).toEqual(['Apple', 'Zebra'])
  })
})

describe('the introspection query', () => {
  it('is valid-looking GraphQL that asks for the schema', () => {
    expect(INTROSPECTION_QUERY).toContain('__schema')
    expect(INTROSPECTION_QUERY).toContain('fragment TypeRef on __Type')
  })

  it('is bounded rather than fully recursive', () => {
    // A fully recursive introspection on a large schema is megabytes of
    // response. Three levels of `ofType` covers `[Thing!]!`, which is as
    // nested as a real field type gets.
    const depth = (INTROSPECTION_QUERY.match(/ofType/g) ?? []).length
    expect(depth).toBeLessThanOrEqual(6)
  })
})

describe('the redesigned client’s introspection query', () => {
  const sdl = buildSchema(`
    type Query { country(code: ID!): Country, grid: [[Cell]!]! }
    """A country"""
    type Country { name: String @deprecated(reason: "use label"), label: String }
    type Cell { v: Int }
  `)

  it('is valid against the introspection schema, in both forms', () => {
    for (const lean of [false, true]) expect(validate(sdl, parse(introspectionQuery({ lean })))).toEqual([])
  })

  it('goes four ofType deep, which is enough to rebuild [[Thing]!]!', () => {
    const q = introspectionQuery()
    expect(q.split('fragment TypeRef')[1].match(/ofType/g)).toHaveLength(4)
    const result = graphqlSync({ schema: sdl, source: q })
    expect(result.errors).toBeUndefined()
    const rebuilt = buildClientSchema(result.data as never)
    expect(String(rebuilt.getQueryType()!.getFields().grid.type)).toBe('[[Cell]!]!')
  })

  it('can be asked deeper, for the schema that needs it', () => {
    expect(introspectionQuery({ depth: 8 }).split('fragment TypeRef')[1].match(/ofType/g)).toHaveLength(8)
  })

  it('drops descriptions and deprecated fields when lean', () => {
    const full = introspectionQuery()
    const lean = introspectionQuery({ lean: true })
    expect(full).toContain('description')
    expect(lean).not.toContain('description')
    expect(lean).toContain('includeDeprecated: false')
    const rebuilt = buildClientSchema(graphqlSync({ schema: sdl, source: lean }).data as never)
    expect(rebuilt.getType('Country')!.description).toBeFalsy()
    expect(Object.keys((rebuilt.getType('Country') as never as { getFields(): object }).getFields())).toEqual(['label'])
  })

  it('is no heavier than graphql’s own default query', () => {
    expect(introspectionQuery().length).toBeLessThan(getIntrospectionQuery().length * 1.5)
  })

  it('recognises a refusal for size, and only that', () => {
    expect(isDepthOrComplexityError([{ message: 'Query depth 12 exceeds maximum 10' }])).toBe(true)
    expect(isDepthOrComplexityError([{ message: 'Query is too complex: 1200 > 1000' }])).toBe(true)
    expect(isDepthOrComplexityError([{ message: 'Cannot query field "x" on type "Query".' }])).toBe(false)
    expect(isDepthOrComplexityError(undefined)).toBe(false)
  })
})
