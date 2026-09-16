import type { DbConnectConfig } from '../../../shared/db'
import type { SshHop } from '../../../shared/ssh'
import type { CloudTarget } from '../../../shared/cloud'
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

/**
 * Attach the cloud target a saved server is reached through.
 *
 * A pure annotation, exactly like withVpnTransport above and for the same
 * reason: resolved in main from the saved record rather than sent by the
 * renderer, so a connection cannot skip its provider because one call site was
 * written before the feature existed. A server with no cloud target is returned
 * untouched, which is what makes it safe to apply everywhere.
 *
 * The async half - detecting the CLI, opening a tunnel, minting a credential -
 * deliberately does NOT happen here. This function stays synchronous so that
 * preparedSshTarget can too, and ssh.ts does the dialling where the VPN layer
 * already does its own. Making this async would turn thirty call sites into
 * awaits for no gain.
 */
export function withCloudTransport<T extends SshHop & { serverId?: string; cloudTarget?: CloudTarget }>(
  cfg: T
): T & { cloudTarget?: CloudTarget } {
  /**
   * No server id means nothing is saved to resolve against: the connection
   * editor testing an entry before it exists. Whatever the caller supplied
   * stands, because there is nothing more authoritative — it is the user's own
   * unsaved form input, it reaches one renderer-owned IPC channel, and the
   * broker validates every field before it builds an argument.
   */
  if (!cfg.serverId) return cfg

  /**
   * For anything SAVED the record decides, and a caller-supplied target is
   * discarded rather than merged.
   *
   * Keeping it would be a way to redirect a saved server from outside: pass the
   * id of an ordinary SSH host together with a cloud target, and the connection
   * goes somewhere the record never named. Resolving transports in main from
   * the saved record — never from what the caller claims — is the rule the VPN
   * annotation above is built on, and it has to hold here for the same reason.
   */
  const cloud = getCachedServer(cfg.serverId)?.cloud
  if (!cloud) return cfg.cloudTarget ? { ...cfg, cloudTarget: undefined } : cfg
  return { ...cfg, cloudTarget: cloud }
}

/**
 * The same annotation for the SSH hop a database is tunnelled through.
 *
 * Without it a database reached through a cloud server dials the empty host on
 * that record and fails: `openEphemeralForward` calls `openChain`, which looks
 * for `cloudTarget` and finds nothing, because nothing on the database path
 * ever put one there. The type in shared/db.ts says a cloud-hosted database
 * works; this is what makes that true.
 */
export function withCloudTransportDb(cfg: DbConnectConfig): DbConnectConfig {
  if (!cfg.ssh?.serverId) return cfg
  const cloud = getCachedServer(cfg.ssh.serverId)?.cloud
  if (!cloud) return cfg
  return { ...cfg, ssh: { ...cfg.ssh, cloudTarget: cloud } }
}

/** The bastion a database is tunnelled through, annotated with its own VPN. */
function withVpnTransportJump(cfg: DbConnectConfig): DbConnectConfig {
  if (!cfg.ssh?.serverId) return cfg
  const ssh = withVpnTransport(cfg.ssh as SshHop & { serverId: string })
  return ssh === cfg.ssh ? cfg : { ...cfg, ssh: ssh as DbConnectConfig['ssh'] }
}

export function withVpnTransportDb(cfg: DbConnectConfig): DbConnectConfig {
  /**
   * A test dialog and a saved connection are the same shape, and the rule for
   * each is different.
   *
   * For anything SAVED the record decides and a caller-supplied profile is
   * discarded, exactly as withCloudTransport does with a cloud target and for
   * the same reason: keeping it would be a way to route a saved connection
   * through a tunnel the record never named, from outside main.
   *
   * An UNSAVED one has no record to consult, so the form's own choice stands —
   * it is the user's own input, on its way to being saved a moment later, and
   * there is nothing more authoritative. This used to be described as
   * "guessing"; it is not, and dropping it is what made Test connection
   * silently ignore a VPN the user had just picked.
   */
  /**
   * The bastion's own VPN, which nothing applied.
   *
   * `withCloudTransportDb` annotates the jump host with its cloud target, and
   * the VPN half of the same question was never asked — so a database reached
   * through a bastion that is itself only routable over a tunnel dialled the
   * bastion's private address from this machine and failed with a connect
   * timeout. Exactly the omission the note at the top of this file describes,
   * on the one hop nothing had swept.
   *
   * `withVpnTransport` is a pure annotation keyed on the hop's own serverId, so
   * a bastion with no VPN comes back untouched, and `acquire` does the dialling
   * — including the forward's lifetime and its pool tag. Note this is the
   * bastion's profile, not the database's: `buildOverVpn` handles that one, and
   * clears this field when its forward has already arrived at the bastion.
   */
  const withCloud = withVpnTransportJump(withCloudTransportDb(cfg))
  const saved = getCachedDatabase(cfg.id)
  const vpnProfileId = vpnForDatabase(cfg.id) ?? (saved ? undefined : cfg.vpnProfileId)
  if (!vpnProfileId) {
    return cfg.vpnProfileId ? { ...withCloud, vpnProfileId: undefined } : withCloud
  }
  return { ...withCloud, vpnProfileId, name: cfg.name ?? saved?.name }
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
): T & { vpnProfileId?: string; serverName?: string; cloudTarget?: CloudTarget } {
  // Cloud last, and it is another pure annotation: a server that is not a cloud
  // one comes back untouched, so every existing caller is unaffected and every
  // cloud one is handled without being edited.
  return withCloudTransport(withVpnTransport(resolveChainSecrets(cfg)))
}
