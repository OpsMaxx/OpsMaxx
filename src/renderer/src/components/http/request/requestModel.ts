import {
  MAX_PERSISTED_BODY_BYTES,
  newId,
  type HttpRequest,
  type Row
} from '../../../../../shared/apiModel'
import { ensureScheme, pathParamNames, splitUrl, withParams } from '../../../../../shared/apiUrl'

// The REST request's pure rules: the two-way sync between the URL and its
// params, the scheme written back at send, counts, and the production test.

export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE'] as const

/** §2.1 step 4: the method picker's short form. */
export const METHOD_ABBR: Record<string, string> = {
  GET: 'GET',
  POST: 'POST',
  PUT: 'PUT',
  PATCH: 'PAT',
  DELETE: 'DEL',
  HEAD: 'HEAD',
  OPTIONS: 'OPT',
  TRACE: 'TRC'
}

export function methodToken(method: string): string {
  const m = method.toUpperCase()
  return ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(m) ? `--method-${m.toLowerCase()}` : '--method-other'
}

/**
 * The URL was edited: its query becomes the enabled params. Disabled rows are
 * not in the URL, so they stay where they were; an enabled row keeps its id
 * and description when its slot is still filled.
 */
export function syncFromUrl(req: HttpRequest, url: string): HttpRequest {
  const incoming = [...splitUrl(url).query]
  const params: Row[] = []
  for (const row of req.params) {
    if (!row.enabled) params.push(row)
    else {
      const next = incoming.shift()
      if (next) params.push({ ...row, key: next.key, value: next.value })
    }
  }
  params.push(...incoming)
  const pathParams = pathParamNames(url).map(
    (name) => req.pathParams.find((p) => p.key === name) ?? { id: newId('row'), key: name, value: '', enabled: true }
  )
  return { ...req, url, params, pathParams }
}

/** The params table was edited: the URL's query is rebuilt from the enabled rows. */
export function syncFromParams(req: HttpRequest, params: Row[]): HttpRequest {
  return { ...req, params, url: withParams(req.url, params) }
}

/**
 * The URL with its scheme made explicit, as it will be sent. A template that
 * starts with `{{` supplies its own scheme, and one already written is kept.
 */
export function withResolvedScheme(url: string): string {
  const trimmed = url.trim()
  if (trimmed === '' || trimmed.startsWith('{{') || /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return url
  return ensureScheme(trimmed).url
}

/** Tab counts are enabled rows with a name, and nothing when there are none. */
export const enabledCount = (rows: Row[]): number => rows.filter((r) => r.enabled && r.key.trim() !== '').length

/** A JSON body that does not parse: a red dot on Body, and the send still goes. */
export function invalidJson(req: HttpRequest): boolean {
  if (req.body.mode !== 'json' || req.body.text.trim() === '') return false
  try {
    JSON.parse(req.body.text)
    return false
  } catch {
    return true
  }
}

/** Free-text bodies are sent verbatim, so a `vault:` reference in one is not resolved (SEC-M2). */
export function vaultRefInFreeText(req: HttpRequest): boolean {
  return (req.body.mode === 'json' || req.body.mode === 'text' || req.body.mode === 'xml') && /vault:[A-Za-z0-9_-]+#/.test(req.body.text)
}

export function bodyTooLargeToSave(req: HttpRequest): boolean {
  return (
    (req.body.mode === 'json' || req.body.mode === 'text' || req.body.mode === 'xml') &&
    new TextEncoder().encode(req.body.text).length > MAX_PERSISTED_BODY_BYTES
  )
}
