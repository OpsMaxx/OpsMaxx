/** One hand-written request. Structurally the renderer's ApiEndpoint. */
export interface ApiEndpoint {
  method: string
  path: string
  summary?: string
}

/**
 * The methods a brand-new scratch collection stubs.
 *
 * The client takes its method from the OPERATION rather than from a control of
 * its own, so a document defining only `get` leaves the method beside the
 * address bar a label instead of a choice. Stubbing all seven is what makes a
 * collection with no endpoints yet usable at all.
 */
const SCRATCH_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const

/**
 * The OpenAPI document a collection builds when it imports none.
 *
 * Pure, and in shared/ rather than beside the component, because this is the
 * piece that decides what the HTTP client can DO — and the component it used
 * to live in pulls in Scalar and Vue, so nothing about it could be tested
 * without mounting an API client.
 *
 * ── Why a document at all ──────────────────────────────────────────────────
 *
 * The client is spec-driven: it renders operations from an OpenAPI document
 * and sends them through a transport that knows about SSH forwarding, VPN
 * routing and per-collection TLS. A collection with no description used to get
 * a synthetic one — a single path off the base URL with all seven methods
 * stubbed — and nothing ever wrote paths back into it. So there was no way to
 * name a second path, and therefore no way to add an endpoint, remove one, or
 * craft a request against a service that publishes no description.
 *
 * Building the document from user-defined endpoints fixes all of that in one
 * place, and keeps hand-written requests on the same Send button and the same
 * transport as imported ones. A separate request builder would have had to
 * re-earn the routing that is the whole reason this client lives in OpsMaxx.
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
export function scratchPathOf(baseUrl: string): string {
  try {
    const path = new URL(baseUrl).pathname
    return path && path !== '/' ? path : '/'
  } catch {
    return '/'
  }
}

/** The origin, since the path is carried by the operation instead. */
export function scratchOriginOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).origin
  } catch {
    return baseUrl
  }
}

/**
 * The document a collection with no description gets.
 *
 * Built from the endpoints the user wrote, and falling back to the old
 * behaviour — one path, all seven methods — only for a collection that has
 * none yet. That fallback is what makes a brand-new scratch collection usable
 * the moment it is created rather than an empty screen with no obvious next
 * step; as soon as one endpoint exists, the list IS the document.
 */
export function scratchDocument(
  title: string,
  baseUrl: string,
  endpoints: readonly ApiEndpoint[] = []
): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {}

  if (endpoints.length === 0) {
    const path = scratchPathOf(baseUrl)
    const operations: Record<string, unknown> = {}
    for (const method of SCRATCH_METHODS) {
      operations[method] = operationFor(method, `${method.toUpperCase()} ${path}`)
    }
    paths[path] = operations
  } else {
    for (const e of endpoints) {
      // Two endpoints may share a path with different methods, which is what
      // an OpenAPI path item is: a path, holding one operation per method.
      const path = e.path.startsWith('/') ? e.path : `/${e.path}`
      const item = paths[path] ?? (paths[path] = {})
      item[e.method] = operationFor(e.method, e.summary?.trim() || `${e.method.toUpperCase()} ${path}`)
    }
  }

  return {
    openapi: '3.1.0',
    info: { title, version: '1.0.0' },
    ...(baseUrl ? { servers: [{ url: scratchOriginOf(baseUrl) }] } : {}),
    paths
  }
}

/** One operation, shaped the way the client expects. */
function operationFor(method: string, summary: string): Record<string, unknown> {
  return {
    operationId: `${method}-${summary.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()}`,
    summary,
    // A body only where one is meaningful. Offering it on GET is how a client
    // ends up sending one, which some servers reject outright.
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

