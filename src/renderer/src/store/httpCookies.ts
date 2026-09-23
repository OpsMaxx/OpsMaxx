import { create } from 'zustand'
import type { Id, RouteKey } from '../../../shared/apiModel'

// The HTTP client's cookie jar. Memory only, and keyed by (workspace, route),
// so a cookie `server:A` received for `localhost` is never sent via `direct`
// or `server:B`: each route's `localhost` is a different machine.

export interface StoredCookie {
  name: string
  value: string
  domain: string
  /** No usable `Domain=`: sent to this exact host only. */
  hostOnly: boolean
  path: string
  secure: boolean
  httpOnly: boolean
  sameSite?: 'strict' | 'lax' | 'none'
  /** Epoch ms; absent means a session cookie. */
  expiresAt?: number
  createdAt: number
}

export type JarKey = `${Id}|${RouteKey}`

interface HttpCookiesState {
  jars: Record<JarKey, StoredCookie[]>
  store: (wsId: Id, routeKey: RouteKey, url: string, setCookie: string[]) => void
  headerFor: (wsId: Id, routeKey: RouteKey, url: string) => string
  list: () => { key: JarKey; cookies: StoredCookie[] }[]
  remove: (key: JarKey, name: string, domain: string, path: string) => void
  clearDomain: (key: JarKey, domain: string) => void
  clearAll: () => void
}

// ponytail: fixed caps rather than RFC 6265's per-domain accounting; a jar
// that lives until quit only has to stop a runaway server, not be exact.
const MAX_COOKIE_BYTES = 4096
const MAX_PER_JAR = 300

// ponytail: no public-suffix list. Two labels is the floor, and the common
// `co.uk`-shaped second-level suffixes are refused by pattern; a real PSL is
// the upgrade if a host outside these shapes turns up.
const SECOND_LEVEL_SUFFIX = /^(co|com|net|org|gov|edu|ac|or|ne|go|gv|mil|nic|ltd|plc)\.[a-z]{2}$/

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/

function isIpLiteral(host: string): boolean {
  return IPV4.test(host) || host.includes(':')
}

/** RFC 6265 §5.1.3. */
function domainMatches(host: string, domain: string): boolean {
  return host === domain || (host.endsWith(`.${domain}`) && !isIpLiteral(host))
}

/** RFC 6265 §5.1.4. */
function defaultPath(pathname: string): string {
  if (!pathname.startsWith('/')) return '/'
  const last = pathname.lastIndexOf('/')
  return last <= 0 ? '/' : pathname.slice(0, last)
}

function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true
  if (!requestPath.startsWith(cookiePath)) return false
  return cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/'
}

function parseUrl(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}

const hostOf = (u: URL): string => u.hostname.toLowerCase().replace(/^\[|\]$/g, '')
const isSecureScheme = (u: URL): boolean => u.protocol === 'https:' || u.protocol === 'wss:'

/** One `Set-Cookie` line, or null when it is to be ignored. Pure; exported for tests. */
export function parseSetCookie(line: string, requestUrl: string, now: number): StoredCookie | null {
  const u = parseUrl(requestUrl)
  if (!u || new TextEncoder().encode(line).length > MAX_COOKIE_BYTES) return null
  const host = hostOf(u)
  const [pair, ...attrs] = line.split(';')
  const eq = pair.indexOf('=')
  if (eq < 0) return null
  const name = pair.slice(0, eq).trim()
  if (name === '') return null

  const cookie: StoredCookie = {
    name,
    value: pair.slice(eq + 1).trim(),
    domain: host,
    hostOnly: true,
    path: defaultPath(u.pathname),
    secure: false,
    httpOnly: false,
    createdAt: now
  }
  let maxAge: number | undefined
  let expires: number | undefined
  for (const attr of attrs) {
    const at = attr.indexOf('=')
    const key = (at < 0 ? attr : attr.slice(0, at)).trim().toLowerCase()
    const val = at < 0 ? '' : attr.slice(at + 1).trim()
    if (key === 'domain' && val) {
      const domain = val.replace(/^\./, '').toLowerCase()
      // Honoured only when it covers the request host, is not an IP literal,
      // and is not a public suffix. Otherwise the cookie stays host-only.
      if (
        domainMatches(host, domain) &&
        !isIpLiteral(domain) &&
        domain.includes('.') &&
        !SECOND_LEVEL_SUFFIX.test(domain)
      ) {
        cookie.domain = domain
        cookie.hostOnly = false
      }
    } else if (key === 'path') {
      cookie.path = val.startsWith('/') ? val : defaultPath(u.pathname)
    } else if (key === 'secure') {
      cookie.secure = true
    } else if (key === 'httponly') {
      cookie.httpOnly = true
    } else if (key === 'samesite') {
      const s = val.toLowerCase()
      if (s === 'strict' || s === 'lax' || s === 'none') cookie.sameSite = s
    } else if (key === 'max-age' && /^-?\d+$/.test(val)) {
      maxAge = Number(val)
    } else if (key === 'expires') {
      const t = Date.parse(val)
      if (!Number.isNaN(t)) expires = t
    }
  }
  // Max-Age wins over Expires (§5.3 step 3).
  if (maxAge !== undefined) cookie.expiresAt = maxAge <= 0 ? 0 : now + maxAge * 1000
  else if (expires !== undefined) cookie.expiresAt = expires
  // A Secure cookie arriving over plain http could be a downgrade forging one.
  if (cookie.secure && !isSecureScheme(u)) return null
  return cookie
}

const sameSlot = (a: StoredCookie, b: StoredCookie): boolean =>
  a.name === b.name && a.domain === b.domain && a.path === b.path

const live = (c: StoredCookie, now: number): boolean => c.expiresAt === undefined || c.expiresAt > now

function jarOf(jars: Record<JarKey, StoredCookie[]>, key: JarKey): StoredCookie[] {
  return Object.hasOwn(jars, key) ? jars[key] : []
}

function withJar(
  jars: Record<JarKey, StoredCookie[]>,
  key: JarKey,
  cookies: StoredCookie[]
): Record<JarKey, StoredCookie[]> {
  const next: Record<JarKey, StoredCookie[]> = Object.assign(Object.create(null), jars)
  if (cookies.length) next[key] = cookies
  else delete next[key]
  return next
}

export const jarKey = (wsId: Id, routeKey: RouteKey): JarKey => `${wsId}|${routeKey}`

export const useHttpCookies = create<HttpCookiesState>((set, get) => ({
  jars: Object.create(null),

  store: (wsId, routeKey, url, setCookie) => {
    if (setCookie.length === 0) return
    const key = jarKey(wsId, routeKey)
    const now = Date.now()
    let cookies = jarOf(get().jars, key).filter((c) => live(c, now))
    for (const line of setCookie) {
      const cookie = parseSetCookie(line, url, now)
      if (!cookie) continue
      const old = cookies.find((c) => sameSlot(c, cookie))
      cookies = cookies.filter((c) => !sameSlot(c, cookie))
      // An already-expired cookie is how a server deletes one.
      if (live(cookie, now)) cookies.push(old ? { ...cookie, createdAt: old.createdAt } : cookie)
    }
    set((s) => ({ jars: withJar(s.jars, key, cookies.slice(-MAX_PER_JAR)) }))
  },

  headerFor: (wsId, routeKey, url) => {
    const u = parseUrl(url)
    if (!u) return ''
    const host = hostOf(u)
    const now = Date.now()
    return jarOf(get().jars, jarKey(wsId, routeKey))
      .filter(
        (c) =>
          live(c, now) &&
          (c.hostOnly ? host === c.domain : domainMatches(host, c.domain)) &&
          pathMatches(u.pathname || '/', c.path) &&
          (!c.secure || isSecureScheme(u))
      )
      // Longer paths first, then oldest first (§5.4 step 2).
      .sort((a, b) => b.path.length - a.path.length || a.createdAt - b.createdAt)
      .map((c) => `${c.name}=${c.value}`)
      .join('; ')
  },

  list: () => {
    const now = Date.now()
    return (Object.keys(get().jars) as JarKey[])
      .map((key) => ({ key, cookies: get().jars[key].filter((c) => live(c, now)) }))
      .filter((j) => j.cookies.length > 0)
  },

  remove: (key, name, domain, path) =>
    set((s) => ({
      jars: withJar(
        s.jars,
        key,
        jarOf(s.jars, key).filter((c) => !(c.name === name && c.domain === domain && c.path === path))
      )
    })),

  clearDomain: (key, domain) =>
    set((s) => ({ jars: withJar(s.jars, key, jarOf(s.jars, key).filter((c) => c.domain !== domain)) })),

  clearAll: () => set({ jars: Object.create(null) })
}))
