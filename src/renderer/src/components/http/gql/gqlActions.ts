import { routeKeyOf, type GraphQlRequest, type HttpTabState, type Id } from '../../../../../shared/apiModel'
import { resolveTemplate } from '../../../../../shared/apiVariables'
import { introspect, runGraphQl } from '../../../lib/httpSend'
import { useApi } from '../../../store/api'
import { useGqlSchemas, type SchemaKey } from '../../../store/gqlSchemas'
import { useHttp } from '../../../store/http'
import { errorsStrip, loadSchema, operationAt, operationsIn, prettify } from './graphqlLanguage'

// What a GraphQL tab does, outside any component, so the http-send and
// beautify hotkeys and the palette reach the same code as the buttons.

export function gqlRequestOf(tab: HttpTabState | undefined): GraphQlRequest | null {
  if (!tab) return null
  const req =
    tab.draft ?? (tab.ref?.requestId ? useApi.getState().findRequest(tab.ref.collectionId, tab.ref.requestId) : null)
  return req?.kind === 'graphql' ? req : null
}

const tabOf = (tabId: Id): HttpTabState | undefined => useHttp.getState().tabs.find((t) => t.id === tabId)

export function updateGql(tabId: Id, patch: Partial<GraphQlRequest>): void {
  const req = gqlRequestOf(tabOf(tabId))
  if (req) useHttp.getState().updateDraft(tabId, { ...req, ...patch })
}

/** The schema cache key: the URL as it resolves now, and the route it goes over. */
export function schemaKeyFor(tab: HttpTabState, req: GraphQlRequest): SchemaKey {
  const api = useApi.getState()
  const url = resolveTemplate(req.url, api.scopeChainFor(tab)).text.trim()
  return `${url}|${routeKeyOf(api.effectiveRoute(tab))}`
}

/** Load schema: explicit, never on typing, because requests may route through production servers. */
export function loadGqlSchema(tabId: Id): Promise<void> {
  const tab = tabOf(tabId)
  const req = gqlRequestOf(tab)
  if (!tab || !req) return Promise.resolve()
  return useGqlSchemas.getState().load(schemaKeyFor(tab, req), () =>
    loadSchema(async (query) => {
      const r = await introspect(tabId, query)
      return r.ok ? r : { ok: false, message: r.message }
    })
  )
}

/**
 * Run. `cursor` picks the operation under it when the document has several;
 * `operationName` picks one outright (the Run menu). The production confirm
 * for mutations is the send layer's, so every entry point hits it.
 */
export async function runGql(
  tabId: Id,
  opts: { cursor?: number; operationName?: string; allowUnresolved?: boolean } = {}
): Promise<void> {
  const tab = tabOf(tabId)
  const req = gqlRequestOf(tab)
  if (!tab || !req) return
  const ops = operationsIn(req.query)
  const name =
    opts.operationName ??
    (ops.length > 1
      ? (opts.cursor === undefined ? ops.find((o) => o.name === req.operationName) : operationAt(ops, opts.cursor))?.name
      : undefined)
  await (opts.allowUnresolved ? runGraphQl(tabId, name, { allowUnresolved: true }) : runGraphQl(tabId, name))

  const res = useHttp.getState().responses[tabId]
  // A 200 carrying errors[] is a failed query: open a collapsed response to say so.
  if (errorsStrip(res) !== null) useHttp.getState().revealResponse(tabId)

  // The first successful Run against this (URL, route) loads its schema.
  if (res?.status !== 'done' || res.response.status < 200 || res.response.status >= 300) return
  const key = schemaKeyFor(tab, req)
  if (!useGqlSchemas.getState().byKey[key]) void loadGqlSchema(tabId)
}

/** ⌥⌘B. A query that does not parse is left as it is. */
export function prettifyGql(tabId: Id): void {
  const req = gqlRequestOf(tabOf(tabId))
  const pretty = req ? prettify(req.query) : null
  if (pretty !== null && pretty !== req?.query) updateGql(tabId, { query: pretty })
}
