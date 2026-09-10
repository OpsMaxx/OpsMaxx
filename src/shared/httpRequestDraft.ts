import { methodAllowsBody } from './httpClient'

/**
 * A request a person is composing, and the URL it becomes.
 *
 * Pure, and separate from the component, because this is the part that has to
 * be RIGHT: joining a base URL to a path without doubling or losing a slash,
 * appending query parameters to a URL that may already carry some, and
 * deciding whether a body is even legal for the method. Each of those has an
 * obvious implementation that is wrong at one edge, and none of them needs a
 * DOM to check.
 */

export interface KeyValueRow {
  id: string
  enabled: boolean
  key: string
  value: string
}

export interface RequestDraft {
  method: string
  /** A path against the collection's base URL, or an absolute URL of its own. */
  path: string
  params: KeyValueRow[]
  headers: KeyValueRow[]
  body: string
}

export const emptyDraft = (method = 'GET', path = '/'): RequestDraft => ({
  method,
  path,
  params: [],
  headers: [],
  body: ''
})

/** Rows the user has actually filled in and left switched on. */
export function activeRows(rows: readonly KeyValueRow[]): KeyValueRow[] {
  return rows.filter((r) => r.enabled && r.key.trim() !== '')
}

/**
 * Join a base URL and a path.
 *
 * Both halves are typed by a person, so both arrive with and without slashes.
 * The base's own path is KEPT — `https://h/api` with `/v1/users` is
 * `https://h/api/v1/users`, because someone who put `/api` in the base meant
 * it to apply to every request.
 *
 * An absolute path — one that already names a scheme — wins outright: it is
 * how somebody sends one request somewhere else without editing the
 * collection.
 */
export function joinUrl(baseUrl: string, path: string): string {
  const p = path.trim()
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) return p

  const base = baseUrl.trim().replace(/\/+$/, '')
  if (!base) return p
  if (!p) return base
  return `${base}/${p.replace(/^\/+/, '')}`
}

/**
 * The final URL, with the enabled parameters on it.
 *
 * Appended rather than replacing, so a base URL or path that already carries a
 * query keeps it — `?api_key=…` in the base is a real way to configure a
 * collection, and dropping it would send an unauthenticated request that fails
 * for a reason nothing on screen explains.
 */
export function buildUrl(baseUrl: string, draft: RequestDraft): string {
  const joined = joinUrl(baseUrl, draft.path)
  const rows = activeRows(draft.params)
  if (rows.length === 0) return joined

  const qs = rows
    .map((r) => `${encodeURIComponent(r.key.trim())}=${encodeURIComponent(r.value)}`)
    .join('&')
  const [withoutHash, hash] = joined.split('#', 2)
  const sep = withoutHash.includes('?') ? '&' : '?'
  const url = `${withoutHash}${sep}${qs}`
  return hash === undefined ? url : `${url}#${hash}`
}

/** Enabled header rows as the object the transport takes. */
export function buildHeaders(draft: RequestDraft): Record<string, string> {
  const out: Record<string, string> = {}
  for (const r of activeRows(draft.headers)) out[r.key.trim()] = r.value
  return out
}

/**
 * Whether this draft should send a body, and why not when it should not.
 *
 * GET and HEAD carry none — fetch itself throws on the attempt — so a body
 * typed against a GET is kept in the draft and simply not sent. Kept rather
 * than cleared: switching GET → POST → GET while writing a payload should not
 * silently destroy it.
 */
export function bodyFor(draft: RequestDraft): string | null {
  if (!methodAllowsBody(draft.method)) return null
  return draft.body.trim() === '' ? null : draft.body
}

/**
 * A guess at the body's content type, for the header row the user did not add.
 *
 * Only a default: an explicit Content-Type header always wins, because
 * somebody who typed one meant it.
 */
export function guessContentType(body: string): string {
  const t = body.trim()
  if (t.startsWith('{') || t.startsWith('[')) return 'application/json'
  if (t.startsWith('<')) return 'application/xml'
  return 'text/plain'
}

/** True when the headers already name a content type, in any casing. */
export function hasContentType(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')
}

/**
 * Pretty-print a response body when it is JSON, and leave it alone otherwise.
 *
 * Returns the ORIGINAL text on any parse failure. A truncated response is
 * still worth reading, and replacing it with an error about invalid JSON would
 * hide the bytes that explain what went wrong.
 */
export function prettyBody(text: string): string {
  const t = text.trim()
  if (!t.startsWith('{') && !t.startsWith('[')) return text
  try {
    return JSON.stringify(JSON.parse(t), null, 2)
  } catch {
    return text
  }
}
