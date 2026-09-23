import type { Extension } from '@codemirror/state'
import { linter, type Diagnostic } from '@codemirror/lint'
import { getSchema, graphql } from 'cm6-graphql'
import {
  GraphQLError,
  buildClientSchema,
  parse,
  print,
  type GraphQLSchema,
  type IntrospectionQuery
} from 'graphql'
import { isSensitiveName, type ResponseState } from '../../../../../shared/apiModel'
import { isLiteralSecret } from '../request/AuthEditor'
import { introspectionQuery, isDepthOrComplexityError, readGraphQlResponse } from '../../../../../shared/graphql'

// The GraphQL editor's language: cm6-graphql for highlighting, completion and
// schema validation, plus `graphql`'s own parser for syntax errors when no
// schema is loaded. Everything a schema says is shown as text (SEC-M9).

/** A completion's documentation, as a text node: a schema description is the server's text. */
export function describeAsText(item: { documentation?: string; deprecationReason?: string | null }): Node | null {
  const text = item.documentation || item.deprecationReason || ''
  if (!text) return null
  const el = document.createElement('div')
  el.textContent = text
  return el
}

/** Without a schema cm6-graphql reports nothing, so syntax errors come from `parse`. */
const syntaxLint = linter((view) => {
  if (getSchema(view.state)) return []
  const text = view.state.doc.toString()
  if (text.trim() === '') return []
  try {
    parse(text)
    return []
  } catch (err) {
    if (!(err instanceof GraphQLError)) return []
    const at = err.positions?.[0] ?? 0
    const from = Math.min(at, text.length)
    return [{ from, to: Math.min(from + 1, text.length), severity: 'error', message: err.message } satisfies Diagnostic]
  }
})

/** The query editor's extensions. The schema is swapped later with cm6-graphql's `updateSchema`. */
export function gqlExtensions(schema?: GraphQLSchema): Extension[] {
  return [
    graphql(schema, { onCompletionInfoRender: (item) => describeAsText(item) }),
    syntaxLint
  ]
}

export interface Operation {
  name?: string
  type: 'query' | 'mutation' | 'subscription'
  from: number
  to: number
}

/** The operations a document defines, or none when it does not parse. */
export function operationsIn(query: string): Operation[] {
  try {
    return parse(query).definitions.flatMap((d) =>
      d.kind === 'OperationDefinition'
        ? [{ name: d.name?.value, type: d.operation, from: d.loc?.start ?? 0, to: d.loc?.end ?? query.length }]
        : []
    )
  } catch {
    return []
  }
}

/** The operation under the cursor: the one containing it, else the one before it, else the first. */
export function operationAt(ops: Operation[], offset: number): Operation | undefined {
  return ops.find((o) => offset >= o.from && offset <= o.to) ?? [...ops].reverse().find((o) => o.to <= offset) ?? ops[0]
}

/** Prettify, or null when the query does not parse. Comments are not kept: `print` drops them. */
export function prettify(query: string): string | null {
  try {
    return print(parse(query))
  } catch {
    return null
  }
}

export type IntrospectResult =
  | { ok: true; status: number; text: string }
  | { ok: false; message: string }

/**
 * Introspects through `run`, and retries once without descriptions and
 * deprecated fields when the server refuses the first for depth or complexity.
 * Throws with the reason on failure, which the schema store keeps beside the
 * previous schema rather than in place of it.
 */
export async function loadSchema(
  run: (query: string) => Promise<IntrospectResult>
): Promise<GraphQLSchema | { schema: GraphQLSchema; note: string }> {
  let depth = 4
  const attempt = async (lean: boolean): Promise<GraphQLSchema | 'too-big'> => {
    const result = await run(introspectionQuery({ lean, depth }))
    if (!result.ok) throw new Error(result.message)
    const read = readGraphQlResponse(result.status, result.text)
    if (read.parseError) throw new Error(read.parseError)
    const errors = read.response?.errors
    if (errors?.length) {
      if (!lean && isDepthOrComplexityError(errors)) return 'too-big'
      throw new Error(`The server refused introspection: ${errors[0].message}`)
    }
    const data = read.response?.data as IntrospectionQuery | undefined
    if (!data?.__schema) throw new Error('The response has no __schema: introspection may be turned off on this server.')
    try {
      return buildClientSchema(data)
    } catch (err) {
      // A field type nested past four `ofType`s. Rare enough not to make every
      // schema pay for it; asked for again, once, at graphql's own depth.
      if (depth > 4 || !/deeper than introspection/i.test(String(err))) throw err
      depth = 8
      return attempt(lean)
    }
  }
  const full = await attempt(false)
  if (full !== 'too-big') return full
  const lean = (await attempt(true)) as GraphQLSchema
  return { schema: lean, note: 'Loaded without descriptions or deprecated fields: the server refused the full query for its depth or complexity.' }
}

const STRIP_MAX_BYTES = 2 * 1024 * 1024

/**
 * "2 errors · first: …" for a GraphQL response. It arrives as HTTP 200, so the
 * status row stays green; this is what says the query failed.
 */
export function errorsStrip(res: ResponseState | undefined): string | null {
  if (res?.status !== 'done' || res.response.body.byteLength > STRIP_MAX_BYTES) return null
  const read = readGraphQlResponse(res.response.status, new TextDecoder().decode(res.response.body))
  const errors = read.response?.errors
  if (!Array.isArray(errors) || errors.length === 0) return null
  const first = typeof errors[0]?.message === 'string' ? errors[0].message : 'no message'
  return `${errors.length} error${errors.length === 1 ? '' : 's'} · first: ${first}`
}

/**
 * Keys in a JSON document whose name is sensitive and whose value is a literal
 * rather than a `{{variable}}` or vault reference, at any depth (§3.5: kept on
 * save, with this warning). Text that is not JSON yet has none.
 */
export function literalSecretsIn(json: string): { key: string; value: string }[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return []
  }
  const found: { key: string; value: string }[] = []
  const walk = (v: unknown, depth: number): void => {
    if (depth > 16 || v === null || typeof v !== 'object') return
    for (const [key, child] of Object.entries(v)) {
      if (typeof child === 'string' && isSensitiveName(key) && isLiteralSecret(child)) found.push({ key, value: child })
      else walk(child, depth + 1)
    }
  }
  walk(parsed, 0)
  return found
}
