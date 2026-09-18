import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * The check every loopback HTTP server in this app runs before anything else.
 *
 * Three servers bind 127.0.0.1: the MCP bridge on 5177, the credential proxy on
 * 5178, and the RDP relay on a port it picks. Binding to loopback keeps other
 * machines out. It does NOT keep a web page out, and that is the whole reason
 * this file exists.
 *
 * DNS REBINDING, concretely. The user visits any page. That page's origin
 * resolves, briefly, to a real address; the attacker's DNS then answers
 * 127.0.0.1 with a one-second TTL. Script on the page now fetches
 * `http://their-domain:5178/...`, the browser considers it same-origin
 * — same host, same port as the page it came from — so the same-origin policy
 * does not apply, no CORS preflight is sent, and the request arrives at the
 * credential proxy on this machine. From the socket's point of view it came
 * from 127.0.0.1, because it did.
 *
 * What distinguishes it is the headers, and there are two independent tells:
 *
 *  - `Host` carries the name the browser dialled, which is the attacker's
 *    domain and not a loopback literal. A legitimate local client dials
 *    `127.0.0.1` or `localhost` and says so.
 *  - `Origin` is sent by browsers and by essentially nothing else. The MCP
 *    bridge is spoken to by editors and CLIs, the credential proxy by curl and
 *    by scripts, the RDP relay by this app's own renderer over a same-document
 *    WebSocket. None of them has any reason to send one.
 *
 * So the rule is: the Host must be a loopback literal, and an Origin header
 * must not be present at all. The second is the stronger half — refusing every
 * request that carries one is a blunt instrument, and blunt is right here,
 * because the alternative is an allowlist of origins that somebody eventually
 * widens.
 */

/** Hostnames a local client legitimately dials. Compared after the port is
 *  stripped, and case-insensitively, because a `Host` header is neither
 *  normalised nor trustworthy. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

export type LoopbackRefusal = 'host' | 'origin'

/**
 * Splits a `Host` header into its hostname, keeping an IPv6 literal's brackets.
 *
 * `Host` is attacker-controlled, so this does no validation beyond what it
 * needs: anything it cannot parse comes back unchanged and then fails the set
 * membership below, which is the safe direction.
 */
export function hostnameOf(host: string): string {
  const trimmed = host.trim().toLowerCase()
  if (trimmed.startsWith('[')) {
    const close = trimmed.indexOf(']')
    return close === -1 ? trimmed : trimmed.slice(0, close + 1)
  }
  const colon = trimmed.indexOf(':')
  return colon === -1 ? trimmed : trimmed.slice(0, colon)
}

/**
 * Whether this request must be refused, and why.
 *
 * `null` means it may proceed. A missing `Host` is refused: HTTP/1.1 requires
 * one, and a client that omits it is not one of the three this serves.
 */
export function loopbackRefusal(req: IncomingMessage): LoopbackRefusal | null {
  // Checked first, because it is the one that catches a rebound request whose
  // Host happens to be loopback — a page served from `http://localhost:3000`
  // by the user's own dev server, for instance, which is a real configuration
  // and would otherwise pass the Host check outright.
  if (req.headers.origin !== undefined) return 'origin'

  const host = req.headers.host
  if (host === undefined) return 'host'
  return LOOPBACK_HOSTS.has(hostnameOf(host)) ? null : 'host'
}

/**
 * Applies the check and writes the refusal, returning whether the caller
 * should stop.
 *
 * 403 with a body that names the header, because the person who hits this in
 * practice is not an attacker: it is somebody whose editor or script is
 * sending an `Origin` for reasons of its own, and "403" alone would send them
 * to the issue tracker. An attacker learns nothing from it that the refusal
 * itself did not already tell them.
 */
export function refuseNonLoopback(req: IncomingMessage, res: ServerResponse): boolean {
  const refusal = loopbackRefusal(req)
  if (!refusal) return false

  const detail =
    refusal === 'origin'
      ? 'This port refuses any request carrying an Origin header, because browsers send one and local clients do not. If your client sets Origin, stop it.'
      : `This port serves 127.0.0.1 only. The request arrived with Host: ${String(req.headers.host ?? '(none)')}, which is not a loopback name.`

  res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end(detail)
  return true
}

/**
 * The same check for a WebSocket upgrade.
 *
 * `ws` hands the upgrade to a `verifyClient`-style hook before the handshake
 * completes. Refusing there rather than closing afterwards matters: a closed
 * socket looks like a network problem to the page that opened it, while a
 * refused upgrade is a clean 403 the page cannot mistake for anything else.
 */
export function loopbackUpgradeAllowed(req: IncomingMessage): boolean {
  return loopbackRefusal(req) === null
}
