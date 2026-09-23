/**
 * The one-time conversion of `apiCollections` v1 and the `apiWorkspace` v1
 * snapshot into the v2 model.
 *
 * Pure: no network and no filesystem. Deterministic: ids come from `stableId`,
 * so two runs over the same input are deep-equal, and two devices upgrading
 * the same synced blob mint the same ids. Hostile input is expected: every map
 * is null-prototype, every lookup is `Object.hasOwn`, and a record whose id
 * would reach a prototype is rejected, kept in legacy, and reported.
 *
 * What was verified against the captured v0.51.3 fixtures
 * (tests/fixtures/apiWorkspace, x-scalar-keys.md) and is honoured here:
 * `x-scalar-selected-server`, `x-scalar-selected-content-type`,
 * `parameters[].examples.<name>.x-disabled`, `x-scalar-order` (top level and
 * per tag), `meta.x-scalar-environments`, `meta.x-scalar-active-environment`.
 * Edited example values need nothing: they are plain OpenAPI `examples`, which
 * the converter already reads.
 */

import {
  isValidId,
  MAX_COLLECTIONS_BYTES,
  stableId,
  type ApiCollectionV2,
  type ApiWorkspaceV2,
  type Environment,
  type Folder,
  type HostColor,
  type HttpRequest,
  type Id,
  type Item,
  type Variable
} from './apiModel'
import { requestsFromOpenApi, type OpenApi3Doc } from './apiOpenApi'
import { maskUserinfo, withoutCredentials, withParams } from './apiUrl'

export interface MigrationReport {
  id: string
  collections: number
  requests: number
  environments: number
  needsReimport: { id: Id; name: string }[]
  dropped: ('cookies' | 'proxy' | 'tabs' | 'auth')[]
  rejected: { kind: 'collection' | 'workspace' | 'environment'; id: string; reason: string }[]
  baseUrlCollisions: { collectionId: Id; environment: string; value: string }[]
  shedForCap: Id[]
}

export interface MigrationCtx {
  activeWorkspaceId: Id
  /**
   * For `mergeIncoming` of a v1 blob: the workspaces its environments belong
   * to. Defaults to the active one. `migrateApiState` derives its own from the
   * collections.
   */
  workspaceIds?: Id[]
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const own = (o: Obj, k: string): unknown => (Object.hasOwn(o, k) ? o[k] : undefined)
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

/**
 * The v1 snapshot shape (`shared/apiWorkspaceSnapshot.ts`), inlined so that
 * file can go at cutover. Anything else is "no snapshot".
 */
interface SnapshotV1 {
  version: 1
  meta: unknown
  documents: Obj
  sourceKeys: Obj
  shed?: unknown
}

export function isSnapshot(value: unknown): value is SnapshotV1 {
  return isObj(value) && value.version === 1 && isObj(value.documents) && isObj(value.sourceKeys)
}

export function isWorkspaceV2(value: unknown): value is ApiWorkspaceV2 {
  return isObj(value) && value.version === 2 && Array.isArray(value.environments)
}

/**
 * The client stores a variable's value as either a string or an object with a
 * `default`. Copied from ScalarClient.tsx, which cutover deletes.
 */
function valueOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && 'default' in value) {
    return String((value as { default: unknown }).default ?? '')
  }
  return ''
}

const PROTOTYPE_NAMES = new Set(['__proto__', 'constructor', 'prototype'])
const PROD_NAME = /\bprod(uction)?\b/i

// The dark-theme `--host-*` values, which is what a v1 swatch was picked against.
const HOST_HEX: [HostColor, number, number, number][] = [
  ['blue', 0x5c, 0x96, 0xd0],
  ['violet', 0xb8, 0x77, 0xd8],
  ['pink', 0xd5, 0x70, 0xa2],
  ['jade', 0x30, 0xa4, 0x7d],
  ['rust', 0xcd, 0x7d, 0x54],
  ['olive', 0x96, 0x96, 0x2b]
]

export function nearestHostColor(color: unknown): HostColor {
  const m = typeof color === 'string' ? /^#?([0-9a-f]{6})$/i.exec(color.trim()) : null
  if (!m) return 'blue'
  const n = parseInt(m[1], 16)
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  let best = HOST_HEX[0]
  let bestD = Infinity
  for (const c of HOST_HEX) {
    const d = (c[1] - r) ** 2 + (c[2] - g) ** 2 + (c[3] - b) ** 2
    if (d < bestD) [best, bestD] = [c, d]
  }
  return best[0]
}

/** `https://u:p@h/` → `https://h/`. */
function withoutUserinfo(url: string): string {
  return maskUserinfo(url, '')
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

function sizeOf(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

/** Deletes `x-scalar-cookies` and `x-scalar-active-proxy`, at any depth. */
export function scrubLegacy(v1: unknown): unknown {
  if (v1 === undefined || v1 === null) return null
  try {
    return JSON.parse(
      JSON.stringify(v1, (key, value) =>
        key === 'x-scalar-cookies' || key === 'x-scalar-active-proxy' ? undefined : value
      )
    ) as unknown
  } catch {
    // A cycle or a BigInt cannot have been saved by v1 in the first place.
    return null
  }
}

// ---------------------------------------------------------------- documents

const OPERATION_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']

/**
 * The document with each operation's request body narrowed to the content
 * type the user selected, so the converter builds that body. Copies only what
 * it changes.
 */
function withSelectedContentTypes(doc: Obj): Obj {
  const paths = own(doc, 'paths')
  if (!isObj(paths)) return doc
  const nextPaths: Obj = Object.create(null)
  let changed = false
  for (const [path, item] of Object.entries(paths)) {
    nextPaths[path] = item
    if (!isObj(item)) continue
    let nextItem: Obj | null = null
    for (const method of OPERATION_METHODS) {
      const op = own(item, method)
      const body = isObj(op) ? own(op, 'requestBody') : undefined
      const selected = isObj(body) ? own(body, 'x-scalar-selected-content-type') : undefined
      const content = isObj(body) ? own(body, 'content') : undefined
      if (!isObj(selected) || !isObj(content)) continue
      const type = str(own(selected, 'default')) ?? str(Object.values(selected)[0])
      if (!type || !Object.hasOwn(content, type)) continue
      nextItem ??= { ...item }
      nextItem[method] = { ...(op as Obj), requestBody: { ...(body as Obj), content: { [type]: content[type] } } }
    }
    if (nextItem) {
      nextPaths[path] = nextItem
      changed = true
    }
  }
  return changed ? { ...doc, paths: nextPaths } : doc
}

/** `x-disabled` for a parameter, from its `default` example or the first that says. */
function disabledOf(param: Obj): boolean | undefined {
  const examples = own(param, 'examples')
  if (!isObj(examples)) return undefined
  const ordered = [own(examples, 'default'), ...Object.values(examples)]
  for (const ex of ordered) {
    const flag = isObj(ex) ? own(ex, 'x-disabled') : undefined
    if (typeof flag === 'boolean') return flag
  }
  return undefined
}

/** Every operation in the document, by the id the converter gives its request. */
function operationsById(doc: Obj, seed: Id): Map<Id, { method: string; path: string; op: Obj }> {
  const out = new Map<Id, { method: string; path: string; op: Obj }>()
  const paths = own(doc, 'paths')
  if (!isObj(paths)) return out
  for (const [path, item] of Object.entries(paths)) {
    if (!isObj(item)) continue
    for (const method of OPERATION_METHODS) {
      const op = own(item, method)
      if (isObj(op)) out.set(stableId('req', seed, method.toUpperCase(), path, '0'), { method: method.toUpperCase(), path, op })
    }
  }
  return out
}

/** Applies `x-disabled` to each parameter row the converter made. */
function overlayDisabled(req: HttpRequest, op: Obj): HttpRequest {
  const params = own(op, 'parameters')
  if (!Array.isArray(params)) return req
  let next = req
  for (const p of params) {
    if (!isObj(p)) continue
    const disabled = disabledOf(p)
    const name = str(own(p, 'name'))
    const where = own(p, 'in')
    if (disabled === undefined || !name) continue
    const section = where === 'query' ? 'params' : where === 'header' ? 'headers' : null
    if (!section) continue
    next = { ...next, [section]: next[section].map((r) => (r.key === name ? { ...r, enabled: !disabled } : r)) }
  }
  return next === req ? req : { ...next, url: withParams(next.url, next.params) }
}

/** `<slug>/tag/<tag>`, `<slug>/<METHOD>/<path>`, `<slug>/tag/<tag>/<METHOD>/<path>` → a sort key. */
function orderIndex(order: unknown, slug: Id): Map<string, number> {
  const index = new Map<string, number>()
  if (!Array.isArray(order)) return index
  order.forEach((entry, i) => {
    if (typeof entry === 'string' && entry.startsWith(`${slug}/`)) index.set(entry.slice(slug.length + 1), i)
  })
  return index
}

function sortBy<T>(items: T[], keyOf: (item: T) => string, index: Map<string, number>): T[] {
  if (index.size === 0) return items
  // Stable: anything the order does not name keeps its place after those it does.
  return items
    .map((item, i) => ({ item, i, at: index.get(keyOf(item)) ?? Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => a.at - b.at || a.i - b.i)
    .map((x) => x.item)
}

function opKey(req: Item, ops: Map<Id, { method: string; path: string }>): string {
  const op = ops.get(req.id)
  return op ? `${op.method}/${op.path.replace(/^\//, '')}` : ''
}

function overlayOrder(items: Item[], doc: Obj, slug: Id, ops: Map<Id, { method: string; path: string }>): Item[] {
  const tagOrders = new Map<string, Map<string, number>>()
  const tags = own(doc, 'tags')
  if (Array.isArray(tags)) {
    for (const t of tags) {
      const name = isObj(t) ? str(own(t, 'name')) : undefined
      if (name !== undefined) tagOrders.set(name, orderIndex(own(t as Obj, 'x-scalar-order'), `${slug}/tag/${name}`))
    }
  }
  const inFolders = items.map((item) =>
    item.kind === 'folder'
      ? { ...item, items: sortBy(item.items, (r) => opKey(r, ops), tagOrders.get(item.name) ?? new Map()) }
      : item
  )
  return sortBy(
    inFolders,
    (item) => (item.kind === 'folder' ? `tag/${item.name}` : opKey(item, ops)),
    orderIndex(own(doc, 'x-scalar-order'), slug)
  )
}

function mapRequests(items: Item[], fn: (req: HttpRequest) => HttpRequest): Item[] {
  return items.map((item) =>
    item.kind === 'folder'
      ? ({ ...item, items: mapRequests(item.items, fn) } as Folder)
      : item.kind === 'http'
        ? fn(item)
        : item
  )
}

function countRequests(items: Item[]): number {
  return items.reduce((n, item) => n + (item.kind === 'folder' ? countRequests(item.items) : 1), 0)
}

/** v0.51.3's document for a collection with no description (`documentForCollection`), inlined. */
function documentForEndpoints(baseUrl: string, endpoints: unknown): Obj {
  const list = Array.isArray(endpoints)
    ? endpoints.filter((e): e is Obj => isObj(e) && typeof e.method === 'string' && typeof e.path === 'string')
    : []
  const paths: Obj = Object.create(null)
  const op = (method: string, path: string, summary?: string): Obj => ({
    summary: summary?.trim() || `${method.toUpperCase()} ${path}`,
    responses: { '200': { description: 'OK' } }
  })
  let origin = baseUrl
  let basePath = '/'
  try {
    const u = new URL(baseUrl)
    origin = u.origin
    basePath = u.pathname && u.pathname !== '/' ? u.pathname : '/'
  } catch {
    /* Not a URL: the whole of it is the server, as v1 did. */
  }
  if (list.length === 0) {
    paths[basePath] = { get: op('get', basePath) }
    return { openapi: '3.1.1', servers: origin ? [{ url: origin }] : [], paths }
  }
  for (const e of list) {
    const path = (e.path as string).trim().startsWith('/') ? (e.path as string).trim() : `/${(e.path as string).trim()}`
    const method = (e.method as string).toLowerCase()
    if (!OPERATION_METHODS.includes(method)) continue
    const item = (Object.hasOwn(paths, path) ? paths[path] : (paths[path] = Object.create(null))) as Obj
    item[method] = op(method, path, str(e.summary))
  }
  return { openapi: '3.1.1', servers: baseUrl ? [{ url: baseUrl }] : [], paths }
}

function absoluteServer(url: unknown, against: string | null): string | null {
  if (typeof url !== 'string' || url.trim() === '') return null
  try {
    const resolved = new URL(url.trim(), against ?? undefined).toString()
    return /^https?:\/\//i.test(resolved) ? resolved.replace(/\/+$/, '') : null
  } catch {
    return null
  }
}

/** Items and base URL from a document, with Scalar's edits laid over them. */
function convertDocument(doc: Obj, c: Obj, id: Id): { items: Item[]; baseUrl: string | null } | null {
  let converted: ReturnType<typeof requestsFromOpenApi>
  try {
    converted = requestsFromOpenApi(withSelectedContentTypes(doc) as OpenApi3Doc, { idSeed: id })
  } catch {
    return null
  }
  const ops = operationsById(doc, id)
  const items = overlayOrder(
    mapRequests(converted.items, (req) => {
      const op = ops.get(req.id)
      return op ? overlayDisabled(req, op.op) : req
    }),
    doc,
    id,
    ops
  )
  const against = str(own(c, 'specUrl')) ?? str(own(doc, 'x-scalar-original-source-url')) ?? str(own(c, 'baseUrl')) ?? null
  const servers = own(doc, 'servers')
  const baseUrl =
    absoluteServer(own(doc, 'x-scalar-selected-server'), against) ??
    absoluteServer(Array.isArray(servers) && isObj(servers[0]) ? servers[0].url : undefined, against) ??
    converted.baseUrl
  return { items, baseUrl }
}

// --------------------------------------------------------------- collections

interface Converted {
  collection: ApiCollectionV2
  specDerived: boolean
  fromV1: boolean
}

function convertCollection(c: Obj, snapshot: SnapshotV1 | null): Converted {
  const id = c.id as Id
  const name = str(c.name)?.trim() || 'Untitled'
  const specUrl = str(c.specUrl) || null
  const specPath = str(c.specPath) || null
  const v1Base = str(c.baseUrl) ?? ''
  const doc = snapshot && Object.hasOwn(snapshot.documents, id) ? snapshot.documents[id] : undefined

  let items: Item[] = []
  let baseUrl = v1Base
  let needsReimport = false
  const fromDoc = isObj(doc) ? convertDocument(doc, c, id) : null
  if (fromDoc) {
    items = fromDoc.items
    baseUrl = fromDoc.baseUrl ?? v1Base
  } else if (specUrl || specPath) {
    needsReimport = true
  } else {
    const built = convertDocument(documentForEndpoints(v1Base, own(c, 'endpoints')), c, id)
    items = built?.items ?? []
    baseUrl = built?.baseUrl ?? v1Base
  }

  const viaServerId = isValidId(c.viaServerId) ? c.viaServerId : null
  const collection: ApiCollectionV2 = {
    version: 2,
    id,
    workspaceId: c.workspaceId as Id,
    name,
    items,
    // A collection waiting on re-import gets its baseUrl from the spec's servers
    // then. v1's value for it was only the spec URL's origin (or '' for a
    // file), and a variable here would win over the servers the import reads.
    variables: needsReimport
      ? []
      : [{ id: stableId('var', id, 'baseUrl', '0'), key: 'baseUrl', value: withoutUserinfo(baseUrl), enabled: true }],
    auth: { type: 'none' },
    viaServerId,
    insecureTls: c.insecureTls === true,
    ...(specUrl || specPath
      ? {
          importedFrom: {
            kind: 'openapi' as const,
            ...(specUrl ? { url: withoutCredentials(specUrl) } : { fileName: basename(specPath!) }),
            // Unknown for a migrated collection; empty rather than a clock, so runs are deterministic.
            at: ''
          }
        }
      : {}),
    ...(needsReimport ? { needsReimport: true } : {}),
    // Deprecated v1 fields, carried verbatim so an older synced build still reads the record.
    baseUrl: v1Base,
    // The synced copy keeps no credential and no local path: the file's name
    // is in importedFrom, and a path is a map of this machine's directories.
    specUrl: specUrl ? withoutCredentials(specUrl) : null,
    specPath: specPath && specUrl ? basename(specPath) : null,
    endpoints: Array.isArray(c.endpoints) ? (c.endpoints as unknown[]) : []
  }
  return { collection, specDerived: Boolean(specUrl || specPath) && items.length > 0, fromV1: true }
}

// -------------------------------------------------------------- environments

function environmentsFrom(
  meta: unknown,
  owners: Id[],
  rejected: MigrationReport['rejected']
): { environments: Environment[]; active: Record<Id, Id | null> } {
  const environments: Environment[] = []
  const active: Record<Id, Id | null> = Object.create(null)
  const envs = isObj(meta) ? own(meta, 'x-scalar-environments') : undefined
  const activeName = isObj(meta) ? str(own(meta, 'x-scalar-active-environment')) : undefined
  if (!isObj(envs)) return { environments, active }
  for (const [name, env] of Object.entries(envs)) {
    if (PROTOTYPE_NAMES.has(name) || name.trim() === '' || name.length > 200) {
      rejected.push({ kind: 'environment', id: name.slice(0, 64), reason: 'The name cannot be used as a key.' })
      continue
    }
    const vars = isObj(env) && Array.isArray(env.variables) ? env.variables : []
    for (const ws of owners) {
      const id = stableId('env', ws, name)
      const variables: Variable[] = vars
        .filter((v): v is Obj => isObj(v) && typeof v.name === 'string' && v.name !== '')
        .map((v, i) => ({ id: stableId('var', id, v.name as string, String(i)), key: v.name as string, value: valueOf(v.value), enabled: true }))
      environments.push({
        id,
        workspaceId: ws,
        name,
        color: nearestHostColor(isObj(env) ? env.color : undefined),
        production: PROD_NAME.test(name),
        variables
      })
      if (name === activeName) active[ws] = id
    }
  }
  return { environments, active }
}

// ------------------------------------------------------------------- entry

function emptyWorkspace(): ApiWorkspaceV2 {
  return { version: 2, environments: [], activeEnvironment: Object.create(null), globals: Object.create(null) }
}

/** A v2 workspace from sync or disk, rebuilt with null-prototype maps and hostile records left out. */
export function normaliseWorkspace(ws: ApiWorkspaceV2, rejected: MigrationReport['rejected'] = []): ApiWorkspaceV2 {
  const out = emptyWorkspace()
  for (const env of ws.environments) {
    if (!isObj(env) || !isValidId(env.id) || !isValidId(env.workspaceId) || typeof env.name !== 'string') {
      rejected.push({ kind: 'environment', id: String(isObj(env) ? env.id : env).slice(0, 64), reason: 'Not a valid environment.' })
      continue
    }
    out.environments.push(env)
  }
  for (const [map, target] of [
    [ws.activeEnvironment, out.activeEnvironment],
    [ws.globals, out.globals]
  ] as [Obj, Obj][]) {
    if (!isObj(map)) continue
    for (const key of Object.keys(map)) if (isValidId(key)) target[key] = map[key]
  }
  return out
}

function collectionId(c: unknown): string {
  return String(isObj(c) ? c.id : c).slice(0, 64)
}

export function migrateApiState(
  collections: unknown,
  workspace: unknown,
  ctx: MigrationCtx
): { collections: ApiCollectionV2[]; workspace: ApiWorkspaceV2; legacy: unknown | null; report: MigrationReport } {
  const report: MigrationReport = {
    id: '',
    collections: 0,
    requests: 0,
    environments: 0,
    needsReimport: [],
    dropped: [],
    rejected: [],
    baseUrlCollisions: [],
    shedForCap: []
  }
  const snapshot = isSnapshot(workspace) ? workspace : null
  const input = Array.isArray(collections) ? collections : []
  const out: Converted[] = []
  const seen = new Set<string>()
  let sawV1 = snapshot !== null

  for (const c of input) {
    if (!isObj(c)) {
      report.rejected.push({ kind: 'collection', id: collectionId(c), reason: 'Not a collection record.' })
      continue
    }
    if (!isValidId(c.id) || seen.has(c.id)) {
      report.rejected.push({ kind: 'collection', id: collectionId(c), reason: 'The id is not valid, or is used twice.' })
      continue
    }
    if (!isValidId(c.workspaceId)) {
      report.rejected.push({ kind: 'workspace', id: String(c.workspaceId).slice(0, 64), reason: `Collection ${c.id} names a workspace id that is not valid.` })
      continue
    }
    if (c.version === 2 && (!Array.isArray(c.items) || !Array.isArray(c.variables) || !isObj(c.auth))) {
      report.rejected.push({ kind: 'collection', id: c.id, reason: 'Not a valid v2 collection.' })
      continue
    }
    seen.add(c.id)
    // A v2 record passes through untouched. That is what makes this idempotent.
    if (c.version === 2) {
      out.push({ collection: c as unknown as ApiCollectionV2, specDerived: false, fromV1: false })
      continue
    }
    sawV1 = true
    const converted = convertCollection(c, snapshot)
    out.push(converted)
    report.collections++
    report.requests += countRequests(converted.collection.items)
    if (converted.collection.needsReimport) {
      report.needsReimport.push({ id: converted.collection.id, name: converted.collection.name })
    }
  }

  // The cap: shed the largest spec-derived collections until the rest fits.
  // Hand-written ones exist nowhere else, so they are never shed.
  const sheddable = out
    .filter((x) => x.specDerived)
    .sort((a, b) => sizeOf(b.collection) - sizeOf(a.collection) || (a.collection.id < b.collection.id ? -1 : 1))
  for (const x of sheddable) {
    if (sizeOf(out.map((o) => o.collection)) <= MAX_COLLECTIONS_BYTES) break
    report.requests -= countRequests(x.collection.items)
    x.collection = { ...x.collection, items: [], needsReimport: true }
    report.shedForCap.push(x.collection.id)
    report.needsReimport.push({ id: x.collection.id, name: x.collection.name })
  }
  const result = out.map((x) => x.collection)

  // Environments, for every workspace that owns a collection.
  let ws: ApiWorkspaceV2
  if (isWorkspaceV2(workspace)) {
    ws = normaliseWorkspace(workspace, report.rejected)
  } else {
    ws = emptyWorkspace()
    if (snapshot) {
      const owners = [...new Set(result.map((c) => c.workspaceId))]
      const { environments, active } = environmentsFrom(snapshot.meta, owners.length ? owners : [ctx.activeWorkspaceId], report.rejected)
      ws.environments = environments
      Object.assign(ws.activeEnvironment, active)
      report.environments = environments.length
      const meta = isObj(snapshot.meta) ? snapshot.meta : {}
      if (Array.isArray(own(meta, 'x-scalar-cookies')) && (own(meta, 'x-scalar-cookies') as unknown[]).length) report.dropped.push('cookies')
      if (own(meta, 'x-scalar-active-proxy')) report.dropped.push('proxy')
      if (Object.hasOwn(meta, 'x-scalar-tabs')) report.dropped.push('tabs')
    }
  }

  // An environment's baseUrl that disagrees with a migrated collection's: the
  // environment now wins where v1's collection base did (UX-M16).
  const migrated = new Set(out.filter((x) => x.fromV1).map((x) => x.collection.id))
  for (const env of ws.environments) {
    const envBase = env.variables.find((v) => v.key === 'baseUrl')
    if (!envBase) continue
    for (const c of result) {
      const colBase = c.variables.find((v) => v.key === 'baseUrl')
      if (migrated.has(c.id) && c.workspaceId === env.workspaceId && colBase && colBase.value !== envBase.value) {
        report.baseUrlCollisions.push({ collectionId: c.id, environment: env.name, value: envBase.value })
      }
    }
  }

  report.id = stableId('mig', ...result.map((c) => c.id), String(report.requests), String(report.environments))
  return {
    collections: result,
    workspace: ws,
    legacy: sawV1 ? scrubLegacy({ version: 1, apiCollections: collections, apiWorkspace: workspace }) : null,
    report
  }
}

/**
 * Environments from `incoming` that `current` does not have, by (workspace,
 * name). Never deletes and never overwrites. When nothing is added it returns
 * `current` itself, so no setState, save or sync follows, and a v1 and a v2
 * device cannot ping-pong the blob between them.
 */
export function mergeIncoming(current: ApiWorkspaceV2, incoming: unknown, ctx: MigrationCtx): ApiWorkspaceV2 {
  let candidates: Environment[] = []
  if (isSnapshot(incoming)) {
    candidates = environmentsFrom(incoming.meta, ctx.workspaceIds?.length ? ctx.workspaceIds : [ctx.activeWorkspaceId], []).environments
  } else if (isWorkspaceV2(incoming)) {
    candidates = normaliseWorkspace(incoming).environments
  }
  const have = new Set(current.environments.map((e) => `${e.workspaceId}\u0000${e.name}`))
  const added = candidates.filter((e) => {
    const key = `${e.workspaceId}\u0000${e.name}`
    if (have.has(key)) return false
    have.add(key)
    return true
  })
  return added.length ? { ...current, environments: [...current.environments, ...added] } : current
}
