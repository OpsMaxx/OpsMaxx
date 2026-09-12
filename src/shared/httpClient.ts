/**
 * The HTTP client's wire contract between renderer and main.
 *
 * Requests are executed in main rather than by the renderer's own fetch, for
 * three reasons the renderer cannot work around:
 *
 *   - Chromium refuses a self-signed or privately-signed certificate, which is
 *     what most internal services present. Node can be handed a private CA for
 *     one request (`caPem`, trusted in addition to the system roots, with
 *     verification still on), or told (explicitly, per request) to skip
 *     verification entirely.
 *   - A renderer fetch leaves from this machine. Sending it through a server's
 *     SSH connection reaches services bound to that host's loopback, which are
 *     not exposed to the network at all — the thing no standalone API client
 *     can do.
 *   - CORS does not apply to a request that never goes through the browser
 *     stack, so an API with no `Access-Control-Allow-Origin` still answers.
 */

import type { SshHop } from './ssh'

/**
 * The SSH details main needs to reach a server, in the shape every other
 * feature sends. Credentials are deliberately absent: main merges them from
 * the encrypted store by `serverId`, exactly as it does for the terminal and
 * SFTP. A renderer that could send a password could also exfiltrate one.
 */
export type HttpSshTarget = SshHop & {
  serverId?: string
  hops?: SshHop[]
  vpnProfileId?: string
  serverName?: string
}

/** Where a request leaves from. */
export type HttpVia =
  | { kind: 'direct' }
  /**
   * Through a saved server's SSH connection, as a direct-tcpip channel. The
   * request's host is resolved on the SERVER, so `localhost` means that host's
   * loopback and a private DNS name resolves in that host's network.
   */
  | { kind: 'server'; server: HttpSshTarget }
  /**
   * Through a VPN profile with no SSH server in front of it — a GitLab or
   * Jenkins sitting on the far side of a WireGuard profile and nothing else.
   *
   * `direct` cannot reach it: userspace mode "exposes the tunnel as local
   * listeners only: no TUN device, no route table change" (`shared/vpn.ts:12`),
   * so a plain `net.connect` never enters the tunnel. `server` cannot reach it
   * either, because there is no server to route through. Main starts the
   * profile, opens a forward into it and dials the loopback end of that.
   */
  | { kind: 'vpn'; vpnProfileId: string }

export interface HttpRequestSpec {
  url: string
  method: string
  /** Header names are matched case-insensitively downstream; values are sent verbatim. */
  headers: Record<string, string>
  /** Absent for GET/HEAD. */
  body?: ArrayBuffer
  via: HttpVia
  /**
   * Skip TLS certificate verification for THIS request.
   *
   * Off by default and never remembered implicitly: the renderer has to set it
   * per request, and the UI has to show that it is set. An API client that
   * quietly stopped verifying certificates would be worse than one that cannot
   * reach a self-signed host at all.
   *
   * THIS request means this host: a redirect to another origin is sent without
   * it, whatever `maxRedirects` says.
   */
  insecureTls?: boolean
  /**
   * A PEM bundle to trust for THIS request, in addition to the system roots.
   *
   * The point is that it is not `insecureTls`: a self-hosted Jenkins or GitLab
   * on a company CA is the common case, and the alternative to naming that CA
   * is turning verification off wholesale for every request to that host.
   */
  caPem?: string
  /**
   * Follow up to this many 3xx hops. Absent or 0 means the 3xx is returned as
   * it arrived, which is what every caller before this did and still gets.
   *
   * Credentials do not travel across an origin change — see
   * `CROSS_ORIGIN_SAFE_HEADERS`. There is deliberately no option to keep them.
   *
   * Neither does anything else that was granted to the ORIGINAL host: a
   * cross-origin hop is sent `via: direct`, with `insecureTls` and `caPem`
   * dropped, because all three answer "what do I grant this host" and the far
   * end picks the next one. See `httpRequest` in `main/services/httpClient.ts`.
   *
   * The practical consequence, worth knowing before opting in: a redirect into
   * a private network reachable ONLY through an SSH route fails rather than
   * being followed. That is the intended trade — the alternative is letting a
   * remote host pick which addresses inside the user's network this app reads
   * — but it is the shape of the bug report it produces.
   */
  maxRedirects?: number
  timeoutMs?: number
}

export interface HttpResponseOk {
  ok: true
  status: number
  statusText: string
  headers: Record<string, string>
  /** ArrayBuffer so it survives structured clone across IPC without re-encoding. */
  body: ArrayBuffer
  durationMs: number
  /** True when the body hit MAX_RESPONSE_BYTES and was cut short. */
  truncated: boolean
}

export interface HttpResponseErr {
  ok: false
  error: string
  /** Node's error code where there is one (ENOTFOUND, ECONNREFUSED, …). */
  code?: string
}

export type HttpResult = HttpResponseOk | HttpResponseErr

/**
 * 32 MiB. Big enough for any API response worth reading in a client, small
 * enough that a misdirected request at a disk image cannot exhaust main's heap
 * — the buffer lives in the main process, so an OOM there takes the whole app
 * down rather than one renderer view.
 */
export const MAX_RESPONSE_BYTES = 32 * 1024 * 1024

export const DEFAULT_TIMEOUT_MS = 30_000

/** Ceiling on the per-request timeout, so a typo cannot wedge a socket for a day. */
export const MAX_TIMEOUT_MS = 10 * 60_000

/**
 * Methods that carry no request body. Matches fetch's own rule, which throws
 * on a GET/HEAD with a body.
 */
const BODILESS = new Set(['GET', 'HEAD'])

export function methodAllowsBody(method: string): boolean {
  return !BODILESS.has(method.toUpperCase())
}

/**
 * Header names that main sets from the transport itself. Letting a caller
 * supply them produces a request that contradicts what is actually on the
 * wire — a `Host` that disagrees with the connection, or a `Content-Length`
 * that disagrees with the body, which some servers treat as request
 * smuggling.
 */
const RESERVED_HEADERS = new Set(['content-length', 'connection', 'transfer-encoding', 'host'])

/**
 * A header name is a token per RFC 9110; a value must not carry CR or LF.
 * Node would throw on both, but throwing inside the request path turns a bad
 * header into an opaque failure, so they are dropped where the reason can be
 * reported.
 */
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

export function sanitizeHeaders(headers: Record<string, string>): {
  headers: Record<string, string>
  dropped: string[]
} {
  const out: Record<string, string> = {}
  const dropped: string[] = []
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase()
    if (!TOKEN.test(name) || RESERVED_HEADERS.has(lower) || /[\r\n]/.test(value ?? '')) {
      dropped.push(name)
      continue
    }
    out[name] = value
  }
  return { headers: out, dropped }
}

export interface ParsedTarget {
  url: URL
  tls: boolean
  hostname: string
  port: number
  /** Path plus query, which is what goes on the request line. */
  path: string
}

/**
 * Parse and vet a target URL.
 *
 * Only http and https: `file:` would read this machine's disk through a
 * request the user thinks goes to a server, and custom schemes have no meaning
 * to an HTTP client.
 *
 * Link-local is refused here — see `isLinkLocalHost`. Nothing else about the
 * address is judged: `127.0.0.1:8080` is how a Jenkins behind a local tunnel is
 * reached and `10.x`/`192.168.x` is how a self-hosted GitLab on a LAN is
 * reached, so a private-IP deny-list would break the majority of installs to
 * stop a user typing an address they had to be tricked into typing.
 */
export function parseTarget(raw: string): ParsedTarget | { error: string } {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { error: `Not a valid URL: ${raw}` }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { error: `Only http and https are supported, not ${url.protocol.replace(':', '')}` }
  }
  if (!url.hostname) return { error: 'The URL has no host.' }
  if (isLinkLocalHost(url.hostname)) {
    return {
      error: `${url.hostname} is a link-local address, which this client will not request.`
    }
  }

  const tls = url.protocol === 'https:'
  return {
    url,
    tls,
    hostname: url.hostname,
    port: url.port ? Number(url.port) : tls ? 443 : 80,
    path: `${url.pathname}${url.search}`
  }
}

export function clampTimeout(ms: number | undefined): number {
  if (!ms || !Number.isFinite(ms) || ms <= 0) return DEFAULT_TIMEOUT_MS
  return Math.min(Math.floor(ms), MAX_TIMEOUT_MS)
}

// ------------------------------------------------------------- link-local

/**
 * `169.254.0.0/16` and `fe80::/10`, plus the IPv4-mapped spelling of the
 * former. These are the cloud metadata endpoints — `169.254.169.254` on AWS,
 * GCP and Azure — and no CI server has ever lived on one, so refusing them
 * costs nothing and closes the one SSRF target worth closing.
 *
 * This looks at a literal, not at what a name resolves to: `ci.example.com`
 * pointed at `169.254.169.254` still gets through. Resolution happens in
 * `net.connect`, after this, and on the `via: 'server'` path it happens on the
 * far end entirely — the honest control there is re-resolving at connect time,
 * which this is not.
 */
export function isLinkLocalHost(hostname: string): boolean {
  // URL keeps IPv6 bracketed; compare the address itself.
  const host = hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase()
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(host)) return true
  if (/^::ffff:(0:)?169\.254\.\d{1,3}\.\d{1,3}$/.test(host)) return true
  // fe80::/10 is the first hextet in fe80–febf. It cannot be written with
  // leading zeros stripped, so matching the opening hextet is enough.
  return /^fe[89ab][0-9a-f]:/.test(host)
}

// --------------------------------------------------------------- origins

/**
 * Normalise an origin so that `===` is a sound comparison afterwards:
 * lowercase scheme and host, default port dropped, path/query/fragment and
 * userinfo discarded, one trailing dot removed from the hostname.
 *
 * Copied from `normaliseOrigin` in `src/shared/credproxy.ts:194` rather than
 * imported: credProxy is deliberately unreachable in both directions
 * (`src/main/services/credProxy.ts:34-73`, guarded by
 * `tests/jobsNotExposed.test.ts`), so an import would be the wrong kind of
 * reuse. Keep the two in step by hand if either changes.
 */
export function normaliseOrigin(raw: string): string | null {
  const text = String(raw ?? '').trim()
  if (text === '') return null
  let u: URL
  try {
    u = new URL(text)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  const host = u.hostname.replace(/\.$/, '')
  if (host === '') return null
  return `${u.protocol}//${host}${u.port ? `:${u.port}` : ''}`
}

/**
 * Whether a URL is on a pinned origin. Exact equality on the normalised
 * origin — not a suffix test, not a hostname `includes`, not a wildcard, for
 * the reason set out at `src/shared/credproxy.ts:38-57`: a pin for
 * `ci.example.com` that also matched `ci.example.com.evil.tld` hands the token
 * to whoever registered the second domain, and every suffix formulation does
 * exactly that.
 *
 * An unparseable input on either side is not a match. What this buys is that a
 * redirect cannot move a credential; it does not stop DNS moving one, because
 * the pin is a string and the address behind it is resolved at connect time.
 */
export function isPinnedOrigin(url: string, pinnedOrigin: string): boolean {
  const want = normaliseOrigin(pinnedOrigin)
  const got = normaliseOrigin(url)
  return want !== null && got !== null && want === got
}

// ------------------------------------------------------------- redirects

/** Hops this client will follow however many a caller asks for. */
export const MAX_REDIRECT_HOPS = 10

export const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

/**
 * The only headers that survive a redirect to a different origin.
 *
 * An allowlist rather than a list of credential header names, because the list
 * of ways to spell a credential is open-ended — `Authorization`, `Cookie`,
 * `PRIVATE-TOKEN`, `Circle-Token`, `X-Api-Key`, and whatever the next provider
 * invents. GitHub's job-log endpoint is the case that forces the issue: it
 * answers 302 with a signed blob URL on another origin that *rejects* an
 * Authorization header, and forwarding a PAT to wherever a Location points is
 * the classic exfiltration bug.
 */
export const CROSS_ORIGIN_SAFE_HEADERS = new Set([
  'accept',
  'accept-encoding',
  'accept-language',
  'user-agent'
])

export function stripCredentialHeaders(headers: Record<string, string>): {
  headers: Record<string, string>
  dropped: string[]
} {
  const out: Record<string, string> = {}
  const dropped: string[] = []
  for (const [name, value] of Object.entries(headers)) {
    if (CROSS_ORIGIN_SAFE_HEADERS.has(name.toLowerCase())) out[name] = value
    else dropped.push(name)
  }
  return { headers: out, dropped }
}
