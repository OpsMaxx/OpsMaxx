import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

/**
 * The parts of Scalar this app reaches into, asserted to still be there.
 *
 * `@scalar/api-client` has **no root export**. It is a block library, and
 * everything the HTTP client uses comes from a deep `v2/...` subpath that is
 * not part of any stable API — the package's own `dist/` and its `exports` map
 * already disagree with each other (`v2/blocks/channel-operation-block` is
 * built and shipped but not exported, so it cannot be imported at all).
 *
 * That makes a version bump the most likely way this feature breaks, and the
 * breakage is invisible until someone opens the pane: a moved subpath is a
 * dynamic-import rejection inside an effect, which renders as "the API client
 * could not start" with no clue which import went.
 *
 * So the contract is pinned here instead. If this fails after an upgrade, the
 * fix is to find where the export moved — not to delete the assertion.
 *
 * Resolution is checked through `exports` (`require.resolve` honours the map)
 * rather than by importing: these are Vue modules, and pulling the real ones
 * into a node test would drag in the entire client for a question about
 * whether a path exists.
 */

const require_ = createRequire(import.meta.url)

/** Every Scalar subpath `src/` imports, and what it is for. */
const SUBPATHS: Array<[specifier: string, usedFor: string]> = [
  ['@scalar/api-client/v2/features/operation', 'the request/response pane itself'],
  ['@scalar/api-client/v2/components/sidebar', "the client's own operation tree"],
  ['@scalar/api-client/style.css', "the client's stylesheet"],
  ['@scalar/workspace-store/client', 'createWorkspaceStore'],
  ['@scalar/workspace-store/events', 'createWorkspaceEventBus'],
  ['@scalar/workspace-store/request-example', 'getActiveEnvironment'],
  ['@scalar/workspace-store/mutators', 'generateClientMutators, for creating a request'],
  [
    '@scalar/workspace-store/schemas/v3.1/strict/openapi-document',
    'OpenApiDocument, the narrowed document type'
  ],
  ['@scalar/workspace-store/schemas/navigation', 'TraversedEntry, the sidebar entry type'],
  ['@scalar/sidebar', 'createSidebarState'],
  [
    '@scalar/api-client/v2/workspace-events',
    'initializeWorkspaceEventHandlers, without which every edit is discarded'
  ]
]

describe('the Scalar subpaths this app imports', () => {
  it.each(SUBPATHS)('%s resolves (%s)', (specifier) => {
    expect(() => require_.resolve(specifier)).not.toThrow()
  })

  /**
   * Not a curiosity — this one is load-bearing in the other direction.
   *
   * The WebSocket work wanted `connectWebSocket`/`customWebSocket` from
   * `v2/blocks/channel-operation-block`, and the files are right there in
   * `dist/`. They are unreachable because the export map omits them, which is
   * why OpsMaxx owns its WebSocket transport instead. If a later release
   * exports it, that decision is worth revisiting — so the day it becomes
   * importable should be a test failure that says so, not a thing nobody
   * notices.
   */
  it('does not export the AsyncAPI channel block (if it starts to, reconsider wsClient)', () => {
    expect(() => require_.resolve('@scalar/api-client/v2/blocks/channel-operation-block')).toThrow()
  })
})

describe('vue', () => {
  /**
   * Scalar is a Vue app and OpsMaxx is a React one, so Vue arrives as a real
   * dependency of this package rather than through npm's hoisting of Scalar's.
   * An undeclared transitive dependency resolves until an install layout
   * changes, and then does not.
   */
  it('is a declared dependency, not a hoisted accident', async () => {
    const pkg = require_('../package.json') as { dependencies?: Record<string, string> }
    expect(pkg.dependencies?.vue).toBeTypeOf('string')
  })

  /**
   * Two copies of Vue are two reactivity systems: a store created under one
   * and read under the other updates nothing, and the client renders with
   * inputs that do not respond. `dedupe` in electron.vite.config.ts is what
   * prevents it, and it is easy to drop in a refactor of that file.
   */
  it('is deduped in the renderer build', async () => {
    const { readFile } = await import('node:fs/promises')
    const config = await readFile(new URL('../electron.vite.config.ts', import.meta.url), 'utf8')
    expect(config).toMatch(/dedupe:\s*\[[^\]]*'vue'/)
  })
})

/**
 * Two contracts the type system cannot state, both of which shipped broken.
 *
 * Scalar's `Operation` declares `exampleName?: string`, so omitting it is not a
 * type error — and its render guard requires it. Without it the component fell
 * through to "Select an operation to view details" for every request, including
 * the one already selected. The address bar, the method control, Send, the
 * params/body/headers/auth tabs, the code snippets, the response pane and the
 * history all live inside the block behind that guard, so none of them had ever
 * rendered. The feature looked unbuilt.
 *
 * And its blocks only EMIT. `initializeWorkspaceEventHandlers` is what binds
 * those events to the mutators that apply them; unimported, a header or body
 * typed into the pane reverted on the next render, auth was never stored and
 * the history could never fill.
 *
 * Read from the source rather than exercised, because rendering the real
 * component needs a Vue app, a workspace store and a document — and a test that
 * mounts a stub proves nothing about either contract, which is precisely how
 * both survived.
 */
describe('the two handoffs Scalar will not tell you about', () => {
  const client = require_('node:fs').readFileSync(
    require_('node:path').resolve(__dirname, '..', 'src/renderer/src/components/http/ScalarClient.tsx'),
    'utf8'
  ) as string

  it('passes exampleName to Operation, which renders nothing without it', () => {
    expect(client).toContain('exampleName:')
  })

  it('subscribes the event bus to the mutators', () => {
    expect(client).toContain('initializeWorkspaceEventHandlers(')
  })

  it('turns off the hosted proxy the web layout would otherwise default to', () => {
    // `layout: 'web'` is right for the UI and also selects
    // https://proxy.scalar.com as the default route for every non-loopback
    // request, carrying the URL, the headers and the body to a third party.
    expect(client).toContain("'x-scalar-active-proxy'")
    expect(client).toMatch(/update\('x-scalar-active-proxy',\s*null\)/)
  })
})
