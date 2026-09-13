import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Loader2, X } from 'lucide-react'
import { useApp } from '../../store/app'
import { sshTargetFor } from '../../lib/ssh'
import { createHttpTransport, type HttpTransportOptions } from '../../lib/httpTransport'
import { useResolvedTheme } from '../../hooks/useResolvedTheme'
import type { TraversedEntry } from '@scalar/workspace-store/schemas/navigation'
import type { OpenApiDocument } from '@scalar/workspace-store/schemas/v3.1/strict/openapi-document'
import type { SidebarState } from '@scalar/sidebar'
import type { ApiCollection } from '../../types'
import { documentForCollection, firstOperationOf } from '../../../../shared/apiCollectionImport'

/**
 * The API client, for every collection at once.
 *
 * ── What changed, and why it matters more than it sounds ───────────────────
 *
 * This used to be one Vue app per collection, keyed on the collection id and
 * on its endpoints, inside a view that React unmounted whenever the user
 * clicked another activity. Three consequences, all of which read as "the
 * client is broken":
 *
 *   - Switching collection tore the client down and built another one, so
 *     anything typed into the first was gone.
 *   - Editing a collection did the same, because the key included its
 *     endpoints.
 *   - Visiting Terminals and coming back did the same again.
 *
 * Now: ONE workspace, ONE Vue app, mounted once and kept. Every collection is
 * a document in that workspace. Switching collection re-points two refs; it
 * does not rebuild anything, so drafts survive exactly as they do in a real
 * API client.
 *
 * ── Why the collection list is React and the operation tree is Vue ─────────
 *
 * Scalar's `Sidebar` takes a `documents` array and could, in principle, list
 * every collection itself. It is driven here with one document at a time
 * instead, and the list of COLLECTIONS stays in OpsMaxx's own left rail
 * (`ApiSidebar`). Two reasons:
 *
 *   - Its entry ids come from one document's `x-scalar-navigation`, and
 *     concatenating several documents' trees under a synthetic root is not a
 *     shape the library documents or promises.
 *   - The collection list is OpsMaxx's own concept — it carries the route and
 *     the certificate state, which Scalar knows nothing about.
 *
 * The operation tree inside a document is exactly what Scalar's sidebar is
 * good at, especially for an imported description with hundreds of operations,
 * so that half stays.
 */

interface Engine {
  /** Make sure every live collection has a document, and no dead one does. */
  sync: (collections: readonly ApiCollection[]) => Promise<void>
  /** Show this collection, restoring wherever the user last was inside it. */
  select: (collectionId: string) => void
  /** Add a request to a collection and land on it. */
  addRequest: (collectionId: string) => void
  unmount: () => void
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const
type HttpMethodName = (typeof HTTP_METHODS)[number]

/**
 * A method name the operation view can actually be pointed at.
 *
 * `trace` is a legal OpenAPI operation and is not in this list, because the
 * client's own `HttpMethod` does not carry it. A document that defines one is
 * fine — the operation is simply not somewhere this can land, and returning
 * null leaves the pane where it was rather than setting a method the view
 * cannot render.
 */
function methodOf(raw: string | undefined): HttpMethodName | null {
  const m = (raw ?? '').toLowerCase() as HttpMethodName
  return (HTTP_METHODS as readonly string[]).includes(m) ? m : null
}

function placeOf(op: { path: string; method: string }): {
  path: string
  method: HttpMethodName
} | null {
  const method = methodOf(op.method)
  return method ? { path: op.path, method } : null
}

/** What a collection's document is built from, for change detection. */
function sourceKeyOf(c: ApiCollection): string {
  return JSON.stringify({
    name: c.name,
    specUrl: c.specUrl ?? null,
    specPath: c.specPath ?? null,
    baseUrl: c.baseUrl,
    endpoints: c.endpoints ?? []
  })
}

export function ScalarClient({
  collections,
  activeId
}: {
  collections: readonly ApiCollection[]
  activeId: string | null
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const engineRef = useRef<Engine | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [transportError, setTransportError] = useState<string | null>(null)
  const theme = useResolvedTheme()

  const servers = useApp((s) => s.servers)
  const update = useApp((s) => s.updateApiCollection)
  const active = collections.find((c) => c.id === activeId) ?? collections[0] ?? null

  /**
   * The transport reads these when a request is SENT, not when the client is
   * built, so changing the route or the certificate toggle takes effect on the
   * next Send instead of rebuilding the client and losing what was typed.
   *
   * Assigned during render rather than in an effect, because a Send can happen
   * before an effect for this render has run — and sending with the previous
   * collection's route is the one mistake that quietly reaches the wrong host.
   */
  const optionsRef = useRef<HttpTransportOptions>({ via: { kind: 'direct' }, insecureTls: false })
  optionsRef.current = {
    via: (() => {
      if (!active?.viaServerId) return { kind: 'direct' as const }
      const server = servers.find((s) => s.id === active.viaServerId)
      // A collection outlives the server it named. `direct` would quietly
      // reach a different machine — usually a public one wearing the same
      // name as something internal — so an unresolved route is reported by
      // the toolbar and this stays direct only because there is nothing to
      // send through.
      if (!server) return { kind: 'direct' as const }
      return { kind: 'server' as const, server: sshTargetFor(server) }
    })(),
    insecureTls: active?.insecureTls === true
  }

  const reportRef = useRef((message: string | null) => setTransportError(message))

  // Mounted ONCE. Not keyed, not re-run: everything that used to be a
  // dependency here is now handled by `sync` and `select` below.
  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    let disposed = false

    void (async () => {
      try {
        const engine = await createEngine(el, optionsRef, reportRef)
        // React 19 re-invokes effects in development. Without this, the second
        // invocation leaks an entire Vue app and its event bus behind the
        // first — and with no key to force a remount, nothing would ever
        // clean it up.
        if (disposed) {
          engine.unmount()
          return
        }
        engineRef.current = engine
        await engine.sync(collectionsRef.current)
        const wanted = activeRef.current
        if (wanted) engine.select(wanted)
        setLoading(false)
      } catch (err) {
        if (!disposed) {
          setError(err instanceof Error ? err.message : String(err))
          setLoading(false)
        }
      }
    })()

    return () => {
      disposed = true
      engineRef.current?.unmount()
      engineRef.current = null
    }
    // Mounted once by design: the collections and the selection are carried
    // in by `sync` and `select` instead of by a dependency list. Nothing in
    // this effect's body reads a prop directly, which is why the empty list is
    // honest rather than suppressed.
  }, [])

  // What the mount effect should converge on once it finishes building. It
  // cannot read props directly: it runs after an await, by which time the
  // render that started it is long gone.
  const collectionsRef = useRef(collections)
  collectionsRef.current = collections
  const activeRef = useRef(active?.id ?? null)
  activeRef.current = active?.id ?? null

  // Collections added, removed or re-pointed at a different description.
  useEffect(() => {
    void engineRef.current?.sync(collections)
  }, [collections])

  // Which one is on screen.
  useEffect(() => {
    if (active) engineRef.current?.select(active.id)
  }, [active])

  /**
   * The toolbar's `+`, which used to focus a separate endpoint editor.
   *
   * Watched on the nonce rather than on the collection id, so pressing it
   * twice for the same collection is two events — a value that was already
   * equal would give this nothing to react to, and the second press would
   * appear to do nothing.
   */
  const focusRequest = useApp((s) => s.apiEndpointFocus)
  const lastFocusNonce = useRef(focusRequest?.nonce ?? 0)
  useEffect(() => {
    if (!focusRequest || focusRequest.nonce === lastFocusNonce.current) return
    lastFocusNonce.current = focusRequest.nonce
    engineRef.current?.addRequest(focusRequest.collectionId)
  }, [focusRequest])

  if (error) {
    return (
      <div className="empty">
        <div className="empty-icon" style={{ color: 'var(--danger)' }}>
          <AlertTriangle size={22} />
        </div>
        <h3>{error}</h3>
        <p>The API client could not start.</p>
      </div>
    )
  }

  return (
    <>
      {transportError && (
        <TransportError
          message={transportError}
          onDismiss={() => setTransportError(null)}
          onSkipCertificateCheck={
            // Only offered when that is actually the problem, and only when it
            // is not already off.
            active && /certificate/i.test(transportError) && !active.insecureTls
              ? () => {
                  update(active.id, { insecureTls: true })
                  setTransportError(null)
                }
              : undefined
          }
        />
      )}
      {loading && (
        <div className="empty">
          <Loader2 size={22} className="spin" />
          <p>Loading the API client…</p>
        </div>
      )}
      <div
        ref={hostRef}
        // `scalar-app` is the library's own root class; the mode class is how
        // it is themed, so it follows OpsMaxx's setting rather than guessing.
        className={`scalar-app http-client-host ${theme === 'dark' ? 'dark-mode' : 'light-mode'}`}
        hidden={loading}
      />
    </>
  )
}

/**
 * Builds the Vue app and returns the two handles React drives it with.
 *
 * Everything Scalar is imported lazily and in one place: it is by far the
 * largest thing in the renderer, and someone who never opens the HTTP client
 * should not pay to parse it.
 */
async function createEngine(
  el: HTMLElement,
  optionsRef: { current: HttpTransportOptions },
  reportRef: { current: (message: string | null) => void }
): Promise<Engine> {
  const [
    { Operation },
    { createWorkspaceStore },
    { createWorkspaceEventBus },
    { getActiveEnvironment },
    { generateClientMutators },
    { createApp, h, ref, shallowRef },
    { Sidebar },
    { createSidebarState }
  ] = await Promise.all([
    import('@scalar/api-client/v2/features/operation'),
    import('@scalar/workspace-store/client'),
    import('@scalar/workspace-store/events'),
    import('@scalar/workspace-store/request-example'),
    import('@scalar/workspace-store/mutators'),
    import('vue'),
    import('@scalar/api-client/v2/components/sidebar'),
    import('@scalar/sidebar'),
    // The stylesheet rides the same dynamic import as the code, so it is not
    // in the main CSS bundle either.
    import('@scalar/api-client/style.css')
  ])

  const workspaceStore = createWorkspaceStore()
  const eventBus = createWorkspaceEventBus()
  const mutators = generateClientMutators(workspaceStore)
  const transport = createHttpTransport(
    () => optionsRef.current,
    (message) => reportRef.current(message)
  )

  const activeSlug = ref<string | null>(null)
  const currentPath = ref('/')
  const currentMethod = ref<HttpMethodName>('get')
  const sidebarWidth = ref(280)
  // shallowRef: a sidebar state is a whole reactive object of its own, and
  // deep-tracking it from out here would make every keystroke inside it a
  // re-render of this wrapper.
  const sidebarState = shallowRef<SidebarState<TraversedEntry> | null>(null)

  /** What each slug was built from, so an unchanged collection is not rebuilt. */
  const sources = new Map<string, string>()
  /** Where the user was inside each collection, so switching back returns there. */
  const lastPlace = new Map<string, { path: string; method: HttpMethodName }>()
  const sidebars = new Map<string, SidebarState<TraversedEntry>>()

  /**
   * The document for a slug, or null.
   *
   * Narrowed rather than cast: a workspace can hold an AsyncAPI document, and
   * the operation view is OpenAPI-only. One that is not OpenAPI renders the
   * client's own empty state instead of being forced through a type it does
   * not satisfy.
   */
  const documentOf = (slug: string): OpenApiDocument | null => {
    const doc = workspaceStore.workspace.documents[slug]
    return doc && 'openapi' in doc ? doc : null
  }

  const sidebarFor = (slug: string): SidebarState<TraversedEntry> | null => {
    const cached = sidebars.get(slug)
    if (cached) return cached
    const doc = documentOf(slug)
    const nav = (doc as { 'x-scalar-navigation'?: { children?: TraversedEntry[] } } | null)?.[
      'x-scalar-navigation'
    ]
    const entries = nav?.children ?? []
    if (entries.length === 0) return null

    const state: SidebarState<TraversedEntry> = createSidebarState(entries, {
      hooks: {
        // `onAfterSelect`, not `onBefore`: the row the user sees highlighted
        // has to be the one the pane is showing.
        onAfterSelect: (id: string | null) => {
          if (id === null) return
          const entry = state.getEntryById(id)
          // Tags, descriptions and schemas are all legal selections and none
          // of them is a request. Ignoring them leaves the pane on the last
          // operation, which beats blanking it.
          if (!entry || entry.type !== 'operation') return
          const method = methodOf(entry.method)
          if (!method) return
          currentPath.value = entry.path
          currentMethod.value = method
          if (activeSlug.value) lastPlace.set(activeSlug.value, { path: entry.path, method })
        }
      }
    })
    sidebars.set(slug, state)
    return state
  }

  const select = (collectionId: string): void => {
    if (!documentOf(collectionId)) return
    activeSlug.value = collectionId

    const doc = documentOf(collectionId) as Record<string, unknown>
    const first = firstOperationOf(doc)
    const landing = lastPlace.get(collectionId) ?? (first ? placeOf(first) : null)
    if (landing) {
      currentPath.value = landing.path
      currentMethod.value = landing.method
    }

    const state = sidebarFor(collectionId)
    sidebarState.value = state
    if (state && landing) {
      // Land ON something. A pane already rendering the landing operation
      // while the tree shows nothing selected is how the first click on that
      // same row became a no-op that looked like a dead control.
      const entry = findOperationEntry(state.items.value, landing.path, landing.method)
      state.setSelected(entry?.id ?? null)
    }
  }

  const sync = async (collections: readonly ApiCollection[]): Promise<void> => {
    const live = new Set(collections.map((c) => c.id))

    for (const slug of [...sources.keys()]) {
      if (live.has(slug)) continue
      sources.delete(slug)
      sidebars.delete(slug)
      lastPlace.delete(slug)
      // The store has no public remove, and a stale document costs a little
      // memory and nothing else — it is unreachable once its collection is
      // gone. Dropping our own bookkeeping is what stops it being rebuilt.
    }

    for (const collection of collections) {
      const key = sourceKeyOf(collection)
      if (sources.get(collection.id) === key) continue
      // Rebuilt from a different source: the cached tree and position describe
      // a document that no longer exists.
      sidebars.delete(collection.id)
      lastPlace.delete(collection.id)
      await addDocument(collection)
      sources.set(collection.id, key)
    }
  }

  const addDocument = async (collection: ApiCollection): Promise<void> => {
    const name = collection.id
    if (collection.specPath) {
      // Re-read on every load rather than cached: a description on disk is a
      // file someone edits, and showing them yesterday's copy of their own API
      // with no way to tell is worse than not offering files at all.
      const text = await window.opsmaxx!.http.readSpecFile(collection.specPath)
      await workspaceStore.addDocument({
        name,
        document: await parseSpec(text, collection.specPath)
      })
      return
    }
    if (collection.specUrl) {
      // Fetched through the same transport as the requests. A description
      // served by the very host the requests go to would otherwise be
      // unreachable for exactly the reasons the transport exists.
      await workspaceStore.addDocument({ name, url: collection.specUrl, fetch: transport })
      return
    }
    await workspaceStore.addDocument({ name, document: documentForCollection(collection) })
  }

  const app = createApp({
    render: () => {
      const slug = activeSlug.value
      const doc = slug ? documentOf(slug) : null
      if (!slug || !doc) return h('div', { class: 'scalar-empty' })

      const state = sidebarState.value
      return h('div', { class: 'flex h-full min-h-0 w-full' }, [
        // Only when there is more than one thing to choose between: a tree
        // with a single row in it is chrome that takes width and answers
        // nothing.
        state && state.items.value.length > 1
          ? h(Sidebar, {
              sidebarState: state,
              layout: 'web',
              eventBus,
              activeWorkspace: { id: 'opsmaxx' },
              workspaces: [],
              documents: [doc],
              isDroppable: () => false,
              sidebarWidth: sidebarWidth.value,
              'onUpdate:sidebarWidth': (v: number) => (sidebarWidth.value = v)
            })
          : null,
        h(Operation, {
          documentSlug: slug,
          document: doc,
          eventBus,
          // `web`, not `modal`. The modal layout is what rendered the method
          // beside the address bar as a LABEL rather than a control, gated
          // `{{variable}}` completion in every input, and hid two whole
          // sections of the request block.
          layout: 'web',
          path: currentPath.value,
          method: currentMethod.value,
          environment: getActiveEnvironment(workspaceStore, doc).environment,
          workspaceStore,
          plugins: [],
          options: { customFetch: transport }
        })
      ])
    }
  })
  app.mount(el)

  /**
   * A new request in a collection.
   *
   * This is what the toolbar's `+` used to reach: a separate endpoint editor
   * that wrote `{method, path}` into OpsMaxx's own record. The document is the
   * source of truth now, so the request is created IN it — which also puts it
   * in the operation tree, rather than in a list beside one.
   *
   * The path is a placeholder, not a guess at what the user wants. They are
   * landed on it with the address bar ready, which is the same thing every
   * other client does with an untitled request.
   */
  const addRequest = (collectionId: string): void => {
    const doc = documentOf(collectionId)
    if (!doc) return

    const paths = (doc.paths ?? {}) as Record<string, Record<string, unknown>>
    // A free path, because creating over an existing GET would silently
    // replace a request the user already had.
    let path = '/new-request'
    for (let n = 2; paths[path]?.get !== undefined; n++) path = `/new-request-${n}`

    const created = mutators.doc(collectionId).operation.createOperation({
      documentName: collectionId,
      path,
      method: 'get',
      operation: { summary: 'New request', responses: { '200': { description: 'OK' } } }
    })
    if (created === undefined) return

    // The tree changed shape, so the cached state describes a document that no
    // longer matches. Rebuilt on the next `select`.
    sidebars.delete(collectionId)
    lastPlace.set(collectionId, { path: created, method: 'get' })
    select(collectionId)
  }

  return {
    sync,
    select,
    addRequest,
    unmount: () => app.unmount()
  }
}

/**
 * The navigation entry for one path+method, at any depth.
 *
 * A description groups its operations under tags, so an operation's entry is
 * usually a grandchild of the root rather than a child — and a flat scan of
 * `children` finds nothing on exactly the documents that have the most in them.
 */
function findOperationEntry(
  entries: TraversedEntry[],
  path: string,
  method: string
): TraversedEntry | null {
  for (const entry of entries) {
    const e = entry as TraversedEntry & { type?: string; path?: string; method?: string }
    if (e.type === 'operation' && e.path === path && e.method === method) return entry
    const children = (entry as { children?: TraversedEntry[] }).children
    if (children) {
      const found = findOperationEntry(children, path, method)
      if (found) return found
    }
  }
  return null
}

/**
 * An OpenAPI description read from disk, as an object.
 *
 * JSON first, because it is the cheap case and most `.json` descriptions are
 * exactly that. YAML costs a dynamic import, so only someone who actually has
 * a YAML description pays for the parser.
 *
 * A file that is neither is reported by its own parse error rather than as a
 * generic failure: "unexpected end of the stream within a flow collection at
 * line 40" tells someone where to look, and "the API client could not start"
 * does not.
 */
async function parseSpec(text: string, path: string): Promise<Record<string, unknown>> {
  const trimmed = text.trimStart()
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(text) as Record<string, unknown>
    } catch (e) {
      throw new Error(`${path} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  const { parse } = await import('yaml')
  try {
    const doc = parse(text) as unknown
    if (!doc || typeof doc !== 'object') throw new Error('it does not describe an object')
    return doc as Record<string, unknown>
  } catch (e) {
    throw new Error(
      `${path} could not be read as YAML: ${e instanceof Error ? e.message : String(e)}`
    )
  }
}

/**
 * A failed request, in OpsMaxx's own words.
 *
 * The API client renders nothing for a rejected fetch, and the two most common
 * reasons a request fails here are both ones OpsMaxx can fix in a click — so
 * the fix is offered next to the reason rather than described.
 */
function TransportError({
  message,
  onDismiss,
  onSkipCertificateCheck
}: {
  message: string
  onDismiss: () => void
  onSkipCertificateCheck?: () => void
}): React.JSX.Element {
  return (
    <div className="http-error" role="alert">
      <AlertTriangle size={15} className="http-error-icon" />
      <span className="http-error-text">{message}</span>
      {onSkipCertificateCheck && (
        <button className="btn" onClick={onSkipCertificateCheck}>
          Skip the check for this API
        </button>
      )}
      <button className="icon-btn" title="Dismiss" onClick={onDismiss}>
        <X size={14} />
      </button>
    </div>
  )
}
