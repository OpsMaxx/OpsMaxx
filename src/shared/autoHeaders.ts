/** The headers a request gets without the user writing them, and why. */

import type { Auth, HttpRequest } from './apiModel'
import { methodAllowsBody } from './httpClient'

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
  return (m?.[1] ?? '').replace(/^[^@]*@/, '') || '<from the URL>'
}

function authHeader(auth: Auth): AutoHeader | null {
  const reason = 'From the Auth tab'
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
      reason: 'OpsMaxx names itself unless you set User-Agent',
      overridable: true
    }
  ]
  const hasBody = req.body.mode !== 'none' && methodAllowsBody(req.method)
  if (hasBody) {
    out.push({
      name: 'Content-Type',
      value: CONTENT_TYPES[req.body.mode],
      reason: 'Set from the body type',
      overridable: true
    })
    out.push({
      name: 'Content-Length',
      value: '<computed when sent>',
      reason: 'Measured from the body; it has to match what is on the wire',
      overridable: false
    })
  }
  out.push({ name: 'Host', value: hostOf(req.url), reason: 'Set by the connection', overridable: false })
  if (ctx.hasCookies) {
    out.push({ name: 'Cookie', value: '<from the cookie jar>', reason: 'Cookies this route received earlier', overridable: true })
  }
  const auth = authHeader(req.auth.type === 'inherit' ? (ctx.inheritedAuth ?? { type: 'none' }) : req.auth)
  if (auth) out.push(req.auth.type === 'inherit' ? { ...auth, reason: 'Inherited from the collection' } : auth)
  return out
}

/** True when an enabled explicit row replaces this auto header. */
export function isOverridden(header: AutoHeader, rows: { enabled: boolean; key: string }[]): boolean {
  const name = header.name.toLowerCase()
  return header.overridable && rows.some((r) => r.enabled && r.key.trim().toLowerCase() === name)
}
