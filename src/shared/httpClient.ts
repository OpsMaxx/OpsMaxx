/**
 * The HTTP client's wire contract between renderer and main.
 *
 * Requests are executed in main rather than by the renderer's own fetch, for
 * three reasons the renderer cannot work around:
 *
 *   - Chromium refuses a self-signed or privately-signed certificate, which is
 *     what most internal services present. Node can be told to trust a pinned
 *     CA, or (explicitly, per request) to skip verification.
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
   */
  insecureTls?: boolean
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
