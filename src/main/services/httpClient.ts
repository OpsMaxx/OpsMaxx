import { app, dialog, type BrowserWindow } from 'electron'
import { createReadStream, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { remoteText } from '../../shared/remoteText'
import http from 'node:http'
import zlib from 'node:zlib'
import type { Transform } from 'node:stream'
import {
  DECODABLE_ENCODINGS,
  MAX_BODY_FILE_BYTES,
  MAX_CA_BYTES,
  MAX_SPEC_FILE_BYTES,
  MAX_REDIRECT_HOPS,
  MAX_RESPONSE_BYTES,
  REDIRECT_STATUSES,
  certificateBlocks,
  clampTimeout,
  contentEncodings,
  isPinnedOrigin,
  methodAllowsBody,
  parseTarget,
  sanitizeHeaders,
  stripCredentialHeaders,
  type HttpRequestSpec,
  type HttpResponseOk,
  type HttpResult,
  type HttpSshTarget
} from '../../shared/httpClient'
import { asSocket, closeDial, dial, startTls, type DialResult } from './netTransport'

/**
 * Executes the HTTP client's requests.
 *
 * Every request is built the same way: open a transport, optionally wrap it in
 * TLS, then speak HTTP over it. The only thing `via` changes is where the
 * transport comes from — a TCP socket from this machine, a direct-tcpip
 * channel on a server's existing SSH connection, or a loopback forward into a
 * VPN. Keeping one path means a request through a server behaves identically
 * to a direct one, including timeouts, the response cap and the redirect rules
 * below.
 *
 * Redirects are `sendOnce` called again on the `Location`, and only when the
 * caller asked for them (`maxRedirects`). A hop to a different origin keeps
 * only `CROSS_ORIGIN_SAFE_HEADERS` and loses the transport and the TLS
 * relaxations with them; nothing that was granted to the host the user named
 * follows a Location to a host the far end named.
 */

// --------------------------------------------------------------- decoding

/**
 * A decompressor for one content coding, or null for one we cannot undo.
 *
 * `deflate` has two spellings in the wild. The RFC says zlib-wrapped, and some
 * servers (IIS historically, and a few reverse proxies since) send raw deflate
 * with no header at all. `deflate-raw` is not a real coding name — it is the
 * internal token `decodeContent` retries with when the wrapped decoder rejects
 * the stream, so both spellings work without guessing from the first byte.
 */
function decoderFor(coding: string): Transform | null {
  switch (coding) {
    case 'gzip':
    case 'x-gzip':
      return zlib.createGunzip()
    case 'deflate':
      return zlib.createInflate()
    case 'deflate-raw':
      return zlib.createInflateRaw()
    case 'br':
      return zlib.createBrotliDecompress()
    // Added to Node after this app's floor, so it is probed rather than
    // assumed. A build without it treats zstd as undecodable, which is the
    // same outcome as any other coding we do not implement.
    case 'zstd': {
      const make = (zlib as unknown as { createZstdDecompress?: () => Transform })
        .createZstdDecompress
      return typeof make === 'function' ? make() : null
    }
    default:
      return null
  }
}

/**
 * Undo one coding, stopping at `limit` bytes.
 *
 * The limit is enforced DURING decompression rather than after, which is the
 * whole point: a few hundred kilobytes of gzip can expand to gigabytes, and a
 * decoder that allocates the full output before anyone checks its size has
 * already taken main's heap with it. Streaming means the cap is a counter, and
 * hitting it destroys the decoder mid-flight.
 */
function inflateOnce(
  input: Buffer<ArrayBuffer>,
  coding: string,
  limit: number
): Promise<{ out: Buffer<ArrayBuffer>; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const stream = decoderFor(coding)
    if (!stream) {
      reject(new Error(`No decoder for ${coding}`))
      return
    }
    const chunks: Buffer<ArrayBuffer>[] = []
    let size = 0
    let stopped = false

    stream.on('data', (chunk: Buffer<ArrayBuffer>) => {
      if (stopped) return
      if (size + chunk.length > limit) {
        chunks.push(chunk.subarray(0, limit - size))
        stopped = true
        // Resolve before destroying: destroy emits an error on some streams,
        // and the handler below must not turn a successful truncation into a
        // failed request.
        resolve({ out: Buffer.concat(chunks), truncated: true })
        stream.destroy()
        return
      }
      chunks.push(chunk)
      size += chunk.length
    })
    stream.on('end', () => {
      if (!stopped) resolve({ out: Buffer.concat(chunks), truncated: false })
    })
    stream.on('error', (err) => {
      if (!stopped) reject(err)
    })
    stream.end(input)
  })
}

/**
 * The body as the server meant it, with `Content-Encoding` undone.
 *
 * Three rules, each of which is a bug if it goes the other way:
 *
 *   - Codings are undone in REVERSE. The header lists them in the order they
 *     were applied, so `gzip, br` is brotli over gzip and decoding left to
 *     right produces garbage on the first step.
 *   - A coding we cannot undo returns the ORIGINAL bytes with no `decodedFrom`.
 *     Half-decoded output that claims to be decoded is worse than compressed
 *     output that says so.
 *   - A decoder that rejects the stream does the same. The common case is a
 *     server sending raw deflate under the wrapped name, which is retried once;
 *     anything else is a body we should hand over untouched rather than
 *     failing a request that genuinely succeeded.
 */
async function decodeContent(
  body: Buffer<ArrayBuffer>,
  encodings: string[],
  limit: number
): Promise<{ body: Buffer<ArrayBuffer>; truncated: boolean; decodedFrom?: string }> {
  if (encodings.length === 0) return { body, truncated: false }
  if (encodings.some((c) => !DECODABLE_ENCODINGS.has(c))) return { body, truncated: false }

  let out = body
  let truncated = false
  for (const coding of [...encodings].reverse()) {
    try {
      const step = await inflateOnce(out, coding, limit)
      out = step.out
      truncated = step.truncated
    } catch {
      if (coding !== 'deflate') return { body, truncated: false }
      try {
        const step = await inflateOnce(out, 'deflate-raw', limit)
        out = step.out
        truncated = step.truncated
      } catch {
        return { body, truncated: false }
      }
    }
    // A body cut short is not a valid input to the next decoder, so stop here
    // and report what we have rather than feeding it a fragment.
    if (truncated) break
  }
  return { body: out, truncated, decodedFrom: encodings.join(', ') }
}

/** Node attaches a `code` to transport errors; surfacing it lets the UI explain the failure. */
function codeOf(err: unknown): string | undefined {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  return typeof code === 'string' ? code : undefined
}

/**
 * Why a request that the caller routed through a server or a VPN did not go
 * that way.
 *
 * Without this the user sees `getaddrinfo ENOTFOUND ghes-blob.internal` — a
 * hostname they never typed — and, on the refused branch, advice to "send the
 * request through that server", which is precisely what they configured. The
 * mechanism is invisible: a third party chose the second host, and the route
 * they granted the first host does not extend to it.
 */
function explainDroppedRoute(
  error: string,
  dropped: { from: string; to: string; hadRoute: boolean }
): string {
  // The ECONNREFUSED tail is actively wrong here — it tells them to do the
  // thing the policy just declined to do — so it is cut rather than appended to.
  const bare = error.replace(
    / — nothing is listening there\. If the service is bound to the server's loopback, send the request through that server\./,
    ''
  )
  const what = dropped.hadRoute
    ? 'was reached from this machine rather than through the route you configured'
    : 'was reached with normal certificate checking'
  return (
    `${bare} — ${remoteText(dropped.to, 120)} ${what}: ` +
    `${remoteText(dropped.from, 120)} redirected there, and a redirect target does not inherit ` +
    'the route, private CA or certificate exemption you granted the host you named.'
  )
}

function messageOf(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  // A self-signed certificate is reported as Node states it, with no advice
  // to switch verification off: the HTTP client never offers that from an
  // error (its fix is adding the CA), and a suggestion here would read as one.
  if (codeOf(err) === 'ECONNREFUSED') {
    return `${raw} — nothing is listening there. If the service is bound to the server's loopback, send the request through that server.`
  }
  return raw
}

export interface HttpRequestContext {
  /**
   * Merges the server's stored credentials into the hop the renderer sent, and
   * rewrites the first hop when the server sits behind a VPN. Supplied by
   * main's IPC layer — the same `resolveChainSecrets`/`withVpnTransport`
   * pipeline the terminal and SFTP go through — so this service never reads
   * secrets itself and stays unit-testable with a stub.
   */
  prepare: (target: HttpSshTarget) => HttpSshTarget
}

const ABORTED: HttpResult = { ok: false, error: 'The request was cancelled.', code: 'ABORTED' }

/** One request over one transport. `httpRequest` calls it once per redirect hop. */
interface Hop {
  url: string
  /** Already uppercased. */
  method: string
  /** Already sanitized, and already stripped if this hop crossed an origin. */
  headers: Record<string, string>
  body?: ArrayBuffer
}

async function sendOnce(
  hop: Hop,
  spec: HttpRequestSpec,
  ctx: HttpRequestContext,
  signal: AbortSignal | undefined
): Promise<HttpResult> {
  const target = parseTarget(hop.url)
  if ('error' in target) return { ok: false, error: target.error }

  const timeoutMs = clampTimeout(spec.timeoutMs)
  const { method, headers } = hop

  let dialled: DialResult | null = null
  let dialling: Promise<DialResult> | null = null
  if (signal?.aborted) return ABORTED
  // Set once the request exists, so an abort mid-body can end it. Before that,
  // an abort destroys what the dial opened, and the TLS await below throws.
  let abortRequest: (() => void) | null = null
  const onAbort = (): void => {
    if (abortRequest) abortRequest()
    // Only the stream: `finally` releases the rest, and releasing a pooled
    // connection twice would hand back a reference this request never took.
    else dialled?.transport.destroy()
  }
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    dialling = dial(spec.via, target.hostname, target.port, timeoutMs, (t) => ctx.prepare(t))
    // A dial through a slow SSH handshake is the longest wait there is, so an
    // abort must not sit behind it. The dial is left to finish and closed then.
    dialled = await (signal
      ? Promise.race([
          dialling,
          new Promise<never>((_, reject) => {
            if (signal.aborted) reject(new Error('aborted'))
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
          })
        ])
      : dialling)

    const socket = target.tls
      ? await startTls(
          dialled.transport,
          target.hostname,
          spec.insecureTls === true,
          timeoutMs,
          spec.caPem
        )
      : asSocket(dialled.transport)

    return await new Promise<HttpResult>((resolve) => {
      const started = Date.now()
      let settled = false
      const finish = (result: HttpResult): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(result)
      }

      const timer = setTimeout(() => {
        request.destroy()
        socket.destroy()
        finish({ ok: false, error: `Timed out after ${timeoutMs}ms`, code: 'ETIMEDOUT' })
      }, timeoutMs)
      abortRequest = () => {
        request.destroy()
        socket.destroy()
        finish(ABORTED)
      }

      // `createConnection` is an AGENT option, not a request option: with
      // `agent: false` Node builds its own agent and ignores it, opening a
      // fresh TCP connection instead — which would silently dial the target
      // directly even when the user asked to go through a server, and would
      // redo TLS with verification back on. Handing the socket over on a real
      // agent is the only way it is actually used.
      //
      // `http` rather than `https` even for TLS targets, because the socket is
      // already encrypted by startTls above. `https` would try to negotiate TLS
      // a second time, inside the tunnel it just built.
      const agent = new http.Agent({ keepAlive: false, maxSockets: 1 })
      agent.createConnection = () => socket

      // THE LENGTH OF THE BODY, WHICH NOTHING ELSE WILL SUPPLY.
      //
      // `content-length` is in RESERVED_HEADERS, so a caller's value is
      // stripped and this is the only place it can be set. Node only falls
      // back to `Transfer-Encoding: chunked` for methods whose
      // useChunkedEncodingByDefault is true, and DELETE and OPTIONS are not
      // among them -- so a DELETE with a body went out with neither header and
      // the server read it as empty. Measured: POST sent 7 body bytes, DELETE
      // sent 0. Elasticsearch, Neo4j and every bulk-delete API take a body on
      // DELETE, and the client offers an editor for it.
      //
      // It fixes the other direction too. POST, PUT and PATCH were always
      // chunked, and a presigned S3 PUT answers 501 to chunked while SigV4
      // requires the length -- "curl works, the app does not".
      const outgoing =
        hop.body && methodAllowsBody(method)
          ? { ...headers, 'Content-Length': String(hop.body.byteLength) }
          : headers

      const request = http.request(
        {
          method,
          // Still needed: they build the request line and the Host header.
          host: target.hostname,
          port: target.port,
          path: target.path,
          headers: outgoing,
          // One request per transport. Keeping it alive would strand an SSH
          // channel for every request the user ever sent.
          agent
        },
        (res) => {
          // A stream is not a response, and this client buffers.
          //
          // `text/event-stream` never ends on its own, so buffering one means
          // sitting on the socket until the request timeout and then reporting
          // ETIMEDOUT — a Send button that appears to hang, for a request the
          // server answered instantly. Refusing immediately is the honest
          // version of the same limitation, and it names the limitation rather
          // than looking like a broken endpoint.
          //
          // Streaming properly needs a chunked IPC channel of its own. When
          // that exists, this guard is what it replaces.
          const contentType = String(res.headers['content-type'] ?? '')
          if (/^\s*text\/event-stream\b/i.test(contentType)) {
            res.destroy()
            finish({
              ok: false,
              error:
                'This endpoint answers with a server-sent event stream, which OpsMaxx cannot display yet — the response is read in full before it is shown, and a stream has no end to wait for.',
              code: 'ESTREAMUNSUPPORTED'
            })
            return
          }

          const chunks: Buffer[] = []
          let size = 0
          let truncated = false

          res.on('data', (chunk: Buffer) => {
            if (truncated) return
            if (size + chunk.length > MAX_RESPONSE_BYTES) {
              chunks.push(chunk.subarray(0, MAX_RESPONSE_BYTES - size))
              size = MAX_RESPONSE_BYTES
              truncated = true
              res.destroy()
              return
            }
            chunks.push(chunk)
            size += chunk.length
          })

          // `end` and `close` both land here (see below), and decoding is
          // async — so without this the second one starts a second decode of
          // the same buffer while the first is still running.
          let finishing = false
          const done = (): void => {
            if (finishing) return
            finishing = true

            const headerPairs = Object.entries(res.headers).map(
              ([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v ?? '')] as const
            )
            // Taken from the raw array BEFORE the join above. This is the one
            // header that cannot be put back together afterwards.
            const setCookie = res.headers['set-cookie']

            const raw = Buffer.concat(chunks)
            void decodeContent(raw, contentEncodings(Object.fromEntries(headerPairs)), MAX_RESPONSE_BYTES)
              .then(({ body, truncated: expandedPastCap, decodedFrom }) => {
                finish({
                  ok: true,
                  status: res.statusCode ?? 0,
                  statusText: res.statusMessage ?? '',
                  headers: Object.fromEntries(headerPairs),
                  ...(setCookie && setCookie.length > 0 ? { setCookie } : {}),
                  body: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
                  durationMs: Date.now() - started,
                  // Either end can cut the body short: the socket read, or the
                  // decoder expanding past the cap.
                  truncated: truncated || expandedPastCap,
                  ...(decodedFrom ? { decodedFrom } : {})
                })
              })
          }
          res.on('end', done)
          // A capped body destroys the stream, which ends it via `close`
          // rather than `end`. Without this the response never resolves.
          res.on('close', done)
          res.on('error', (err) => finish({ ok: false, error: messageOf(err), code: codeOf(err) }))
        }
      )

      request.on('error', (err) => finish({ ok: false, error: messageOf(err), code: codeOf(err) }))
      if (hop.body && methodAllowsBody(method)) request.write(Buffer.from(hop.body))
      request.end()
    })
  } catch (err) {
    if (signal?.aborted) {
      // The dial lost the race: close it whenever it does arrive.
      if (!dialled) void dialling?.then(closeDial, () => undefined)
      return ABORTED
    }
    return { ok: false, error: messageOf(err), code: codeOf(err) }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    // The channel belongs to this request; the pooled SSH connection does not,
    // and a VPN forward opened for this request — including the one that
    // failed — is a listener per attempt if nobody closes it.
    if (dialled) closeDial(dialled)
  }
}

function locationOf(res: HttpResponseOk): string | null {
  if (!REDIRECT_STATUSES.has(res.status)) return null
  const raw = Object.entries(res.headers).find(([k]) => k.toLowerCase() === 'location')?.[1]
  return raw && raw.trim() !== '' ? raw.trim() : null
}

/**
 * `signal` aborts the request: the socket, the SSH channel or VPN forward, and
 * any redirect not yet followed. The result is then `{ ok: false, code: 'ABORTED' }`.
 */
export async function httpRequest(
  spec: HttpRequestSpec,
  ctx: HttpRequestContext,
  signal?: AbortSignal
): Promise<HttpResult> {
  const maxHops = Math.min(Math.max(Math.floor(spec.maxRedirects ?? 0), 0), MAX_REDIRECT_HOPS)
  const { headers } = sanitizeHeaders(spec.headers ?? {})

  // `node:http` sends no User-Agent of its own - curl and browsers add one, the
  // Node module does not - and GitHub's REST API refuses a request without one
  // with 403 "Request forbidden by administrative rules", which reads as a
  // rejected token rather than a malformed request. That is a property of every
  // request this client makes rather than of one provider, so the default lives
  // here instead of in a provider's header block.
  //
  // A caller that sets its own still wins, including the API client's own
  // requests, where the point is to send exactly what the user typed.
  // `CROSS_ORIGIN_SAFE_HEADERS` already carries `user-agent` across a redirect.
  if (!Object.keys(headers).some((name) => name.toLowerCase() === 'user-agent')) {
    headers['User-Agent'] = `OpsMaxx/${app.getVersion()}`
  }

  // Set when a cross-origin hop lost the route or the TLS relaxations, so a
  // later failure can say why it was reached the way it was.
  let dropped: { from: string; to: string; hadRoute: boolean } | null = null
  let hop: Hop = {
    url: spec.url,
    method: (spec.method || 'GET').toUpperCase(),
    headers,
    body: spec.body
  }

  // The per-hop spec, which is the original one only until a Location moves the
  // request to another origin. See the cross-origin branch below for why.
  let hopSpec = spec

  for (let hops = 0; ; hops++) {
    const res = await sendOnce(hop, hopSpec, ctx, signal)
    // A caller that did not ask to follow gets the 3xx itself, which is what
    // every caller before `maxRedirects` existed relied on.
    if (!res.ok && dropped) return { ...res, error: explainDroppedRoute(res.error, dropped) }
    if (!res.ok) return res
    // `finalUrl` names the hop that produced this response, and so the host
    // its Set-Cookie belongs to. Intermediate hops' cookies are never returned:
    // a cookie from wherever a redirect pointed must not be filed under the
    // host the user typed, or it is sent there next time.
    const answer: HttpResponseOk = { ...res, finalUrl: hop.url, ...(dropped ? { routeDropped: true } : {}) }
    if (maxHops === 0) return answer

    const location = locationOf(res)
    if (location === null) return answer
    if (hops >= maxHops) {
      return {
        ok: false,
        error: `Stopped after ${maxHops} redirect${maxHops === 1 ? '' : 's'}; ${remoteText(hop.url, 120)} redirected again.`,
        code: 'ETOOMANYREDIRECTS'
      }
    }

    let next: string
    try {
      next = new URL(location, hop.url).toString()
    } catch {
      return {
        ok: false,
        // `location` is a header the far end wrote. It reaches the UI and, for
        // a CI connection, MCP tool results — so it is flattened and capped on
        // the way into a message the same way any other remote text is. A
        // Location carrying a bidi override would otherwise reverse the
        // sentence it lands in.
        error: `The redirect pointed at something that is not a URL: ${remoteText(location, 120)}`
      }
    }

    // The one rule that matters. GitHub answers a job-log request with a 302
    // to a signed blob URL on another origin, and that URL rejects an
    // Authorization header — forwarding the PAT there would both fail and hand
    // the token to whatever the Location named.
    const crossOrigin = !isPinnedOrigin(next, hop.url)
    const nextHeaders = crossOrigin ? stripCredentialHeaders(hop.headers).headers : hop.headers

    // A PER-HOST TRUST DECISION MUST NOT BECOME A GLOBAL ONE FOR THE LENGTH OF
    // A REDIRECT CHAIN. `via`, `insecureTls` and `caPem` are all answers to the
    // question "what do I grant THIS host", asked once about the URL the user
    // typed. The far end chooses where the next hop goes, so on an origin
    // change all three are dropped and stay dropped:
    //
    //   - `via` is the serious one. A self-hosted GitLab or Jenkins answering
    //     `302 Location: http://10.0.0.5:8080/admin` would otherwise have that
    //     URL fetched through the user's SSH direct-tcpip channel or VPN
    //     forward and the body handed back as a build log — a read primitive
    //     into a private network, pointed by the remote side, with the
    //     credential stripping doing nothing to stop it. Direct is the only
    //     transport the far end cannot aim.
    //   - `insecureTls` and `caPem` say "for THIS request"
    //     (shared/httpClient.ts:65-72), and a hop to another origin is a
    //     different request to a different host. A user who skipped
    //     verification for their own Jenkins did not skip it for wherever
    //     Jenkins points, and a company CA is not evidence about a third party.
    //
    // Sticky rather than recomputed from `spec`, so a chain that goes
    // A → B → A cannot walk back into the tunnel on the third hop.
    if (crossOrigin && (hopSpec.via.kind !== 'direct' || hopSpec.insecureTls || hopSpec.caPem)) {
      // Remembered, because the failure this causes is otherwise undiagnosable.
      // The request fails at a hostname the user never typed, with Node's own
      // message, and nothing says a redirect happened or that the route was
      // taken away — the ECONNREFUSED branch of `messageOf` even advises
      // routing through a server, which is exactly what they already did.
      dropped = { from: hop.url, to: next, hadRoute: hopSpec.via.kind !== 'direct' }
      hopSpec = { ...hopSpec, via: { kind: 'direct' }, insecureTls: false, caPem: undefined }
    }

    // 307/308 keep the method AND the body. To the same origin that is what
    // was asked for; to another origin it would re-send the body, often a
    // login form or a token exchange, to a host the far end chose, direct.
    // Refused with a reason rather than silently followed or silently emptied.
    if (
      crossOrigin &&
      (res.status === 307 || res.status === 308) &&
      hop.body &&
      hop.body.byteLength > 0 &&
      methodAllowsBody(hop.method)
    ) {
      return {
        ok: false,
        error:
          `${remoteText(hop.url, 120)} answered ${res.status} with ${remoteText(next, 120)}, on another origin, ` +
          'and asked for the request body to be sent there. OpsMaxx does not send a body across origins on a redirect; ' +
          'send the request to that URL yourself if that is what you mean.',
        code: 'ECROSSORIGINBODY'
      }
    }

    // 303 always, and 301/302 by universal practice, turn a non-idempotent
    // request into a GET. 307/308 exist precisely to keep method and body.
    const downgrade = res.status !== 307 && res.status !== 308 && hop.method !== 'HEAD'
    hop = {
      url: next,
      method: downgrade ? 'GET' : hop.method,
      headers: nextHeaders,
      body: downgrade ? undefined : hop.body
    }
  }
}

// ------------------------------------------------------------ cancellation

/**
 * In-flight requests that named themselves, keyed `${senderId}:${requestId}`.
 *
 * Keyed by the sender so one window can only ever cancel its own requests:
 * the ids are chosen by the renderer, and another webContents naming the same
 * string reaches a different key (review SEC-L2).
 */
const inFlight = new Map<string, AbortController>()

/** The number of requests that can currently be cancelled. For tests. */
export function inFlightCount(): number {
  return inFlight.size
}

/**
 * `httpRequest`, cancellable through `cancelHttpRequest` when the spec carries
 * a `requestId`. A malformed id or one already in flight is refused rather
 * than overwritten: overwriting would orphan the first request's controller,
 * and that request could then never be cancelled.
 */
export async function trackedHttpRequest(
  senderId: number,
  spec: HttpRequestSpec,
  ctx: HttpRequestContext
): Promise<HttpResult> {
  const id: unknown = spec?.requestId
  if (id === undefined) return httpRequest(spec, ctx)
  if (typeof id !== 'string' || id.length === 0 || id.length > 64) {
    return { ok: false, error: 'A request id is a string of 1 to 64 characters.' }
  }
  const key = `${senderId}:${id}`
  if (inFlight.has(key)) {
    return { ok: false, error: 'A request with this id is already in flight.' }
  }
  const controller = new AbortController()
  inFlight.set(key, controller)
  try {
    return await httpRequest(spec, ctx, controller.signal)
  } finally {
    inFlight.delete(key)
  }
}

/** Abort this sender's request `requestId`. Anything else is a no-op. */
export function cancelHttpRequest(senderId: number, requestId: unknown): void {
  if (typeof requestId !== 'string') return
  inFlight.get(`${senderId}:${requestId}`)?.abort()
}

// ------------------------------------------------------------------ files
//
// The renderer never names a path in either direction. A save goes where the
// user points the dialog main shows; a pick comes back as a basename and
// bytes. A path the renderer could supply is a path a compromised renderer
// could aim — `http:readSpecFile` was that bug.

// C0, DEL, C1 and the bidi controls: U+202E turns `a‮fdp.exe` into what
// reads as `aexe.pdf` in the dialog the user is trusting.
// eslint-disable-next-line no-control-regex -- matching them is the point
const UNSAFE_NAME = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g

/** A server-suggested file name, reduced to something safe to offer. */
export function safeFileName(suggested: unknown): string {
  const raw = typeof suggested === 'string' ? suggested : ''
  // Both separators: a name from a Windows server arrives with backslashes.
  const base = (raw.split(/[\\/]/).pop() ?? '').replace(UNSAFE_NAME, '').trim().slice(0, 200)
  return base === '' || base === '.' || base === '..' ? 'response' : base
}

/**
 * Save response bytes where the user picks. The dialog starts in Downloads
 * with a sanitised name; the bytes are written unmodified. Resolves to the
 * path, or null when dismissed (review SEC-L1).
 */
export async function saveResponse(
  win: BrowserWindow | null,
  suggestedName: unknown,
  bytes: unknown
): Promise<string | null> {
  if (!(bytes instanceof ArrayBuffer)) throw new Error('A response to save is bytes.')
  const defaultPath = join(app.getPath('downloads'), safeFileName(suggestedName))
  const options = { title: 'Save response', defaultPath }
  const chosen = await (win ? dialog.showSaveDialog(win, options) : dialog.showSaveDialog(options))
  if (chosen.canceled || !chosen.filePath) return null
  writeFileSync(chosen.filePath, Buffer.from(bytes))
  return chosen.filePath
}

async function pickFile(
  win: BrowserWindow | null,
  title: string,
  filters?: Electron.FileFilter[]
): Promise<string | null> {
  const options: Electron.OpenDialogOptions = { title, properties: ['openFile'], ...(filters ? { filters } : {}) }
  const chosen = await (win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options))
  return chosen.canceled ? null : (chosen.filePaths[0] ?? null)
}

/**
 * Up to `cap` bytes of `path`, or null when it is longer. One bounded stream
 * rather than `stat` then `readFile`: a file that grows between the two would
 * be read past the cap (review SEC-L5).
 */
function readCapped(path: string, cap: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    // `end` is inclusive, so this reads at most cap + 1 bytes: one more than
    // allowed is how "too large" is told apart from "exactly the cap".
    const stream = createReadStream(path, { start: 0, end: cap })
    stream.on('data', (chunk: string | Buffer) => {
      const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      chunks.push(b)
      size += b.length
    })
    stream.on('error', reject)
    stream.on('end', () => resolve(size > cap ? null : Buffer.concat(chunks)))
  })
}

const mib = (n: number): number => Math.round(n / (1024 * 1024))

/** A request body from disk: the basename and the bytes, never the path. */
export async function chooseBodyFile(
  win: BrowserWindow | null
): Promise<{ name: string; bytes: ArrayBuffer } | { error: string } | null> {
  const path = await pickFile(win, 'Choose a file to send')
  if (!path) return null
  const data = await readCapped(path, MAX_BODY_FILE_BYTES)
  if (!data) return { error: `That file is larger than ${mib(MAX_BODY_FILE_BYTES)} MiB, the most a request body can be.` }
  return {
    name: basename(path),
    bytes: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
  }
}

/**
 * An OpenAPI description from disk: its basename and its text, never the path.
 * Nothing re-reads the file later, and `importedFrom` keeps only the name, so
 * the renderer has no use for where it lives.
 */
export async function chooseSpecFile(
  win: BrowserWindow | null
): Promise<{ name: string; text: string } | { error: string } | null> {
  const path = await pickFile(win, 'Choose an OpenAPI description', [
    { name: 'OpenAPI', extensions: ['json', 'yaml', 'yml'] },
    { name: 'All files', extensions: ['*'] }
  ])
  if (!path) return null
  const data = await readCapped(path, MAX_SPEC_FILE_BYTES)
  if (!data) {
    return { error: `That file is larger than ${mib(MAX_SPEC_FILE_BYTES)} MiB. An OpenAPI description this large is almost certainly not one.` }
  }
  return { name: basename(path), text: data.toString('utf8') }
}

/** A CA from disk: its certificate blocks only, refused if it holds a private key. */
export async function chooseCaFile(
  win: BrowserWindow | null
): Promise<{ pem: string } | { error: string } | null> {
  const path = await pickFile(win, 'Choose a CA certificate', [
    { name: 'Certificates', extensions: ['pem', 'crt', 'cer'] },
    { name: 'All files', extensions: ['*'] }
  ])
  if (!path) return null
  const data = await readCapped(path, MAX_CA_BYTES)
  if (!data) return { error: `That file is larger than ${mib(MAX_CA_BYTES)} MiB, which no CA bundle is.` }
  return certificateBlocks(data.toString('utf8'))
}

// -------------------------------------------------------------- navigation

/**
 * Keep the main window on the app.
 *
 * The HTTP client renders text the far end wrote — response headers, OpenAPI
 * descriptions, GraphQL docs — always as React text nodes. The day something
 * renders one as HTML instead, an injected `<form action=https://evil>` would
 * navigate the main window to a remote origin that still has the preload
 * bridge (`sandbox: false`, `window.opsmaxx.*`); the prod CSP has no
 * `form-action`, and that directive does not fall back to `default-src`.
 * Refusing every navigation away from the app's own URL closes it whatever
 * renders what (review SEC-M9). A reload of the app itself is still allowed.
 */
export function guardNavigation(contents: {
  getURL(): string
  on(event: 'will-navigate', listener: (e: { url: string; preventDefault(): void }) => void): unknown
}): void {
  // The URL the window is showing, read at the moment of the attempt rather than
  // rebuilt from a path: `loadFile`'s encoding of a path with spaces or non-ASCII
  // in it is Chromium's, and a hand-built file URL that differed by one escape
  // would refuse the app's own reload.
  contents.on('will-navigate', (e) => {
    if (withoutHash(e.url) !== withoutHash(contents.getURL())) e.preventDefault()
  })
}

function withoutHash(url: string): string {
  try {
    const u = new URL(url)
    u.hash = ''
    return u.href
  } catch {
    return url
  }
}
