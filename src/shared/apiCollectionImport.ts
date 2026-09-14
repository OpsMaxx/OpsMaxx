/**
 * A saved API, as the OpenAPI document the client actually drives.
 *
 * ── Why this replaces `apiScratch` ─────────────────────────────────────────
 *
 * The old module built a SYNTHETIC document for a collection with no
 * description: one path, with all seven methods stubbed on it. The stubbing
 * existed for one reason, stated in its own comment — the client took its
 * method from the OPERATION rather than from a control, so a document defining
 * only `get` left the method beside the address bar a label instead of a
 * choice.
 *
 * That is no longer true. The client is mounted with `layout: 'web'`, which is
 * what makes the method an editable control (the modal layout is what made it
 * a label; see the note in the client pane). So a path needs exactly the
 * operations the user actually defined, and six unused stubs per path were
 * only ever a workaround for a wrapper that is gone.
 *
 * What is left is a straight conversion: the collection's own endpoints become
 * the document's paths, once, on the way in. After that the document is the
 * source of truth and `ApiCollection.endpoints` is never read again.
 */

/** One hand-written request, as `ApiCollection.endpoints` stores it. */
export interface ApiEndpointInput {
  method: string
  path: string
  summary?: string
}

export interface ApiCollectionInput {
  name: string
  baseUrl: string
  endpoints?: readonly ApiEndpointInput[]
}

/**
 * A path as the document will hold it.
 *
 * Endpoints are normalised when typed, but one restored from a backup or
 * edited by hand can hold `v1/users` — and a document containing `/v1/users`
 * while the client is told to open `v1/users` names an operation that does not
 * exist, which renders as a blank pane rather than as an error.
 */
export function apiPathOf(raw: string): string {
  const t = raw.trim()
  return t.startsWith('/') ? t : `/${t}`
}

/**
 * The path half of a collection's base URL.
 *
 * Someone adding a collection pastes the URL they were going to curl, and that
 * URL usually carries a path. `http://host:9090/metrics` has to open ON
 * /metrics — dropping the path sends the first request somewhere the user
 * never asked for, and the 404 that comes back looks like the service is
 * broken.
 */
export function basePathOf(baseUrl: string): string {
  try {
    const path = new URL(baseUrl).pathname
    return path && path !== '/' ? path : '/'
  } catch {
    return '/'
  }
}

/** The origin alone, for when the path is carried by an operation instead. */
export function baseOriginOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).origin
  } catch {
    return baseUrl
  }
}

/**
 * An operationId that is stable for the same request and unique within the
 * document. Stable matters because it is what history and tabs key on: one
 * derived from a counter would re-point every saved reference the moment an
 * endpoint above it was deleted.
 */
function operationIdFor(method: string, path: string): string {
  const slug = path.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase()
  return `${method.toLowerCase()}-${slug || 'root'}`
}

function operationFor(method: string, path: string, summary?: string): Record<string, unknown> {
  return {
    operationId: operationIdFor(method, path),
    summary: summary?.trim() || `${method.toUpperCase()} ${path}`,
    responses: { '200': { description: 'OK' } }
  }
}

/**
 * The document for a collection that imports no description.
 *
 * Two shapes, because a collection with endpoints and one without are
 * genuinely different starting points:
 *
 *   - **With endpoints**, the server is the base URL *including its own path*
 *     — someone who put `/api` in the base meant it to apply to every request
 *     — and each endpoint is a path beneath it.
 *   - **Without**, there is nothing to list, so the base URL is split: its
 *     origin becomes the server and its path becomes the one operation. That
 *     is what makes a brand-new collection land on something sendable instead
 *     of on an empty screen.
 */
export function documentForCollection(collection: ApiCollectionInput): Record<string, unknown> {
  const { name, baseUrl } = collection
  const endpoints = collection.endpoints ?? []
  const paths: Record<string, Record<string, unknown>> = {}

  if (endpoints.length === 0) {
    const path = basePathOf(baseUrl)
    paths[path] = { get: operationFor('get', path) }
    return document(name, baseOriginOf(baseUrl), paths)
  }

  for (const endpoint of endpoints) {
    const path = apiPathOf(endpoint.path)
    const method = endpoint.method.toLowerCase()
    // Two endpoints may share a path with different methods, which is exactly
    // what an OpenAPI path item is: a path holding one operation per method.
    const item = paths[path] ?? (paths[path] = {})
    item[method] = operationFor(method, path, endpoint.summary)
  }
  return document(name, baseUrl, paths)
}

function document(
  title: string,
  server: string,
  paths: Record<string, Record<string, unknown>>
): Record<string, unknown> {
  return {
    openapi: '3.1.1',
    info: { title, version: '1.0.0' },
    ...(server ? { servers: [{ url: server }] } : {}),
    paths
  }
}

/**
 * The first operation in a document, as `{path, method}`.
 *
 * Where a collection lands when it is opened. `Object.entries` order is
 * insertion order for string keys, which is the order the endpoints were
 * written — so this is "the first one the user defined" rather than an
 * arbitrary pick.
 */
export function firstOperationOf(
  doc: Record<string, unknown>
): { path: string; method: string } | null {
  const paths = doc.paths as Record<string, Record<string, unknown>> | undefined
  for (const [path, item] of Object.entries(paths ?? {})) {
    for (const method of Object.keys(item ?? {})) {
      if (METHODS.has(method.toLowerCase())) return { path, method: method.toLowerCase() }
    }
  }
  return null
}

/**
 * Keys of a path item that are operations. A path item also legally carries
 * `summary`, `description`, `servers` and `parameters`, and treating one of
 * those as an operation lands the client on something it cannot send.
 */
const METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'])
