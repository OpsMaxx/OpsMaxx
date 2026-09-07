import type { VpnDiagnoseCheck } from './vpn'

// The checks that are about THIS MACHINE rather than about the far side.
//
// The sidecar's probes all run inside the netstack and answer "does anything
// over there respond". This one answers a question the tunnel cannot: whether
// traffic that was supposed to go through it is going somewhere else instead.
// That is a fact about the local routing table, so it is decided here and
// appended to the sidecar's checklist rather than asked of netd, which has no
// view of the host's routes at all.

/** What the caller managed to learn about the host's routing before asking. */
export interface Ipv6LeakInput {
  /** Userspace mode captures nothing: an application reaches the tunnel by
   *  connecting to a listener on purpose. System mode installs routes, and is
   *  the only mode in which "bypass" means anything. */
  mode: 'userspace' | 'system'
  /**
   * True when the profile's own configuration says it carries `::/0`, false
   * when it says it does not, and NULL when the profile cannot say.
   *
   * Null is OpenVPN. Its routes are pushed by the server at connect time and
   * are not in the stored profile at all, so whether IPv6 goes through the
   * tunnel is not a question this file can answer from a spec. Guessing `false`
   * would raise a leak warning on every working IPv6 OpenVPN profile; guessing
   * `true` would hide a real one.
   */
  claimsIpv6: boolean | null
  /**
   * Whether a default IPv6 route is live on this machine, or NULL when the
   * routing table could not be read.
   *
   * Null is the case this check exists to get right. A read that did not
   * happen is not a read that found nothing, and rendering it as "no leak"
   * would be a green tick over a question nobody managed to ask.
   */
  hostHasIpv6Default: boolean | null
  /** Whatever the platform said about where that route points, for the
   *  operator to act on. Absent when there is no such route. */
  where?: string
}

export function ipv6LeakCheck(i: Ipv6LeakInput): VpnDiagnoseCheck {
  if (i.mode === 'userspace') {
    return {
      name: 'ipv6',
      status: 'skipped',
      detail:
        'This profile is in userspace mode, so it installs no routes and captures no traffic. Nothing can bypass a tunnel that nothing is being sent through.'
    }
  }
  if (i.claimsIpv6 === true) {
    return {
      name: 'ipv6',
      status: 'ok',
      detail: 'This profile routes ::/0, so IPv6 goes through the tunnel with everything else.'
    }
  }
  if (i.claimsIpv6 === null) {
    return {
      name: 'ipv6',
      status: 'skipped',
      detail:
        'This engine takes its routes from the server at connect time rather than from the stored profile, so whether IPv6 goes through the tunnel cannot be read here. Check the routing table on this machine once the tunnel is up.'
    }
  }
  if (i.hostHasIpv6Default === null) {
    return {
      name: 'ipv6',
      status: 'skipped',
      detail:
        'This machine’s routing table could not be read, so whether IPv6 is bypassing the tunnel is unknown rather than fine.'
    }
  }
  if (!i.hostHasIpv6Default) {
    return {
      name: 'ipv6',
      status: 'ok',
      detail:
        'This profile does not carry IPv6, and this machine has no default IPv6 route, so there is no IPv6 traffic to bypass it.'
    }
  }
  return {
    name: 'ipv6',
    status: 'failed',
    // The same sentence `detectIpv6Leak` uses at apply time. One wording for
    // one fact: an operator who was warned at connect and then reads this
    // checklist must not have to work out whether they are the same problem.
    detail: `This profile does not carry IPv6, but a default IPv6 route is live ${i.where ?? 'on this machine'}. IPv6 traffic will bypass the tunnel.`
  }
}

// ------------------------------------------------- reaching an OpenVPN server

/**
 * What a probe may say about one `remote` line.
 *
 * WHY A FAILED TLS HANDSHAKE IS NOT A FAILURE. An OpenVPN server configured
 * with `tls-auth` or `tls-crypt` -- which is most of them, and all the
 * well-configured ones -- wraps or encrypts its control channel with a shared
 * key and silently DROPS a packet that arrives without it. A bare TLS
 * ClientHello is exactly such a packet. So a handshake that does not complete
 * is the expected behaviour of a correctly configured server, and reporting it
 * as a failure would send somebody to debug the one thing that was right.
 *
 * What the probe can say without qualification is whether TCP connected: that
 * separates a firewall or DNS problem from a certificate or credential problem,
 * which is the split an operator actually needs. A completed handshake is
 * reported as EXTRA, never as the pass condition.
 */
export type RemoteReach =
  | { host: string; port: number; reached: true; tls: boolean }
  | { host: string; port: number; reached: false; why: string }

/** UDP remotes are not probed. There is no connect to attempt, and sending an
 *  OpenVPN control packet would mean speaking the protocol on somebody's
 *  server -- a different act from seeing whether a port answers. */
export function probableRemotes(
  remotes: { host: string; port: number; proto: string }[]
): { probe: { host: string; port: number }[]; skippedUdp: number } {
  const probe: { host: string; port: number }[] = []
  let skippedUdp = 0
  for (const r of remotes) {
    if (r.proto.toLowerCase().startsWith('udp')) {
      skippedUdp += 1
      continue
    }
    probe.push({ host: r.host, port: r.port })
  }
  return { probe, skippedUdp }
}

export function serverReachCheck(
  results: RemoteReach[],
  skippedUdp: number,
  totalRemotes: number
): VpnDiagnoseCheck {
  if (totalRemotes === 0) {
    return {
      name: 'server',
      status: 'skipped',
      detail:
        'This profile has no remote recorded, so there is no address to try. Re-import it if the server has moved.'
    }
  }
  if (results.length === 0) {
    return {
      name: 'server',
      status: 'skipped',
      detail: `Every remote on this profile is UDP (${skippedUdp}), and a UDP remote cannot be reached by connecting to it — there is nothing to answer unless this app speaks the OpenVPN protocol at your server, which a diagnose button should not do.`
    }
  }
  const ok = results.filter((r): r is Extract<RemoteReach, { reached: true }> => r.reached)
  const udp = skippedUdp > 0 ? ` ${skippedUdp} UDP remote(s) were not tried.` : ''
  if (ok.length === 0) {
    const first = results[0] as Extract<RemoteReach, { reached: false }>
    return {
      name: 'server',
      status: 'failed',
      detail: `None of this profile's ${results.length} TCP remote(s) accepted a connection — ${first.host}:${first.port} ${first.why}. That is a network, DNS or firewall problem rather than a certificate one: nothing got far enough to present one.${udp}`
    }
  }
  const w = ok[0]
  // The handshake is reported as extra. It is real information -- it says the
  // control channel is not key-wrapped -- but it is never what "ok" means.
  const tls = w.tls
    ? ' A TLS handshake also completed, so this server does not wrap its control channel with tls-auth or tls-crypt. The certificate was NOT validated: this measured reach, not trust.'
    : ' The TLS handshake did not complete, which is what a server using tls-auth or tls-crypt is supposed to do to an unkeyed packet — it is not evidence of a problem.'
  return {
    name: 'server',
    status: 'ok',
    detail: `${w.host}:${w.port} accepted a TCP connection, so the server is reachable from this machine.${tls}${udp}`
  }
}
