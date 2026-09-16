import type { Hop, Server } from '../types'
import type { SshHop } from '../../../shared/ssh'

const asAuth = (a: string): SshHop['auth'] =>
  a === 'password' || a === 'agent' ? a : 'key'

// Jump hops for a server. Every consumer (terminal, SFTP, metrics, tunnels)
// must build these identically: dropping serverId/keyPath makes the hop
// authenticate with nothing, and also changes its connection-pool identity so
// it opens a second connection to the same bastion instead of sharing one.
export function sshHopsFor(server: Server): (SshHop & { serverId?: string })[] {
  return server.route.map((h: Hop) => ({
    host: h.host,
    port: h.port,
    username: h.username,
    auth: asAuth(h.auth),
    serverId: h.serverId ?? undefined,
    keyPath: h.keyPath || undefined
  }))
}

/**
 * A server as a connectable target, for callers that dial it without opening a
 * terminal — the HTTP client sends a request down a direct-tcpip channel and
 * has no session id, cols or rows to invent. Credentials are absent for the
 * same reason they are absent from sshHopsFor: main merges them by serverId.
 *
 * PASS THIS, NEVER THE `Server` ITSELF. A Server carries its jump chain in
 * `route`; every consumer in main — resolveChainSecrets, openChain — reads
 * `hops`. Handing a raw Server across the bridge therefore type-checks (the
 * IPC handlers take `cfg: unknown`), resolves credentials fine, and SILENTLY
 * loses the chain, so the read dials the private address from the laptop:
 *
 *   The filesystems could not be read: connect ETIMEDOUT 192.168.19.7:1051
 *
 * That is exactly what shipped in v0.27.0. The fix there wrapped the four
 * on-demand handlers (fleet:storage / kernel / timer / security-list) in
 * resolveChainSecrets + withVpnTransport, which fixed the CREDENTIAL and VPN
 * halves and left the chain broken, because the shape crossing the bridge was
 * still a Server. The `route` -> `hops` rename is the whole bug; this function
 * is the one place that performs it.
 *
 * withVpnTransport fills `vpnProfileId` and `serverName` in main from the
 * saved record keyed on serverId, so nothing here needs to carry them — main
 * deliberately does not trust a caller for the VPN profile.
 */
export function sshTargetFor(server: Server): SshHop & { serverId: string; hops: SshHop[] } {
  return {
    serverId: server.id,
    host: server.host,
    port: server.port,
    username: server.username,
    auth: asAuth(server.auth),
    hops: sshHopsFor(server)
  }
}

export interface SshHopInfo {
  serverId: string
  host: string
  port: number
  username: string
  auth: 'password' | 'key' | 'agent'
  /** The bastion's OWN jump chain. See below for why this is not optional. */
  hops: SshHop[]
}

/**
 * The SSH details the main process needs to open a connection. Credentials are
 * deliberately absent — main merges them from the encrypted store by serverId.
 *
 * `hops` was missing, and its absence is the v0.27.0 bug again on two more
 * surfaces. A server carries its jump chain in `route`; main reads `hops`. Drop
 * the rename and the config still type-checks, still resolves its credential,
 * and SILENTLY dials the bastion's own private address from this laptop — so a
 * database or a tunnel whose jump host is itself behind another jump host fails
 * with a connect timeout naming an address the user never typed.
 *
 * That is not a corner: it is the ordinary shape of an estate with one
 * authentication gateway in front of a second bastion, which is exactly the
 * topology this was reported from.
 *
 * It also decides pool identity. `hopKey` includes the parent, so a hop with no
 * parent is a DIFFERENT connection from the same hop reached through its chain
 * — meaning a database could not share the bastion a terminal had already
 * authenticated even once the forward started pooling.
 */
export function sshHopFor(server: Server): SshHopInfo {
  return {
    serverId: server.id,
    host: server.host,
    port: server.port,
    username: server.username,
    auth: server.auth === 'password' ? 'password' : server.auth === 'agent' ? 'agent' : 'key',
    hops: sshHopsFor(server)
  }
}
