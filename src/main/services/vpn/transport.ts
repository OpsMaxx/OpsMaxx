import type { DbConnectConfig } from '../../../shared/db'
import type { SshHop } from '../../../shared/ssh'
import { getCachedDatabase, getCachedServer } from '../mcpDataCache'
import { vpnForDatabase, vpnForServer } from './dependencies'
import { resolveChainSecrets } from '../credentialResolver'

// Which VPN a connection rides, resolved in main from the saved record rather
// than sent by the renderer.
//
// The renderer could pass it, but then every caller would have to remember to —
// the terminal, SFTP, the metrics sampler, the database shell, the MCP tools
// and the CLI all build their own config objects. Resolving it here from the
// same cache that already resolves server names means a connection cannot
// accidentally skip its VPN because one call site was written before the
// feature existed.
//
// A reference to a deleted profile resolves to nothing rather than failing:
// `vpnForServer` already checks the profile still exists, because one deleted
// profile must not make a fleet unreachable.

// Constrained to SshHop rather than SshConnectConfig because only `serverId` is
// read here. A caller that dials a server without opening a terminal — the HTTP
// client sends a request down a direct-tcpip channel — has no session id, no
// cols and no rows to invent, and must still ride the right VPN.
export function withVpnTransport<T extends SshHop & { serverId?: string }>(
  cfg: T
): T & { vpnProfileId?: string; serverName?: string } {
  if (!cfg.serverId) return cfg
  const vpnProfileId = vpnForServer(cfg.serverId)
  if (!vpnProfileId) return cfg
  return { ...cfg, vpnProfileId, serverName: getCachedServer(cfg.serverId)?.name }
}

export function withVpnTransportDb(cfg: DbConnectConfig): DbConnectConfig {
  // A test dialog and a saved connection are the same shape, but only a saved
  // one has an id in the cache — an unsaved "Test connection" has nothing to
  // look up, and asking it to pick a VPN it has not been assigned yet would be
  // guessing.
  const vpnProfileId = vpnForDatabase(cfg.id)
  if (!vpnProfileId) return cfg
  return { ...cfg, vpnProfileId, name: cfg.name ?? getCachedDatabase(cfg.id)?.name }
}

/**
 * Credentials AND the VPN, in one call.
 *
 * These two have to happen together on every SSH target and were paired by
 * hand at each call site, which is exactly the arrangement the note at the top
 * of this file warned about: "every caller would have to remember to". Six
 * remembered. Twenty did not.
 *
 * The ones that did not were not obscure — the monitor pane's metrics, the
 * fleet sampler and all four of its probes, broadcast, jobs, Docker,
 * Kubernetes, cron, the log tail, the access committer's staged write, and SSH
 * tunnels. On a directly routable host that omission is invisible, because the
 * dial works either way. On a host reachable ONLY through a VPN it is total:
 * the feature dials the address itself, and a tailnet address is not routed on
 * this machine.
 *
 * Safe to apply everywhere, and that is what makes one helper the right shape
 * rather than a shortcut: `withVpnTransport` is a pure annotation. It returns
 * the config untouched unless the saved record for that `serverId` actually
 * names a VPN profile, so a server with no VPN is unaffected by construction.
 *
 * tests/sshTargetsRideTheirVpn.ts fails the build if a bare
 * `resolveChainSecrets` reappears on an SSH path.
 */
export function preparedSshTarget<T extends SshHop & { serverId?: string; hops?: SshHop[] }>(
  cfg: T
): T & { vpnProfileId?: string; serverName?: string } {
  return withVpnTransport(resolveChainSecrets(cfg))
}
