import type { CloudTarget } from '../../shared/cloud'
import type { RdpSettings } from '../../shared/rdp'

// Re-exported for the same reason the VPN domain is: one definition of the
// record, shared with main, rather than a renderer-only restatement that can
// disagree with it.
export type {
  RdpDesktopSize,
  RdpErrorCode,
  RdpSettings,
  RdpTicket,
  RdpTicketResult
} from '../../shared/rdp'

export type UUID = string

export type WorkspaceColor =
  | 'green'
  | 'purple'
  | 'blue'
  | 'orange'
  | 'red'
  | 'cyan'
  | 'pink'

export interface Workspace {
  id: UUID
  name: string
  color: WorkspaceColor
  hidden: boolean
  locked: boolean
  hasPassword: boolean
}

export type ServerStatus = 'online' | 'idle' | 'offline' | 'connecting'
export type AuthMethod = 'password' | 'key' | 'agent' | 'certificate'

export interface Hop {
  id: UUID
  label: string
  host: string
  port: number
  username: string
  auth: AuthMethod
  // Populated from a saved server; its stored credentials are then used for
  // this hop instead of anything held here.
  serverId?: UUID | null
  // Private key for this hop when it is not backed by a saved server.
  keyPath?: string
}

export interface Server {
  id: UUID
  workspaceId: UUID
  folderId: UUID | null
  name: string
  host: string
  port: number
  username: string
  auth: AuthMethod
  /**
   * Bumped every time this connection profile is saved.
   *
   * Part of the connection's IDENTITY, not a detail of it. Every live
   * connection cache in main was keyed on the server id alone, so editing a
   * record changed the record and no key -- and the next connect was handed a
   * connection still authenticated to the box the record used to name. This
   * travels into the pool key, so a stale entry can never be hit; it is left
   * to idle out rather than raced against the reconnect.
   *
   * A COUNTER rather than a hash of the fields, and that is the whole reason
   * it exists as a field: rotating a credential changes nothing on this record
   * -- secrets live in the OS keychain -- and must still retire the connection
   * that authenticated with the old one. `updateServer` bumps it on the act of
   * saving, not on a field diff.
   *
   * Absent means never edited, which is every record saved before this.
   */
  rev?: number
  status: ServerStatus
  tags: string[]
  favorite: boolean
  os: string
  route: Hop[]
  // Reach this server through a VPN profile when set. The VPN is the outer
  // transport: the route hops above are dialled *through* it, not beside it.
  // Main resolves this from the saved record rather than trusting a caller to
  // pass it, and a reference to a deleted profile means "connect directly"
  // rather than "fail" — one deleted profile must not strand a fleet.
  vpnProfileId: UUID | null
  /**
   * Present when this server is reached through a cloud provider rather than by
   * dialling `host` directly.
   *
   * A cloud server has no address of its own to save: the provider resolves one
   * at connect time, and for a private instance there is no address at all
   * until a tunnel exists. So `host` is left empty on these records and this
   * field is what identifies the machine - a project and instance name, a
   * region and instance id, a resource group and VM.
   *
   * It holds identifiers only. No access token, no refresh token and no key
   * ever reaches this record, because cloud identity stays with the cloud
   * provider's own tooling; reconnecting uses whatever session that tooling has
   * now, not one we captured earlier.
   */
  cloud?: CloudTarget
  /**
   * This account can transfer files but cannot run anything.
   *
   * The ordinary shape of a delivery or backup account: sshd is configured
   * with `ForceCommand internal-sftp`, often chrooted, so SFTP succeeds while
   * a shell and `exec` are both refused. The transport already handles it —
   * SFTP is a subsystem, not a shell — but the app assumed otherwise: opening
   * such a server started a terminal, the shell was refused, and the failure
   * marked the whole server offline.
   *
   * With this set, the server opens on Files, no shell is attempted, and the
   * views that need `exec` (Terminal, Monitor) are not offered rather than
   * offered and broken.
   *
   * Optional like `demo`: absent means an ordinary server, which is what every
   * server saved before this existed is.
   */
  sftpOnly?: boolean
  /**
   * This server also speaks RDP, on the port and with the login named here.
   *
   * A field on `Server` rather than a record of its own, for the same reason
   * `sftpOnly` is: the machine has already been described once — host,
   * workspace, folder, VPN — and a second record would restate all of it and
   * then drift from it. What RDP does get of its own is a tab kind, because a
   * remote desktop is not a shell and cannot share the views of one.
   *
   * Absent means the server does not speak RDP, which is every server saved
   * before this existed.
   */
  rdp?: RdpSettings
  /**
   * This machine speaks RDP and NOT SSH.
   *
   * The two protocols are wholly separate connections, and the app treated
   * only one of them as the reason a server exists: the dialog was titled
   * "Create a new SSH connection profile" and RDP was a checkbox on it, so a
   * Windows box with nothing on port 22 could not be described at all without
   * inventing an SSH account for it.
   *
   * Shaped like `sftpOnly` rather than as a second record, and for the same
   * reason: the machine has been described once — host, workspace, folder,
   * VPN — and a second record would restate all of it and then drift. What
   * this marks is which halves are real, and everything that needs a shell
   * asks before offering one.
   *
   * Absent means the server speaks SSH, which is every server saved before
   * this existed.
   */
  rdpOnly?: boolean
  demo?: boolean
}

export type FolderKind = 'server' | 'database'

export interface Folder {
  id: UUID
  workspaceId: UUID
  name: string
  parentId: UUID | null
  // Connections and databases keep separate folder trees, so a "Staging"
  // folder for servers does not appear in the database sidebar.
  kind: FolderKind
}

// A section in the Fleet Monitor. Groups are a monitoring-only arrangement:
// they are independent of connection folders, so a server can sit under
// "Staging" in the sidebar and under "Databases" on the monitor wall.
export interface MonitorGroup {
  id: UUID
  workspaceId: UUID
  name: string
  collapsed: boolean
  // Cards in this group, in display order.
  serverIds: UUID[]
  // The bucket every unplaced server falls into. One per workspace; it cannot
  // be renamed, deleted or dragged, and always sorts last.
  system?: boolean
}

// The VPN domain lives in src/shared/vpn.ts, shared with main and preload, and
// is re-exported here rather than restated. What used to sit at this spot was a
// renderer-only mock (`rx`/`tx`/`connectedSince`, kinds `pritunl`/`easyconnect`)
// that nothing read; a second definition of the same record is how a renderer
// and a main process end up disagreeing about it.
export type {
  FrpProxy,
  FrpProxyStatus,
  FrpProxyType,
  FrpSpec,
  FrpVisitor,
  OpenVpnAuthMode,
  OpenVpnSpec,
  StrippedDirective,
  VpnBoundListener,
  VpnDependent,
  VpnEngineInfo,
  VpnErrorCode,
  ImportableVpnKind,
  NgrokEndpoint,
  NgrokSpec,
  TailnetPeer,
  NgrokTunnel,
  TailscaleSpec,
  VpnImportResult,
  VpnKind,
  VpnListener,
  VpnLogLine,
  VpnMode,
  VpnProfile,
  VpnPrompt,
  VpnResult,
  VpnSecretRef,
  VpnSpec,
  VpnStartResult,
  VpnState,
  VpnStats,
  VpnStatus,
  VpnValidation,
  VpnValidationIssue,
  WireGuardPeer,
  WireGuardSpec
} from '../../shared/vpn'

export type TunnelKind = 'local' | 'remote' | 'socks'
export interface Tunnel {
  id: UUID
  workspaceId: UUID
  name: string
  kind: TunnelKind
  status: 'active' | 'inactive'
  // SSH server the tunnel is carried over.
  serverId: UUID | null
  listen: string
  target: string
}

export type DbKind = 'postgres' | 'mysql' | 'mssql' | 'mongodb' | 'redis'
export interface DatabaseConn {
  id: UUID
  /**
   * Bumped every time this connection profile is saved. The database half of
   * `Server.rev`, and there for exactly the same reason: main caches one
   * client per database id, so editing a record changed the record and no key
   * -- and the next query was answered by a client still connected to the
   * database the record used to name.
   *
   * Absent means never edited.
   */
  rev?: number
  workspaceId: UUID
  name: string
  kind: DbKind
  host: string
  port: number
  username: string
  database: string
  ssl: boolean
  uri: boolean // true when the connection is defined by a full connection string
  folderId: UUID | null
  // Reach the database through this SSH server (a bastion) when set.
  sshServerId: UUID | null
  // Reach the database through a VPN profile when set. Independent of the
  // bastion above and composable with it: with both, the VPN carries the
  // *bastion*, and the database is reached from there as it always was.
  vpnProfileId: UUID | null
}

/**
 * The views an SSH tab can show. Deliberately NOT the union of every tab's
 * views: 'desktop' lives on RdpTab alone, and putting it here made
 * `{ kind: 'ssh', view: 'desktop' }` a shape the compiler accepted and nothing
 * rendered — which is exactly the blank tab `duplicateOf` produced. A tab's
 * view is declared per kind, below, so the invalid combinations cannot be
 * written rather than being caught by guards someone has to remember.
 */
export type PanelView = 'terminal' | 'monitor' | 'files'
export type ActivityView =
  | 'connections'
  | 'databases'
  | 'tunnels'
  | 'http'
  | 'monitor'
  | 'vault'
  | 'ai'
  | 'settings'

// `view` is deliberately absent here and declared on each member instead. It
// is the one field whose legal values depend entirely on the discriminant.
interface TabBase {
  id: UUID
  // Tabs belong to the workspace they were opened in, so switching workspaces
  // does not show another workspace's sessions.
  workspaceId: UUID
  title: string
  /**
   * Restored from the last run and not yet reconnected.
   *
   * Every tab is MOUNTED at once -- background tabs are hidden with
   * `display: none` rather than unmounted, so that switching workspaces does
   * not kill their sessions. That makes restoring the tab strip and dialling
   * the estate the same act unless something stops it, and dialling eight
   * servers because the app launched is not a thing the app may decide: it can
   * mean eight vault prompts, eight 2FA pushes, and eight authenticated
   * sessions the user did not ask for on a machine that may not be theirs.
   *
   * So a restored tab comes back as itself -- name, kind, view, pane layout --
   * and connects when the user says so. The session panel already has the
   * control for that, because a dropped connection needed it first.
   */
  dormant?: boolean
}

// A tab backed by a saved server. `serverId` is non-null here on purpose: it
// was typed `UUID | null` while every consumer assumed non-null, which is how
// "Session unavailable" became reachable for reasons other than a deleted
// server.
export interface SshTab extends TabBase {
  kind: 'ssh'
  view: PanelView
  serverId: UUID
  /**
   * Set when this tab is a shell inside a container on that server, rather than
   * a shell on the server itself.
   *
   * A field on SshTab rather than a fourth tab kind because that is what it
   * genuinely is: the same connection, the same session machinery, one
   * different command. A separate kind would fork every switch in the app to
   * describe a difference that only exists at connect time.
   *
   * Only 'terminal' is meaningful with it — the Monitor and Files views read
   * the host, not the container, and showing the host's disk usage under a
   * container's name would be worse than not offering them.
   */
  containerRef?: string
  /**
   * The container shell needs sudo because this account cannot reach the docker
   * socket unprivileged.
   *
   * On the tab rather than recomputed at connect time: the panel that knew it
   * may be long gone by the time the session reconnects, and a shell that
   * silently drops the escalation fails in a way that looks like the container
   * died.
   */
  containerSudo?: boolean
}

// A tab backed by a shell on this machine. It has no server, and deliberately
// does not synthesize one: `servers` is persisted (store/persist.ts:16) and
// mirrored into the MCP data cache by `data:save`, so a fake row there would
// make the local terminal an MCP-addressable target without anyone
// registering a tool for it.
export interface LocalTab extends TabBase {
  kind: 'local'
  // A LocalShell.id from src/shared/local.ts. Opaque — a readable prefix plus
  // a digest of the shell's path ('darwin-zsh-b663616e'). Resolve it against
  // the discovered list; never parse it.
  shellId: string
  // Where the shell was started, when the user asked for somewhere specific.
  cwd?: string
  /**
   * Terminal, Files and Monitor — the same three an SSH tab has.
   *
   * Files earned its place because main serves this machine's half from
   * node:fs behind the same channel and the same result shape, so the view
   * needs no server — it takes `server?: Server` and absent means here.
   *
   * Monitor was excluded for a real reason and no longer is. The collector
   * read /proc and Linux `df` semantics, so on a Mac or a Windows box it drew
   * numbers that looked right and were not — a volume at 40% capacity read as
   * 3.7% full, and `df -iP` printed the block columns again so the inode
   * figure was the disk figure wearing a different label. There are now
   * collectors written for those platforms rather than borrowed from Linux,
   * and each reports null where its platform has no equivalent quantity
   * instead of approximating one. See shared/localMetricsDarwin.ts and
   * shared/localMetricsWindows.ts.
   */
  view: 'terminal' | 'files' | 'monitor'
}

/**
 * A remote desktop on a saved server, backed by that server's `rdp` settings.
 *
 * Its own kind rather than a fourth `PanelView` on `SshTab`, because the three
 * existing views all read an SSH transport that an RDP session does not have,
 * and every one of them would have to learn to be absent. It is also the only
 * tab that cannot be split: `PaneGrid` splits terminals, and half a desktop is
 * not a smaller desktop.
 *
 * `view` is fixed rather than omitted so that the viewbar, the tab strip and
 * `setTabView` keep working off one field across every tab kind.
 */
export interface RdpTab extends TabBase {
  kind: 'rdp'
  serverId: UUID
  view: 'desktop'
}

/**
 * Every view any tab can be showing.
 *
 * Derived rather than declared, so it cannot drift from the members, and used
 * only where something genuinely handles all three kinds at once. Anything
 * that means "a view an SSH tab has" wants `PanelView`.
 */
export type TabView = Tab['view']

export type Tab = SshTab | LocalTab | RdpTab
