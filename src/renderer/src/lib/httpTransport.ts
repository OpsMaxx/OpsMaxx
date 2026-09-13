import type { HttpVia } from '../../../shared/httpClient'
import { resolveSecrets, resolveUrl, type SecretLookup } from '../../../shared/apiSecrets'
import { useVault } from '../store/vault'

/**
 * A `fetch`-shaped function backed by OpsMaxx's main process.
 *
 * The API client accepts this as its `customFetch`, so every request it sends
 * leaves from Node rather than from this window. That is what lets a request
 * reach a self-signed endpoint, a service on a server's loopback, or an API
 * with no CORS headers — none of which the renderer's own fetch can do.
 */
export interface HttpTransportOptions {
  via: HttpVia
  insecureTls: boolean
  timeoutMs?: number
  /** A private CA to trust for these requests, in addition to the system roots. */
  caPem?: string
}

/**
 * Told about every transport failure, and about the first success after one.
 *
 * The API client logs a rejected fetch to the console and renders nothing, so
 * a request that fails for a OpsMaxx-shaped reason — an untrusted
 * certificate, a service that is only reachable through a server — would look
 * to the user like a button that does nothing. OpsMaxx knows exactly why it
 * failed, so it reports it in its own chrome instead.
 */
export type TransportReporter = (error: string | null) => void

/**
 * The vault, as the transport sees it: one question and one lookup.
 *
 * Read at SEND time from the live store rather than captured when the
 * transport is built. The transport outlives an unlock — it is created once
 * with the client and used for the rest of the session — so a snapshot taken
 * at construction would report the vault locked forever, or, worse, keep
 * serving values from a vault that has since re-locked.
 */
function liveVault(): SecretLookup {
  const state = useVault.getState()
  return {
    unlocked: state.unlocked,
    read: ({ entryId, field }) => {
      const entry = state.entries.find((e) => e.id === entryId)
      if (!entry) return null
      return field === 'username' ? entry.username : entry.password
    }
  }
}

/**
 * How many redirects a `RequestInit.redirect` mode asks for.
 *
 * `fetch` defaults to `'follow'`, and the API client sends that, so until now
 * this transport silently followed none of them: main only follows when
 * `maxRedirects` is set, and nothing ever set it. A login that answers 302
 * looked like a blank 302 rather than the page behind it.
 *
 * Five, not `MAX_REDIRECT_HOPS`, because a chain longer than five is a loop
 * far more often than it is an API — and main clamps to the hard ceiling
 * anyway, so this only has to be a sensible default rather than a safe one.
 */
const FOLLOW_HOPS = 5

function hopsFor(redirect: RequestRedirect | undefined): number {
  return redirect === 'manual' || redirect === 'error' ? 0 : FOLLOW_HOPS
}

export function createHttpTransport(
  read: () => HttpTransportOptions,
  report?: TransportReporter
): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init)
    const { via, insecureTls, timeoutMs, caPem } = read()

    // Reading the body consumes the Request, so this must happen once, here.
    // `arrayBuffer()` is also what keeps multipart working: it serialises a
    // FormData body with the boundary the Request already generated, which a
    // rebuilt body would not match.
    const body =
      request.method === 'GET' || request.method === 'HEAD'
        ? undefined
        : await request.arrayBuffer()

    /**
     * Vault-backed values, substituted here and nowhere earlier.
     *
     * This is the last point before the request leaves the renderer, which is
     * exactly where a credential should enter it: the API client's document
     * holds a `vault:` reference, so a secret is never in the workspace, never
     * in what gets persisted, and never in a backup.
     *
     * A locked vault throws, and the throw is a TypeError by the time it
     * reaches the client — the same shape a transport failure has — so it
     * surfaces in OpsMaxx's own error banner with an unlock offered, rather
     * than sending `Authorization: Bearer ` and collecting a 401 that looks
     * like a wrong password.
     */
    const vault = liveVault()
    let url: string
    let headers: Record<string, string>
    try {
      url = resolveUrl(request.url, vault)
      headers = resolveSecrets(Object.fromEntries(request.headers.entries()), vault)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      report?.(message)
      throw new TypeError(message)
    }

    const result = await window.opsmaxx.http.request({
      url,
      method: request.method,
      headers,
      body,
      via,
      insecureTls,
      timeoutMs,
      ...(caPem ? { caPem } : {}),
      maxRedirects: hopsFor(request.redirect)
    })

    // The client reports a rejected fetch as a failed request, which is what a
    // transport error is. Throwing a TypeError matches what the real fetch
    // does, so its error handling needs no special case for us.
    if (!result.ok) {
      report?.(result.error)
      throw new TypeError(result.error)
    }
    // A response of any status is a working transport — a 500 is the server
    // answering, not a failure to reach it. Clearing here is what stops a
    // stale certificate warning outliving the setting that fixed it.
    report?.(null)

    const response = new Response(result.body, {
      status: result.status,
      statusText: result.statusText,
      headers: result.headers
    })

    /**
     * Cookies, which cannot be handed over as a header.
     *
     * A `Headers` built for a Response carries the "response" guard, and that
     * guard drops `Set-Cookie` on `append` — so putting the cookies back the
     * obvious way puts back nothing at all. The API client reads them through
     * exactly one call, `headers.getSetCookie()`, so defining that method is
     * both necessary and sufficient.
     *
     * Repeated `Set-Cookie` lines are why `setCookie` exists separately on the
     * result at all: main cannot join them into `headers` without destroying
     * them, because an `Expires` date contains a comma.
     */
    Object.defineProperty(response.headers, 'getSetCookie', {
      value: (): string[] => result.setCookie ?? [],
      configurable: true
    })

    // The client reads `response.url` and passes it to `new URL(...)`. A
    // Response built by hand has an empty url, which throws there and loses the
    // result after a successful round trip, so the real one is put back —
    // the RESOLVED one, because a `vault:` token left in it would both fail to
    // parse and put the reference somewhere it does not belong.
    Object.defineProperty(response, 'url', { value: url })
    return response
  }
}
