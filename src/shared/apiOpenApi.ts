/**
 * A parsed OpenAPI 3 document, converted into collection items.
 *
 * `$ref`s are followed only when they are internal (`#/...`), one pointer at a
 * time, as each operation is converted. Nothing here fetches or reads: an
 * external reference simply does not resolve, and `parseOpenApi` has already
 * counted it for the report. See openapiImport.ts for why.
 *
 * Ids are deterministic (`stableId`) from the operation and `idSeed`, so two
 * independent conversions of the same spec for the same collection are
 * deep-equal. Migration depends on that (ARCH-B6), and so does re-import.
 */

import {
  stableId,
  type Body,
  type Folder,
  type HttpRequest,
  type Id,
  type Item,
  type MultipartRow,
  type Row
} from './apiModel'

/** Deliberately loose: the importer validates what it reads, field by field. */
export interface OpenApi3Doc {
  openapi: string
  servers?: { url: string; description?: string }[]
  paths?: Record<string, unknown>
  tags?: { name: string; description?: string }[]
  components?: Record<string, unknown>
  [key: string]: unknown
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const

/** How deep the example walk goes into a schema. */
const MAX_EXAMPLE_DEPTH = 8
/** Roughly how much example text one body may generate. */
const MAX_EXAMPLE_BYTES = 4 * 1024 * 1024

/** The node an internal JSON pointer names, or undefined. Own properties only. */
function pointer(doc: OpenApi3Doc, ref: string): unknown {
  if (ref === '#') return doc
  if (!ref.startsWith('#/')) return undefined
  let node: unknown = doc
  for (const raw of ref.slice(2).split('/')) {
    let seg: string
    try {
      seg = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~')
    } catch {
      return undefined
    }
    if (Array.isArray(node)) node = node[Number(seg)]
    else if (isObj(node) && Object.hasOwn(node, seg)) node = node[seg]
    else return undefined
  }
  return node
}

/** `value` with its `$ref` chain followed, internal only, at most 20 hops. */
function deref(doc: OpenApi3Doc, value: unknown): unknown {
  let node = value
  for (let hops = 0; hops < 20 && isObj(node) && typeof node.$ref === 'string'; hops++) {
    node = pointer(doc, node.$ref)
  }
  return isObj(node) && typeof node.$ref === 'string' ? undefined : node
}

interface Budget {
  bytes: number
}

/**
 * An example value for a schema. Cycle-guarded by the schemas on the current
 * path (a sibling reusing a schema still renders), depth-capped, and stopped
 * by the byte budget, because a wide schema nested eight deep is otherwise a
 * few lines of spec that expand to more memory than main has.
 */
function exampleFor(doc: OpenApi3Doc, schemaIn: unknown, depth: number, path: WeakSet<object>, budget: Budget): unknown {
  if (depth > MAX_EXAMPLE_DEPTH || budget.bytes <= 0) return undefined
  const schema = deref(doc, schemaIn)
  if (!isObj(schema) || path.has(schema)) return undefined
  budget.bytes -= 16
  if (schema.example !== undefined) return schema.example
  if (schema.default !== undefined) return schema.default
  if (schema.const !== undefined) return schema.const
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0]
  if (Array.isArray(schema.examples) && schema.examples.length > 0) return schema.examples[0]

  path.add(schema)
  try {
    for (const key of ['allOf', 'oneOf', 'anyOf'] as const) {
      const parts = schema[key]
      if (!Array.isArray(parts) || parts.length === 0) continue
      if (key !== 'allOf') return exampleFor(doc, parts[0], depth + 1, path, budget)
      const merged: Obj = {}
      for (const part of parts) {
        const v = exampleFor(doc, part, depth + 1, path, budget)
        if (isObj(v)) Object.assign(merged, v)
      }
      return merged
    }
    const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== 'null') : schema.type
    if (type === 'object' || isObj(schema.properties)) {
      const out: Obj = {}
      for (const [name, prop] of Object.entries(isObj(schema.properties) ? schema.properties : {})) {
        if (budget.bytes <= 0) break
        budget.bytes -= name.length
        const v = exampleFor(doc, prop, depth + 1, path, budget)
        if (v !== undefined) Object.defineProperty(out, name, { value: v, enumerable: true, writable: true, configurable: true })
      }
      return out
    }
    if (type === 'array') {
      const item = exampleFor(doc, schema.items, depth + 1, path, budget)
      return item === undefined ? [] : [item]
    }
    if (type === 'integer' || type === 'number') return 0
    if (type === 'boolean') return true
    if (type === 'string') {
      if (schema.format === 'date-time') return '1970-01-01T00:00:00Z'
      if (schema.format === 'date') return '1970-01-01'
      if (schema.format === 'uuid') return '00000000-0000-0000-0000-000000000000'
      return 'string'
    }
    return undefined
  } finally {
    path.delete(schema)
  }
}

/** Text for a value: strings as they are, anything else as JSON. Never throws. */
function textOf(v: unknown, pretty = false): string {
  if (v === undefined || v === null) return ''
  if (typeof v === 'string') return v
  try {
    const s = JSON.stringify(v, null, pretty ? 2 : undefined) ?? ''
    return s.length > MAX_EXAMPLE_BYTES ? '' : s
  } catch {
    // An example built from YAML anchors can refer to itself.
    return ''
  }
}

function firstExample(doc: OpenApi3Doc, holder: Obj): unknown {
  if (holder.example !== undefined) return holder.example
  if (isObj(holder.examples)) {
    for (const ex of Object.values(holder.examples)) {
      const resolved = deref(doc, ex)
      if (isObj(resolved) && resolved.value !== undefined) return resolved.value
    }
  }
  return undefined
}

function paramValue(doc: OpenApi3Doc, param: Obj): string {
  const direct = firstExample(doc, param)
  if (direct !== undefined) return textOf(direct)
  return textOf(exampleFor(doc, param.schema, 0, new WeakSet(), { bytes: 64 * 1024 }))
}

// OpenAPI says a header parameter with one of these names is ignored: they
// are described by the body, the responses and `security` instead.
const IGNORED_HEADER_PARAMS = new Set(['accept', 'content-type', 'authorization'])

function bodyFor(doc: OpenApi3Doc, requestBody: unknown, rowId: (section: string, i: number) => Id): Body {
  const rb = deref(doc, requestBody)
  if (!isObj(rb) || !isObj(rb.content)) return { mode: 'none' }
  const types = Object.keys(rb.content)
  const pick =
    types.find((t) => /^application\/json\b|\+json\b/i.test(t)) ??
    types.find((t) => /x-www-form-urlencoded/i.test(t)) ??
    types.find((t) => /multipart\/form-data/i.test(t)) ??
    types.find((t) => /xml/i.test(t)) ??
    types.find((t) => /^text\//i.test(t)) ??
    types[0]
  if (pick === undefined) return { mode: 'none' }
  const media = deref(doc, rb.content[pick])
  if (!isObj(media)) return { mode: 'none' }
  const budget = { bytes: MAX_EXAMPLE_BYTES }
  const example = firstExample(doc, media) ?? exampleFor(doc, media.schema, 0, new WeakSet(), budget)

  if (/json/i.test(pick)) return { mode: 'json', text: textOf(example, true) }
  if (/xml/i.test(pick)) return { mode: 'xml', text: typeof example === 'string' ? example : '' }
  if (/^text\//i.test(pick)) return { mode: 'text', text: typeof example === 'string' ? example : '' }

  const form = /x-www-form-urlencoded|multipart\/form-data/i.test(pick)
  if (!form) return { mode: 'binary' }
  const schema = deref(doc, media.schema)
  const props = isObj(schema) && isObj(schema.properties) ? schema.properties : {}
  const values = isObj(example) ? example : {}
  const multipart = /multipart/i.test(pick)
  const rows = Object.entries(props).map(([key, propIn], i): MultipartRow => {
    const prop = deref(doc, propIn)
    const file = isObj(prop) && (prop.format === 'binary' || prop.format === 'base64')
    return {
      id: rowId('body', i),
      enabled: true,
      key,
      value: file ? '' : textOf(Object.hasOwn(values, key) ? values[key] : undefined),
      kind: multipart && file ? 'file' : 'text'
    }
  })
  return multipart
    ? { mode: 'multipart', rows }
    : { mode: 'urlencoded', rows: rows.map(({ kind: _kind, ...row }) => row) }
}

/** `servers[0].url` when it is absolute http(s); null when relative or absent. */
function baseUrlOf(doc: OpenApi3Doc): string | null {
  const first = Array.isArray(doc.servers) ? doc.servers[0] : undefined
  const url = isObj(first) && typeof first.url === 'string' ? first.url.trim() : ''
  return /^https?:\/\//i.test(url) ? url.replace(/\/+$/, '') : null
}

export function requestsFromOpenApi(
  doc: OpenApi3Doc,
  /** Makes ids unique per collection: pass the collection id. */
  opts: { idSeed?: string } = {}
): {
  items: Item[]
  baseUrl: string | null
  skipped: { method: string; path: string; reason: string }[]
} {
  const seed = opts.idSeed ?? ''
  const skipped: { method: string; path: string; reason: string }[] = []
  const top: Item[] = []
  const folders = new Map<string, Folder>()
  // Folders in the order `tags` declares them, then in order of first use.
  const declared = Array.isArray(doc.tags) ? doc.tags : []
  for (const t of declared) {
    if (isObj(t) && typeof t.name === 'string' && !folders.has(t.name)) {
      folders.set(t.name, { kind: 'folder', id: stableId('fld', seed, t.name), name: t.name.slice(0, 200), items: [] })
    }
  }
  const occurrences = new Map<string, number>()

  for (const [path, itemIn] of Object.entries(isObj(doc.paths) ? doc.paths : {})) {
    const pathItem = deref(doc, itemIn)
    if (!isObj(pathItem)) {
      skipped.push({ method: '*', path, reason: 'The path item is an external reference, or not an object.' })
      continue
    }
    const shared = Array.isArray(pathItem.parameters) ? pathItem.parameters : []
    for (const method of METHODS) {
      if (!Object.hasOwn(pathItem, method)) continue
      const op = deref(doc, pathItem[method])
      const METHOD = method.toUpperCase()
      if (!isObj(op)) {
        skipped.push({ method: METHOD, path, reason: 'The operation is not an object.' })
        continue
      }
      const key = `${METHOD} ${path}`
      const occurrence = occurrences.get(key) ?? 0
      occurrences.set(key, occurrence + 1)
      const id = stableId('req', seed, METHOD, path, String(occurrence))
      const rowId = (section: string, i: number): Id => stableId('row', id, section, String(i))

      // Operation parameters override path-level ones by (in, name).
      const params = new Map<string, Obj>()
      for (const p of [...shared, ...(Array.isArray(op.parameters) ? op.parameters : [])]) {
        const resolved = deref(doc, p)
        if (isObj(resolved) && typeof resolved.name === 'string' && typeof resolved.in === 'string') {
          params.set(`${resolved.in}:${resolved.name}`, resolved)
        }
      }
      const query: Row[] = []
      const pathParams: Row[] = []
      const headers: Row[] = []
      for (const p of params.values()) {
        const name = p.name as string
        const row = (section: string, list: Row[], enabled: boolean): void => {
          list.push({ id: rowId(section, list.length), enabled, key: name, value: paramValue(doc, p) })
        }
        if (p.in === 'query') row('params', query, p.required === true)
        else if (p.in === 'path') row('pathParams', pathParams, true)
        else if (p.in === 'header' && !IGNORED_HEADER_PARAMS.has(name.toLowerCase())) {
          row('headers', headers, p.required === true)
        }
      }
      const enabledQuery = query.filter((r) => r.enabled)
      const search = enabledQuery.length
        ? `?${enabledQuery.map((r) => `${encodeURIComponent(r.key)}=${encodeURIComponent(r.value)}`).join('&')}`
        : ''
      const summary = typeof op.summary === 'string' && op.summary.trim() ? op.summary.trim() : ''
      const operationId = typeof op.operationId === 'string' ? op.operationId : ''
      const request: HttpRequest = {
        id,
        kind: 'http',
        name: (summary || operationId || key).slice(0, 200),
        url: `{{baseUrl}}${path}${search}`,
        method: METHOD,
        headers,
        params: query,
        pathParams,
        auth: { type: 'inherit' },
        body: bodyFor(doc, op.requestBody, rowId),
        settings: { followRedirects: true, maxRedirects: 5 },
        ...(typeof op.description === 'string' && op.description ? { description: op.description } : {})
      }

      const tag = Array.isArray(op.tags) && typeof op.tags[0] === 'string' ? op.tags[0] : null
      if (tag === null) {
        top.push(request)
        continue
      }
      let folder = folders.get(tag)
      if (!folder) {
        folder = { kind: 'folder', id: stableId('fld', seed, tag), name: tag.slice(0, 200), items: [] }
        folders.set(tag, folder)
      }
      folder.items.push(request)
    }
  }

  const used = [...folders.values()].filter((f) => f.items.length > 0)
  return { items: [...used, ...top], baseUrl: baseUrlOf(doc), skipped }
}
