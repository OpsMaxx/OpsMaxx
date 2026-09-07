import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Loader2, X } from 'lucide-react'
import { useApp } from '../../store/app'
import { sshTargetFor } from '../../lib/ssh'
import { createHttpTransport, type HttpTransportOptions } from '../../lib/httpTransport'
import { useResolvedTheme } from '../../hooks/useResolvedTheme'
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
  const baseUrl = collection.baseUrl

  useEffect(() => {
    let disposed = false
    let app: { unmount: () => void } | null = null

    void (async () => {
      try {
        const [{ createApiClientModal }, { createWorkspaceStore }, { createWorkspaceEventBus }] =
          await Promise.all([
            import('@scalar/api-client/modal'),
            import('@scalar/workspace-store/client'),
            import('@scalar/workspace-store/events'),
            // The stylesheet rides the same dynamic import as the code, so it
            // is not in the main CSS bundle either.
            import('@scalar/api-client/style.css')
          ])
        const el = hostRef.current
        if (disposed || !el) return

        const workspaceStore = createWorkspaceStore()
        const eventBus = createWorkspaceEventBus()

        if (specUrl) {
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

        const client = createApiClientModal({
          el,
          eventBus,
          workspaceStore,
          options: {
            customFetch: createHttpTransport(() => optionsRef.current, reportRef.current),
            // A description names its own servers, and they are usually
            // production. What the toolbar shows is what gets sent.
            ...(baseUrl ? { baseServerURL: baseUrl } : {})
          }
        })
        app = client.app
        client.open(
          specUrl
            ? // 'default' is the library's own placeholder for "the caller does
              // not know a path or method"; it resolves to the first operation,
              // which is the only sensible landing point in a spec that may
              // describe hundreds.
              {
                documentSlug: collection.id,
                path: 'default',
                method: 'default' as NonNullable<Parameters<typeof client.open>[0]>['method']
              }
            : // A scratch document has exactly one operation and we wrote it, so
              // name it outright.
              { documentSlug: collection.id, path: SCRATCH_PATH, method: 'get' }
        )
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
  }, [collection.id, collection.name, specUrl, baseUrl])

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
const SCRATCH_PATH = '/'

function scratchDocument(title: string, baseUrl: string): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: { title, version: '1.0.0' },
    ...(baseUrl ? { servers: [{ url: baseUrl }] } : {}),
    paths: {
      [SCRATCH_PATH]: {
        get: {
          operationId: 'request',
          summary: 'New request',
          responses: { '200': { description: 'OK' } }
        }
      }
    }
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
