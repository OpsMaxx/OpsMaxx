// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { EditorState } from '@codemirror/state'
import { CompletionContext, type CompletionResult, type CompletionSource } from '@codemirror/autocomplete'
import { buildSchema, graphqlSync, type GraphQLSchema } from 'graphql'
import { stubBridge } from './setup/renderer'
import { useGqlSchemas, type SchemaKey } from '../src/renderer/src/store/gqlSchemas'
import {
  describeAsText,
  errorsStrip,
  literalSecretsIn,
  gqlExtensions,
  loadSchema,
  operationAt,
  operationsIn,
  prettify,
  type IntrospectResult
} from '../src/renderer/src/components/http/gql/graphqlLanguage'
import { SchemaExplorer, explorerMode } from '../src/renderer/src/components/http/gql/SchemaExplorer'
import type { ResponseState } from '../src/shared/apiModel'

// The GraphQL tab's parts that stand on their own: the language, the schema
// store, introspection with its fallbacks, the explorer and the errors strip.


const SDL = buildSchema(`
  """The root."""
  type Query {
    """Look one up by ISO code."""
    country(code: ID!): Country
    countries: [Country!]!
  }
  type Mutation { rename(code: ID!, name: String!): Country }
  """A country. <img src=x onerror="window.pwned=1">"""
  type Country { code: ID!, name: String, continent: Continent }
  enum Continent { AF EU }
`)

/** A server that answers introspection by executing it against `schema`. */
const serve =
  (schema: GraphQLSchema, refuse?: (query: string) => string | null) =>
  async (query: string): Promise<IntrospectResult> => {
    const refusal = refuse?.(query)
    if (refusal) return { ok: true, status: 200, text: JSON.stringify({ errors: [{ message: refusal }] }) }
    return { ok: true, status: 200, text: JSON.stringify(graphqlSync({ schema, source: query })) }
  }

const clipboard = { write: vi.fn() }
beforeEach(() => {
  vi.clearAllMocks()
  stubBridge({ clipboard })
})

describe('the query language', () => {
  it('offers a field from a loaded schema', async () => {
    const state = EditorState.create({ doc: '{ cou', extensions: gqlExtensions(SDL) })
    const [source] = state.languageDataAt<CompletionSource>('autocomplete', 5)
    const result = (await source(new CompletionContext(state, 5, true))) as CompletionResult
    expect(result.options.map((o) => o.label)).toEqual(expect.arrayContaining(['country', 'countries']))
  })

  it('renders completion documentation as text, never markup', () => {
    const node = describeAsText({ documentation: '<img src=x onerror="window.pwned=1">' }) as HTMLElement
    expect(node.querySelector('img')).toBeNull()
    expect(node.textContent).toBe('<img src=x onerror="window.pwned=1">')
    expect(describeAsText({})).toBeNull()
  })

  it('lists operations, and picks the one under the cursor', () => {
    const doc = 'query A { countries { code } }\n\nmutation B { rename(code: "x", name: "y") { code } }'
    const ops = operationsIn(doc)
    expect(ops.map((o) => [o.name, o.type])).toEqual([
      ['A', 'query'],
      ['B', 'mutation']
    ])
    expect(operationAt(ops, 3)?.name).toBe('A')
    expect(operationAt(ops, doc.length - 2)?.name).toBe('B')
    // Between the two: the one before the cursor.
    expect(operationAt(ops, 31)?.name).toBe('A')
    expect(operationsIn('query {')).toEqual([])
  })

  it('prettifies with graphql’s printer, and leaves a broken query alone', () => {
    expect(prettify('{countries{code name}}')).toBe('{\n  countries {\n    code\n    name\n  }\n}')
    expect(prettify('{ countries {')).toBeNull()
  })
})

describe('introspection', () => {
  it('rebuilds the schema from the server’s answer', async () => {
    const schema = (await loadSchema(serve(SDL))) as GraphQLSchema
    expect(Object.keys(schema.getQueryType()!.getFields())).toEqual(['country', 'countries'])
  })

  it('retries once without descriptions when the server refuses for depth, and says so', async () => {
    const run = vi.fn(serve(SDL, (q) => (q.includes('description') ? 'Query depth 9 exceeds maximum depth 7' : null)))
    const got = await loadSchema(run)
    expect(run).toHaveBeenCalledTimes(2)
    expect('note' in got && got.note).toMatch(/without descriptions/)
  })

  it('does not retry an error that is not about size', async () => {
    const run = vi.fn(serve(SDL, () => 'Introspection is disabled'))
    await expect(loadSchema(run)).rejects.toThrow(/Introspection is disabled/)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('asks again deeper for a type nested past four ofTypes', async () => {
    const deep = buildSchema('type Query { shape: [[[Float!]!]!]! }')
    const run = vi.fn(serve(deep))
    const schema = (await loadSchema(run)) as GraphQLSchema
    expect(String(schema.getQueryType()!.getFields().shape.type)).toBe('[[[Float!]!]!]!')
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('reports a transport failure with its reason', async () => {
    await expect(loadSchema(async () => ({ ok: false, message: 'That server was removed' }))).rejects.toThrow(
      'That server was removed'
    )
  })
})

describe('the schema store', () => {
  const key: SchemaKey = 'https://countries.example.test/|direct'

  it('loads, and runs one introspection for concurrent asks', async () => {
    const fetcher = vi.fn(async () => SDL)
    await Promise.all([useGqlSchemas.getState().load(key, fetcher), useGqlSchemas.getState().load(key, fetcher)])
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(useGqlSchemas.getState().byKey[key].status).toBe('ready')
  })

  it('keeps the schema it had when a reload fails, and says why beside it', async () => {
    await useGqlSchemas.getState().load(key, async () => SDL)
    await useGqlSchemas.getState().load(key, async () => {
      throw new Error('timed out')
    })
    const entry = useGqlSchemas.getState().byKey[key]
    expect(entry.status === 'ready' && entry.schema).toBe(SDL)
    expect(entry.status === 'ready' && entry.error).toBe('timed out')
  })

  it('keys by route as well as URL', async () => {
    await useGqlSchemas.getState().load(key, async () => SDL)
    expect(useGqlSchemas.getState().byKey['https://countries.example.test/|server:web-01']).toBeUndefined()
    useGqlSchemas.getState().clear(key)
    expect(useGqlSchemas.getState().byKey[key]).toBeUndefined()
  })
})

describe('the explorer', () => {
  const ready = { status: 'ready' as const, schema: SDL, at: Date.now() }
  const props = { pinned: false, onPin: () => {}, onClose: () => {}, onLoad: () => {}, target: 'https://x.test via This machine' }

  it('docks when the request half keeps a 320px editor beside it, and overlays otherwise', () => {
    expect(explorerMode(604)).toBe('dock')
    expect(explorerMode(603)).toBe('overlay')
    const { rerender } = render(<SchemaExplorer entry={ready} mode="overlay" {...props} />)
    expect(screen.getByRole('complementary', { name: 'Schema explorer' }).className).toContain('is-overlay')
    rerender(<SchemaExplorer entry={ready} mode="dock" {...props} />)
    expect(screen.getByRole('complementary', { name: 'Schema explorer' }).className).toContain('is-dock')
  })

  it('offers Load schema, and names where introspection goes, before anything is loaded', () => {
    const onLoad = vi.fn()
    render(<SchemaExplorer entry={undefined} mode="dock" {...props} onLoad={onLoad} />)
    expect(screen.getByText(/Introspection is sent to https:\/\/x\.test via This machine/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Load schema' }))
    expect(onLoad).toHaveBeenCalled()
  })

  it('shows the roots with arguments and types, filters, and goes to a type', () => {
    render(<SchemaExplorer entry={ready} mode="dock" {...props} />)
    const tree = screen.getByRole('tree', { name: 'Schema' })
    expect(within(tree).getByText('country(code: ID!)')).toBeTruthy()
    expect(within(tree).getAllByRole('button', { name: 'Go to type Country' })[0].textContent).toBe('Country')

    fireEvent.change(screen.getByLabelText('Filter schema'), { target: { value: 'renam' } })
    expect(screen.queryByText('country(code: ID!)')).toBeNull()
    expect(screen.getByText('rename(code: ID!, name: String!)')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Filter schema'), { target: { value: '' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'Go to type Country' })[0])
    const country = screen.getByRole('tree', { name: 'Country' })
    expect(within(country).getByText('continent')).toBeTruthy()
  })

  it('renders descriptions as text', () => {
    const { container } = render(<SchemaExplorer entry={ready} mode="dock" {...props} />)
    fireEvent.click(screen.getAllByRole('button', { name: 'Go to type Country' })[0])
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByText(/A country\. <img src=x/)).toBeTruthy()
  })

  it('has the field menu: copy name, copy type, go to type', () => {
    render(<SchemaExplorer entry={ready} mode="dock" {...props} />)
    fireEvent.contextMenu(screen.getByText('country(code: ID!)').closest('li')!)
    expect(screen.getAllByRole('menuitem').map((b) => b.textContent)).toEqual(['Copy field name', 'Copy type', 'Go to type'])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy type' }))
    expect(clipboard.write).toHaveBeenCalledWith('Country')
  })

  it('keeps showing the old schema while a reload runs, and closes on Esc', () => {
    const onClose = vi.fn()
    render(
      <SchemaExplorer entry={{ status: 'loading', previous: { schema: SDL, at: 0 } }} mode="overlay" {...props} onClose={onClose} />
    )
    expect(screen.getByText('Loading schema…')).toBeTruthy()
    expect(screen.getByText('country(code: ID!)')).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('complementary', { name: 'Schema explorer' }), { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })
})

describe('the errors strip', () => {
  const done = (body: unknown, status = 200): ResponseState => ({
    status: 'done',
    at: 0,
    response: {
      ok: true,
      status,
      statusText: 'OK',
      headers: {},
      body: new TextEncoder().encode(JSON.stringify(body)).buffer as ArrayBuffer,
      durationMs: 1
    } as never,
    sentAs: {} as never
  })

  it('counts errors[] and quotes the first, on a 200', () => {
    expect(errorsStrip(done({ data: null, errors: [{ message: 'Unknown code' }, { message: 'b' }] }))).toBe(
      '2 errors · first: Unknown code'
    )
  })

  it('says nothing for a clean response, or before one', () => {
    expect(errorsStrip(done({ data: { a: 1 } }))).toBeNull()
    expect(errorsStrip(done({ data: { a: 1 }, errors: [] }))).toBeNull()
    expect(errorsStrip(undefined)).toBeNull()
    expect(errorsStrip({ status: 'sending', startedAt: 0, requestId: 'r' })).toBeNull()
  })

  it('is text: a message carrying markup stays a string', () => {
    act(() => {})
    expect(errorsStrip(done({ errors: [{ message: '<b>x</b>' }] }))).toBe('1 error · first: <b>x</b>')
  })
})

describe('secrets in the variables', () => {
  it('finds a sensitive key with a literal value, at any depth', () => {
    expect(literalSecretsIn('{"a":{"password":"hunter2"},"id":1}')).toEqual([{ key: 'password', value: 'hunter2' }])
    expect(literalSecretsIn('{"input":{"apiKey":"sk_live_x","name":"n"}}').map((s) => s.key)).toEqual(['apiKey'])
  })

  it('leaves references, ordinary keys and text that is not JSON alone', () => {
    expect(literalSecretsIn('{"token":"{{token}}"}')).toEqual([])
    expect(literalSecretsIn('{"password":"vault:abc123#password"}')).toEqual([])
    expect(literalSecretsIn('{"code":"BR"}'.replace('code', 'country'))).toEqual([])
    expect(literalSecretsIn('{"token": {{token}} }')).toEqual([])
  })
})
