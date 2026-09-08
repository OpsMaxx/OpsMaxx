import type { HttpVia } from '../../../shared/httpClient'

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

export function createHttpTransport(
  read: () => HttpTransportOptions,
  report?: TransportReporter
): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init)
    const { via, insecureTls, timeoutMs } = read()

    // Reading the body consumes the Request, so this must happen once, here.
    const body =
      request.method === 'GET' || request.method === 'HEAD'
        ? undefined
        : await request.arrayBuffer()

    const result = await window.opsmaxx.http.request({
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      body,
      via,
      insecureTls,
      timeoutMs
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

    // The client reads `response.url` and passes it to `new URL(...)`. A
    // Response built by hand has an empty url, which throws there and loses the
    // result after a successful round trip, so the real one is put back.
    Object.defineProperty(response, 'url', { value: request.url })
    return response
  }
}
