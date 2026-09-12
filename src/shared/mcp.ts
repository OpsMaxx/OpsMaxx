// Shared AI/MCP types used by main, preload and renderer.
//
// This is the vocabulary of the security boundary described in the project
// brief: an AI agent talks to the MCP bridge, the bridge resolves an Access
// Group for the target server, and every capability that group grants is one
// of ALLOW / ASK / DENY rather than a blanket yes/no.

export type PermissionValue = 'allow' | 'ask' | 'deny'

export type AiCapability =
  | 'viewServer'
  | 'terminal'
  | 'readFiles'
  | 'writeFiles'
  | 'sftpDownload'
  | 'sftpUpload'
  | 'sshTunnel'
  | 'databaseAccess'
  | 'sudo'
  | 'serverMetrics'
  | 'hostFacts'
  | 'firewallRules'
  | 'sudoersRead'
  | 'manageServers'
  | 'vpnControl'
  | 'containers'
  | 'containerControl'
  | 'fleetRead'
  | 'backupRead'
  | 'ciRead'
  | 'ciTrigger'

// `detail` is the consent surface, and it is not decoration. A user reading this
// grid is deciding what an agent may do, and the only thing they have to decide
// on is the label. When a label understates its grant, consent was given for
// something narrower than what was taken — which is what happened to Server
// metrics: it meant CPU and memory when the user granted it, and it now also
// returns a service and port inventory of the host. Nobody was asked again.
//
// So a `detail` that merely restates its label is a bug. Each one below names
// what an agent can actually obtain, and any tool added under an existing
// capability has to be reflected here in the same change.
export const AI_CAPABILITIES: { id: AiCapability; label: string; detail: string }[] = [
  {
    id: 'viewServer',
    label: 'View server',
    detail:
      'Lets an agent see that this server exists and read the permissions it has on it. Hostnames, usernames and keys are never disclosed.'
  },
  {
    id: 'terminal',
    label: 'Execute terminal commands',
    detail:
      'Runs shell commands over SSH. Unrestricted privilege-escalation shells (sudo -i, su, sudo bash) are refused whatever this is set to.'
  },
  {
    id: 'readFiles',
    label: 'Read files',
    detail: 'Reads file contents and lists directories. The path rules below can widen or narrow this per path.'
  },
  {
    id: 'writeFiles',
    label: 'Write files',
    detail: 'Creates and overwrites files. The path rules below can widen or narrow this per path.'
  },
  {
    id: 'sftpDownload',
    label: 'SFTP download',
    detail:
      'The transport underneath reading. Applied on top of the path rules, so denying it blocks every path regardless of what they say.'
  },
  {
    id: 'sftpUpload',
    label: 'SFTP upload',
    detail: 'The transport underneath writing. Denying it blocks every path regardless of what the rules say.'
  },
  {
    id: 'sshTunnel',
    label: 'SSH tunnels',
    detail: 'Lists tunnels, and opens or closes a forward between this machine and a port on the server.'
  },
  {
    id: 'databaseAccess',
    label: 'Database access',
    detail: 'Lists databases and runs queries against them through the server.'
  },
  {
    id: 'sudo',
    label: 'Sudo / privilege escalation',
    detail:
      'Commands beginning with sudo, checked on top of Execute terminal commands. Path rules still apply — sudo does not waive them.'
  },
  {
    id: 'serverMetrics',
    label: 'Server metrics, services & ports',
    detail:
      'CPU, memory, disk and uptime — and also every failed systemd unit and every listening port with the process that owns it. That is a service and port inventory of the server, not only its capacity.'
  },
  // Its own capability, NOT a widening of Server metrics, and that was decided
  // rather than defaulted. "How many unpatched security updates, and which
  // distribution and kernel" is a vulnerability report about the host and is
  // arguably the most attacker-useful thing this bridge can return —
  // materially different from CPU and memory. The 0.8.0 finding recorded above
  // was exactly a consent that had drifted wider than its grid text, and the
  // standard it set is that the grid must describe what is actually taken. A
  // new capability backfills to DENY for every existing group, which is the
  // correct default here.
  {
    id: 'hostFacts',
    label: 'Host inventory & pending security updates',
    detail:
      'Distribution and version, CPU model, architecture, virtualisation type, package manager, how many updates are pending, how many of those are SECURITY updates, and whether the server is waiting on a reboot. That is a patch-status report: it tells an agent which of your servers are unpatched and against what.'
  },
  // Its own capability again, and this one is not reachable by an agent AT ALL
  // — which is why the detail says so rather than leaving a reader to assume
  // the grid's usual meaning. Roadmap item 31 settled that deliberately: a
  // firewall rule list is a map of how to attack the host, and an agent that
  // could read one could exfiltrate it. tests/jobsNotExposed.test.ts holds the
  // property, by name, in the MCP bridge's own closure.
  //
  // What this line grants is COLLECTION. Item 24's posture probe reads firewall
  // scalars — tool, active, default policy, rule count — on every host once an
  // hour; the rule LINES are read only where this says allow, and the probe is
  // built without the commands that would list them everywhere else. So the
  // grid is the consent surface for a human-only feature, which is unusual and
  // is the point: this is the one thing in the posture read that turns counts
  // and fixed vocabulary into addresses and ports.
  //
  // 'ask' collects nothing. The sweep is unattended and hourly, with nobody at
  // the screen to answer, so anything short of 'allow' means do not read them.
  {
    id: 'firewallRules',
    label: 'Firewall rules: the addresses and ports this server accepts',
    detail:
      'The rule lines themselves, as ufw, firewalld, nft or iptables print them — every address, port and protocol named in them, capped and stripped of control characters on the server. That is an inventory of what this server is exposed on and to whom, which is the thing an attacker would otherwise have to scan for. No agent can read it whatever this is set to: it is not behind any MCP tool. Setting it to allow lets OpsMaxx COLLECT the rules for this server, for a person to read in Security posture; anything else and they are never asked for.'
  },
  // Item 36b, and the same argument one step further. Firewall rules say what
  // this server is exposed on; sudoers says who can become root on it and
  // whether they need a password to do it. That is the shortest description of
  // how to take the machine, so it is consented to separately and read for a
  // person, never for an agent.
  //
  // 'ask' collects nothing here for the same reason: the sweep is unattended.
  {
    id: 'sudoersRead',
    label: 'Sudoers: who can become root on this server',
    detail:
      'The rules in /etc/sudoers and /etc/sudoers.d — which accounts and groups may run which commands as root, and which of them need no password. OpsMaxx reads it to replace a guess it makes today, that anyone in wheel or sudo has root, which is wrong in both directions. It is also the shortest description of how to take this machine, so it is asked for separately and never by an agent: no MCP tool exposes it whatever this is set to. Setting it to allow lets OpsMaxx COLLECT it for a person to read in Keys and access; anything else and it is never asked for.'
  },
  {
    id: 'manageServers',
    label: 'Add servers to the workspace',
    detail: 'Adds a new server to the workspace. It does not grant any access to the server it adds.'
  },
  {
    id: 'vpnControl',
    label: 'VPN & reverse proxies',
    // Says what it grants and what it does not. It used to say "and starts
    // or stops them", which promised something no value of this setting
    // delivers: an frp reverse proxy makes a port on the user's own machine
    // reachable from the internet, so set_vpn refuses one outright and no
    // access group can permit it. A permission UI that offers a power the
    // code refuses is how an operator ends up believing they granted less
    // than they did, or more.
    detail:
      'Lists VPN profiles and reverse proxies, and starts or stops the VPNs. Reverse proxies ' +
      'are never started or stopped by an agent, at any setting.'
  },
  {
    id: 'containers',
    label: 'Containers: what is running, and their logs',
    detail:
      'Lists containers with their image, state, ports, uptime and compose project, and reads container logs. The logs are the part to weigh: an application writes its own connection strings, tokens and customer records to stdout, and this returns them as the container emitted them. It reads only — starting and stopping is a separate permission.'
  },
  {
    id: 'containerControl',
    label: 'Containers: start, stop and restart them',
    detail:
      'Restarts, stops and starts containers, and brings compose projects up and down. Stopping a container is an outage for whatever it serves, so this is separate from reading the list: an agent that may see what is running does not thereby get to stop it.'
  },
  {
    id: 'backupRead',
    label: 'Backups: whether they are running and when they last succeeded',
    detail:
      'Reads the backup destinations and how each is doing — the last successful run, how late it is, and any alarm raised against it. It names destinations and their kind, never their credentials. Running a backup and restoring one are not here at any setting: a run outlives the approval that started it, and a restore overwrites data.'
  },
  {
    id: 'fleetRead',
    label: 'Fleet: read across many servers at once',
    detail:
      'Answers questions over everything already collected rather than one host at a time — the inventory, search across it, drift, alerts and the running process list. One call can return data from every server in the workspace, so the reach is the workspace and not the server this is set on.'
  },
  // The first two capabilities in this grid that are not about a server the
  // user administers at all. A CI connection is a base URL and a token for
  // somebody else's build infrastructure, so neither of these is bounded by
  // anything OpsMaxx can see, and both are seeded DENY on every built-in group.
  {
    id: 'ciRead',
    label: 'CI/CD: pipelines, runs and build output',
    detail:
      'Lists the CI connections, the pipelines on them and their recent runs, and reads the output a run produced. The output is the part to weigh, the same way container logs are: a build prints whatever its steps echo — access tokens, deploy keys, the contents of a test fixture — and this returns it as the runner recorded it. It is also written by whoever opened the merge request that ran it, so it is the least trustworthy text the bridge can hand an agent.'
  },
  {
    id: 'ciTrigger',
    label: 'CI/CD: start, cancel and re-run pipelines',
    detail:
      'Starts a pipeline run on the CI server, cancels one, or re-runs it. What that run then does is defined on the provider and not here: OpsMaxx cannot read the pipeline definition before it starts, and cannot see what it deploys or where. Stopping AI access takes away the agent\'s cancel along with everything else, so a run already accepted is then yours to stop — from the Stop button on that run in CI/CD, or in the provider. Starting a run is always asked for, on every group, including one raised to allow.'
  }
]

export type AiCapabilityPolicy = Record<AiCapability, PermissionValue>

// A path-scoped override. The most specific matching pattern (longest string)
// wins over a shorter one; anything not matched falls back to the group's
// blanket readFiles/writeFiles capability.
export interface FilePathRule {
  id: string
  pattern: string
  read?: PermissionValue
  write?: PermissionValue
}

export interface AccessGroup {
  id: string
  name: string
  // The four seeded groups cannot be deleted (so assignments referencing them
  // never dangle) but every field on them, including capabilities, is
  // editable — there is no hard-coded three-tier permission model.
  builtIn: boolean
  capabilities: AiCapabilityPolicy
  filePolicies: FilePathRule[]
}

export type PolicyScope =
  | { level: 'workspace'; workspaceId: string }
  | { level: 'server'; serverId: string }

// null groupId means "No AI Access" for that scope. More specific scope
// (server) overrides less specific (workspace); a server with no assignment
// at all inherits its workspace's assignment; a workspace with no assignment
// at all defaults to No AI Access.
export interface PolicyAssignment {
  id: string
  scope: PolicyScope
  groupId: string | null
}

export interface ServerAiMeta {
  serverId: string
  aliases: string[]
}

export interface McpGlobalConfig {
  enabled: boolean
  port: number
  defaultSessionTtlMinutes: number
  approvalTimeoutSeconds: number
  /**
   * The access group a new agent session starts on.
   *
   * The session's group is the grant, so this is the single most consequential
   * default in the AI feature and it gets to be a setting rather than a
   * hardcoded first-in-the-list. Absent means no group at all for a caller that
   * offers no fallback — read resolveDefaultSessionGroup() below for why that,
   * and not "the narrowest group that exists", is the most restrictive answer
   * available. A caller may pass a `fallbackGroupId` for the case where nothing
   * is configured, and ConnectAgent.tsx does (Read & Write); what no caller may
   * do is substitute a group for a configured default, or for one that was
   * configured and has since been deleted.
   *
   * resolveDefaultSessionGroup() is how this field is read, everywhere.
   */
  defaultSessionGroupId?: string
}

/**
 * Which access group a newly minted session starts on.
 *
 * Three paths mint sessions: CLI pairing (no picker in front of it at all), the
 * Connect-an-agent buttons, and the New AI agent session form. Each of them used
 * to answer this on its own — `listGroups()[0]`, `groups[0]`, a hardcoded id —
 * so the same install could hand one agent Full Access and another nothing,
 * decided by array order rather than by anyone. Hence one function, in shared/,
 * pure: no electron and no fs, so main and the renderer run the same code rather
 * than two copies of a rule.
 *
 * They do not all answer it identically, and `fallbackGroupId` is how they are
 * allowed not to. The rule they share is that a CONFIGURED default is honoured
 * and never substituted; where they differ is the unconfigured case, which
 * ConnectAgent.tsx answers with Read & Write (`grp-read-write`) because the user
 * is in front of that flow choosing to connect an agent, while CLI pairing and
 * the session form answer it with null. tests/defaultSessionGroup.test.tsx pins
 * that divergence, so it is a decision rather than a drift.
 *
 * `null` is returned whenever the setting does not name a group that exists, and
 * it is not a cosmetic fallback. The session's group is the GRANT, so a null
 * group fails closed at every consumer: resolveGroups()/sessionGroupFor() in
 * mcpServer.ts hand null to effectiveCapability, effectiveCommand,
 * effectiveFilePath and effectiveWorkspaceCapability, each of which denies
 * before looking at anything else ("This AI session has no access group"), and
 * every evaluate* in policyEngine.ts independently denies on a null group too.
 * The agent connects, is refused on every call, and the user lifts it under
 * AI & MCP → AI Agents having been told which group they are granting.
 *
 * Deliberately NOT "the most restrictive group that exists", which this
 * setting's own doc comment used to promise. Restrictiveness over 28
 * capabilities plus per-path file rules is a partial order, not a ranking: a
 * group that allows reads and refuses the terminal and one that does the reverse
 * are incomparable, so any "narrowest group" has to break ties — and the only
 * tiebreak on offer is position in the list, which is the exact bug this
 * function exists to delete. No group is at least as restrictive as any group
 * that could have been picked, and proving that takes no ranking code.
 *
 * `fallbackGroupId` is for a flow with its own considered default (ConnectAgent)
 * and is consulted ONLY when nothing is configured. A default that was
 * configured and has since been deleted still resolves to null: the user did
 * choose, their choice is gone, and no other group gets to stand in for it.
 */
export function resolveDefaultSessionGroup(
  config: Pick<McpGlobalConfig, 'defaultSessionGroupId'> | null | undefined,
  groups: AccessGroup[],
  fallbackGroupId?: string
): { id: string | null; name: string } {
  // Trimmed, and `||` rather than `??`, because an empty or whitespace-only id
  // IS nothing configured. `??` accepted `''` as a configured choice, which then
  // matched no group, so the answer was null with `fallbackGroupId` never
  // consulted — the deleted-default case, reached by a config that names nothing
  // at all. No UI writes the field today; a hand-edited or IPC-patched config
  // does, and this function is the single authority for the grant.
  const wanted = config?.defaultSessionGroupId?.trim() || fallbackGroupId
  const found = wanted ? groups.find((g) => g.id === wanted) : undefined
  return found ? { id: found.id, name: found.name } : { id: null, name: 'No AI Access' }
}

export interface WorkspaceRef {
  id: string
  name: string
}

// Each agent connects with its own bearer token: the session — not one
// shared secret for the whole app — so Claude Code and Codex can be pointed
// at different workspaces/access groups at the same time, each individually
// revocable. The raw token is shown to the user once, at creation, and only
// its SHA-256 hash plus a display preview are ever persisted.
//
// A session can be granted several workspaces at once (chosen explicitly at
// creation, never "all workspaces including future ones") — every tool that
// lists or resolves a server filters against this exact set, so a workspace
// left out is invisible to the session, not merely denied.
export interface McpAgentSession {
  id: string
  agentName: string
  workspaces: WorkspaceRef[]
  groupId: string | null
  groupName: string
  tokenHash: string
  tokenPreview: string
  createdAt: string
  expiresAt: string | null
  lastActiveAt: string
  revoked: boolean
}

// Everything below `status` is optional, and the optionality is not laziness —
// it is what lets the approval dialog keep its honest-absence paths alive. A
// required field would compile everywhere and then arrive as `undefined` from
// one gate() call site somebody forgot, which the renderer would have no way to
// tell apart from a measured value. Optional says "this may genuinely not have
// been recorded", and every consumer is forced to decide what to print when it
// was not. See src/renderer/src/components/ai/ApprovalDialog.tsx.
export interface ApprovalRequest {
  id: string
  sessionId: string
  agentName: string
  workspaceId: string
  workspaceName: string
  serverId: string
  serverName: string
  capability: AiCapability
  action: string
  risk: 'low' | 'medium' | 'high'
  createdAt: string
  status: 'pending' | 'approved' | 'denied' | 'timeout'
  resolvedAt?: string

  /**
   * When this request auto-denies, as main's timer actually has it.
   *
   * The renderer used to derive the deadline from `createdAt` plus the
   * configured timeout, which was right only for as long as nothing could move
   * the fuse. extendApproval() moves it, so a derived deadline would go on
   * counting down to a moment that no longer exists and the operator would
   * watch it hit zero while the request was still very much alive. This is the
   * timer, not a reconstruction of it; the derivation stays as the fallback.
   */
  deadlineAt?: string

  /** The MCP tool the agent called, e.g. `execute_command`. */
  toolName?: string

  /**
   * The agent's own stated reason for the call, ALREADY SANITISED.
   *
   * Written by the party asking for permission, so it is evidence about the
   * agent and never evidence about the action. sanitizeAgentIntent() in
   * shared/approvalRisk.ts is the only thing that may put a value here, and the
   * dialog renders it as an attributed quotation. Absent means the agent sent
   * none — the bridge offers the field on every gated tool and does not require
   * it.
   */
  intent?: string

  /**
   * The rule that produced `risk`, in the operator's language, from the gate()
   * call site that fired it. The renderer can re-derive something similar from
   * capability and action, but that derivation is a copy of main's rules kept
   * in step by hand; this is the rule itself.
   */
  riskReason?: string

  /** When the agent's session connected. Exact — main holds the session. */
  sessionStartedAt?: string
  /** The access group named on the session. */
  sessionGroupName?: string
  /**
   * WHY approval was needed at all, as the policy engine put it.
   *
   * Distinct from `riskReason`, which describes the ACTION -- "the command runs
   * as root". This describes the RULE: "Ask Before Commands: terminal = ask".
   * Without it an operator who has set a session's ceiling to Full Access and
   * is still being asked on every command has no way to find out which of the
   * two layers said no. The ceiling is a cap, the workspace or server
   * assignment is the grant, and the effective answer is the more restrictive
   * of the two -- a model the approval card was in the best position to explain
   * and was the one place not explaining it.
   */
  policyReason?: string
  /**
   * Audited actions this session took before this one — EXACT, or absent.
   *
   * Absent whenever main could not count them exactly (unreadable log, a
   * corrupt line, a log too large to read in a modal's lifetime). It is never a
   * partial count: the renderer's own tail read is the approximate answer and
   * it labels itself "at least N", so a number here is always the real one.
   */
  actionsThisSession?: number
}

/**
 * `approved-earlier` is an action allowed on the strength of an approval the
 * user gave earlier in the same session, for the same capability on the same
 * server. It is deliberately not folded into `approved`: the audit log is the
 * only place the difference between "a human looked at this one" and "a human
 * looked at one like it" survives, and that is exactly the question an audit is
 * for.
 */
export type AuditApproval = 'not-required' | 'approved' | 'approved-earlier' | 'denied' | 'timeout'
export type AuditResult = 'success' | 'error' | 'denied'

export interface AuditEntry {
  id: string
  timestamp: string
  agentName: string
  sessionId: string
  workspaceId: string | null
  workspaceName: string | null
  serverId: string | null
  serverName: string | null
  action: string
  capability: AiCapability | null
  approval: AuditApproval
  result: AuditResult
  exitCode?: number
  error?: string
}

export interface PolicyState {
  /**
   * 1 — assignments were the grant, and the session's group only capped it.
   * 2 — the session's group grants, and an assignment is an optional
   *     restriction. Reaching 2 clears every assignment written under rule 1,
   *     because each of them was made to mean the opposite thing.
   */
  version: 1 | 2
  groups: AccessGroup[]
  assignments: PolicyAssignment[]
  /**
   * What the version-2 migration removed, kept so the user can be told.
   *
   * Clearing an assignment WIDENS what an AI session can reach, so the app does
   * not get to do it quietly: this is what lets the UI name the targets that
   * used to carry a restriction and offer to put it back.
   */
  clearedAssignments?: PolicyAssignment[]
  serverMeta: ServerAiMeta[]
  // Highest seeded-file-policy generation this file has been brought up to.
  // Absent on every file written before the generation counter existed, which
  // is what lets a new deny rule reach existing installs exactly once without
  // resurrecting rules the user deliberately deleted. See policyStore.
  filePolicyGeneration?: number
}

export const DEFAULT_MCP_PORT = 5177

// A short-lived code shown only inside OpsMaxx (never returned to the CLI
// that requested it) so the `opsmaxx claude|codex|run` launcher can bootstrap
// a session without a human pasting a token/URL by hand.
export interface CliPairingRequest {
  id: string
  code: string
  agentName: string
  createdAt: string
  expiresAt: string
}
