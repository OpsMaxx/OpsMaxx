import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Loader2, X } from 'lucide-react'
import { useApp } from '../../store/app'
import { sshTargetFor } from '../../lib/ssh'
import { createHttpTransport, type HttpTransportOptions } from '../../lib/httpTransport'
import { useResolvedTheme } from '../../hooks/useResolvedTheme'
import type { TraversedEntry } from '@scalar/workspace-store/schemas/navigation'
import type { ApiCollection } from '../../types'

/**
 * The API client itself, for one collection.
 *
 * The client is a Vue app. It is mounted into a div this component owns rather
 * than into document.body, so a collection is a pane in the layout like every
 * other view, and switching collections tears one down and builds the next
 * instead of stacking overlays.
 *
 * Two details make that work:
 *
 *   - The client's panel is `position: fixed`. A `transform` on the host makes
 *     the host its containing block, so it fills this pane rather than the
 *     window. That is CSS's own rule for fixed descendants, not a trick
 *     against the library.
 *   - The module is imported lazily. It is by far the largest thing in the
 *     renderer, and someone who never opens the HTTP client should never pay
 *     to parse it.
 */
export function ApiClientPane({ collection }: { collection: ApiCollection }): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  // The last transport failure, if the most recent request had one.
  const [transportError, setTransportError] = useState<string | null>(null)
  const theme = useResolvedTheme()

  const servers = useApp((s) => s.servers)
  const update = useApp((s) => s.updateApiCollection)

  /**
   * The transport reads these when a request is sent, not when the client is
   * built, so changing the target or the certificate toggle takes effect on the
   * next Send instead of rebuilding the client and losing what the user typed.
   */
  // Stable across renders: the transport is built once, when the client is,
  // and must still reach today's setState rather than the first one.
  const reportRef = useRef((message: string | null) => setTransportError(message))
  const optionsRef = useRef<HttpTransportOptions>({ via: { kind: 'direct' }, insecureTls: false })
  optionsRef.current = {
    via: (() => {
      if (!collection.viaServerId) return { kind: 'direct' as const }
      const server = servers.find((s) => s.id === collection.viaServerId)
      // A collection can outlive the server it named. Falling back to a direct
      // request would quietly send it somewhere else, so refuse instead — the
      // toolbar shows the same thing as an unresolved target.
      if (!server) return { kind: 'direct' as const }
      return { kind: 'server' as const, server: sshTargetFor(server) }
    })(),
    insecureTls: collection.insecureTls
  }

  // Rebuilt only when the identity or the document changes — not when `via` or
  // the certificate toggle does, which the ref above carries instead.
  const specUrl = collection.specUrl
  const specPath = collection.specPath ?? null
  const baseUrl = collection.baseUrl

  useEffect(() => {
    let disposed = false
    let app: { unmount: () => void } | null = null

    void (async () => {
      try {
        const [
          { Operation },
          { createWorkspaceStore },
          { createWorkspaceEventBus },
          { getActiveEnvironment },
          { createApp, h, ref },
          { Sidebar },
          { createSidebarState }
        ] = await Promise.all([
            import('@scalar/api-client/v2/features/operation'),
            import('@scalar/workspace-store/client'),
            import('@scalar/workspace-store/events'),
            import('@scalar/workspace-store/request-example'),
            import('vue'),
            import('@scalar/api-client/v2/components/sidebar'),
            import('@scalar/sidebar'),
            // The stylesheet rides the same dynamic import as the code, so it
            // is not in the main CSS bundle either.
            import('@scalar/api-client/style.css')
          ])
        const el = hostRef.current
        if (disposed || !el) return

        const workspaceStore = createWorkspaceStore()
        const eventBus = createWorkspaceEventBus()

        if (specPath) {
          // Re-read on every open rather than cached at import: a description
          // on disk is a file someone edits, and showing them yesterday's copy
          // of their own API with no way to tell is worse than not offering
          // files at all.
          const text = await window.opsmaxx!.http.readSpecFile(specPath)
          await workspaceStore.addDocument({
            name: collection.id,
            document: await parseSpec(text, specPath)
          })
        } else if (specUrl) {
          // The document is fetched through the same transport as the requests.
          // A spec served by the very host the requests go to would otherwise
          // be unreachable for exactly the reasons the transport exists.
          await workspaceStore.addDocument({
            name: collection.id,
            url: specUrl,
            fetch: createHttpTransport(() => optionsRef.current, reportRef.current)
          })
        } else {
          await workspaceStore.addDocument({
            name: collection.id,
            document: scratchDocument(collection.name, baseUrl)
          })
        }
        if (disposed) return

        // Where to land. A description may hold hundreds of operations, so the
        // first one is the only sensible answer; a scratch document has one we
        // wrote ourselves and can name outright.
        const first = firstOperationOf(workspaceStore, collection.id)
        const landingPath = specUrl || specPath ? (first?.path ?? '/') : scratchPathOf(baseUrl)
        const landingMethod = specUrl || specPath ? (first?.method ?? 'get') : 'get'

        // Mounted as the client's OWN operation view rather than through
        // `createApiClientModal`.
        //
        // That helper is Scalar's minimal embed — "jump to one operation from a
        // reference page" — and it hardcodes `layout: 'modal'` as a literal in
        // its render function. Nine components downstream read that value and
        // take features away: the method beside the address bar is rendered
        // with `isEditable: layout !== 'modal'`, so it was a label rather than
        // a control; `{{variable}}` completion in every input is gated the same
        // way; and the request block hides two whole sections. None of that was
        // our document or a broken dropdown — it was the wrapper.
        //
        // `Operation` is exported, takes `layout` as an ordinary prop, and
        // derives everything else from the workspace store, which is why this
        // is twelve props rather than the thirty its inner block wants.
        // Narrowed rather than cast: the workspace can hold an AsyncAPI
        // document, and the operation view is OpenAPI-only. A description that
        // is not OpenAPI renders the client's own empty state instead of being
        // forced through a type it does not satisfy.
        const active = workspaceStore.workspace.documents[collection.id]
        const openApiDocument = active && 'openapi' in active ? active : null
        const documentRef = { value: openApiDocument }
        // The operation tree, which the modal wrapper never showed.
        //
        // Its entries come from the navigation the workspace store builds for
        // the document; a scratch collection has one operation and a
        // description has as many as it describes, which is exactly the list
        // someone needs to move around an API rather than retyping paths.
        // Typed as the store's own navigation entries rather than loosely:
        // the sidebar keys, sorts and renders by fields that a `{ id }` shape
        // does not carry, and a cast that hid that would fail at render.
        const navigation = (
          openApiDocument as { 'x-scalar-navigation'?: { children?: TraversedEntry[] } } | null
        )?.['x-scalar-navigation']
        const entries: TraversedEntry[] = navigation?.children ?? []
        const sidebarState = createSidebarState(entries)
        const sidebarWidth = ref(280)
        // Selecting an entry re-points the operation view at it. Held in refs
        // so a click re-renders without rebuilding the client and losing what
        // the user has typed.
        const currentPath = ref(landingPath)
        const currentMethod = ref<HttpMethodName>(landingMethod)
        sidebarState.setSelected(null)

        const vueApp = createApp({
          render: () =>
            h('div', { class: 'flex h-full min-h-0 w-full' }, [
              entries.length > 1
                ? h(Sidebar, {
                    sidebarState,
                    layout: 'web',
                    eventBus,
                    activeWorkspace: { id: 'opsmaxx' },
                    workspaces: [],
                    documents: openApiDocument ? [openApiDocument] : [],
                    isDroppable: () => false,
                    sidebarWidth: sidebarWidth.value,
                    'onUpdate:sidebarWidth': (v: number) => (sidebarWidth.value = v)
                  })
                : null,
              h(Operation, {
              documentSlug: collection.id,
              document: documentRef.value,
              eventBus,
              // The whole point of the change.
              layout: 'web',
              path: currentPath.value,
              method: currentMethod.value,
              environment: getActiveEnvironment(workspaceStore, documentRef.value).environment,
              workspaceStore,
              plugins: [],
              options: {
                customFetch: createHttpTransport(() => optionsRef.current, reportRef.current),
                // A description names its own servers, and they are usually
                // production. What the toolbar shows is what gets sent.
                ...(baseUrl ? { baseServerURL: scratchOriginOf(baseUrl) } : {})
              }
              })
            ])
        })
        vueApp.mount(el)
        app = vueApp
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
      app?.unmount()
    }
  }, [collection.id, collection.name, specUrl, specPath, baseUrl])

  if (error) {
    return (
      <div className="empty">
        <div className="empty-icon" style={{ color: 'var(--danger)' }}>
          <AlertTriangle size={22} />
        </div>
        <h3>{error}</h3>
        <p>
          {specUrl
            ? 'The API description could not be loaded. Check the URL, and whether it needs to be reached through a server.'
            : 'The API client could not start.'}
        </p>
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
            /certificate/i.test(transportError) && !collection.insecureTls
              ? () => {
                  update(collection.id, { insecureTls: true })
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
        // scalar-app is the library's own root class; the mode class is how it
        // is themed, so it follows OpsMaxx's setting rather than guessing.
        className={`scalar-app http-client-host ${theme === 'dark' ? 'dark-mode' : 'light-mode'}`}
        hidden={loading}
      />
    </>
  )
}

/**
 * The document behind a scratch collection: one GET the user can retarget.
 *
 * A collection with no OpenAPI description still needs a document, because the
 * client is built around one. Starting from a request that is already valid
 * means the address bar is ready to type in rather than showing an empty state
 * inside an empty state.
 */
/**
 * The path half of a collection's base URL.
 *
 * Someone adding a scratch collection pastes the URL they were going to curl,
 * and that URL usually has a path on it. Splitting it means
 * `http://host:9090/metrics` opens on /metrics — dropping the path and opening
 * on `/` sends the first request somewhere the user never asked for, and the
 * 404 that comes back looks like the service is broken.
 */
function scratchPathOf(baseUrl: string): string {
  try {
    const path = new URL(baseUrl).pathname
    return path && path !== '/' ? path : '/'
  } catch {
    return '/'
  }
}

/** The origin, since the path is carried by the operation instead. */
function scratchOriginOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).origin
  } catch {
    return baseUrl
  }
}

/**
 * The methods a scratch request offers.
 *
 * The client takes its method from the OPERATION, not from a control of its
 * own: a path that describes only `get` has no other method to switch to, and
 * the method beside the address bar is then a label rather than a choice. This
 * document used to define exactly one operation, which is why a scratch
 * request was stuck on GET — not a dropdown that failed to work, a document
 * with nothing else in it.
 *
 * Describing the whole set costs nothing — they are four lines of JSON each —
 * and turns the same control into a real choice.
 */
const SCRATCH_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const

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
    throw new Error(`${path} could not be read as YAML: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/**
 * The first operation in a description, as a path and a method.
 *
 * A description may hold hundreds; landing on the first is the only answer
 * that does not require guessing which one the user meant. Returns null for a
 * document with no paths at all, which is a valid if useless description and
 * must not throw here.
 */
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const
type HttpMethodName = (typeof HTTP_METHODS)[number]

function firstOperationOf(
  store: { workspace: { documents: Record<string, unknown> } },
  slug: string
): { path: string; method: HttpMethodName } | null {
  const doc = store.workspace.documents[slug] as
    | { paths?: Record<string, Record<string, unknown>> }
    | undefined
  const paths = doc?.paths
  if (!paths) return null
  const methods = HTTP_METHODS
  for (const [path, item] of Object.entries(paths)) {
    for (const method of methods) {
      if (item && typeof item === 'object' && method in item) return { path, method }
    }
  }
  return null
}

function scratchDocument(title: string, baseUrl: string): Record<string, unknown> {
  const path = scratchPathOf(baseUrl)
  const operations: Record<string, unknown> = {}
  for (const method of SCRATCH_METHODS) {
    operations[method] = {
      operationId: `request-${method}`,
      summary: `${method.toUpperCase()} ${path}`,
      // A body only where one is meaningful. Offering it on GET is how a
      // client ends up sending one, which some servers reject outright.
      ...(method === 'post' || method === 'put' || method === 'patch'
        ? {
            requestBody: {
              required: false,
              content: { 'application/json': { schema: { type: 'object' } } }
            }
          }
        : {}),
      responses: { '200': { description: 'OK' } }
    }
  }
  return {
    openapi: '3.1.0',
    info: { title, version: '1.0.0' },
    ...(baseUrl ? { servers: [{ url: scratchOriginOf(baseUrl) }] } : {}),
    paths: { [path]: operations }
  }
}

/**
 * A failed request, in OpsMaxx's own words.
 *
 * The API client renders nothing for a rejected fetch, and the two most common
 * reasons a request fails here are both ones OpsMaxx can fix in a click —
 * so the fix is offered next to the reason rather than described.
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
