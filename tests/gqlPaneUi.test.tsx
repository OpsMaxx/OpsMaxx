// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode, Ref } from 'react'
import { buildSchema, graphqlSync } from 'graphql'
import { stubBridge } from './setup/renderer'
import type { GraphQlRequest, ResponseState } from '../src/shared/apiModel'
import { useHttp } from '../src/renderer/src/store/http'
import { useGqlSchemas } from '../src/renderer/src/store/gqlSchemas'
import { introspect, runGraphQl } from '../src/renderer/src/lib/httpSend'
import { GraphQlRequestPane } from '../src/renderer/src/components/http/gql/GraphQlRequestPane'
import { prettifyGql } from '../src/renderer/src/components/http/gql/gqlActions'

// The GraphQL tab as a whole (§2.13). Other streams' pieces are stood in by
// the smallest thing that exposes the props this pane passes them.

const cursor = vi.hoisted(() => ({ at: 0 }))
vi.mock('../src/renderer/src/components/http/ProtocolLayout', async (actual) => ({
  ...(await actual<object>()),
  ProtocolLayout: (p: Record<string, ReactNode>) => (
    <div>
      <div data-testid="bar">{p.bar}</div>
      <div data-testid="request-tabs">{p.requestTabs}</div>
      <div data-testid="request-toolbar">{p.requestToolbar}</div>
      <div data-testid="request">{p.request}</div>
      <div data-testid="response">{p.response}</div>
      <div data-testid="response-summary">{p.responseSummary}</div>
    </div>
  )
}))
vi.mock('../src/renderer/src/components/common/Tabs', () => ({
  Tabs: (p: { tabs: { id: string; label: string }[]; onChange: (id: string) => void }) => (
    <div role="tablist">
      {p.tabs.map((t) => (
        <button key={t.id} role="tab" onClick={() => p.onChange(t.id)}>
          {t.label}
        </button>
      ))}
    </div>
  )
}))
vi.mock('../src/renderer/src/components/common/CodeEditor', () => ({
  CodeEditor: (p: { value: string; onChange?: (v: string) => void; onSubmit?: () => void; ariaLabel: string; editorRef?: Ref<unknown> }) => {
    const view = { state: { selection: { main: { get head() { return cursor.at } } } }, dispatch: () => {} }
    if (p.editorRef && typeof p.editorRef === 'object') (p.editorRef as { current: unknown }).current = view
    return (
      <textarea
        aria-label={p.ariaLabel}
        value={p.value}
        onChange={(e) => p.onChange?.(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && e.metaKey && p.onSubmit?.()}
      />
    )
  }
}))
vi.mock('../src/renderer/src/components/common/SplitButton', () => ({
  SplitButton: (p: { label: string; onClick: () => void; entries: { label: string; onClick?: () => void }[] }) => (
    <div>
      <button onClick={p.onClick}>{p.label}</button>
      {p.entries.map((e) => (
        <button key={e.label} onClick={e.onClick}>
          {e.label}
        </button>
      ))}
    </div>
  )
}))
vi.mock('../src/renderer/src/components/http/fields/VariableInput', () => ({
  VariableInput: (p: { value: string; onChange: (v: string) => void; ariaLabel: string }) => (
    <input aria-label={p.ariaLabel} value={p.value} onChange={(e) => p.onChange(e.target.value)} />
  )
}))
vi.mock('../src/renderer/src/components/http/response/ResponsePane', async (actual) => ({
  ...(await actual<object>()),
  ResponsePane: () => <div data-testid="response-pane" />
}))
vi.mock('../src/renderer/src/lib/httpSend', () => ({ runGraphQl: vi.fn(), introspect: vi.fn() }))

const SDL = buildSchema('type Query { country(code: ID!): String } type Mutation { rename(code: ID!): String }')
const answer = (query: string) => ({ ok: true as const, status: 200, text: JSON.stringify(graphqlSync({ schema: SDL, source: query })) })
const done = (status: number, body: unknown): ResponseState => ({
  status: 'done',
  at: 0,
  response: { ok: true, status, statusText: 'OK', headers: {}, body: new TextEncoder().encode(JSON.stringify(body)).buffer, durationMs: 1 } as never,
  sentAs: {} as never
})

beforeEach(() => {
  vi.clearAllMocks()
  cursor.at = 0
  stubBridge({ clipboard: { write: vi.fn() } })
  vi.mocked(introspect).mockImplementation(async (_tab, query) => answer(query))
  vi.mocked(runGraphQl).mockImplementation(async (tabId) => useHttp.getState().setResponse(tabId, done(200, { data: {} })))
})

function newGqlTab(patch: Partial<GraphQlRequest> = {}): string {
  const id = useHttp.getState().openScratch('graphql')
  const tab = useHttp.getState().tabs.find((t) => t.id === id)!
  useHttp.getState().updateDraft(id, { ...(tab.draft as GraphQlRequest), url: 'https://countries.example.test/', ...patch })
  return id
}
const draftOf = (id: string): GraphQlRequest => useHttp.getState().tabs.find((t) => t.id === id)!.draft as GraphQlRequest
const schemaKey = 'https://countries.example.test/|direct'

describe('Run', () => {
  const doc = 'query A { country(code: "x") }\n\nmutation B { rename(code: "x") }'

  it('runs the operation under the cursor', async () => {
    const id = newGqlTab({ query: doc })
    render(<GraphQlRequestPane tabId={id} />)
    cursor.at = doc.length - 3
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Run' })))
    expect(runGraphQl).toHaveBeenCalledWith(id, 'B')
    cursor.at = 4
    await act(async () => fireEvent.keyDown(screen.getByLabelText('GraphQL query'), { key: 'Enter', metaKey: true }))
    expect(runGraphQl).toHaveBeenLastCalledWith(id, 'A')
  })

  it('lists the operations in the Run menu when there is more than one', async () => {
    const id = newGqlTab({ query: doc })
    render(<GraphQlRequestPane tabId={id} />)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Run B' })))
    expect(runGraphQl).toHaveBeenCalledWith(id, 'B')
  })

  it('opens a collapsed response when a 200 carries errors[]', async () => {
    vi.mocked(runGraphQl).mockImplementation(async (tabId) =>
      useHttp.getState().setResponse(tabId, done(200, { data: null, errors: [{ message: 'Unknown code' }] }))
    )
    const id = newGqlTab({ query: '{ country(code: "x") }' })
    useHttp.getState().setSplit(id, 'response-collapsed')
    render(<GraphQlRequestPane tabId={id} />)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Run' })))
    expect(useHttp.getState().tabs.find((t) => t.id === id)!.split).toBe('normal')
  })

  it('names no operation for a single-operation document', async () => {
    const id = newGqlTab({ query: '{ country(code: "x") }' })
    render(<GraphQlRequestPane tabId={id} />)
    expect(screen.queryByRole('button', { name: /^Run / })).toBeNull()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Run' })))
    expect(runGraphQl).toHaveBeenCalledWith(id, undefined)
  })
})

describe('the schema', () => {
  it('is not loaded while the URL is typed', () => {
    const id = newGqlTab()
    render(<GraphQlRequestPane tabId={id} />)
    fireEvent.change(screen.getByLabelText('GraphQL endpoint'), { target: { value: 'https://prod.example.test/graphql' } })
    expect(introspect).not.toHaveBeenCalled()
  })

  it('loads on Load schema, without touching the response', async () => {
    const id = newGqlTab()
    useHttp.getState().setResponse(id, done(200, { data: { kept: true } }))
    const before = useHttp.getState().responses[id]
    render(<GraphQlRequestPane tabId={id} />)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Load schema' })))
    expect(introspect).toHaveBeenCalledTimes(1)
    expect(useGqlSchemas.getState().byKey[schemaKey].status).toBe('ready')
    expect(useHttp.getState().responses[id]).toBe(before)
    expect(screen.getByText(/types ·/)).toBeTruthy()
  })

  it('loads after the first successful Run against that endpoint, and only the first', async () => {
    const id = newGqlTab({ query: '{ country(code: "x") }' })
    render(<GraphQlRequestPane tabId={id} />)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Run' })))
    expect(introspect).toHaveBeenCalledTimes(1)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Run' })))
    expect(introspect).toHaveBeenCalledTimes(1)
  })

  it('is not loaded by a Run that failed', async () => {
    vi.mocked(runGraphQl).mockImplementation(async (tabId) => useHttp.getState().setResponse(tabId, done(500, {})))
    const id = newGqlTab({ query: '{ country(code: "x") }' })
    render(<GraphQlRequestPane tabId={id} />)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Run' })))
    expect(introspect).not.toHaveBeenCalled()
  })

  it('docks the explorer in a wide request half, and overlays the response otherwise', () => {
    useHttp.getState().setPrefs({ gqlSchemaOpen: true })
    const id = newGqlTab()
    const { rerender } = render(<GraphQlRequestPane tabId={id} requestWidth={700} />)
    const explorer = (): HTMLElement => screen.getByRole('complementary', { name: 'Schema explorer' })
    expect(screen.getByTestId('request').contains(explorer())).toBe(true)
    rerender(<GraphQlRequestPane tabId={id} requestWidth={530} />)
    expect(screen.getByTestId('response').contains(explorer())).toBe(true)
  })
})

describe('the query tab', () => {
  it('prettifies, from the button and from the hotkey’s action', () => {
    const id = newGqlTab({ query: '{country(code:"x")}' })
    render(<GraphQlRequestPane tabId={id} />)
    fireEvent.click(screen.getByRole('button', { name: 'Prettify' }))
    expect(draftOf(id).query).toBe('{\n  country(code: "x")\n}')
    act(() => useHttp.getState().updateDraft(id, { ...draftOf(id), query: '{a{b}}' }))
    prettifyGql(id)
    expect(draftOf(id).query).toBe('{\n  a {\n    b\n  }\n}')
  })

  it('edits variables in a collapsible section', () => {
    const id = newGqlTab()
    render(<GraphQlRequestPane tabId={id} />)
    fireEvent.change(screen.getByLabelText('GraphQL variables'), { target: { value: '{"c":"BR"}' } })
    expect(draftOf(id).variables).toBe('{"c":"BR"}')
    fireEvent.click(screen.getByRole('button', { name: 'Variables' }))
    expect(screen.queryByLabelText('GraphQL variables')).toBeNull()
    expect(useHttp.getState().prefs.gqlVariablesOpen).toBe(false)
  })

  it('warns about a literal credential in the variables, and offers a variable for it', () => {
    const id = newGqlTab({ variables: '{"input":{"password":"hunter2"}}' })
    render(<GraphQlRequestPane tabId={id} />)
    expect(screen.getByRole('note').textContent).toMatch(/password looks like a credential: saved and\s+synced as plain text/)
    const asked: unknown[] = []
    const on = (e: Event): number => asked.push((e as CustomEvent).detail)
    document.addEventListener('hc-set-variable', on)
    fireEvent.click(screen.getByRole('button', { name: 'Set as variable…' }))
    document.removeEventListener('hc-set-variable', on)
    expect(asked).toEqual([{ tabId: id, name: 'password', value: 'hunter2' }])
  })

  it('says nothing when the credential is a {{variable}}', () => {
    const id = newGqlTab({ variables: '{"input":{"password":"{{pw}}"}}' })
    render(<GraphQlRequestPane tabId={id} />)
    expect(screen.queryByRole('note')).toBeNull()
  })

  it('puts "N errors · first: …" in the collapsed bar for a 200 that carries errors[]', () => {
    const id = newGqlTab()
    useHttp.getState().setResponse(id, done(200, { data: null, errors: [{ message: 'Unknown code' }] }))
    render(<GraphQlRequestPane tabId={id} />)
    expect(screen.getByTestId('response-summary').textContent).toBe('1 error · first: Unknown code')
  })

  it('acts on the response pane’s Send anyway, Raise the timeout and Retry with http://', async () => {
    const id = newGqlTab({ url: 'https://127.0.0.1:9346/graphql', query: '{ a }' })
    render(<GraphQlRequestPane tabId={id} />)
    const fix = (action: string): void => {
      screen.getByTestId('response-pane').dispatchEvent(new CustomEvent('hc-fix', { bubbles: true, detail: { tabId: id, action } }))
    }
    await act(async () => fix('send-anyway'))
    expect(runGraphQl).toHaveBeenCalledWith(id, undefined, { allowUnresolved: true })
    await act(async () => fix('retry-http'))
    expect(draftOf(id).url).toBe('http://127.0.0.1:9346/graphql')
    expect(runGraphQl).toHaveBeenLastCalledWith(id, undefined)
    act(() => fix('raise-timeout'))
    expect(screen.getByLabelText('Timeout in milliseconds')).toBeTruthy()
  })})
