# AI & MCP — technical guide

This is the detailed reference for OpsMaxx's [MCP](https://modelcontextprotocol.io) bridge —
how it's built, what each screen does, and how to connect Claude Code, Claude Desktop, Codex or
another MCP client. For the short pitch and the security summary, see the
[README's AI Agent Access section](ai-agents.md). For the threat model, see
[AI-SECURITY.md](AI-SECURITY.md).

## Contents

- [Architecture](#architecture)
- [The MCP server](#the-mcp-server)
- [Sessions](#sessions)
- [Workspaces](#workspaces)
- [Access Groups](#access-groups)
- [Permission modes](#permission-modes)
- [Approvals](#approvals)
- [Audit Log](#audit-log)
- [Credential isolation](#credential-isolation)
- [The `opsmaxx` CLI and pairing](#the-opsmaxx-cli-and-pairing)
- [Connecting Claude Code](#connecting-claude-code)
- [Connecting Codex, Gemini CLI and other HTTP clients](#connecting-codex-gemini-cli-and-other-http-clients)
- [Connecting Claude Desktop](#connecting-claude-desktop)
- [Troubleshooting](#troubleshooting)

## Architecture

![Architecture: AI agent to MCP to OpsMaxx policy to approval to SSH/SFTP/database to servers](images/ai-mcp-architecture.svg)

1. An MCP client (Claude Code, Claude Desktop, Codex, Gemini CLI, ...) sends a tool call over
   MCP — either **stdio** (via the `opsmaxx` CLI's `bridge` subcommand) or **Streamable HTTP**
   with an `Authorization: Bearer <token>` header, directly to OpsMaxx.
2. OpsMaxx's MCP server (`src/main/services/mcpServer.ts`) is an HTTP server bound to
   **`127.0.0.1` only** (`startMcpServer`, `mcpServer.ts`). Nothing outside the machine can reach
   it, regardless of firewall or network configuration.
3. Every tool call authenticates the bearer token against a session (`mcpAuth.ts`), then resolves
   the target server **by friendly name** (`serverResolver.ts`) — never by hostname, IP or username,
   because the tool call never carries one.
4. The session's **access group** is evaluated for the specific capability the tool needs
   (`policyEngine.ts`), together with any restriction assigned to that server or workspace,
   producing `allow`, `ask` or `deny`. The session's **mode** and whether the target is
   **Protected** are then applied to that answer (`applyMode`) — see
   [Permission modes](#permission-modes).
5. `ask` blocks on a human decision (`approvals.ts`) before anything happens. `deny` returns an
   error immediately. `allow` proceeds.
6. Only at this point does OpsMaxx resolve the server's actual SSH/database credential
   (`credentialResolver.ts`) and open the connection — using the exact same connection-pooling
   path (`ssh.ts`) an interactive terminal session uses.
7. Command/file output is redacted (`secretRedaction.ts`) before it is returned to the agent, and
   the whole exchange is written to the audit log (`auditLog.ts`).

## The MCP server

`src/main/services/mcpServer.ts` registers **36 tools** — 28 core, plus the 8-tool CI/CD set at
the end of the table. `tests/localTerminalNotExposed.test.ts` holds the same 36 as a reviewed
whitelist, so a new tool cannot appear on the bridge without a diff somebody reads.

| Tool | Capability gating it | What it returns |
|---|---|---|
| `list_workspaces` | — | The workspace(s) this session is scoped to |
| `list_servers` | `viewServer` | Friendly names only, filtered to what the session can see |
| `get_server_details` | `viewServer` | Name, OS, access group, effective ALLOW/ASK/DENY per capability — **never hostname/IP/username** |
| `execute_command` | `terminal` (+ `sudo` if the command is sudo/doas, + file path rules for any absolute path it names); a destructive, elevated or run-time-computed command is **risky** | stdout/stderr/exit code, redacted |
| `read_file` | `readFiles` + `sftpDownload` (+ file path rules) | File contents, redacted |
| `write_file` | `writeFiles` + `sftpUpload` (+ file path rules) | Bytes written |
| `list_files` | `readFiles` + `sftpDownload` (+ file path rules) | Directory listing |
| `get_capacity_trends` | `serverMetrics` | Where CPU, memory, disk and inodes are heading, from history already stored — it opens no connection and answers for an offline server. Answers with a **sentence per metric**, not the samples behind them: a rate, a crossing date or the named rule that refused, and always the window it was drawn from plus how much of that window was actually sampled. Disk is measured in bytes, because the stored percentage is df's rounded integer and too coarse to forecast |
| `get_server_metrics` | `serverMetrics` | CPU/memory/disk/uptime — and every failed systemd unit and listening port with its owning process, which is a service and port inventory as much as a capacity read |
| `get_host_facts` | `hostFacts` | Distribution, architecture, CPU model, virtualisation, package manager, pending updates and how many are security updates, and whether a reboot is owed. Its own capability rather than a widening of metrics, because it is a patch-status report. It never refreshes a package cache. A count reported as NOT AVAILABLE is not zero |
| `list_databases` | `viewServer` | Friendly names and engines, never a hostname or credential |
| `query_database` | `databaseAccess` for reads; `+ writeFiles` for anything that writes, which is **risky** | Rows, capped |
| `list_tunnels` | `sshTunnel` | Configured tunnels and whether each is running |
| `set_tunnel` | `sshTunnel`; starting is **risky** | Confirmation, with the bound port |
| `create_tunnel` | `sshTunnel`, **risky**, **never cached** | A saved tunnel — **not a running one**. Starting it is `set_tunnel` and a second approval. A `remote` forward binding a non-loopback address is graded higher, and the prompt says it publishes that port on the server's network |
| `delete_tunnel` | `sshTunnel`, **risky**, **never cached** | That the tunnel is gone; it is stopped first if running |
| `list_vpns` | `vpnControl` | Names, engine, mode and state — **never an endpoint, key or listener address** |
| `set_vpn` | `vpnControl`; starting, or stopping with live sessions depending on it, is **risky**; **frp refused outside Bypass** | Confirmation, with a listener count |
| `add_server` | `manageServers`, resolved on the **workspace**, **never cached**; not risky, so ALLOW adds without asking | The name the new connection was saved under. `jumpHosts` names existing servers to reach it through, so a bastion-only host can be onboarded without disclosing one; `verify: true` dials it once and reports whether it came up rather than reporting a dead entry as added |
| `update_server` | `manageServers`, **risky**; a session grant covers only further changes to that one server | Which fields changed. Only what you pass is touched — a port change does not disturb the stored credential |
| `remove_server` | `manageServers`, **risky**, **never cached** | That the connection and its stored credential are gone. The approval names what the removal takes with it when the server is another server's jump host |
| `test_connection` | `viewServer` | Whether the connection came up, and the *category* of failure if not — never a hostname, port or username, and never the driver's own text, which contains the address |
| `list_containers` | `containers` | Containers on one server: image, state, the runtime's own status line, published ports and compose project. It says when it fell back to root, and distinguishes "not in a project" from "the runtime could not say" |
| `container_logs` | `containers`, weighed higher at the prompt than the list | The last lines a container wrote. **It never follows** — a stream would outlive the approval that authorised it, and the stop-all-AI-access switch works by resolving requests still pending |
| `fleet_inventory` | `fleetRead`, resolved on the **workspace** | One row per server from what the sampler already collected, each stamped with when. Drift is deliberately absent from it |
| `container_action` | `containerControl`, graded **high** at the prompt | **The one tool on the bridge that changes the state of a running service.** Starts, stops or restarts exactly one container per call — there is no shape in which one approval acts on a host's worth of them. Starting is graded no lower than stopping: an agent starting a container begins serving traffic nobody asked for |
| `backup_status` | `backupRead`, resolved on the **workspace** | Every backup destination and how late each is against its own schedule. Destinations and kinds, never their credentials. It cannot run a backup or restore one at any setting |
| `describe_capabilities` | — **the one tool that is not gated** | What this session may do on a server, with the sentence the user was shown when they granted it, plus what is absent by design. Gating "what am I allowed to do" is how an agent discovers the boundary by tripping over it |
| `list_alerts` | `fleetRead`, resolved on the **workspace** | Alerts already raised, newest first. It says what *happened*; it does not rank hosts by exposure |
| `compose_status` | `containers` | The same container read, grouped by compose project and service. A container the runtime could not attribute is listed as ungrouped, never guessed at |
| `list_images` | `containers` | Images present, with dangling layers marked as dangling rather than named `<none>`. What exists, not what it costs — there is no disk-usage tool here at any setting |
| `get_config_drift` | `fleetRead`, checked per server | Whether **one** named server's watched files still match their baseline. Secret-shaped text is redacted before the comparison, so a changed password is reported as a change without disclosing either value |
| `fleet_drift` | `fleetRead`, resolved on the **workspace**, graded **high** | The fleet-wide form, and a heavier disclosure: read as an attacker would, "which hosts have fallen behind" is a ranked list of the weakest machines. An unsampled host is reported as unknown, never as clean |
| `list_ci_connections` | `ciRead`, resolved on the **workspace** | Connection names and providers — **never a base URL or API token** |
| `list_pipelines` | `ciRead` | Pipelines on one connection, with their opaque `ref` and whether each can be started. Capped |
| `list_runs` | `ciRead` | Recent runs of one pipeline, newest first, capped. Fenced as untrusted |
| `get_run` | `ciRead` | One run: status, timing, per-step outcomes. Fenced as untrusted |
| `get_run_logs` | `ciRead` | Build output, redacted, tailed, and fenced as untrusted |
| `trigger_run` | `ciTrigger`, **risky**, **never cached** | What the provider returned — a run, a queue item, or an honest "requested" |
| `cancel_run` | `ciTrigger`, **risky**, **never cached** | That the provider accepted the request, not that the run stopped |
| `rerun_run` | `ciTrigger`, **risky**, **never cached** | A new attempt of the same run — **GitHub only**; Jenkins and GitLab refuse and say to start a new run |

**Risky** means an ALLOW on that capability still asks while the access group's **Confirm risky
actions** switch is on — the default on every group but Full Access. **Never cached** means that when
the call asks, one approval covers that call and no later one. Every row is also subject to the
session's mode and to a Protected target — see [Permission modes](#permission-modes).

Each tool carries a `title`, an MCP annotation set (`readOnlyHint`, `destructiveHint`,
`openWorldHint`) and a description of every parameter, and the server sends `instructions` on
initialize. That metadata is what stops an agent reaching for `execute_command` when a
purpose-built tool exists — see [Tool discoverability](#tool-discoverability).

### File rules apply to shell commands too

`execute_command` is checked against the same per-path rules as the SFTP tools. Absolute paths are
extracted from the command line — operands of known file-reading and file-writing commands,
redirection targets, `cp`/`mv` sources and destinations, `dd if=`/`of=` — and each is evaluated
before the command runs. `cat /etc/shadow` is refused exactly as `read_file /etc/shadow` is, and
`sudo` does not bypass it.

The same check runs on every segment the escalation check walks (`walkCommand`, described in
docs/AI-SECURITY.md): inside a shell's command string (`sh -c`, and `-c` in a cluster such as
`bash -lc` or `sh -ec`), `script -c`, `su -c`, `sg`, `env -S`, `eval`, `watch`, `flock -c`,
`find -exec`, a `parallel` template, `$(…)`, `<(…)` and backticks, up to three levels deep, and past
shell grammar (`if … then`, `{ … }`), backslash-quoted command words and every wrapper and escalator
it steps over (`timeout`, `xargs`, `busybox`, `chroot`, `strace`, `bwrap`, `pkexec`, `run0`,
`systemd-run` and the rest). So `bash -lc 'cat /etc/shadow'`, `timeout 5 cat /etc/shadow` and
`echo $(cat /root/.ssh/id_rsa)` are refused like `cat /etc/shadow`, and the two checks cannot
disagree about what a command runs.

This is best-effort by design: only absolute paths and only recognised commands, because a
relative operand cannot be matched against a pattern without knowing the remote working directory.
What still gets through: a relative path after a `cd` (`cd /etc && cat shadow`,
`cd /root/.ssh && cat id_rsa`), a glob (`cat /etc/sh*dow`), a path in a variable (`f=/etc/shadow;
cat $f`), `eval` of a variable, a script file that reads the path, and a program that is not on the list of
recognised file commands (`python3 -c 'open("/etc/shadow")'`). It closes the direct and wrapped
forms and can only ever narrow a decision, never widen one; a file that must stay unread needs
`readFiles`/`terminal` at ask or deny, or the host's own permissions.

### Databases, tunnels and VPNs

`query_database` classifies the statement before running it. Reads are governed by
`databaseAccess` alone; anything that modifies data or schema is additionally bounded by
`writeFiles` — a group whose point is that it cannot change anything should not be able to change
a row either — and, while the group's Confirm risky actions switch is on, never resolves better
than ASK. That clamp exists because `databaseAccess` is ALLOW in every built-in group that grants it
at all, so honouring it plainly hands an agent a silent `DROP TABLE`. Full Access ships with the
switch off, so a Full Access session in Auto mode does run a write without asking: on that group,
ALLOW means allow.

A read cannot smuggle a write behind a semicolon, comments cannot hide the verb, and an
unrecognised verb counts as a write: there are too many dialects to enumerate and guessing
"harmless" is the expensive direction to be wrong in. Mongo shell syntax is classified separately,
since `db.users.find({})` leads with the collection rather than the verb.

`set_tunnel` starts and stops tunnels; `create_tunnel` and `delete_tunnel` define and remove them.
Starting binds a listening port on the user's own machine, so it asks even at ALLOW while the
group's Confirm risky actions switch is on (`evaluateTunnelOpen`). Stopping does not, being the
safe direction.

Defining one is risky too, and for a reason worth stating: a tunnel an agent writes **outlives the
session that wrote it**, and the next person to press Start starts what the agent wrote. Defining
does not start it — that stays a separate approval, so nothing an agent writes carries traffic
without a second yes. The sharp case is a `remote` forward, which listens **on the server**: a
non-loopback listen address there publishes the port to that server's whole network, so it is
graded higher and the prompt says exactly that instead of "define a tunnel".

**Prefer a jump host to a tunnel.** If the goal is to reach a machine that sits behind another,
`add_server`/`update_server` take `jumpHosts` — authenticated at every hop, binding no port, and
leaving nothing behind. The server instructions say so, because the alternative an agent reaches
for otherwise is a relay on the bastion that forwards straight past the authentication the bastion
exists to enforce.

`set_vpn` is the same shape one step further out, and gated on `vpnControl` rather than
`sshTunnel`. It can start or stop a VPN profile the user has already defined; it cannot create one
or change where one points, and **there is no `add_vpn` or `edit_vpn` tool** — not an omission to
be filled in later, but a decision, because a profile determines which network everything
downstream of it travels over. While the group's Confirm risky actions switch is on, starting asks
even for a group set to ALLOW (`evaluateVpnControl`, `policyEngine.ts`), and so does a stop that
would close sessions depending on the VPN, so "close 3 sessions" is not something an agent does
quietly.

**Reverse proxies (frp) are refused to every access group.** An frp proxy makes a port on the
user's own machine reachable from the frp server — which is to say from the internet — and an
approval prompt would not help, because "Start VPN office" is indistinguishable, to the person
clicking it, from consent to publish a port. So it is not a permission an administrator can raise
on a group: the refusal is hard-coded (`AI_REFUSED_VPN_KINDS`, `policyEngine.ts`), the same
treatment as unrestricted root shells, and it applies to stopping as well as starting. It is
expressed as a refusal *decision* rather than an early return, so the one thing that reaches past
it is the same one that reaches past a root shell: a session the human has put in **Bypass** mode,
on a workspace that is not Protected.

`list_vpns` reports which profiles exist, which engine carries each one, whether it is up, and
frp's per-proxy status table. It never reports an endpoint, a key, or a listener's bind address —
the cached shape it reads from does not contain them at all (`CachedVpn`, `mcpDataCache.ts`), so a
future template string cannot leak one by accident.

### CI/CD

Eight tools reach Jenkins, GitLab and GitHub Actions. They are the only tools on this bridge
annotated `openWorldHint: true` besides `execute_command` and `query_database`, and the reason is
narrower than "they use the network": every other tool acts on something OpsMaxx holds a record
for, while these act on a third party the user does not administer, running a pipeline definition
OpsMaxx has never read.

**Connections are a second name space.** `connectionName` comes from `list_ci_connections` and a
server name does not resolve there. The cached shape the bridge reads from (`CachedCicdConnection`,
`mcpDataCache.ts`) carries the id, the workspace, the name, the provider and whether it is enabled
— **not the base URL and not the vault reference**, so neither can leak through a template string.
Main resolves the name to a real record and merges the token at request time.

**There is no tool that creates, edits or deletes a CI connection**, the same decision as
`set_vpn` and for a sharper reason: an agent that could add one would choose the base URL it points
at, and could then ask the user to paste a token into it.

**`trigger_run`, `cancel_run` and `rerun_run` are risky and never cached.** While the group's
Confirm risky actions switch is on, `evaluateCiTrigger` (`policyEngine.ts`) upgrades `allow` to
`ask` before `gate()` runs, and `gate()` excludes `ciTrigger` from `sessionElevations` in both
directions, so every run that asks is its own approval. With the switch off (Full Access as
shipped) or in Bypass mode, a run starts without asking. One pipeline per call, so a mistake costs
one pipeline rather than a fleet.

`trigger_run`, `cancel_run` and `rerun_run` call `cicd/wiring` — the same functions the panel's
own buttons call. The difference between the two callers is entirely the gate: a second copy of the
provider switch inside the bridge would be a second place for Jenkins' queue semantics to be wrong.

**Everything a provider reports comes back fenced.** Not just logs: a run's title is a pull-request
title, its actor a username, its branch a branch name, all written by whoever opened the change and
all arriving through `readOnlyHint` tools with no prompt. Each field goes through
`remoteText`/`remoteName`, and the result as a whole is wrapped in a block whose opening and
closing markers carry a random per-call nonce, with the stated rule that anything claiming to close
the block without that nonce is part of the data. `hostReportedBlock` is not used here: it is
unfenced prose, sound only for the single 200-character lines its other callers hand it, and a
10,000-line log can forge it.

`get_run_logs` returns the **tail** by default, capped, and says how much it withheld. That bounds
context cost, not risk — the last lines of a failing build are exactly what an attacker's step
prints before exiting non-zero. The body goes through `redactOutput` with the connection's own API
token as a known secret, which is close to free and worth very little: that token never reaches a
runner, so a job leaking `$CI_JOB_TOKEN` is leaking the *platform's* credential, which OpsMaxx has
never seen and cannot enumerate. Only the pattern layer applies, and it is not exhaustive.

### Managing connections

`add_server`, `update_server` and `remove_server` share the `manageServers` capability, and
`test_connection` needs only `viewServer`. None of them touches the machine at the far end — they
edit OpsMaxx's own records.

The capability used to mean only "add", and adding was all it could do. That made the bridge a
one-way ratchet: an agent that wrote a wrong entry could not correct or withdraw it, so every
mistake became manual cleanup and the rational move was to stop using `add_server` at all. Two
consequences of closing that are deliberate and are not left to the capability's plain reading:

- **Changing and removing are risky**: while the group's Confirm risky actions switch is on they
  ask even at ALLOW (`evaluateServerWrite`, `policyEngine.ts`). An administrator who set this to
  ALLOW on such a group meant "add servers without asking me"; that cannot be read as consent to
  repoint or delete the ones already there. Adding is the only part of this capability an ALLOW
  makes silent there. Turning the switch off — Full Access ships with it off — is the explicit
  consent to the rest.

  Changing is in that rule and not only deleting, because it is the quieter of the two.
  Deleting `Prod DB` is loud and the next call that names it fails; repointing it keeps the
  name, the stored credential and the sidebar entry, and every later use — by this agent,
  another agent, or the person clicking it — goes to the new host.
- **An approval never spreads.** `add_server` and `remove_server` are marked per-call, so when
  they ask, an approval authorises the call in front of the user and never the next one. Without that,
  `add_server` — which has no server id yet and so shares one elevation key across every add in a
  session — approved the first write and then wrote every one after it silently. `update_server`
  is scoped to itself rather than per-call: its dialog offers a second answer, **Allow
  update_server this session** (in full, with the server, in its tooltip), after which further
  changes to that same
  connection in that same session do not ask. **Approve once** covers the one change. Either yes
  reaches no other tool, no other server and no later session.

**Jump hosts.** `jumpHosts` names servers that already exist, by friendly name, in dial order.
Each hop authenticates with that saved server's own stored credential, so no credential is passed
for it, and an agent cannot describe a bastion OpsMaxx has not been told about — it never sees an
address to type. Without this, an estate reachable only through a bastion could not be onboarded
over the bridge at all: every entry dialled direct, timed out at TCP, and was still reported as
added.

**Verification.** `verify: true` dials the new entry once, through its jump chain and VPN, and
reports whether it came up. It runs after the write, because the credential only reaches the
keychain once the renderer has stored it. A failure is a **warning, not a rollback** — a saved
connection to a host that is down, or behind a VPN that is not up, is a correct record of a real
machine, and deleting it would also throw away the approval the user just gave.

**Duplicates.** `list_servers` with `dedup: true` returns an opaque identity per server: equal
tokens mean the same host, port and account. It is an HMAC keyed on the session's own secret, so
it discloses nothing, cannot be turned back into an address, and differs in every session — it
answers "is this box already registered" for as long as the task asking it, and is meaningless to
anyone reading it later. It exists because the honest alternative people actually used was to SSH
into every saved server and run `hostname`, which is a far larger disclosure, needs `terminal`,
and is worse for privacy than the non-secret metadata it was avoiding.

### `add_server`

An agent can add an SSH connection, including its credential, when the session's access group
grants `manageServers`. Of the built-in groups, **Read & Write** and **Sudo Access** set it to ASK,
so every add surfaces an approval dialog naming the connection, the user and the server; **Full
Access** sets it to ALLOW, so there an add in Auto mode does not ask. The credential itself never appears in that dialog or in the audit log — only the fact
that one was supplied. It goes straight to the OS keychain and cannot be read back through the
bridge.

A capability a saved access group predates — `manageServers`, and now `vpnControl`, for any group
written before the version that introduced it — evaluates as DENY, never as an accidental grant.
On load, built-in groups are backfilled with the value a fresh install would have given them and
custom groups with DENY (`backfillCapabilities`, `policyStore.ts`), so an upgraded install neither
silently gains a permission nor quietly loses a feature with nothing in the UI explaining why.

## Tool discoverability

Descriptions are written to route an agent to the narrowest tool that does the job:

- The server's `instructions` state that servers are addressed by friendly name, that
  `list_servers` must be called first, that credentials are never visible, and which capabilities
  do not exist at all (running jobs, defining rules, a shell on the OpsMaxx machine itself,
  reading the vault, restoring a backup) so an agent does not shell out to reach them. Tunnels
  and databases are NOT in that list — `list_tunnels`, `set_tunnel`, `list_databases` and
  `query_database` are all registered, and the instructions used to claim otherwise.
- `execute_command` names its four alternatives; `read_file`, `list_files` and
  `get_server_metrics` each say why they are preferable.
- Every `serverName` parameter points back at `list_servers`, because a hostname or IP will not
  resolve.

`tests/toolMetadata.integration.test.ts` asserts all of this through a real MCP client, so a tool
cannot be added without it.

There is no `vault` tool. The MCP server has no code path into the Vault at all — an AI session
cannot read a Vault entry no matter what access group it holds, including when a server's
credential is stored there.

The server also exposes two unauthenticated bootstrap endpoints used only by the CLI pairing flow:
`POST /pair/start` and `POST /pair/confirm` (see [Pairing](#the-opsmaxx-cli-and-pairing) below).

## Sessions

![Creating an AI agent session under AI & MCP → AI Agents](images/ai-agents.png)

A session (`McpAgentSession`, `shared/mcp.ts`) is created from **AI & MCP → AI Agents**, or via
CLI pairing. Each one has:

- an **agent name** (a label, e.g. "Claude Code")
- **one or more workspaces**, chosen explicitly — never "all workspaces including future ones"
- exactly **one access group**, which is the grant — see [Access Groups](#access-groups)
- a **mode** — Read only, Ask first, Auto or Bypass permissions — which only the human sets, in the
  OpsMaxx window; see [Permission modes](#permission-modes)
- an **expiry**: 15 minutes, 1 hour, 8 hours, 7 days, or never (CLI pairing always issues 8 hours —
  `TTL_MINUTES = 480` in `cliPairing.ts`)
- a bearer token, shown **once** at creation

Only the token's SHA-256 hash and a 4-character preview (`tokenPreview`) are ever persisted
(`mcpAuth.ts`) — there is no way to recover a lost token from OpsMaxx's own storage. Revoking a
session, or the global **Stop all AI access** switch (Security tab), sets `revoked: true`
immediately; a revoked or expired token fails authentication on its next use.

![Active Sessions: every session that exists, with Revoke and Stop all AI access](images/ai-active-sessions.png)

Sessions are stored at `opsmaxx-mcp-sessions.json` in OpsMaxx's userData directory.

## Workspaces

A session's workspace grant is a hard boundary, not a filter applied after the fact. A session
can be created with one workspace or several — chosen explicitly at creation, never "all
workspaces including future ones" — and every tool resolves servers against exactly that set:
`listCachedServers(session.workspaces.map(w => w.id))` (`mcpDataCache.ts`) only ever loads servers
belonging to a granted workspace in the first place. A workspace left out isn't denied to the
session — it is invisible, because it's never in the candidate list `serverResolver.ts` searches.

Restrictions still resolve per server, not per session: `resolveRestriction` (`policyEngine.ts`)
looks up any assignment on a server using **that server's own workspace**, not "the session's
workspace" — which matters once a session spans more than one, since two servers in the same
multi-workspace session can carry different restrictions. The same is true of Protected: a server
is capped if it, or the workspace it lives in, is marked.

CLI-paired sessions (`opsmaxx claude`/`codex`/`run`) are a special case: there's no workspace
picker at pairing time, so a paired session is granted every workspace that exists at the moment
of pairing (`confirmCliPairing`, `cliPairing.ts`). A session scoped to specific workspaces still
has to be created by hand under **AI & MCP → AI Agents**.

## Access Groups

![Access Groups: the five built-in groups, each described from its own settings, and every capability set to ALLOW, ASK or DENY](images/ai-access-groups.png)

An access group (`AccessGroup`, `shared/mcp.ts`) is a policy across **21 capabilities**
(`AI_CAPABILITIES`): view server, execute terminal commands, read files, write files, SFTP
download, SFTP upload, SSH tunnels, database access, sudo/privilege escalation, server metrics,
host facts & pending security updates, firewall rules, sudoers, add servers to the workspace,
VPN & reverse proxies, containers, container control, fleet reads, backup status, CI/CD reads and
CI/CD triggers. Each is independently `allow`, `ask` or `deny`.

Each group also carries one switch, **Confirm risky actions** (`confirmRisky`; absent reads as on).
While it is on, `allow` still asks for the actions that are hard to take back:

- destructive or elevated commands (`rm -rf`, `mkfs`, `reboot`, package installs, service
  restarts), commands whose program is computed at run time, and `unshare -r`. A computed command
  word also asks with the switch off unless the group allows `sudo` outright, because it may be
  sudo;
- database writes and schema changes;
- opening, defining or deleting SSH tunnels;
- changing or removing saved servers;
- starting a VPN, or stopping one other sessions depend on;
- starting, cancelling or re-running CI/CD pipelines.

Turning the switch off never lets one capability walk past another the group set below `allow`.
Three command upgrades therefore stay whatever the switch says: a computed command word unless
`sudo` is `allow` (above); a destructive command that names no file for the path rules to catch
(`find / -delete`, `mkfs /dev/sdb`, `systemctl stop db`) unless `writeFiles` is `allow`; and a
container's lifecycle (`docker stop`, `docker restart`, `kubectl delete`, …) unless
`containerControl` is `allow` — granting `sudo` does not answer that one.

That list is `RISKY_ACTIONS` in `shared/mcp.ts`, and every allow-to-ask upgrade in
`policyEngine.ts` is conditional on `confirmsRisky(group)` and on nothing else. These upgrades used
to be unconditional, which meant a group set to allow everything still asked, for reasons no screen
showed; the switch makes the same behaviour visible and lets a group turn it off. With it off,
`allow` means allow. It only matters in Auto mode: Ask first asks for every change anyway, and
Bypass asks for nothing. Each group's switch governs its own answer, so a restriction group with the
switch on still asks for a risky action on the target it is assigned to. It does not touch file path
rules — a rule saying `ask` or `deny` for a path still does so.

Two of them gate no tool at all. **Firewall rules** and **sudoers** are the addresses a host
accepts traffic on and the accounts that can become root on it — between them, the shortest
description of how to take the machine — so no MCP tool exposes either at any setting. What
`allow` grants there is OpsMaxx's own hourly collection, for a person to read in Security posture
and in Keys and access. Anything short of `allow` and they are never asked for: the sweep is
unattended, so there is nobody at the screen an `ask` could interrupt.

Five built-in groups ship with OpsMaxx (`policyStore.ts`), in this order:

| Group | What it grants |
|---|---|
| **Read Only** (`grp-observer`) | View server, read files, SFTP download and server metrics. Everything else is `deny` — no terminal, no database access, no container reads and no fleet reads. Container logs are whatever the application wrote to stdout, and a fleet read spans the whole workspace rather than the server it is set on; this is the tier meant to be handed out and then not thought about |
| **Commands, no writes** (`grp-read-only`) | Runs commands, queries databases, reads and controls containers, reads the fleet. What is `deny` here is file writes, SFTP upload, SSH tunnels and sudo — "no writes" means no *file* writes, and a group that runs arbitrary commands is not a read-only one |
| **Read & Write** (`grp-read-write`) | The above plus writes, SFTP upload, SSH tunnels, adding servers and VPN control — each at `ask`. Sudo is `deny` |
| **Sudo Access** (`grp-sudo`) | Read & Write with sudo raised from `deny` to `ask` |
| **Full Access** (`grp-full`) | Every capability an agent tool uses at `allow`, including host facts, CI read, CI trigger, managing servers and VPN control — except **sudo, which stays at `ask`**, so root is asked for until you raise it yourself. Firewall rules and sudoers stay `deny`: no agent tool uses either, and they are consent for OpsMaxx's own background collection (below). **Confirm risky actions is off**, so on this group `allow` means allow |

Confirm risky actions is on for the first four and off for Full Access. The default file path rules
(`/etc/shadow`, SSH keys, shell histories and the rest denied; writes under `/etc/nginx` and
`/var/www` asked) are seeded on all five, Full Access included.

**"Read Only" was renamed, and the group under that name today is a different one.** The group now
called *Commands, no writes* used to be called *Read Only* while leaving `terminal` at `allow` — so
the most conservative-sounding option in the list, and the first card a cautious person lands on,
granted an agent unattended arbitrary shell. The fix was to add the genuinely read-only tier above
it and rename the old one to say what it does; the rename matches on the exact stale string and
never touches `capabilities`, so an existing assignment keeps precisely the grant it already had.

Two capabilities are seeded `deny` on **every** built-in group, Full Access included: firewall
rules and sudoers. Three more — host facts, CI read and CI trigger — are `deny` on every built-in
group but Full Access. That is mechanical as well as substantive: `backfillCapabilities` gives a
built-in group whatever a fresh install would have given it, so seeding any of them at `ask` on the
narrower groups would quietly hand it to every upgraded install.

**Upgrading to policy version 3 widens an unedited Full Access.** `migrateToV3` (`policyStore.ts`)
gives every group an explicit Confirm risky actions value — on for custom groups and the other four
built-ins, which is the behaviour they already had, and off for Full Access. It then moves Full
Access's `hostFacts`, `ciRead` and `ciTrigger` from `deny` to `allow`, and `manageServers` and
`vpnControl` from `ask` to `allow`, **only where each still holds the value OpsMaxx shipped**. A
value you edited is left as you set it. If you want the old Full Access, edit those five values
back, or turn Confirm risky actions on.

Every field on a built-in group, capabilities included, is editable. They cannot be deleted (so an
assignment referencing one never dangles), but there is no hard-coded five-tier model underneath;
create as many custom groups as you want.

**What no access group can grant.** Two refusals do not depend on any capability value, and no
setting on any group reaches past them. Only a session the human has put in **Bypass** mode does —
see [Permission modes](#permission-modes).

- **Reverse proxies.** `set_vpn` refuses any profile whose kind is `frp` before the access group is
  consulted (`isVpnKindRefusedForAi`, `policyEngine.ts`).
- **Unrestricted shells.** `evaluateCommand` (`policyEngine.ts`) checks the command against a fixed
  pattern list — `sudo -i`, `sudo -s`, `sudo su`, `sudo bash`/`sh`/`zsh`/`dash`, bare `su`/`su -`
  — and returns `deny` whatever the group's `terminal` and `sudo` values are. There is no ALLOW
  that reaches past this branch.

**The session's group is the grant; an assignment is an optional restriction.** The group chosen
when the session was created decides what it may do. A group assigned to a server or workspace
under **Server & workspace assignment** can only narrow that: `serverCheck`/`workspaceCheck`
(`mcpServer.ts`) evaluate both and take whichever is stricter (`mostRestrictive`,
`policyEngine.ts`). Assigning **No AI Access** takes the target out of every session's reach.
A restriction group's answer is a permission like any other, so Bypass lifts it; No AI Access is
scope, not a permission, and no mode lifts it. To hold a server below Bypass, mark it Protected or
set it to No AI Access.

**File path rules** override the blanket `readFiles`/`writeFiles` capability for specific paths.
Rules are glob patterns (`**` crosses directories, `*` stays within one segment); when more than
one rule matches a path, **the longest pattern string wins** (`evaluateFilePath`,
`policyEngine.ts`) — not "most specific" in any deeper sense, just the longest string. A path
matching no rule falls back to the blanket capability.

**Server & workspace assignment** is optional. With nothing assigned, the session's own group
applies as written. Assign a group to a workspace, or override one server, to hold that target
below what a session's group allows; a server with no override inherits its workspace's
assignment (`resolveRestriction`, `policyEngine.ts`). Assign **No AI Access** to shut a target
entirely.

![File path rules and per-server/workspace assignment](images/ai-access-groups-assignment.png)

## Permission modes

The access group says **what** an agent may do. The session's **mode** says how much the human
wants to be in the loop while it does it (`SessionMode`, `shared/mcp.ts`). There are four, and each
means exactly its sentence:

| Mode | What it does |
|---|---|
| **Read only** | Reads follow the group. Every change is refused, whatever the group says |
| **Ask first** | Reads follow the group. Every change the group permits is asked for first; what the group denies stays denied |
| **Auto** (default) | The group's `allow`/`ask`/`deny`, literally, plus that group's Confirm risky actions switch |
| **Bypass permissions** | Nothing asks and nothing is refused |

A "change" is any call on a capability that changes something (`MUTATING_CAPABILITIES`,
`policyEngine.ts`: terminal, sudo, file writes and SFTP upload, tunnels, managing servers, VPN
control, container control and CI triggers), plus a database statement that is not classified as a
read. **Every `execute_command` counts as a change**, because OpsMaxx cannot tell from a command
line that it only reads: in Read only mode every command is refused, and in Ask first every command
asks. Use `read_file`, `list_files` and the other read tools in those modes.

The mode is applied in one place, `applyMode` (`policyEngine.ts`), after the session's group and any
restriction on the target have produced their answer. `serverCheck` and `workspaceCheck`
(`mcpServer.ts`) route every tool through it, and the Effective access table and
`describe_capabilities` read the same function, so what a screen shows is what a tool enforces.

**Who sets it.** Only the human, in the OpsMaxx window. A new session starts in the default mode
configured for the bridge (`defaultSessionMode`; Auto if none is set), or in the mode chosen when it
was created, and a change to a live session applies from its next tool call (`setSessionMode`,
`mcpAuth.ts`). No MCP tool can change it: `get_server_details` and `describe_capabilities` tell
the agent which mode it is in and that it cannot change it, and the server instructions tell it
not to suggest Bypass as a way around a refusal.

**Protected targets.** A workspace or server can be marked **Protected** (`protectedScopes`, stored
in the policy file, written only over IPC by the human). A session acting on a Protected target is
held at **Ask first** whatever its mode — Auto and Bypass both become Ask first there, and Read only
stays Read only. The approval request gives Protected as its reason, so an unexpected prompt
explains itself. A server is Protected if it or its workspace is marked. Tunnel, database, VPN and
CI calls are checked against their workspace; starting, stopping, defining and deleting a tunnel is
also capped when the server carrying it is marked.

### What Bypass lifts, and what it does not

Bypass is the mode for a person who has decided to let an agent run and does not want to be
interrupted. It lifts every `ask` and every `deny` that comes from a **permission**:

- the group's `deny` and `ask` on any capability, and Confirm risky actions;
- file path rules, including the seeded denies on `/etc/shadow` and SSH keys;
- a narrower access group assigned to the server or workspace — an assignment to a group is a
  permission restriction, so Bypass lifts its `deny` and `ask` like the session group's own;
- unrestricted privilege-escalation shells (`sudo -i`, `su`, `sudo bash`, ...);
- the refusal of reverse-proxy (frp) profiles.

It does **not** lift:

- **Scope.** A target set to No AI Access and a session with no access group are refused in every
  mode (`outOfScope` on the decision), and a server outside the session's workspaces is never in
  the list a tool resolves against at all.
- **Protected.** A Protected target holds a Bypass session at Ask first.

So to hold a production server even against a Bypass session, **mark it Protected** (changes are
asked for) **or assign it No AI Access** (unreachable). Assigning it a narrower group does not.
- **Stop all AI access, Revoke and expiry.** They end the session; its mode goes with it.
- **The audit log.** Every row records the session's mode, and a call that ran only because of
  Bypass — one the group would have asked about or refused — is audited as `bypassed`, never as
  `not-required`. After the fact, the log alone says which actions only happened because of Bypass.
- **Saving a connection to a fenced machine.** `add_server` and `update_server` refuse an address
  that is the OpsMaxx machine itself (loopback, its hostname, its own interface addresses) and one
  that matches a No AI Access entry by host and port, in every mode; one matching a Protected entry
  is held at Ask first. Protected and No AI Access are set per entry, and this is what stops a
  second entry for the same machine from escaping them.
- **What is absent from the bridge.** Bypass cannot reach a tool that does not exist: there is
  still no local shell, no vault read, no job runner, no backup run or restore, no tool that reads
  firewall rules or sudoers, and no tool that creates a VPN profile or CI connection.

## Approvals

Any call whose final answer — the session's group, any restriction on the target, then the mode
and Protected — is `ask` calls `requestApproval` (`approvals.ts`), which blocks the MCP tool call on an in-memory pending request — nothing is written to disk until it resolves. The
request only clears when:

- a human answers it in the approval dialog or on the **Approvals** screen (`respondToApproval`),
- it times out (`approvalTimeoutSeconds` in Security, 1–10 minutes) and is treated as denied,
- **Stop all AI access** denies every pending request at once (`denyAllPending`), or
- the agent's MCP request goes away first — the client was killed, or cancelled the call. `gate()`
  passes the request's abort signal through, and the request ends at once as `disconnected`:
  nothing runs, it is announced as "The agent disconnected before you answered", and it is audited
  as **Cancelled — agent disconnected**, not as a timeout or a denial. It starts no deny cooldown,
  because nobody decided anything. If the operator's yes and the disconnect land together,
  `gate()` re-reads the signal after the answer and runs nothing (audited the same way), and a
  session grant given in that moment is not remembered.

**Withdrawing is bounded, and a yes is armed.** Because an agent can now end its own request, it
could otherwise ask something benign, withdraw it, and ask something else in its place while the
operator is mid-click. Two things stop that:

- **Click-arming.** For 750 ms after a new request appears — or, on the Approvals page, after the
  list of waiting requests changes — **Approve once** and the session grant are dimmed,
  `aria-disabled` and inert, and an Enter or Space that went down before they armed is ignored
  when it lands. **Deny**, **Decide later** and the kill switch are never held back. The SSH
  agent's signing prompt arms its Allow buttons the same way (`hooks/useArming.ts`).
- **A withdrawal limit.** After three withdrawals from one session inside a minute, that
  session's further requests are not asked until the oldest ages out. The agent is told why,
  and the audit log records each one as **Denied — not asked** with that reason — never as a
  refusal by you. A containment request (the emergency brake) is still asked.

There is no code path from the MCP/HTTP surface into `respondToApproval` — approving a request
requires the renderer's IPC handler, which only the human-facing UI calls. An agent cannot approve
its own request by construction, not by convention.

**Two ways to say yes, and each says how far it reaches.**

- **Approve once** authorises this call and nothing after it. The next call asks again.
- **Allow "*permission*" this session** also remembers the answer, in memory, for
  that permission on that server **under the same policy rule** until the agent's session ends or
  AI access is stopped. The remembered key is session + server + permission + the policy engine's
  reason for asking, so a grant given under "Terminal commands require approval" does not answer
  a path rule that asks on its own account. For a tool whose grant `gate()` narrows to itself
  (`update_server`) the button names the tool instead of the permission. The server is left off
  the button — the dialog's Where row names it — and the full sentence, *Allow "permission" on
  server for this session*, is its tooltip. A long permission name wraps inside the button rather
  than pushing the footer onto a third row. Calls it carries are
  audited as `approved-earlier`, and the call that gave it as `approved-for-session`, so every
  carried row has one to point back to.

**A workspace-wide read asks about the workspace.** `fleet_inventory`, `list_alerts`,
`fleet_drift`, `backup_status` and `list_ci_connections` name no server, so an Ask on
`fleetRead`, `backupRead` or `ciRead` is put to you naming the **workspace** instead: the dialog
says the agent is asking to act on *the Alpha workspace*, and its Where row reads *Workspace:
Alpha — the whole workspace, no single server* (`gateWorkspaces`, `mcpServer.ts`).

- **The session grant is per tool.** It is keyed session + **workspace** + tool + rule, tagged as
  a workspace key, so the button reads *Allow fleet_drift on the Alpha workspace for this
  session*. A yes to `list_alerts` (graded low) does not cover `fleet_drift` (graded high), though
  both are `fleetRead`. A workspace grant never answers a question about one of that workspace's
  servers (`get_config_drift` is `fleetRead` too, and still asks), a per-server grant never
  answers for the workspace, and a grant on workspace A never answers for workspace B.
- **Several workspaces, one question each.** A session that holds several workspaces is asked
  once per workspace that says Ask, in turn; each dialog says *Workspace 2 of 3 this call asks
  about* and that the call returns nothing unless every one is approved. Workspaces that allow
  outright are not asked about. A no to any one refuses the whole call, and a session grant given
  earlier in that same call is taken back, because the call it was given for never ran. If OpsMaxx
  would decline to ask about any of them (deny cooldown, withdrawal limit, too many open
  requests), the call is refused before anyone is asked, rather than after you have approved the
  others for nothing. `backup_status` answers for the whole machine, so every workspace the
  session holds must permit it.
- **One audit row.** When the call covers several workspaces, the row's action names each and
  how it was let through: `fleet_inventory (Alpha: approved-for-session, Beta: approved, Gamma:
  allowed)`.
- **Only these tools ask about a workspace.** `gate()` treats a call as workspace-wide only when
  `gateWorkspaces` marked it so; any other ask that names no server is refused as **Blocked by
  policy**, so a tool that lost its server by mistake cannot be answered by a workspace grant.

Tests: `tests/workspaceApproval.integration.test.ts`. Before this, `gate()` refused every Ask that
named no server, so Ask on these three permissions behaved exactly like Deny and nobody was asked.

The second button is only offered where `gate()` would honour it. These are per-call — whenever
one of them asks, it asks on every call, shows **Approve once** alone, and never reads a remembered
grant. Whether they ask at all is the group's, the mode's and Protected's to decide, as for any
other call:

- `add_server`, `remove_server`, `create_tunnel`, `delete_tunnel`, and the `ciTrigger` tools
  `trigger_run`, `cancel_run` and `rerun_run`;
- `execute_command` for any command the classifier grades above ordinary, any command the
  policy recognises as running as another user (`classifyCommand`: `sudo`, `doas`, `su`,
  `pkexec`, `run0`, `runuser`, `systemd-run`, `sudoedit`, `machinectl shell`, `runas`, `gsudo` or
  `sudo.exe` as the command word of any segment — see docs/AI-SECURITY.md), any command whose
  command word the walk cannot read literally (`$(which sudo) reboot`, `{sudo,reboot}`, or nested
  past three levels), and, as a further raise, any command with the word `sudo` anywhere in it.
  Only the commands the policy recognises as running as another user are also gated and audited
  as the `sudo` permission rather than `terminal`, so an "Execute terminal commands" grant never
  reaches them; one that merely mentions sudo (`grep sudo /var/log/auth.log`) is labelled
  `terminal`, which is what it is, and is only kept per-call. A false positive there only means
  being asked again;
- `container_action` when stopping or restarting a container;
- `query_database` for anything not classified as a read;
- `set_tunnel` and `set_vpn` when starting.

Main reads the scope
strictly — anything other than exactly `session`, including a missing one, is `once`, and a
session answer to a request that did not offer one is also `once` — so a renderer bug fails
toward being asked again. **Deny** keeps the weight and the keyboard focus. The dialog also names
the permission being granted, in the words the Access screen uses.

Up to and including 0.50.25, the only yes button read **Approve once** and was remembered for the session
anyway, on every tool that was not per-call.

**`write_file` shows what it will write.** The dialog used to show `write <path> (N bytes)` and
none of the bytes. It now shows the start of the content — the first 4,096 characters or 80
lines, whichever is shorter, and how much is left out — in a scrolling, fixed-height, monospace
frame labelled as the agent's. The content is redacted with `secretRedaction.ts` against the
server's known secrets *before* it is cut, so a secret straddling the cut cannot survive as a
prefix. Every character in the Unicode categories Cc (controls, except tab and newline), Cf
(format characters, including every bidi, zero-width and directional mark and the U+E0000–E007F
tag block), Zl, Zp and Cs, plus U+034F, the Hangul fillers U+115F, U+1160, U+3164 and U+FFA0,
the braille pattern blank U+2800,
U+180E and the variation selectors U+FE00–FE0F and U+E0100–E01EF, is printed as `⟨U+XXXX⟩`
rather than obeyed, as is a carriage return that is not part of a CRLF pair
(`contentPreview`, `src/shared/approvalRisk.ts`). The preview is built in `approvals.ts`
and is never written to the audit log, never returned to the agent, and dropped from the request
once it is answered. A write carried on a session approval shows no preview, because nothing asks.

## Audit Log

![Audit Log showing agent, session, workspace/server, action and outcome](images/ai-audit-log.png)

Every gated action — allowed outright, approved, denied, or failed — is appended to
`opsmaxx-ai-audit.jsonl` (`auditLog.ts`) as exactly one JSON object per call, including a call
whose connection fails after it was allowed (`tests/auditOneRowPerCall.integration.test.ts`). A
refusal by the policy itself is shown as **Blocked by policy** with the rule that refused it, never
as allowed. A request OpsMaxx declined to put to anyone,
because the session already had too many open or the same action was just denied, is shown as
**Denied — not asked**, never as a refusal by you, and one whose agent disconnected while it waited
as **Cancelled — agent disconnected**. A call that ran without asking only because the session was
in Bypass mode — one the policy would otherwise have asked about or refused — is recorded as
`bypassed`, not `not-required`, and every row carries the mode its session was in (`mode` on
`AuditEntry`). Rows are written one per line, **append-only** (a crash
mid-write can corrupt at most the last line). Every free-text field (`action`, `error`) is passed
through the same redaction (`secretRedaction.ts`) used for tool output before it's written, so the
audit trail itself never becomes a place secrets end up.

## Credential isolation

`credentialResolver.ts` is the only place a server's stored SSH secret is ever read for the MCP
path — the exact same function (`resolveSecrets`/`resolveChainSecrets`) an interactive
terminal/SFTP session uses. The MCP tool handlers never see the resolved value; they build an SSH
config carrying only a `serverId`, and `resolveChainSecrets` fills in the password/key/passphrase
from the OS-keychain-backed store just before connecting. `knownSecretValuesForServer` separately
exposes the *raw values* only to `secretRedaction.ts`, so they can be blanked out of anything that
comes back — never to a response.

Jump hosts resolve independently: every hop in a chain gets its own credential lookup
(`resolveChainSecrets`), so a multi-hop path to a bastion doesn't skip this for the intermediate
servers.

## The `opsmaxx` CLI and pairing

`src/cli/index.ts` is a small Node launcher, built to `out/cli/index.js` and wrapped by
`bin/opsmaxx.cmd` / `bin/opsmaxx.sh`:

```
opsmaxx claude            Registers OpsMaxx with Claude Code, then launches `claude`
opsmaxx codex             Registers OpsMaxx with Codex, then launches `codex`
opsmaxx run -- <command>  Sets OPSMAXX_MCP_COMMAND/ARGS, then launches <command>
```

`opsmaxx bridge --token <token> --port <port>` is the fourth, internal subcommand these three
configure their target client to run — a pure stdio↔HTTP relay (`src/cli/bridge.ts`) with no
tool/session/policy logic of its own. Whatever client spawns it gets the exact same
authenticated, audited, policy-gated path an HTTP client talking to OpsMaxx directly would.

**Pairing** (`getOrPairSession`, `src/cli/pairing.ts`; `startCliPairing`/`confirmCliPairing`,
`src/main/services/cliPairing.ts`) is a device-code-style flow:

1. The CLI `POST`s `/pair/start` with an agent name and gets back a `pairingId` — never a code.
2. OpsMaxx generates a random 6-digit code and shows it **only in the OpsMaxx window**,
   never over the HTTP response. The code expires in **60 seconds** (`CODE_TTL_MS`).
3. You read the code off your screen and type it into the terminal running the CLI.
4. The CLI `POST`s `/pair/confirm` with the code. **5 wrong attempts** (`MAX_ATTEMPTS`) expires the
   pairing outright; the same code cannot be replayed once accepted.
5. On success, OpsMaxx mints a real session (8-hour TTL) in the first workspace with the first
   access group, and hands back the token — which the CLI then caches
   (`~/.config/opsmaxx/cli/sessions.json` on Linux, `%APPDATA%\OpsMaxx\cli\sessions.json` on
   Windows, `~/Library/Application Support/OpsMaxx/cli` on macOS) so it doesn't re-pair on
   every launch.

The property this buys: completing a pairing proves the human at the keyboard can see **both** the
OpsMaxx window and the terminal — the same property a TV-app or `gh auth login` device code
relies on, from a physically separate screen. Nothing sent back to the CLI process ever contains
the code, so a local process cannot complete a pairing purely on its own, without a human reading
the code off the OpsMaxx window.

## Connecting Claude Code

**AI & MCP → Security** generates the exact snippets below with your real port and token filled
in, and is also where the bridge is enabled/disabled and the approval timeout is set:

![Security tab: enable toggle, port, approval timeout, and connection snippets](images/ai-security.png)

Once you have a token (from **AI & MCP → AI Agents**, or via pairing):

```bash
claude mcp add --transport http opsmaxx http://127.0.0.1:<port>/mcp --header "Authorization: Bearer <token>"
```

Or skip the manual token entirely:

```bash
opsmaxx claude
```

First run shows a one-time 6-digit code in OpsMaxx; type it into the terminal. Every later run
reuses the cached session until it expires.

## Connecting Codex, Gemini CLI and other HTTP clients

Most clients that take a JSON MCP config accept a Streamable HTTP entry:

```json
{
  "mcpServers": {
    "opsmaxx": {
      "type": "http",
      "url": "http://127.0.0.1:<port>/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

Two in-app screens can generate this for you, and they differ slightly: **AI & MCP → Security**
includes `"type": "http"` explicitly (as above); the block **AI & MCP → AI Agents** copies right
after you create a session omits it (`url` + `headers` only) — add `"type": "http"` by hand if
your client doesn't auto-detect a Streamable HTTP server without it.

## Connecting Claude Desktop

Claude Desktop is **not** one of those clients, and the HTTP entry above will not work in it.

Entries under `mcpServers` in `claude_desktop_config.json` are launched as stdio subprocesses —
Desktop reads `command`/`args`/`env` there and ignores `url` and `headers` entirely. Its
remote-MCP support is a separate, account-level Connectors feature that expects a publicly
reachable server with OAuth, and offers no field for a bearer token against `127.0.0.1`.

Use the stdio bridge instead. `opsmaxx bridge --token <token> --port <port>`
(`src/cli/bridge.ts`) is a pure protocol relay: stdio in, Streamable HTTP out, `Authorization`
header attached on the way. No tool, session or policy logic lives in it, so a stdio client is
subject to exactly the same Access Group checks, approval prompts and audit entries as an HTTP
one.

1. Create a session under **AI & MCP → AI Agents** and copy its token (shown once). Set
   **Expires** to *Never* — a Desktop client has no way to re-pair when a token lapses.
2. Add this to `claude_desktop_config.json`
   (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS,
   `%APPDATA%\Claude\claude_desktop_config.json` on Windows):

```json
{
  "mcpServers": {
    "opsmaxx": {
      "command": "/Applications/OpsMaxx.app/Contents/MacOS/OpsMaxx",
      "args": [
        "/Applications/OpsMaxx.app/Contents/Resources/app.asar.unpacked/out/cli/index.js",
        "bridge", "--token", "<token>", "--port", "<port>"
      ],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
```

   On Windows the two paths are `%LOCALAPPDATA%\Programs\OpsMaxx\OpsMaxx.exe` and
   `%LOCALAPPDATA%\Programs\OpsMaxx\resources\app.asar.unpacked\out\cli\index.js`.

3. Restart Claude Desktop.

`ELECTRON_RUN_AS_NODE=1` runs OpsMaxx's bundled Electron binary as plain Node, so the bridge
needs no separate Node install and does not depend on `PATH` — which Claude Desktop does not
inherit from a login shell. `out/cli/**` and `bin/**` are kept outside the asar archive
(`asarUnpack` in `electron-builder.yml`) precisely so they can be spawned as real files.

**AI & MCP → Overview → Connect Claude Desktop** writes this block for you, filling in the paths
and a fresh token; the manual steps are here for anyone who would rather see what it does.

If you lose the token before pasting it, there's nothing to recover — revoke that session under
**Active Sessions** and create a new one.

Codex specifically can also be wired up with `opsmaxx codex`, which splices a
`[mcp_servers.opsmaxx]` block into `~/.codex/config.toml` (`registerCodexMcp`,
`src/cli/agents.ts`) inside a marked, safely-removable region, the same way `opsmaxx claude`
calls `claude mcp add`.

`opsmaxx run -- <command>` works for anything else that reads
`OPSMAXX_MCP_COMMAND`/`OPSMAXX_MCP_ARGS` environment variables to find an MCP server to
launch.

## Troubleshooting

**"Could not reach OpsMaxx on 127.0.0.1:`<port>`."** — OpsMaxx Desktop isn't running, or
**AI & MCP → Security → Enable AI & MCP access** is off. If it's on a non-default port, set
`OPSMAXX_PORT` before running `opsmaxx claude`/`codex`/`run`.

**"This token is not recognized" / "revoked" / "expired."** — The session behind that token was
deleted, revoked (individually or via Stop all AI access), or its expiry passed. Create a new
session, or re-run `opsmaxx claude`/`codex` to re-pair.

**"This AI session has no access group."** — The session was created without one, or the group it
named has since been deleted. Give it a group under **AI & MCP → AI Agents**.

**"This target is set to No AI Access."** — Someone assigned No AI Access to that server or its
workspace under **AI & MCP → Access Groups → Server & workspace assignment**. No mode reaches past
it; remove the assignment to lift it.

**"Read-only mode: …" or every command asks.** — The session is in Read only or Ask first mode, or
the target is Protected. Both treat every `execute_command` as a change. See
[Permission modes](#permission-modes).

**A `sudo` command is denied even though the access group allows sudo.** — Check whether it
matches an unrestricted-shell pattern (`sudo -i`, `sudo su`, `sudo bash`, plain `su`, ...) — those
are denied whatever the group's `sudo` capability says, in every mode but Bypass.

**Connecting from inside WSL to a OpsMaxx instance running on Windows.** — The bridge only
binds to `127.0.0.1`, so WSL2 needs to actually reach the Windows loopback address. If a request
from WSL to `127.0.0.1:<port>` times out or is refused even though OpsMaxx is running on
Windows, check `wslinfo --networking-mode`: `mirrored` networking mode shares the network
namespace directly and is the most reliable option; if `.wslconfig` requests `networkingMode=mirrored`
but this still reports `nat`, run `wsl --shutdown` from **Windows** PowerShell (not from inside
WSL) and reopen your WSL terminal.
