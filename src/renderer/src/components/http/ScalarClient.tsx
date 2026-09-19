import { useCallback, useEffect, useRef, useState } from 'react'
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
import { EnvironmentBar } from './EnvironmentBar'
import { VAULT_LOCKED_MESSAGE } from '../../../../shared/apiSecrets'
import { UnlockVaultButton } from '../common/UnlockVaultButton'
import {
  fromSnapshot,
  isSnapshot,
  toSnapshot,
  type WorkspaceLike
} from '../../../../shared/apiWorkspaceSnapshot'

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
  /** Everything worth keeping, for the store to persist. */
  snapshot: () => unknown
  /** Show this collection, restoring wherever the user last was inside it. */
  select: (collectionId: string) => void
  /** Add a request to a collection and land on it. */
  addRequest: (collectionId: string) => void
  /** The environments and their variables, as the panel shows them. */
  environments: () => EnvironmentsView
  /** Which environment requests interpolate from. */
  setActiveEnvironment: (name: string) => void
  createEnvironment: (name: string) => void
  deleteEnvironment: (name: string) => void
  /** `index` absent adds; present replaces that row. */
  setVariable: (environmentName: string, variable: EnvVariable, index?: number) => void
  deleteVariable: (environmentName: string, index: number) => void
  unmount: () => void
}

/** One environment variable, flattened out of the client's two spellings. */
export interface EnvVariable {
  name: string
  value: string
}

export interface EnvironmentsView {
  names: string[]
  active: string
  variables: EnvVariable[]
}

/**
 * The client stores a variable's value as either a string or an object with a
 * `default`. Both are legal and both turn up, so reading goes through one
 * place rather than every call site guessing.
 */
function valueOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && 'default' in value) {
    return String((value as { default: unknown }).default ?? '')
  }
  return ''
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
/**
 * What the document is BUILT FROM, which is not the same as what the
 * collection says about itself.
 *
 * A change here rebuilds the document from scratch, which throws away every
 * request the user added and every edit inside them, with no warning and no
 * undo. So the key may only contain inputs to that build.
 *
 * `name` was in it and is not an input. Renaming a collection -- fixing a typo
 * -- therefore destroyed its entire contents, and the Add-API dialog
 * recommends exactly that as the way to correct a base URL. Nothing renders
 * the document's own title either: the sidebar draws navigation entries, and
 * all three places that show a name read it from the collection record.
 *
 * The rest stay. `specUrl` and `specPath` genuinely select a different
 * document. `baseUrl` and `endpoints` are what a collection with no spec is
 * generated from, and for a spec collection `baseUrl` is derived from the spec
 * URL, so it only moves when that does.
 */
function sourceKeyOf(c: ApiCollection): string {
  return JSON.stringify({
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
  /**
   * The environments, mirrored into React so the panel can render them.
   *
   * The workspace store is Vue-reactive and this side is not, so the mirror is
   * refreshed explicitly — after any mutation here, and on any change coming
   * from inside the client (a variable edited in one of its own inputs).
   */
  const [envs, setEnvs] = useState<EnvironmentsView>({ names: [], active: '', variables: [] })
  const theme = useResolvedTheme()

  /**
   * THE THEME HAS TO FOLLOW THE POPUPS OUT OF THE PANE.
   *
   * Every floating thing the client opens -- the method dropdown, Auth Type,
   * the server picker, the environment menu -- is a `ScalarTeleport`, and
   * `useTeleport()` falls back to `"body"` when nothing has provided a target.
   * Nothing has: neither this file nor the library's own v2 client calls
   * `useProvideTeleport`. So the popup is appended to `<body>` as
   * `<div class="scalar-app">`, and OpsMaxx's `dark-mode` class is on the pane,
   * which is no longer an ancestor.
   *
   * The whole palette is declared on `.dark-mode` / `.light-mode`, so out
   * there `--scalar-background-1` resolves to nothing. `ScalarFloatingBackdrop`
   * is `bg-b-1 shadow-lg`, which is the ONLY thing painting a dropdown's
   * background -- so it computes to `rgba(0, 0, 0, 0)` and the menu renders as
   * bare text floating over whatever is behind it. Measured both ways on the
   * running app: transparent without the class, `rgb(15, 15, 15)` with it.
   *
   * Re-classing the teleport roots rather than teleporting into the pane,
   * deliberately. `.http-client-host` is `overflow: hidden` with a `transform`
   * (both load-bearing -- see global.css), so a target inside it would clip
   * every menu opened near an edge. And this is the library's own idiom:
   * `@scalar/components` ships `addScalarClassesToHeadless`, which is this
   * function for the HeadlessUI portal root.
   */
  useEffect(() => {
    const mode = theme === 'dark' ? 'dark-mode' : 'light-mode'
    const stale = theme === 'dark' ? 'light-mode' : 'dark-mode'
    // Only direct children of body: the pane's own host is nested, carries the
    // class already, and must not be touched by a cleanup that runs on a
    // theme change.
    const roots = (): HTMLElement[] =>
      Array.from(document.body.children).filter(
        (n): n is HTMLElement => n instanceof HTMLElement && n.classList.contains('scalar-app')
      )
    const apply = (el: HTMLElement): void => {
      el.classList.remove(stale)
      el.classList.add(mode)
    }
    roots().forEach(apply)

    // A dropdown's root is created at the moment it opens, so classing what is
    // already there is not enough on its own.
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof HTMLElement && node.classList.contains('scalar-app')) apply(node)
        }
      }
    })
    observer.observe(document.body, { childList: true })
    return () => observer.disconnect()
  }, [theme])

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

  /**
   * Persisting what the user has done, on a long trailing debounce.
   *
   * Two seconds rather than the store's own 400 ms, because the cost here is
   * different in kind: this serialises every document in the workspace, and it
   * is driven by a bus that fires on every keystroke inside the client. The
   * store's debounce then batches the result again on the way to disk.
   */
  // Both read only refs and the store's own getState, so neither needs to be
  // rebuilt between renders — and a stable identity is what lets the mount
  // effect below keep an honest empty dependency list.
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancelSave = useCallback((): void => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = null
  }, [])
  const refreshEnvs = useCallback((): void => {
    const engine = engineRef.current
    if (engine) setEnvs(engine.environments())
  }, [])

  const scheduleSave = useCallback((): void => {
    cancelSave()
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null
      const snapshot = engineRef.current?.snapshot()
      if (snapshot) useApp.getState().setApiWorkspace(snapshot)
    }, 2000)
  }, [cancelSave])

  // Mounted ONCE. Not keyed, not re-run: everything that used to be a
  // dependency here is now handled by `sync` and `select` below.
  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    let disposed = false

    void (async () => {
      try {
        const engine = await createEngine(
          el,
          optionsRef,
          reportRef,
          useApp.getState().apiWorkspace,
          () => {
            scheduleSave()
            refreshEnvs()
          }
        )
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
        setEnvs(engine.environments())
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
      // Before the unmount, or a pending save fires against a torn-down store
      // and writes an empty workspace over a live one.
      cancelSave()
      engineRef.current?.unmount()
      engineRef.current = null
    }
    // Mounted once by design: the collections and the selection are carried
    // in by `sync` and `select` instead of by a dependency list. Nothing in
    // this effect's body reads a prop directly, and the two callbacks it does
    // close over are stable — which is why this list is honest rather than
    // suppressed.
  }, [cancelSave, scheduleSave, refreshEnvs])

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
      {!loading && (
        <EnvironmentBar
          view={envs}
          onActivate={(name) => {
            engineRef.current?.setActiveEnvironment(name)
            refreshEnvs()
          }}
          onCreate={(name) => {
            engineRef.current?.createEnvironment(name)
            refreshEnvs()
          }}
          onDelete={(name) => {
            engineRef.current?.deleteEnvironment(name)
            refreshEnvs()
          }}
          onSetVariable={(variable, index) => {
            engineRef.current?.setVariable(envs.active, variable, index)
            refreshEnvs()
          }}
          onDeleteVariable={(index) => {
            engineRef.current?.deleteVariable(envs.active, index)
            refreshEnvs()
          }}
        />
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
  reportRef: { current: (message: string | null) => void },
  restore: unknown,
  onChanged: () => void
): Promise<Engine> {
  const [
    { Operation },
    { initializeWorkspaceEventHandlers },
    { createWorkspaceStore },
    { createWorkspaceEventBus },
    { getActiveEnvironment, filterGlobalCookie },
    { generateClientMutators },
    { createApp, h, ref, shallowRef },
    { Sidebar },
    { createSidebarState }
  ] = await Promise.all([
    import('@scalar/api-client/v2/features/operation'),
    import('@scalar/api-client/v2/workspace-events'),
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

  // NO THIRD-PARTY PROXY. This is not a preference, it is the difference
  // between a request leaving this machine for its destination and leaving it
  // for somebody else's server.
  //
  // `layout: 'web'` below is right for the UI -- it is what makes the method a
  // control rather than a label -- but Scalar reads the same value to decide
  // routing: getDefaultProxyUrl returns 'https://proxy.scalar.com' for the web
  // layout, and with `x-scalar-active-proxy` unset that default applies. Every
  // request to anything but localhost would then be rewritten to
  // proxy.scalar.com?scalar_url=<target> before reaching our transport,
  // carrying the URL, the headers -- Authorization included -- and the body to
  // a third party. A private hostname or an internal IP is exempt from nothing;
  // only loopback and the reserved TLDs are.
  //
  // It would also quietly undo "Send from <server>": the tunnel would carry a
  // request to Scalar rather than to the host the user picked.
  //
  // Unreachable until now only because the request pane never rendered, so
  // nothing could be sent. Fixing that without this would have turned a client
  // that did nothing into one that did something worse.
  workspaceStore.update('x-scalar-active-proxy', null)

  const eventBus = createWorkspaceEventBus()
  const mutators = generateClientMutators(workspaceStore)

  // THE HALF OF THE BUS THAT APPLIES ANYTHING.
  //
  // Scalar's v2 blocks are emit-only: typing a header emits
  // `operation:upsert:parameter`, choosing an auth scheme emits `auth:*`, a
  // response emits `hooks:on:request:complete`. Nothing in the library
  // subscribes by itself. `initializeWorkspaceEventHandlers` is what binds
  // every one of those to the mutator that performs it, and without it the
  // events were observed -- `onAny` below debounced a save -- and then thrown
  // away.
  //
  // So a header or body typed into the pane was never written to the document:
  // it reverted on the next render, never reached a snapshot, and never went
  // out with the request. Auth was never stored. The history dropdown could
  // not fill, because the completion event had no handler. Cookies from a
  // login response were dropped, which is why a session could not survive into
  // the next request.
  //
  // The only things that did persist were the two paths that bypass the bus
  // and call mutators directly: the environment bar, and adding a request.
  initializeWorkspaceEventHandlers({
    eventBus,
    store: shallowRef(workspaceStore),
    hooks: {}
  })

  /** What each slug was built from, so an unchanged collection is not rebuilt. */
  const sources = new Map<string, string>()

  /**
   * Last session's workspace, before anything is added to this one.
   *
   * `sourceKeys` comes back with it, and that is the load-bearing half: it
   * tells `sync` below that these documents are already current, so a restored
   * document is not immediately overwritten by one rebuilt from its
   * collection — which would discard every edit the snapshot exists to keep.
   */
  if (isSnapshot(restore)) {
    workspaceStore.loadWorkspace(
      fromSnapshot(restore) as Parameters<typeof workspaceStore.loadWorkspace>[0]
    )
    for (const [slug, key] of Object.entries(restore.sourceKeys)) sources.set(slug, key)
  }

  // Every change inside the client — a header typed, an environment edited, a
  // cookie set — arrives here. The debounce lives in the caller, because this
  // fires per keystroke.
  //
  // The unsubscribe is kept and called on unmount: the bus outlives the Vue
  // app, so a dropped listener would go on serialising a workspace for a
  // client that is gone.
  /**
   * Events that change the SHAPE of a document, not a value inside it.
   *
   * `createOperation` writes the path into `document.paths` and stops -- it
   * never calls `store.buildSidebar`, while its siblings such as
   * `updateOperationMeta` do. So `x-scalar-navigation` still described the
   * document as it was before, and a created request was missing from the
   * tree: the pane jumped to it, the tree did not, and pressing `+` again
   * collided on the same path. From the outside that is a button that does
   * nothing.
   *
   * Matched on the verb rather than listed event by event, because the cost of
   * catching one event too many is a cheap rebuild and the cost of missing one
   * is a tree that lies.
   */
  const RESHAPES = /^(operation|tag):.*(create|delete|rename|path-method)/

  const stopListening = eventBus.onAny(({ event }) => {
    if (RESHAPES.test(event)) {
      const slug = activeSlug.value
      // The sidebar state reads navigation through a getter, so rebuilding it
      // here is enough -- the tree updates in place and keeps whatever the
      // user had expanded and selected.
      if (slug && documentOf(slug)) workspaceStore.buildSidebar(slug)
    }
    onChanged()
  })
  /**
   * The cookies that apply to a URL, in the shape a header wants.
   *
   * The transport cannot get these from the request: `Cookie` is a forbidden
   * request-header name and the Request that carries it is built -- and
   * stripped -- before the transport is called. So they come from where Scalar
   * actually keeps them, which is where its own persist-response-cookies
   * writes every `Set-Cookie` it sees.
   *
   * `filterGlobalCookie` is Scalar's own domain and path matcher, taken from
   * the same subpath this file already imports getActiveEnvironment from, so
   * the rule here is the rule Scalar applies rather than a second
   * interpretation of it.
   */
  const cookiesForUrl = (url: string): string => {
    const doc = activeSlug.value ? documentOf(activeSlug.value) : null
    const scoped = [
      ...((workspaceStore.workspace as { 'x-scalar-cookies'?: unknown[] })['x-scalar-cookies'] ?? []),
      ...(((doc as { 'x-scalar-cookies'?: unknown[] } | null)?.['x-scalar-cookies'] ?? []) as unknown[])
    ]
    return scoped
      .filter((cookie) =>
        filterGlobalCookie({
          cookie: cookie as Parameters<typeof filterGlobalCookie>[0]['cookie'],
          url,
          disabledGlobalCookies: {}
        })
      )
      .map((c) => {
        const { name, value } = c as { name?: string; value?: string }
        return `${name ?? ''}=${value ?? ''}`
      })
      .filter((pair) => pair !== '=')
      .join('; ')
  }

  const transport = createHttpTransport(
    () => optionsRef.current,
    (message) => reportRef.current(message),
    cookiesForUrl
  )

  const activeSlug = ref<string | null>(null)
  const currentPath = ref('/')
  const currentMethod = ref<HttpMethodName>('get')
  /**
   * WITHOUT THIS THE CLIENT IS A DEAD SHELL, and nothing says so.
   *
   * Operation renders its request block only when path, method, document,
   * exampleName and the example it resolves are ALL truthy — and its type
   * declares `exampleName?: string`, so omitting it is not a type error. Every
   * request therefore fell through to "Select an operation to view details",
   * including the one already selected in the tree. Clicking a request did
   * nothing, silently, which is exactly what it looks like when a product has
   * not been built.
   *
   * The name comes from the operation's own `example` children. Scalar's
   * resolveExampleName takes the first of them and falls back to the literal
   * `'default'`, which is the key its store writes when a document declares no
   * examples of its own, so that fallback is the common case rather than the
   * edge one.
   */
  const currentExample = ref('default')
  const sidebarWidth = ref(280)
  // shallowRef: a sidebar state is a whole reactive object of its own, and
  // deep-tracking it from out here would make every keystroke inside it a
  // re-render of this wrapper.
  const sidebarState = shallowRef<SidebarState<TraversedEntry> | null>(null)

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
    const navOf = (): TraversedEntry[] => {
      const live = documentOf(slug) as {
        'x-scalar-navigation'?: { children?: TraversedEntry[] }
      } | null
      return live?.['x-scalar-navigation']?.children ?? []
    }
    if (navOf().length === 0) return null

    // A GETTER, NOT THE ARRAY.
    //
    // `createSidebarState` takes `MaybeRefOrGetter<T[]>`, and handing it the
    // array read once froze the tree at the moment the document was built.
    // Everything that adds or removes an operation now goes through the event
    // bus -- `operation:create:operation`, `operation:delete:operation`,
    // `operation:rename:example` -- so with a snapshot, a request created
    // inside the client never appeared in the tree at all. It looked exactly
    // like a `+` that does nothing: the pane switched to the new request, the
    // tree did not, and creating another one collided on the same path.
    const state: SidebarState<TraversedEntry> = createSidebarState(navOf, {
      hooks: {
        // `onAfterSelect`, not `onBefore`: the row the user sees highlighted
        // has to be the one the pane is showing.
        onAfterSelect: (id: string | null) => {
          if (id === null) return
          const selected = state.getEntryById(id)
          if (!selected) return

          // An example row is a request too -- it is how a description with
          // several bodies for one endpoint is navigated -- but the path and
          // method live on its parent operation. Resolving upwards here rather
          // than refusing the selection is what makes those rows work at all.
          const entry =
            selected.type === 'example'
              ? ((selected as { parent?: TraversedEntry }).parent ?? null)
              : selected

          // Tags, descriptions and schemas are all legal selections and none
          // of them is a request. Ignoring them leaves the pane on the last
          // operation, which beats blanking it.
          if (!entry || entry.type !== 'operation') return
          const method = methodOf(entry.method)
          if (!method) return
          currentPath.value = entry.path
          currentMethod.value = method
          currentExample.value =
            selected.type === 'example'
              ? ((selected as { name?: string }).name ?? 'default')
              : exampleNameOf(entry)
          if (activeSlug.value) lastPlace.set(activeSlug.value, { path: entry.path, method })
        }
      }
    })
    sidebars.set(slug, state)
    return state
  }

  /** The example key for an operation entry: its first example child, or the
   *  store's default. Mirrors Scalar's own resolveExampleName. */
  const exampleNameOf = (entry: TraversedEntry | null | undefined): string => {
    const children = (entry as { children?: { type?: string; name?: string }[] } | null)?.children
    const first = children?.find((c) => c.type === 'example')?.name
    return first ?? 'default'
  }

  const select = (collectionId: string): void => {
    if (!documentOf(collectionId)) return
    activeSlug.value = collectionId

    // THE STORE HAS TO BE TOLD TOO, and this ref is not telling it.
    //
    // Every document-scoped event the bus applies goes through
    // `mutators.active()`, and `activeDocument` resolves as
    // `workspace['x-scalar-active-document'] ?? Object.keys(documents)[0]`.
    // Unset, that is whichever collection was added FIRST -- so with two
    // collections open, a header typed into the second is written into the
    // first: it disappears from the pane on the next render, which reads the
    // second, and the first is quietly corrupted and then persisted and backed
    // up in that state. With one collection it happens to be right, which is
    // the worst way for this to behave.
    workspaceStore.update('x-scalar-active-document', collectionId)

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
      currentExample.value = exampleNameOf(entry)
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
              // WITHOUT THIS THE TREE IS A PICTURE.
              //
              // `Sidebar` does `emit('selectItem', id)` and nothing else --
              // across the whole library the only click-driven caller of
              // `setSelected` is the reference client's own `useModalSidebar`.
              // With no handler, `onAfterSelect` fired only from this file's
              // programmatic `select()`, so a user with a 200-operation
              // description could reach exactly one of them: the one they
              // landed on.
              //
              // Selecting is all that is needed here because `onAfterSelect`
              // already does the routing. A row that is not an operation --
              // a tag, a schema -- toggles open instead, which is what makes
              // a folder behave like a folder.
              onSelectItem: (id: string) => {
                const entry = state.getEntryById(id)
                if (entry && (entry.type === 'operation' || entry.type === 'example')) {
                  state.setSelected(id)
                  return
                }
                state.setExpanded(id, !state.isExpanded(id))
              },
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
        // THE WRAPPER IS NOT DECORATION.
        //
        // Operation's own root is `flex h-full flex-col` with no `flex-1`, so
        // as a bare flex child it sizes to its content and stops -- measured at
        // 512px of a 1352px pane, with the rest of the client left blank.
        // Scalar's own app never hits this because it renders Operation into a
        // filled grid cell.
        //
        // The width is not cosmetic. The request block's layout is driven by a
        // CSS container query on `t-app__top-container`, so under its
        // breakpoint the whole thing collapses: the address bar wraps under the
        // method, Send drops onto its own row, and the response stacks BELOW
        // the request instead of beside it. Most of what "there is nothing
        // here" looked like was this.
        //
        // `min-w-0` because a flex item's default `min-width: auto` refuses to
        // shrink below its content, which is how the response pane would widen
        // the client past the window rather than scrolling inside it.
        h('div', { class: 'flex min-w-0 flex-1 flex-col' }, [
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
            exampleName: currentExample.value,
            environment: getActiveEnvironment(workspaceStore, doc).environment,
            workspaceStore,
            plugins: [],
            options: { customFetch: transport }
          })
        ])
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

    // `createOperation` does not rebuild navigation, so without this the new
    // request exists in `paths` and in nothing the user can see. The cached
    // sidebar state is KEPT: it reads navigation through a getter, so it picks
    // the rebuild up on its own, and keeping it is what preserves whatever the
    // user had expanded.
    workspaceStore.buildSidebar(collectionId)
    lastPlace.set(collectionId, { path: created, method: 'get' })
    select(collectionId)
  }

  /**
   * A document whose content can be fetched again.
   *
   * Used only to decide what to shed when the snapshot is too big: a document
   * built from a `specUrl` or `specPath` is re-read on open anyway, so losing
   * it costs a fetch. A hand-written one exists only in the snapshot.
   */
  const rebuildable = (slug: string): boolean => {
    const key = sources.get(slug)
    if (key === undefined) return false
    const source = JSON.parse(key) as { specUrl?: string | null; specPath?: string | null }
    return Boolean(source.specUrl || source.specPath)
  }

  // ---- environments -------------------------------------------------------
  //
  // Held on the WORKSPACE rather than on a document, which is the same choice
  // Postman makes: an environment names a deployment ("staging"), and the
  // point of one is that every collection pointed at that deployment shares
  // it. Per-document environments exist in the client too, and would mean
  // retyping the same base URL and token once per API.

  const workspaceMeta = (): Record<string, unknown> =>
    workspaceStore.workspace as unknown as Record<string, unknown>

  const environmentsRaw = (): Record<string, { variables?: { name: string; value: unknown }[] }> =>
    (workspaceMeta()['x-scalar-environments'] as Record<
      string,
      { variables?: { name: string; value: unknown }[] }
    >) ?? {}

  const environments = (): EnvironmentsView => {
    const all = environmentsRaw()
    const names = Object.keys(all)
    const active = String(workspaceMeta()['x-scalar-active-environment'] ?? '')
    // An active environment that has been deleted falls back to the first
    // rather than leaving the panel pointed at nothing.
    const resolved = names.includes(active) ? active : (names[0] ?? '')
    return {
      names,
      active: resolved,
      variables: (all[resolved]?.variables ?? []).map((v) => ({
        name: v.name,
        value: valueOf(v.value)
      }))
    }
  }

  const setActiveEnvironment = (name: string): void => {
    workspaceStore.update('x-scalar-active-environment', name)
    onChanged()
  }

  const createEnvironment = (name: string): void => {
    mutators.workspace().environment.upsertEnvironment({
      environmentName: name,
      // A colour is required by the schema and means nothing to OpsMaxx, which
      // themes its own chrome. The client uses it to tint its own controls.
      payload: { color: '#8ab4f8', variables: [] }
    })
    setActiveEnvironment(name)
  }

  const deleteEnvironment = (name: string): void => {
    mutators.workspace().environment.deleteEnvironment({ environmentName: name })
    onChanged()
  }

  const setVariable = (environmentName: string, variable: EnvVariable, index?: number): void => {
    mutators.workspace().environment.upsertEnvironmentVariable({
      environmentName,
      variable: { name: variable.name, value: variable.value },
      ...(index === undefined ? {} : { index })
    })
    onChanged()
  }

  const deleteVariable = (environmentName: string, index: number): void => {
    mutators.workspace().environment.deleteEnvironmentVariable({ environmentName, index })
    onChanged()
  }

  const snapshot = (): unknown =>
    toSnapshot(
      workspaceStore.exportWorkspace() as WorkspaceLike,
      Object.fromEntries(sources),
      rebuildable
    )

  return {
    sync,
    snapshot,
    select,
    addRequest,
    environments,
    setActiveEnvironment,
    createEnvironment,
    deleteEnvironment,
    setVariable,
    deleteVariable,
    unmount: () => {
      stopListening()
      app.unmount()
    }
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
      {/* The other failure this screen can fix in a click. */}
      {message === VAULT_LOCKED_MESSAGE && <UnlockVaultButton reason="Sending this request" />}
      <button className="icon-btn" title="Dismiss" onClick={onDismiss}>
        <X size={14} />
      </button>
    </div>
  )
}
