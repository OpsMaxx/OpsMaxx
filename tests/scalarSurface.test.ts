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

/**
 * Which document an edit is applied to.
 *
 * `initializeWorkspaceEventHandlers` routes every document-scoped event —
 * parameters, bodies, auth, cookies, the selected server, the response that
 * fills history — through `mutators.active()`. That resolves as
 * `workspace['x-scalar-active-document'] ?? Object.keys(documents)[0]`, so with
 * the key unset it is whichever collection was added FIRST, regardless of which
 * one is on screen.
 *
 * With one collection that is right by accident. With two, a header typed into
 * the second is written into the first: it vanishes from the pane on the next
 * render, and the first is corrupted, persisted and backed up in that state,
 * with nothing to connect the two events.
 *
 * Strictly worse than the behaviour before the bus was wired, where the edit
 * was merely discarded — which is why this is pinned rather than trusted.
 */
describe('the active document', () => {
  const client = require_('node:fs').readFileSync(
    require_('node:path').resolve(__dirname, '..', 'src/renderer/src/components/http/ScalarClient.tsx'),
    'utf8'
  ) as string

  it('is set on the store, not only on a local ref', () => {
    expect(client).toContain("'x-scalar-active-document'")
    // Where selecting happens, so the store and the pane can never disagree.
    const at = client.indexOf("'x-scalar-active-document'")
    expect(client.slice(Math.max(0, at - 800), at)).toContain('activeSlug.value = collectionId')
  })

  it('does not rebuild a document because its collection was renamed', () => {
    // sourceKeyOf decides when a document is regenerated from its collection,
    // and regenerating discards every request the user added. A name is not an
    // input to that build — and renaming is what the Add-API dialog suggests
    // when a base URL was typed wrong.
    const key = client.slice(client.indexOf('function sourceKeyOf'), client.indexOf('function sourceKeyOf') + 400)
    expect(key).not.toMatch(/\bname:\s*c\.name\b/)
    expect(key).toContain('specUrl')
    expect(key).toContain('endpoints')
  })
})

/**
 * The request pane has to be GIVEN the width.
 *
 * `Operation`'s own root is `flex h-full flex-col` with no `flex-1`, so as a
 * bare flex child it sizes to its content — measured at 512px of a 1352px
 * pane, with the rest of the client blank.
 *
 * That is not only ugly. The request block's layout is driven by a CSS
 * container query on `t-app__top-container`, so under its breakpoint the whole
 * thing collapses: address bar wrapped under the method, Send on its own row,
 * response stacked below the request instead of beside it. Most of what "there
 * is nothing here" looked like was this.
 *
 * Pinned structurally because nothing else catches it: it renders, it throws
 * nothing, and every test that mocks `Operation` to a string agrees it is fine.
 */
describe('the operation pane', () => {
  const client = require_('node:fs').readFileSync(
    require_('node:path').resolve(
      __dirname,
      '..',
      'src/renderer/src/components/http/ScalarClient.tsx'
    ),
    'utf8'
  ) as string

  it('renders Operation inside a flex-1 min-w-0 container', () => {
    const at = client.indexOf('h(Operation, {')
    expect(at).toBeGreaterThan(-1)
    // The wrapper is the element opened immediately before it.
    const before = client.slice(0, at)
    const wrapper = before.slice(before.lastIndexOf("h('div'"))
    expect(wrapper).toContain('flex-1')
    // Without this a flex item's `min-width: auto` refuses to shrink below its
    // content, so the response pane widens the client past the window.
    expect(wrapper).toContain('min-w-0')
  })

  it('still uses the web layout, not modal', () => {
    // `modal` drew the method as a label rather than a control and hid two
    // sections of the request block. Kept beside the width check because both
    // are "the pane renders, and is wrong".
    expect(client.slice(client.indexOf('h(Operation, {'))).toMatch(/layout: 'web'/)
  })
})

/**
 * The four faults a person hit in the first minute of using the client, each
 * pinned against the thing that actually caused it.
 *
 * Every one of them rendered without an error and passed every unit test,
 * because the test mocked away the part that was wrong. So these read the real
 * library where the claim is about the library, and the real source where the
 * claim is about this app.
 */
describe('the client as a person meets it', () => {
  const read = (p: string): string =>
    require_('node:fs').readFileSync(require_('node:path').resolve(__dirname, '..', p), 'utf8')
  const client = read('src/renderer/src/components/http/ScalarClient.tsx')

  /**
   * A file inside an installed package, by its real path.
   *
   * Not `require.resolve` on a deep path: all three of these packages declare
   * an `exports` map, so `./dist/...` is not a subpath Node will resolve even
   * though the file is plainly there. The package's own entry point IS
   * exported, so the directory is derived from that.
   */
  const lib = (pkg: string, entry: string, file: string): string => {
    const path = require_('node:path')
    const resolved = require_.resolve(entry)
    const at = resolved.lastIndexOf(pkg.split('/').join(path.sep))
    expect(at).toBeGreaterThan(-1)
    return require_('node:fs').readFileSync(
      path.join(resolved.slice(0, at + pkg.length), file),
      'utf8'
    ) as string
  }

  describe('dropdowns are opaque', () => {
    /**
     * Scalar teleports every floating thing to `<body>` — `useTeleport()`
     * falls back to `"body"` and neither this app nor the library's own v2
     * client calls `useProvideTeleport`. The palette is declared on
     * `.dark-mode` / `.light-mode`, so out there `--scalar-background-1`
     * resolves to nothing and the ONLY element painting a dropdown's
     * background computes to transparent. Measured on the running app:
     * `rgba(0, 0, 0, 0)` without the class, `rgb(15, 15, 15)` with it.
     */
    it('is still the backdrop, and it still paints with a themed variable', () => {
      const backdrop = lib(
        '@scalar/components',
        '@scalar/components',
        'dist/components/ScalarFloating/ScalarFloatingBackdrop.vue.script.js'
      )
      // If this stops being `bg-b-1`, the reason for the observer below has
      // changed and someone has to look rather than assume.
      expect(backdrop).toContain('bg-b-1')
    })

    it('re-classes the teleport roots, and only the ones under body', () => {
      expect(client).toContain("classList.contains('scalar-app')")
      expect(client).toContain('MutationObserver')
      // Direct children only: the pane's own host is nested and already
      // carries the class, and a cleanup that touched it would strip the
      // theme off the client itself.
      expect(client).toContain('document.body.children')
      expect(client).toContain('observer.disconnect()')
    })
  })

  describe('a created request appears', () => {
    /**
     * `createOperation` writes into `document.paths` and returns. Unlike its
     * siblings it never calls `store.buildSidebar`, so navigation went on
     * describing the document as it was: 16 requests existed in the document
     * and none of them was in the tree.
     */
    it('is still true that createOperation does not rebuild navigation', () => {
      const mutator = lib(
        '@scalar/workspace-store',
        '@scalar/workspace-store/mutators',
        'dist/mutators/operation/operation.js'
      )
      const body = mutator.slice(
        mutator.indexOf('export const createOperation'),
        mutator.indexOf('export const updateOperationMeta')
      )
      expect(body.length).toBeGreaterThan(200)
      // When upstream fixes this, this test fails — and the right response is
      // to delete our buildSidebar calls, not to loosen the assertion.
      expect(body).not.toContain('buildSidebar')
    })

    it('calls buildSidebar itself, on the add and on the bus', () => {
      expect(client).toContain('workspaceStore.buildSidebar(collectionId)')
      expect(client).toContain('workspaceStore.buildSidebar(slug)')
    })

    it('reads navigation through a getter so the tree is not frozen', () => {
      // `createSidebarState` takes MaybeRefOrGetter. Handed the array, the
      // tree is a snapshot of the moment the document was built.
      const at = client.indexOf('createSidebarState(')
      expect(at).toBeGreaterThan(-1)
      expect(client.slice(at, at + 40)).toContain('createSidebarState(navOf')
    })
  })

  describe('the operation tree is clickable', () => {
    /**
     * `Sidebar` does `emit('selectItem', id)` and nothing else. With no
     * handler, a description with 200 operations let a user reach exactly one:
     * the one they landed on.
     */
    it('is still emit-only in the library', () => {
      const sidebar = lib(
        '@scalar/api-client',
        '@scalar/api-client/v2/components/sidebar',
        'dist/v2/components/sidebar/Sidebar.vue.script.js'
      )
      expect(sidebar).toContain('emit("selectItem"')
      // Nothing in the component selects for you.
      expect(sidebar).not.toContain('sidebarState.setSelected')
    })

    it('passes a handler that selects', () => {
      const at = client.indexOf('h(Sidebar, {')
      expect(at).toBeGreaterThan(-1)
      const props = client.slice(at, client.indexOf('h(Operation, {'))
      expect(props).toContain('onSelectItem')
      expect(props).toContain('state.setSelected(id)')
      // A row that is not a request opens instead, which is what makes a tag
      // behave like a folder rather than a dead row.
      expect(props).toContain('setExpanded')
    })
  })

  it('offers add-request on every collection, imported or not', () => {
    // It used to be hidden whenever a collection had a spec, on the reasoning
    // that such a collection takes its operations from the description. That
    // is about where operations come FROM, not about what may be added — and
    // the first thing anyone does after importing is try one call the spec
    // does not have.
    const view = read('src/renderer/src/components/http/HttpView.tsx')
    const at = view.indexOf('Add a request to')
    expect(at).toBeGreaterThan(-1)
    expect(view.slice(Math.max(0, at - 400), at)).not.toContain('!collection.specUrl')
  })
})

/**
 * Rename, delete, and the gear.
 *
 * The mutators for all three have always been there. What was missing was
 * anything that called them: the client's own "Operation settings" gear emits
 * `ui:navigate` and the library subscribes to it nowhere, because routing
 * belongs to whatever hosts the client — and no settings page ships in the
 * package to route to. So the button did nothing, and there was no way to
 * rename or remove a request at all.
 */
describe('editing a request', () => {
  const read = (p: string): string =>
    require_('node:fs').readFileSync(require_('node:path').resolve(__dirname, '..', p), 'utf8')
  const client = read('src/renderer/src/components/http/ScalarClient.tsx')

  const lib = (pkg: string, entry: string, file: string): string => {
    const path = require_('node:path')
    const resolved = require_.resolve(entry)
    const at = resolved.lastIndexOf(pkg.split('/').join(path.sep))
    expect(at).toBeGreaterThan(-1)
    return require_('node:fs').readFileSync(
      path.join(resolved.slice(0, at + pkg.length), file),
      'utf8'
    ) as string
  }

  it('the gear still only emits, so the host still has to route it', () => {
    const header = lib(
      '@scalar/api-client',
      '@scalar/api-client/v2/blocks/operation-block',
      'dist/v2/blocks/operation-block/OperationBlock.vue.script.js'
    )
    expect(header).toContain('ui:navigate')
    // If the library ever grows a settings page and handles this itself, this
    // fails — and the answer is to drop our dialog, not to widen the match.
    expect(header).not.toContain('on("ui:navigate"')
  })

  it('handles ui:navigate and opens something', () => {
    expect(client).toContain("event === 'ui:navigate'")
    expect(client).toContain('RequestSettings')
  })

  it('renames through the summary, because that is what the name is', () => {
    const at = client.indexOf('const editRequest')
    expect(at).toBeGreaterThan(-1)
    const body = client.slice(at, at + 900)
    expect(body).toContain('updateOperationMeta')
    expect(body).toContain('summary')
  })

  it('moves the pane off a request before deleting it', () => {
    const at = client.indexOf('const deleteRequest')
    expect(at).toBeGreaterThan(-1)
    const body = client.slice(at, client.indexOf('deleteOperation'))
    // The pane renders whatever currentPath/currentMethod point at. Deleting
    // out from under them renders the client's empty state, which reads as the
    // delete having removed everything.
    expect(body).toContain('currentPath.value')
    // And the row has to leave the tree: deleteOperation has the same gap as
    // createOperation.
    expect(client.slice(client.indexOf('const deleteRequest'))).toContain(
      'workspaceStore.buildSidebar(target.collectionId)'
    )
  })
})
