/** The headers a request gets without the user writing them, and why. */

import type { Auth, HttpRequest } from './apiModel'
import { methodAllowsBody } from './httpClient'
import { st } from './i18n'

export interface AutoHeader {
  name: string
  value: string
  reason: string
  overridable: boolean
}

const CONTENT_TYPES: Record<string, string> = {
  json: 'application/json',
  text: 'text/plain',
  xml: 'application/xml',
  urlencoded: 'application/x-www-form-urlencoded',
  multipart: 'multipart/form-data; boundary=<generated>',
  binary: 'application/octet-stream'
}

function hostOf(url: string): string {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(url.trim()) ?? /^([^/?#]*)/.exec(url.trim())
  return (m?.[1] ?? '').replace(/^[^@]*@/, '') || st('shared.autoHeaders.hostFromUrl')
}

function authHeader(auth: Auth): AutoHeader | null {
  const reason = st('shared.autoHeaders.fromAuthTab')
  switch (auth.type) {
    case 'bearer':
      return { name: 'Authorization', value: 'Bearer •••', reason, overridable: true }
    case 'basic':
      return { name: 'Authorization', value: 'Basic •••', reason, overridable: true }
    case 'apikey':
      return auth.in === 'header' && auth.name.trim()
        ? { name: auth.name.trim(), value: '•••', reason, overridable: true }
        : null
    default:
      return null
  }
}

/**
 * What OpsMaxx adds, in the order the Headers tab lists it. Values that would
 * be secrets are shown masked; this list is for display, never for sending.
 *
 * `inheritedAuth` is the collection's auth, for a request set to Inherit.
 */
export function autoHeadersFor(
  req: HttpRequest,
  ctx: { version: string; hasCookies: boolean; inheritedAuth?: Auth }
): AutoHeader[] {
  const out: AutoHeader[] = [
    {
      name: 'User-Agent',
      value: `OpsMaxx/${ctx.version}`,
      reason: st('shared.autoHeaders.userAgent'),
      overridable: true
    }
  ]
  const hasBody = req.body.mode !== 'none' && methodAllowsBody(req.method)
  if (hasBody) {
    out.push({
      name: 'Content-Type',
      value: CONTENT_TYPES[req.body.mode],
      reason: st('shared.autoHeaders.contentType'),
      overridable: true
    })
    out.push({
      name: 'Content-Length',
      value: st('shared.autoHeaders.computedWhenSent'),
      reason: st('shared.autoHeaders.contentLength'),
      overridable: false
    })
  }
  out.push({ name: 'Host', value: hostOf(req.url), reason: st('shared.autoHeaders.host'), overridable: false })
  if (ctx.hasCookies) {
    out.push({
      name: 'Cookie',
      value: st('shared.autoHeaders.fromCookieJar'),
      reason: st('shared.autoHeaders.cookie'),
      overridable: true
    })
  }
  const auth = authHeader(req.auth.type === 'inherit' ? (ctx.inheritedAuth ?? { type: 'none' }) : req.auth)
  if (auth) out.push(req.auth.type === 'inherit' ? { ...auth, reason: st('shared.autoHeaders.inherited') } : auth)
  return out
}

/** True when an enabled explicit row replaces this auto header. */
export function isOverridden(header: AutoHeader, rows: { enabled: boolean; key: string }[]): boolean {
  const name = header.name.toLowerCase()
  return header.overridable && rows.some((r) => r.enabled && r.key.trim().toLowerCase() === name)
}
