/**
 * GraphQL over HTTP, in the only two places it differs from a POST.
 *
 * The API client this app embeds has no GraphQL support at all — not a gap in
 * how it is wired up, there is nothing in the package. What GraphQL actually
 * needs beyond "POST some JSON" is small, and both halves are here because
 * both are easy to get subtly wrong:
 *
 *   - The request body has a fixed shape, and `variables` is typed by the
 *     server. Sending `"{}"` as a string where an object is expected is the
 *     most common way a query fails for a reason the error does not explain.
 *   - **A GraphQL error arrives with HTTP 200.** A generic HTTP client shows a
 *     green 200 and a body the user has to read to discover the request
 *     failed. Treating `errors` as the answer is the single thing that makes a
 *     GraphQL client feel like one.
 */

export interface GraphQlRequest {
  query: string
  /** Parsed from the variables editor. Absent when the editor is empty. */
  variables?: Record<string, unknown>
  /** Needed when the document defines more than one operation. */
  operationName?: string
}

export interface GraphQlError {
  message: string
  path?: (string | number)[]
  locations?: { line: number; column: number }[]
  extensions?: Record<string, unknown>
}

export interface GraphQlResponse {
  data?: unknown
  errors?: GraphQlError[]
}

/** Whether the editor's variables text is usable, and what it parsed to. */
export type VariablesResult =
  | { ok: true; variables?: Record<string, unknown> }
  | { ok: false; error: string }

/**
 * The variables editor's contents, as the body will carry them.
 *
 * Empty means absent rather than `{}` — some servers reject a `variables` key
 * that is present but empty on a query taking none.
 *
 * A top-level array or scalar is refused with a reason. GraphQL requires a map
 * of variable names, and sending `[1,2]` produces a server error that talks
 * about the query rather than about the thing that is actually wrong.
 */
export function parseVariables(text: string): VariablesResult {
  const trimmed = text.trim()
  if (trimmed === '') return { ok: true }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'Variables must be a JSON object, like { "id": 1 }.' }
  }
  return { ok: true, variables: parsed as Record<string, unknown> }
}

/** The request body, as JSON text. */
export function buildGraphQlBody(request: GraphQlRequest): string {
  return JSON.stringify({
    query: request.query,
    ...(request.variables ? { variables: request.variables } : {}),
    ...(request.operationName ? { operationName: request.operationName } : {})
  })
}

/**
 * What came back, and whether it counts as a success.
 *
 * `ok` is deliberately NOT the HTTP status. A 200 carrying `errors` is a
 * failed query, and showing it as green is the mistake this function exists to
 * prevent. A 200 carrying both `data` and `errors` is a partial success, which
 * GraphQL allows — it is reported as failed, because the errors are the part
 * that needs attention and `data` is still rendered alongside them.
 */
export function readGraphQlResponse(
  status: number,
  text: string
): { ok: boolean; response?: GraphQlResponse; parseError?: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // A GraphQL endpoint that answered with something that is not JSON is
    // usually an HTML error page from a proxy in front of it. Say so rather
    // than reporting a parse failure as a query failure.
    return {
      ok: false,
      parseError:
        status >= 200 && status < 300
          ? 'The endpoint answered with something that is not JSON. It may not be a GraphQL endpoint.'
          : `The endpoint answered ${status} with something that is not JSON.`
    }
  }

  // `Array.isArray` explicitly: an array is `typeof 'object'`, so a body of
  // `[1,2]` would otherwise be accepted as a response with neither `data` nor
  // `errors` and reported as a clean success.
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, parseError: 'A GraphQL response is a JSON object.' }
  }

  const response = parsed as GraphQlResponse
  const failed = Array.isArray(response.errors) && response.errors.length > 0
  return { ok: status >= 200 && status < 300 && !failed, response }
}

/**
 * The introspection query, as a constant.
 *
 * A constant rather than the `graphql` package: this is the only thing that
 * would need it, the query is static, and a parser is a megabyte of dependency
 * for a string. The trade is that there is no schema-aware autocomplete —
 * that genuinely does need a parser and a second editor stack, and it is not
 * pretended at here.
 *
 * Deliberately shallow on nested types (`ofType` three deep): that covers
 * `[Thing!]!`, which is as nested as a real field type gets, and a fully
 * recursive introspection on a large schema is megabytes of response.
 */
export const INTROSPECTION_QUERY = `query OpsMaxxIntrospection {
  __schema {
    queryType { name }
    mutationType { name }
    subscriptionType { name }
    types {
      kind
      name
      description
      fields(includeDeprecated: false) {
        name
        description
        args { name type { ...TypeRef } }
        type { ...TypeRef }
      }
    }
  }
}

fragment TypeRef on __Type {
  kind
  name
  ofType { kind name ofType { kind name ofType { kind name } } }
}`

export interface SchemaType {
  kind: string
  name?: string
  description?: string
  fields?: { name: string; description?: string; type?: TypeRef }[]
}

export interface TypeRef {
  kind: string
  name?: string
  ofType?: TypeRef
}

/**
 * A field type as it is written in a schema: `[Thing!]!` rather than a nest of
 * NON_NULL and LIST wrappers.
 */
export function renderTypeRef(ref: TypeRef | undefined): string {
  if (!ref) return ''
  if (ref.kind === 'NON_NULL') return `${renderTypeRef(ref.ofType)}!`
  if (ref.kind === 'LIST') return `[${renderTypeRef(ref.ofType)}]`
  return ref.name ?? ''
}

/**
 * The types worth showing, with the introspection machinery filtered out.
 *
 * Every schema carries a few dozen `__`-prefixed types describing
 * introspection itself, plus the built-in scalars. Listing them buries the
 * handful of types somebody actually wants to read.
 */
export function usefulTypes(types: readonly SchemaType[]): SchemaType[] {
  const builtin = new Set(['String', 'Int', 'Float', 'Boolean', 'ID'])
  return types
    .filter((t) => t.name && !t.name.startsWith('__') && !builtin.has(t.name))
    .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
}
