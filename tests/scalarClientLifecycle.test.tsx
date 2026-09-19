// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { stubBridge } from './setup/renderer'
import type { ApiCollection } from '../src/renderer/src/types'

/**
 * The React↔Vue seam, and nothing about Scalar's own rendering.
 *
 * Everything Scalar is mocked. Asserting on the real client's DOM would be a
 * test that fails on its next minor release for a reason nobody can act on —
 * `tests/scalarSurface.test.ts` covers the part of that contract worth
 * pinning. What IS worth checking here is the lifecycle, because it is the
 * part this app owns and the part that used to be wrong:
 *
 *   - The client must be built ONCE and kept. It used to be keyed on the
 *     collection and its endpoints, so switching or editing one tore it down
 *     and lost whatever had been typed.
 *   - With no key to force a remount, a leaked second app would never be
 *     cleaned up. React 19 re-invokes effects in development, so the guard
 *     against that is load-bearing rather than theoretical.
 *   - Teardown has to stop the event-bus listener as well as the app, or a
 *     dead client goes on serialising a workspace forever.
 */

/**
 * jsdom implements no `matchMedia`, and `useResolvedTheme` uses it to follow a
 * scheduled dark mode. Stubbed here rather than guarded in the hook: in
 * Electron the API always exists, and defensive code for a condition that
 * only occurs in a test is how a real failure gets swallowed later.
 */
window.matchMedia = ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
  dispatchEvent: () => false
})) as unknown as typeof window.matchMedia

const mounted = vi.fn()
const unmounted = vi.fn()
const stopListening = vi.fn()
const addDocument = vi.fn(async () => true)
const loadWorkspace = vi.fn()

const documents: Record<string, unknown> = {}

vi.mock('vue', () => {
  const ref = <T,>(value: T): { value: T } => ({ value })
  return {
    ref,
    shallowRef: ref,
    h: (...args: unknown[]) => ({ args }),
    createApp: (options: { render: () => unknown }) => ({
      mount: (el: HTMLElement) => {
        mounted(el)
        // Render once so a throw in the render function is a test failure
        // rather than something only a real browser would surface.
        options.render()
      },
      unmount: unmounted
    })
  }
})

vi.mock('@scalar/api-client/v2/features/operation', () => ({ Operation: 'Operation' }))
vi.mock('@scalar/api-client/v2/components/sidebar', () => ({ Sidebar: 'Sidebar' }))
// Emit-only blocks stay emit-only without this: it is what binds every
// `operation:*`, `auth:*` and `cookie:*` event to the mutator that applies it.
// Mocked to a spy so the lifecycle tests keep testing the lifecycle, and
// asserted for real in the surface test.
vi.mock('@scalar/api-client/v2/workspace-events', () => ({
  initializeWorkspaceEventHandlers: vi.fn()
}))
vi.mock('@scalar/api-client/style.css', () => ({}))
vi.mock('@scalar/sidebar', () => ({
  createSidebarState: (entries: unknown[]) => ({
    items: { value: entries },
    getEntryById: () => undefined,
    setSelected: vi.fn()
  })
}))
vi.mock('@scalar/workspace-store/client', () => ({
  createWorkspaceStore: () => ({
    workspace: { documents, 'x-scalar-environments': {}, 'x-scalar-active-environment': '' },
    addDocument: (input: { name: string; document?: unknown }) => {
      documents[input.name] = input.document ?? { openapi: '3.1.1', info: {}, paths: {} }
      return addDocument()
    },
    loadWorkspace,
    exportWorkspace: () => ({ meta: {}, documents }),
    // Also reached to turn Scalar's hosted proxy off.
    update: vi.fn()
  })
}))
vi.mock('@scalar/workspace-store/events', () => ({
  createWorkspaceEventBus: () => ({ onAny: () => stopListening })
}))
vi.mock('@scalar/workspace-store/request-example', () => ({
  getActiveEnvironment: () => ({ environment: { variables: [] } }),
  // Scalar's own domain and path matcher, used to decide which stored cookies
  // belong on a request. Nothing here exercises cookies, so it simply agrees.
  filterGlobalCookie: () => true
}))
vi.mock('@scalar/workspace-store/mutators', () => ({
  generateClientMutators: () => ({
    workspace: () => ({ environment: {} }),
    doc: () => ({ operation: { createOperation: vi.fn(() => '/new-request') } })
  })
}))

const { ScalarClient } = await import('../src/renderer/src/components/http/ScalarClient')

const collection = (over: Partial<ApiCollection> = {}): ApiCollection => ({
  id: 'col-1',
  workspaceId: 'ws-default',
  name: 'One',
  specUrl: null,
  specPath: null,
  baseUrl: 'https://api.example.test',
  viaServerId: null,
  insecureTls: false,
  endpoints: [],
  ...over
})

beforeEach(() => {
  vi.clearAllMocks()
  for (const key of Object.keys(documents)) delete documents[key]
  stubBridge({})
})

describe('mounting', () => {
  it('builds the client once and adds a document per collection', async () => {
    const collections = [collection(), collection({ id: 'col-2', name: 'Two' })]
    render(<ScalarClient collections={collections} activeId="col-1" />)

    await waitFor(() => expect(mounted).toHaveBeenCalledTimes(1))
    expect(Object.keys(documents).sort()).toEqual(['col-1', 'col-2'])
  })

  it('does not rebuild when the selected collection changes', async () => {
    const collections = [collection(), collection({ id: 'col-2', name: 'Two' })]
    const { rerender } = render(<ScalarClient collections={collections} activeId="col-1" />)
    await waitFor(() => expect(mounted).toHaveBeenCalledTimes(1))

    rerender(<ScalarClient collections={collections} activeId="col-2" />)
    await waitFor(() => expect(Object.keys(documents)).toHaveLength(2))

    // The whole point. Switching used to tear the client down and build
    // another, which is how a half-written request disappeared.
    expect(mounted).toHaveBeenCalledTimes(1)
    expect(unmounted).not.toHaveBeenCalled()
  })

  it('adds a document for a collection created later, without rebuilding', async () => {
    const first = [collection()]
    const { rerender } = render(<ScalarClient collections={first} activeId="col-1" />)
    await waitFor(() => expect(mounted).toHaveBeenCalledTimes(1))

    rerender(
      <ScalarClient collections={[...first, collection({ id: 'col-3' })]} activeId="col-1" />
    )
    await waitFor(() => expect(Object.keys(documents)).toContain('col-3'))
    expect(mounted).toHaveBeenCalledTimes(1)
  })

  it('restores a saved workspace rather than starting empty', async () => {
    const { useApp } = await import('../src/renderer/src/store/app')
    useApp.setState({
      apiWorkspace: { version: 1, meta: {}, documents: {}, sourceKeys: {} }
    })

    render(<ScalarClient collections={[collection()]} activeId="col-1" />)
    await waitFor(() => expect(loadWorkspace).toHaveBeenCalledTimes(1))
  })

  it('ignores a saved workspace in a shape it does not understand', async () => {
    const { useApp } = await import('../src/renderer/src/store/app')
    useApp.setState({ apiWorkspace: { version: 99, nonsense: true } })

    render(<ScalarClient collections={[collection()]} activeId="col-1" />)
    await waitFor(() => expect(mounted).toHaveBeenCalledTimes(1))
    // Rebuilt from the collections, which always works — rather than coercing
    // a shape we cannot read into a half-restored workspace.
    expect(loadWorkspace).not.toHaveBeenCalled()
    expect(Object.keys(documents)).toEqual(['col-1'])
  })
})

describe('unmounting', () => {
  it('tears the client down and stops listening', async () => {
    const { unmount } = render(<ScalarClient collections={[collection()]} activeId="col-1" />)
    await waitFor(() => expect(mounted).toHaveBeenCalledTimes(1))

    unmount()

    expect(unmounted).toHaveBeenCalledTimes(1)
    // The bus outlives the Vue app, so a dropped listener would go on
    // serialising a workspace for a client that is gone.
    expect(stopListening).toHaveBeenCalledTimes(1)
  })

  /**
   * The leak the mount guard exists for.
   *
   * `createEngine` is async, so an unmount can land while it is still
   * building. Without the `disposed` check the finished app is stored in a ref
   * nothing will ever read again — and with no `key` on this component, no
   * later render cleans it up either.
   */
  it('discards a client that finished building after unmount', async () => {
    const { unmount } = render(<ScalarClient collections={[collection()]} activeId="col-1" />)
    unmount()

    await waitFor(() => expect(mounted).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(unmounted).toHaveBeenCalledTimes(1))
    expect(stopListening).toHaveBeenCalledTimes(1)
  })
})
