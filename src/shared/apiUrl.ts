/**
 * URL helpers for the HTTP client: query and path params, schemes, masking.
 *
 * Everything here works on the TEMPLATE text, so a URL is never parsed with
 * `new URL` where it might still hold `{{baseUrl}}`: that would throw, or
 * worse, percent-encode the braces and break templating.
 */

import { isSensitiveName, stableId, type Row } from './apiModel'
import { userinfoSpan } from './httpClient'

const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//

const REFERENCES = /\{\{[^{}]*\}\}|vault:[A-Za-z0-9_-]{1,64}#(?:password|username)/g

/**
 * The URL with its userinfo replaced by `mask`, for the save strip, the
 * credential stripper and the migration. The span comes from httpClient's
 * `userinfoSpan`, the one parser history and cURL use too: leading
 * whitespace trimmed, and the userinfo ends at the LAST `@` of the authority,
 * which is where WHATWG splits it, so
 * `https://u:p@ss@host` loses `u:p@ss` and a token used as the user name
 * (`https://ghp_x@github.com`) goes too. Userinfo made only of `{{vars}}` and
 * vault references is kept. An empty `mask` removes the userinfo and its `@`.
 */
export function maskUserinfo(url: string, mask: string): string {
  const trimmed = url.trimStart()
  const span = userinfoSpan(trimmed)
  if (!span) return trimmed
  if (trimmed.slice(span.start, span.end).replace(REFERENCES, '').replace(/:/g, '').trim() === '') return trimmed
  return `${trimmed.slice(0, span.start)}${mask === '' ? '' : `${mask}@`}${trimmed.slice(span.end + 1)}`
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text.replace(/\+/g, ' '))
  } catch {
    return text
  }
}

/**
 * Percent-encodes what would change the query's structure or is not legal in
 * a URL, and nothing else. `{{name}}` and `vault:id#field` pass through, so a
 * template survives the round trip and is resolved later.
 */
function encodePart(text: string, isKey: boolean): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    const rest = text.slice(i)
    const kept = /^\{\{[^{}]*\}\}/.exec(rest) ?? /^vault:[A-Za-z0-9_-]{1,64}#(?:password|username)/.exec(rest)
    if (kept) {
      out += kept[0]
      i += kept[0].length
      continue
    }
    const ch = text[i]
    out +=
      ch === '&' || ch === '#' || ch === '+' || ch === '%' || (isKey && ch === '=') || /[\s"<>\\^`|{}]/.test(ch)
        ? encodeURIComponent(ch)
        : ch
    i++
  }
  return out
}

/** Splits off the fragment. The `#` inside a `vault:id#field` reference is not one. */
function splitHash(url: string): { head: string; hash: string } {
  for (let at = url.indexOf('#'); at >= 0; at = url.indexOf('#', at + 1)) {
    if (!/vault:[A-Za-z0-9_-]{1,64}$/.test(url.slice(0, at))) return { head: url.slice(0, at), hash: url.slice(at) }
  }
  return { head: url, hash: '' }
}

/** The part before `?` (fragment dropped), and every query pair as an enabled row. */
export function splitUrl(url: string): { base: string; query: Row[] } {
  const { head } = splitHash(url)
  const q = head.indexOf('?')
  if (q < 0) return { base: head, query: [] }
  const query = head
    .slice(q + 1)
    .split('&')
    .filter((pair) => pair !== '')
    .map((pair, index) => {
      const eq = pair.indexOf('=')
      const key = eq < 0 ? pair : pair.slice(0, eq)
      const value = eq < 0 ? '' : pair.slice(eq + 1)
      return {
        id: stableId('row', 'query', String(index)),
        enabled: true,
        key: safeDecode(key),
        value: safeDecode(value)
      }
    })
  return { base: head.slice(0, q), query }
}

/** The URL with its query replaced by the enabled rows. A fragment is kept. */
export function withParams(url: string, rows: Row[]): string {
  const { head, hash } = splitHash(url)
  const q = head.indexOf('?')
  const base = q < 0 ? head : head.slice(0, q)
  const pairs = rows
    .filter((r) => r.enabled && r.key !== '')
    .map((r) =>
      r.value === '' ? encodePart(r.key, true) : `${encodePart(r.key, true)}=${encodePart(r.value, false)}`
    )
  return `${base}${pairs.length ? `?${pairs.join('&')}` : ''}${hash}`
}

/** The path part, and where it starts: after the scheme and authority, or after a leading `{{base}}`. */
function pathPart(url: string): { start: number; path: string } {
  const noQuery = splitHash(url).head.split('?')[0]
  const scheme = SCHEME.exec(noQuery)
  if (scheme) {
    const slash = noQuery.indexOf('/', scheme[0].length)
    return slash < 0 ? { start: noQuery.length, path: '' } : { start: slash, path: noQuery.slice(slash) }
  }
  const lead = /^\{\{[^{}]*\}\}/.exec(noQuery)
  const start = lead ? lead[0].length : 0
  return { start, path: noQuery.slice(start) }
}

const PATH_PARAM = /(?:^|\/):([A-Za-z_][A-Za-z0-9_-]*)|(?<!\{)\{([A-Za-z_][A-Za-z0-9_.-]*)\}(?!\})/g

/** `:id` and `{id}` segments, in order and once each. `{{var}}` is not one. */
export function pathParamNames(url: string): string[] {
  const names: string[] = []
  for (const m of pathPart(url).path.matchAll(PATH_PARAM)) {
    const name = m[1] ?? m[2]
    if (!names.includes(name)) names.push(name)
  }
  return names
}

/** Each `:name` and `{name}` in the path replaced by its encoded value; unknown names are left. */
export function fillPathParams(url: string, values: Record<string, string>): string {
  const { start, path } = pathPart(url)
  if (!path) return url
  const filled = path.replace(PATH_PARAM, (token, colon: string | undefined, brace: string | undefined) => {
    const name = colon ?? brace ?? ''
    if (!Object.hasOwn(values, name)) return token
    const prefix = colon !== undefined && token.startsWith('/') ? '/' : ''
    return `${prefix}${encodeURIComponent(values[name])}`
  })
  return url.slice(0, start) + filled + url.slice(start + path.length)
}

function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '0.0.0.0') return true
  if (!h.includes('.') && !h.includes(':')) return true
  if (h.endsWith('.internal')) return true
  const ip = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(h)
  if (!ip) return false
  const [a, b] = [Number(ip[1]), Number(ip[2])]
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

/** A bare host gets a scheme: loopback, RFC 1918, single-label and `.internal` get http, anything else https. */
export function ensureScheme(url: string): { url: string; scheme: 'http' | 'https'; inferred: boolean } {
  const trimmed = url.trim()
  const m = SCHEME.exec(trimmed)
  if (m) {
    const s = m[1].toLowerCase()
    return { url: trimmed, scheme: s === 'http' || s === 'ws' ? 'http' : 'https', inferred: false }
  }
  // A template decides its own scheme once it is resolved.
  if (trimmed === '' || trimmed.startsWith('{{')) return { url: trimmed, scheme: 'https', inferred: false }
  const authority = trimmed.split(/[/?#]/)[0]
  const host = authority.replace(/^[^@]*@/, '').replace(/:\d+$/, '')
  const scheme = isPrivateHost(host) ? 'http' : 'https'
  return { url: `${scheme}://${trimmed}`, scheme, inferred: true }
}

const MASK = '•••'

/** Userinfo and sensitive query values become `•••`. */
export function maskUrl(url: string): string {
  const { head, hash } = splitHash(url)
  let out = maskUserinfo(head, MASK)
  const q = out.indexOf('?')
  if (q >= 0) {
    const query = out
      .slice(q + 1)
      .split('&')
      .map((pair) => {
        const eq = pair.indexOf('=')
        if (eq < 0) return pair
        return isSensitiveName(safeDecode(pair.slice(0, eq))) ? `${pair.slice(0, eq)}=${MASK}` : pair
      })
      .join('&')
    out = `${out.slice(0, q)}?${query}`
  }
  return out + hash
}

/**
 * A sensible starting URL from the collection's base. `http` and `https` map
 * onto `ws` and `wss`; anything else is left alone rather than guessed at.
 */
export function wsUrlFor(baseUrl: string): string {
  const raw = baseUrl.trim()
  if (raw === '') return ''
  if (/^wss?:\/\//i.test(raw)) return raw
  if (/^https:\/\//i.test(raw)) return raw.replace(/^https:\/\//i, 'wss://')
  if (/^http:\/\//i.test(raw)) return raw.replace(/^http:\/\//i, 'ws://')
  return raw
}

/**
 * A sensible starting endpoint from the collection's base. `/graphql` is the
 * convention, and a base that already names a path is left as it is.
 */
export function graphqlUrlFor(baseUrl: string): string {
  const raw = baseUrl.trim()
  if (raw === '') return ''
  try {
    const url = new URL(raw)
    if (url.pathname && url.pathname !== '/') return raw
    return `${url.origin}/graphql`
  } catch {
    return raw
  }
}

/**
 * A URL as a synced field may keep it: userinfo and every credential-named
 * query parameter (`?access_token=`) are dropped, not masked, because a
 * masked value would be sent as if it were real.
 */
export function withoutCredentials(url: string): string {
  const { head, hash } = splitHash(maskUserinfo(url, ''))
  const bare = head
  const q = bare.indexOf('?')
  if (q < 0) return bare + hash
  const kept = bare
    .slice(q + 1)
    .split('&')
    .filter((pair) => !isSensitiveName(safeDecode(pair.split('=')[0])))
  return `${bare.slice(0, q)}${kept.length ? `?${kept.join('&')}` : ''}${hash}`
}
