import { connect as tcpConnect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'

import type { RemoteReach } from '../../../shared/vpnChecks'

// Can this machine reach the OpenVPN server at all?
//
// The addresses come from the profile's OWN `remotes`, never from anything the
// caller types. That is what keeps this from being a port scanner with a
// friendly label: the only thing it can be pointed at is the server the
// operator already configured, and the diagnose target is ignored here on
// purpose.
//
// The certificate is NOT validated. An OpenVPN server presents a certificate
// from a private CA and validating it against the system store would fail on
// every correctly configured server on earth. What is measured is reach; the
// wording in `serverReachCheck` says so rather than letting a green tick imply
// trust.

/** Short. Somebody is watching this, and a dead remote must not hold the whole
 *  checklist for the length of a TCP retry. */
const REACH_TIMEOUT_MS = 4000

/** One remote, tried once. Never throws: a remote that could not be reached IS
 *  the answer, and an exception would lose the other remotes with it. */
export async function reachRemote(r: { host: string; port: number }): Promise<RemoteReach> {
  const why = await tcpReach(r)
  if (why !== null) return { ...r, reached: false, why }
  // Only attempted once TCP is known to work, so a handshake timeout can never
  // be confused with a port that was closed all along.
  return { ...r, reached: true, tls: await tlsHandshakes(r) }
}

/** Null when the connection was accepted; otherwise the reason, in words the
 *  operator can act on. */
function tcpReach(r: { host: string; port: number }): Promise<string | null> {
  return new Promise((resolve) => {
    const s = tcpConnect({ host: r.host, port: r.port })
    let settled = false
    const done = (v: string | null): void => {
      if (settled) return
      settled = true
      s.destroy()
      resolve(v)
    }
    s.setTimeout(REACH_TIMEOUT_MS, () => done('did not answer in time'))
    s.once('connect', () => done(null))
    s.once('error', (e: NodeJS.ErrnoException) => {
      // The three that mean different things to whoever has to fix it.
      if (e.code === 'ECONNREFUSED') done('refused the connection')
      else if (e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN') done('could not be resolved')
      else done(`could not be reached (${e.code ?? 'unknown error'})`)
    })
  })
}

/** True only when a full handshake completed. False covers both a rejection
 *  and a silence, because a server using tls-crypt produces the second one and
 *  neither is a fault -- see `serverReachCheck`. */
function tlsHandshakes(r: { host: string; port: number }): Promise<boolean> {
  return new Promise((resolve) => {
    const s = tlsConnect({
      host: r.host,
      port: r.port,
      // See the header: a private CA is the normal case, and this measures
      // reach rather than trust.
      rejectUnauthorized: false,
      servername: /^[0-9.]+$/.test(r.host) ? undefined : r.host
    })
    let settled = false
    const done = (v: boolean): void => {
      if (settled) return
      settled = true
      s.destroy()
      resolve(v)
    }
    s.setTimeout(REACH_TIMEOUT_MS, () => done(false))
    s.once('secureConnect', () => done(true))
    s.once('error', () => done(false))
  })
}
