# OpsMaxx roadmap

What we intended to build, what each one actually rests on in the code today, and what is genuinely
hard about it. It began as sixteen items and grew to thirty-two as the work found things the plan
had not; the next section says where all of them now stand, and the rest of this document is kept
because the reasoning behind an ordering outlives the ordering. **Items 33–48 were added on 5 Sep
from a gap audit** — thirty operational areas checked task by task against the code at 0.15.2 —
and they are the section to read if the question is "what do we build next".

Written after 0.8.0, and maintained since: 0.9.0 through 0.9.3 shipped
nine of the sixteen, and 0.9.4 through 0.9.7 were stability releases, and this document keeps their write-ups rather than deleting them, because the
reasoning outlives the ticket.

Items 1–10 were the original list. **Items 11–16 were not, and five of the six outrank most of what
was** — they came out of asking what changes when one person runs fifteen servers instead of three,
which is the actual user, and then reading the code to check the answers.

Item 16 was the one to read first: not a feature, but the reason two of the highest-ranked features
could not be built at all — which the first version of this document ranked around without noticing.
It has since been built, and this document keeps the finding rather than quietly deleting it,
because "we ranked a blocked item first" is the kind of thing worth remembering the next time an
ordering looks obvious.

**Items A–C and 17–28 were added after 0.9.7**, from a second pass that asked a different question:
not "what does an operator want to see" — which the shipped work answers well — but "what does an
operator want to *do*", measured against a real sysadmin's week. The answer put three pieces of
plumbing in front of every feature on that list, which is why they are lettered rather than
numbered. They are not features and should never be sold as any.

The ordering at the end is the useful part of this document; the write-ups exist so that ordering
can be argued with.

This is a statement of direction, not a schedule. Sizes are rough and relative — "weeks" means a
focused person, not a calendar quarter. Where something is a real unknown it says so rather than
guessing, because the cost of a wrong estimate here is a commitment nobody can keep.

## Where this stands, as of 0.16.x

**The three items that were "part done" are closed.**

*Item 18* now covers SQL Server, the fifth and last engine, verified against a
real server rather than from the documentation — which changed three readings:
`user connections = 0` means unlimited, an empty availability-replica list means
"no AG configured" rather than "no replicas healthy", and a NULL in the backup
history means never rather than long ago.

*Item 23*'s write half is opt-in rather than unreachable. Every blocker the
adversarial review raised has been built — the independent re-authentication,
the judgement that refuses a pooled or too-early session, the `systemd-run
--user --scope` watchdog ladder — and the gate comment that still said otherwise
was three of those behind. What remains unobserved is one thing, named where the
operator turns it on: nobody has watched the rollback fire on a real RHEL 9
server with `KillUserProcesses=yes`. A gate nobody can open is a gate nobody can
test, which is why it is now a switch.

*Item 1*'s remote half is a refusal with an argument, not a gap: supervising
over a held-open SSH channel is a reliability promise the transport does not
make. **Its named successor now ships in part** — the `systemctl --user` READER,
as the `services` module. Built and verified against a real RHEL 9.8 running
systemd 252, which is where the fact worth having came from: a `--user` service
stops when the account's last session ends unless that account is lingering, so
units that read `active running` over SSH can be units that are about to stop.
The panel says that before it shows the list. The unit-file EDITOR is the
remaining half and SHIPPED in 0.19.1 — write, enable, back up any unit of that
name first, with the exact bytes previewed before they are sent.

*Item 21b*'s port mappings are STILL unverified, and the blocker is the harness
rather than the code: podman nested in Docker on Apple Silicon cannot keep a
container running (`exec container process /bin/sleep: Invalid argument`), so
there is nothing to publish a port from. Everything else about podman has been
run against a real podman 5.8.4, and the caveat was
pointing at the wrong thing. Every template renders identically and `system df`
matches, so no parsing changed — but `resolveBinary('docker')` was hard-coded at
nine call sites and a stock podman install has no `docker` binary at all, so the
panel reported the runtime absent on a server full of containers. Writing the
test found a second bug: `logs` was the one command that did not resolve its
binary, making it the only thing that failed without sudo and worked with it.
Port mappings remain unverified — podman nested in Docker cannot publish a port
— and nothing was changed on the strength of that reading.

## Where this stood, as of 0.13.1

**Every item in the matrix below is shipped, cut, or gated on something only a real host can
answer.** Four releases did it: 0.10.0, 0.11.0, 0.12.0 and 0.13.0, with 0.13.1 as a fix.

| | |
|---|---|
| **Shipped** | 24 of the 26 matrix rows, plus items 29–32 which were raised by the work rather than planned |
| **Cut, deliberately** | Ghostty (8), Tauri (10), n8n (9) and DNS/TLS — see the cut list |
| **Built but switched off** | Item 23's write half: key revoke. `ACCESS_WRITE_ENABLED` is `false` |
| **Not built, and correctly so** | Item 15(b), a third-party extension API. 15(a) — optional first-party modules — shipped |
| **Tests** | 2,215 → 4,648 |
| **Runtime dependencies added** | None. Every item above is built on `node:sqlite`, `ssh2` and what was already here |
| **Gap audit, 5 Sep** | Nineteen areas partial, five near-full, six refused by decision. Items 33–48 in "The gap audit" below say exactly what is missing in each and in what order to close it |

**The one thing waiting on the physical world.** Item 23 can stage a key revoke, and the code is
written and tested. It is off because a claim in its design has never been checked against a host
that behaves the way the claim assumes: a RHEL 9 machine with `KillUserProcesses=yes`, where ending
the session kills the user's processes. Stage a revoke there, end the session, and see whether the
authorized_keys file comes back. Until someone does that, shipping the write would be shipping a
rollback nobody has watched roll back. The read half is shipped and useful on its own.

**What has never met a real estate.** Patch management, detached execution, Kubernetes drain and the
access collector are tested against real servers, real Postgres and MySQL, a real MinIO and a real
`kind` cluster — each of which found bugs no double did — but not against a production fleet under
load. That is the next thing that will teach us something, and it is not a thing more tests can
substitute for.

## Built since this was written

Shipped in 0.9.0 through 0.9.3, and hardened across 0.9.4 to 0.9.7. Kept here rather than deleted, because the write-ups say why each
was built and that reasoning outlives the ticket.

| Item | State |
|---|---|
| **16. Background metrics sampling** | **Built.** `fleetSampler.ts` in main, scheduled, survives the monitor being closed. Off by default. Resumes when the vault is unlocked rather than sitting silently paused. |
| **3. Alert channels** | **Webhook built** — generic HTTPS JSON POST, which is what Slack, Discord and Teams all accept. Named integrations for WhatsApp and Twilio are not built and may never need to be. Only three kinds fire: `cpu`, `memory`, `unit-failed`. See item 19 for what is missing and why disk is the surprising one. |
| — | **Failed-unit alerts**, which were not on this list and are the case that prompted it: four failed units found by opening the app and looking. A failed unit does not move a CPU graph, so no threshold would have caught it. |
| **13. Fleet-wide search** | **Built.** Searches units, ports and hosts across the workspace from data the sampler already had and discarded. Reports what it could NOT search — never sampled, no systemd, no port probe, gone unreachable — because results without that gap are a lie by omission. |
| **11. Run one command across many servers** | **Built.** Approval model settled and tested first: confirmation scales with blast radius, nothing is safe by omission, cancel means queued hosts never start. Three at a time, 60s per host, output capped at 20 kB. Not exposed to the MCP bridge. Those three bounds are correct for a command and wrong for a task — see item B. |
| **12. Live log tailing across hosts** | **Built.** journalctl, `tail -F` or `docker logs`, several hosts interleaved and colour-keyed, with a real source picker across all three modes. The remote command is built from a validated source and never from user text. |
| **6. Cron, read-only** | **Built.** Crontabs, /etc/cron.d and systemd timers across the estate. Read-only until the parser is proven — the user-field trap is a silent misread, not an error. |
| **15a. Optional first-party modules** | **Built.** Six modules behind the registry. Borrows the AI_CAPABILITIES shape: absent reads as OFF, and an upgrade never switches a new module on for an existing install. Enforced twice — `MODULE_FORBIDDEN_IMPORTS` by walking the real import closure, and `MODULE_FORBIDDEN_BRIDGE` for the `window.opsmaxx` namespaces a closure walk cannot see. Part (b) is not started and `tests/moduleBoundaries.test.ts` guards against drifting into it. |
| **4a. Docker** | **Built** as the first module behind that gate, off by default. Shells out to the host's own binary. The work was in telling the three failures apart: missing binary, stopped daemon, and permission denied have three different fixes. Now beyond listing: start/stop/restart with graded confirmation, `docker exec` as a third `TerminalTransport`, container logs followed live, and `docker system df` parsed down to reclaimable bytes per type. |
| **4b. Kubernetes** | **Built, read-only plus one write.** Pods, nodes, deployments/statefulsets/daemonsets with ready-versus-desired, namespace events, `kubectl top` where a Metrics API answers, and a diagnosis view. The first mutation was `kubectl rollout restart`; cordon, uncordon, drain and a one-command exec followed under item 22. It deliberately does not switch contexts, apply, scale, or delete anything, and `src/shared/kubernetes.ts` states why in the file rather than in a commit message. This document previously said Kubernetes should stay "separate and later"; it arrived earlier because the Docker module's failure classification and sudo discipline transferred wholesale. |

Two things those unlocked, now unblocked rather than done: **fleet-wide search** (item 13) can now
index a complete estate rather than whatever was last looked at, and any future scheduled work has
a scheduler to live in.

### What the pre-release review changed

Three adversarial reviewers went over both features before release and returned about thirty
findings. Two patterns account for most of them, and both are worth remembering rather than
just fixed.

**The main process was built carefully and the renderer used only its happy path.** `fleet.status()`,
`fleet.sampleNow()`, `webhook.delivery()`, `clearUnitAlerts()`, `useFleet.forget()` and
`clearServer()` were each wired through IPC with a docstring saying what they prevented, and each
was called from nowhere. The settings screen showed a webhook as healthy while alerts were being
dropped; the monitor rendered nothing on first run; a deleted server kept counting in the status
bar. None of that was visible from the main-process side, where everything looked complete.

**Four tests asserted only negatives or literals, and each passed against the bug it was written to
catch.** One checked a packaging glob by asserting the pattern string rather than running it — the
pattern matched nothing and shipped two Windows binaries that should not have been there. Every fix
in this round was verified by reverting it and watching its test fail, and one new test had to be
tightened when that check showed it passing against the bug (`toContain` on an array is exact
equality, so a forged line with a trailing suffix slipped past it).

Two defects were already live in 0.8.0. `get_server_metrics` passed systemd unit descriptions,
process names and the kernel string to the agent verbatim through a `readOnlyHint` tool that needs
no approval — an injection channel from any host under an attacker's control. And the capability
grid still said "Server metrics" after that tool began returning a full service and port inventory,
so consent had been given for something narrower than what was taken.

### Measured against a real estate, 2 Sep

Run on the author's own machine against two live hosts, background checking on at a 2-minute
cadence. 174 samples over ~45 minutes, counting OpsMaxx's own sockets by PID.

| | |
|---|---|
| Additional connections from background checking | **none** |
| Steady state | 1 connection per server, shared with the foreground monitor |
| Held with zero foreground sessions | yes, indefinitely |
| `sshMasterIdleMinutes` (set to 15 min) applied | **no** — as the settings rows now disclose |
| Main-process RSS | 125–151 MB |

The pool keys on `srv:${serverId}` (`hopKey` in ssh.ts), so the monitor, the sampler and the MCP
bridge share one connection per server rather than opening three. Sessions were closed at 00:52 and
the connections were still up at 01:08, past the 15-minute idle setting — the refcount never reaches
zero, so the idle timer is never armed. That is now measured rather than argued.

**What this does NOT answer.** Two hosts, direct, no bastion. The open question was fifteen hosts
behind jump boxes, and a chained hop pools *per hop* — so bastion load scales differently and none of
this measures it. Treat the zero-additional-connections result as true for direct estates and
unproven for chained ones.

**Two findings came out of running it, both shipped.** Background checking was silently paused on a
locked vault, with the only indication one line in a Settings pane nobody opens — now a status-bar
chip. And the alert-threshold row claimed "alerts fire wherever you are in the app" while the
sampler sat paused, because it read the setting rather than the running state. Neither was findable
by reading the code.

**Not verified against a real estate.** The sampler has unit tests and the webhook has been proved
against a live local endpoint, but nobody has yet turned background checking on with fifteen hosts
behind bastions and watched what happens to connection count, bastion load or battery. That is the
decision item 16 flagged and it needs a real fleet to answer.

## The gap audit — 5 Sep, against 0.15.2

Every write-up above says what an item was meant to do. This section says what each operational
area can and cannot do **today**, read from the code rather than from the write-ups, so that the
next round of building starts from the gap and not from the intention.

**How it was done.** Thirty operational areas — the ordinary week of the ten-to-fifty-host operator
from "Who this is for" — were broken into their typical tasks and each task was checked against
the working tree at `bb4620b`, in eight independent read-only audits. Every task was classified
one of four ways, and the fourth is the one that matters most:

| | |
|---|---|
| **DONE** | Achievable in the app, end to end, with tests |
| **PARTIAL** | A real piece exists; the task as an operator would phrase it is not covered |
| **MISSING** | Nothing usable exists |
| **REFUSED BY DESIGN** | The code or this document states a deliberate non-goal, with a reason. **Not a gap.** Listed so nobody rebuilds the argument from scratch |

Five areas came out near-complete (monitoring, alerting, Compose, frp, inventory). Six are
refused or absent by decision (Kubernetes backup, DNS/TLS, documentation, vulnerability
scanning, a configuration DSL, unattended patching). The nineteen in between are what this
section is about, and they are numbered from 33 onward so they can be argued with the way
items 1–32 were.

### Three findings that reorder the work

**1. Almost every write the operator asks for lands on one missing surface.** The job engine
shipped in full — waves, health gate, reboot-and-verify, detached execution, approval record —
and **no renderer composes a job.** `jobs.run` is called from exactly one place,
`PatchPanel.tsx:294`, and `jobs.list`/`jobs.get` are called from nowhere; job history is visible
only through the change log. So "restart nginx on twelve hosts", "install a package everywhere",
"push this config", "run VACUUM in a window I chose" are all the same missing thing wearing
different clothes: a job composer plus a handful of *typed* step kinds whose text is built in
main rather than typed by hand. Item 33 is that composer and item 34 the step kinds. Half the
partial areas below close on those two.

**2. Five refusals share one precondition, and it is a lab host.** Firewall edit
(`posture.ts:118-125`), host quarantine (`posture.ts:100-105`), per-account key revoke
(`index.ts:1257-1272`), sudoers edit and SSH key rotation all say, in their own words, "not until
there is a staged write with an independent re-authentication and an automatic revert." That
protocol exists — `access.ts:2814-3140`, 56 tests against a real shell — and is switched off at
`ACCESS_WRITE_ENABLED = false` pending the RHEL 9 `KillUserProcesses=yes` check named at the top
of this document. Nothing else on this page unblocks as much per day of work as that check.
Item 36.

**3. Three defects were found that are not features.** `policyEngine.ts:425` classifies a
statement by its leading verb, so `SELECT pg_terminate_backend(123)` and `ANALYZE` are `read`
and run through `query_database` with **no approval** under the default group. `ComposePanel.tsx:162-181`
mints a job approval without a dialog, which is correct for a one-host `pull` and wrong the
moment `sudo` makes the plan ask for `confirm`. And `assessCommand`'s docker/podman destructive
rule (`broadcast.ts:223-230`) is not applied to `execute_command`, so an agent's `docker volume rm`
is graded `high` only if it says `sudo`. Item 35, and it goes first.

### Corrections to this document

Found while auditing, fixed in the sections above where they were one-line; listed here where
they were not.

- **Item 32 is shipped**, not open: `EVENT_RETENTION_TIERS` at `history.ts:440-458` keeps alerts
  400 days and `RUNBOOK_LOOKBACK_DAYS` mirrors it. Two comments still say JSONL logs have no
  retention (`shared/changelog.ts:154-158`, `services/changelog.ts:57-63`); they do, since
  `jsonlPrune` was wired at `index.ts:884-892`.
- **B4 is in code**, not remaining: stages, gate, reboot-and-wait and jump-host exclusion are all
  in `jobRunner.ts:962-1214` and tested. The matrix row and the split table were wrong.
- **Kubernetes execs into pods.** `modules.ts:259` and the 4b row above still said it never
  would. Exec shipped behind `approvalFor`/`verifyApproval` (`kubernetes.ts:74-79`).
- `jobs.ts:316-329` describes an `access` job kind that `JOB_KINDS` does not contain and
  `access.ts:2462` says was removed. `access.ts:385` mentions a `sudoIsProxy` field that does not
  exist on `AccessAccount`. Both are stale comments, not code.
- The first of item 23's two follow-ons ("the panel must state the scope before selecting a
  target") is done — `ACCESS_WRITE_SCOPE` renders at `AccessPanel.tsx:421`. The second, the
  missing approval-log row, is not, and is folded into item 35.

### Where every partial area stands

One row per area. "Done" is the part an operator can lean on today; "gap" is the exact thing
missing, with the item that closes it. Sizes are for one focused person.

| Area | Done today | Exact gap | Item |
|---|---|---|---|
| **Linux fleet** | Patch apt/dnf/yum/zypper/pacman/apk; security counts where the distro publishes them; reboot waves with boot-id proof, health gate, jump-host and same-wave-DB refusals; failed units read | No package install/remove/hold; no `systemctl` verb; no fsck/LVM/mount; no "kernel installed vs running" fact. OS release jumps refused on the patch path (`patch.ts:133-136`) and should stay so | 34, 46 |
| **Fleet automation** | Broadcast with blast-radius confirm; detached durable jobs; nine fact sources hourly; event rules with pinned approval | **No job composer or job list in the renderer.** No fleet file push. No user primitives. Rules have no time trigger (refused: `rules.ts:6-16`). No tag-seeded target pick, no stop-on-first-failure | 33, 34 |
| **Access & SSH** | Every `authorized_keys` fingerprinted and attributed; locked/expired accounts; admin groups; last login; jump chains | Key add/revoke built, **switched off**, connecting account only. Sudo is group membership, not `sudoers`. No export. No service-account classification | 36, 46 |
| **Security** | Firewall in both layers with rule lines behind their own consent; sshd vs baseline; SELinux/AppArmor mode; failed logins; OOM kills; cert inventory with 30-day alert; drift over seven watches; app-side audit | No firewall/sshd/MAC writes (refused until 36); no secrets rotation; no auditd posture; per-package security list absent; drift watches fixed | 36, 43, 46 |
| **Docker** | Start/stop/restart graded; exec; logs one-shot and followed; stats; `system df -v` per item; reclaim by id with re-preview; health status parsed | No `pull`/`build` as a job (comment-only today); networks reclaimable but never listed; no targeted engine upgrade; no scanner consumer; podman unproven | 42 |
| **Compose** | Discover, parse, declared-vs-running, edit image tag with stale-check, `pull` and `up -d` as jobs, `.env` names only | Per-service scope built but not wired; no compose `restart`; validation errors surface as "nothing this parser could read"; `depends_on`/volumes/`restart:` parsed and not rendered; no `.env` write; approval minted without a dialog | 35, 42 |
| **Kubernetes** | Pods with reason-over-phase, workloads ready/desired, events, describe, previous logs, `top`, PVCs, ingress, RBAC bindings, secret names, deprecated APIs, helm list; rollout restart, cordon/uncordon, drain with seven refusals, exec | No node conditions/allocatable/taints; no requests/limits; no HPA; PDBs only inside the drain; no Role rules; no PV/StorageClass; no cert expiry of any kind; helm list parse unproven | 39 |
| **K8s lifecycle** | Each primitive as a separate click; API scan with stated blind spots | Nothing chains cordon → patch → reboot → uncordon; the job engine does not know a host is a node; gate is systemd-only. Upgrades, helm upgrade/rollback, `rollout undo` contradict the module's own reasoning | 40, 41 |
| **PostgreSQL** | Dump to local/SFTP/S3 with read-back; replication, archiver, vacuum age, connections, locks, sizes, `pg_stat_statements` — nine judged questions | Dumps are manual, plaintext, 512 MB in memory, no restore. No slots/`pg_wal` size. Slow queries have no alarm level. Locks show the blocked, not the blocker. No write of any kind (routed to jobs by `dbOps.ts:33-35`) | 37, 38 |
| **MySQL/MariaDB** | As Postgres, plus binlog inventory and buffer pool | No top-N slow statements (only whether the log is on); no binlog purge; no `KILL`/`OPTIMIZE`; no binlog position in dumps | 37, 38 |
| **MongoDB** | Replica set, oplog window, index usage, connections, current ops, sizes, asserts | **No `mongodump`** (stated absence, `backupTargets.ts:702`); no index build monitor; `mongos` out of scope; index sizes never populated (`dbOps.ts:700-720` does not pass `sizes`) | 37, 38 |
| **Redis** | Memory, eviction, persistence, replication, slowlog, keyspace, cluster, clients | No backup path at all; AOF, Sentinel and Cluster judged but never exercised; no trend | 37, 38 |
| **Backup/DR** | Encrypted app bundle to three destination kinds, retention with three refusals, read-back + decrypt verify; PG/MySQL dumps | The bundle is app state, never host data; dumps have no schedule, encryption, retention or restore test; no volume backup; see 38 | 38 |
| **Logging** | journald/file/container tail across hosts with preflight, pause buffer, priority/since, client filter; K8s pod logs one-shot | No search across hosts or history; no error-rate kind; no rotation read; auditd/sudo logs tailed as files only | 43 |
| **Incident response** | Inbox, ack, snooze, dedupe, flap damping, hysteresis, 400-day history; runbook per kind; rules alert → job | No alert → log deep-link; no systemd restart button; no rollback of anything; no DB restore; quarantine refused until 36; no incident span | 43, 44 |
| **Change management** | Waves with gate; drift; change log over four records | No maintenance window; no rollback plan on the approval; no per-package version inventory | 44, 46 |
| **Housekeeping** | Docker reclaim by id | Nothing reads logs, tmp, journald usage, autoremove candidates, LVM snapshots, stale K8s objects; dead users/keys have no verdict | 45 |
| **Storage** | Root-filesystem disk and inode %, alerted at 85; PVC request and capacity; Docker disk per item | Per-mount capacity now READ on demand (`storageLayout.ts`); the trend and the alert are still `/` only. Inode IS stored and trended -- `inodePct` is in `CAPACITY_METRICS` and in the history metric list, and the fleet sampler writes it. No LVM, mdstat, SMART, zfs, NFS read of any kind | 47 |
| **Capacity** | cpu/memPct/diskPct trends over 7 d full + 90 d hourly, forecast with eight refusals and a 90-day horizon | No K8s allocatable-vs-requested — blocked on a k3s fixture this machine cannot capture. The fleet-level forecast SHIPPED (`shared/fleetForecast.ts`, three bands, headline always carrying the denominator) and so did `get_capacity_trends` over MCP, gated on `serverMetrics` | 47 |
| **OpenVPN / WireGuard** | Client side is complete: sanitised import, OTP, split/full tunnel, management-interface health; WireGuard userspace *and* system mode (Linux/Windows), peers, allowed IPs, handshake age, bytes, keygen with derived public key | Nothing touches a VPN **server**: no `wg set`, no easy-rsa, no CRL. No `vpn-down` alert kind. Client cert `notAfter` never read (`<cert>` is opaque). `latencyMs` exists in the type and no driver fills it. Sidecar reports one handshake and a peer *count*, not per-peer rows | 48 |

### What is refused and stays refused

The audits found these written down, each with a reason that still holds. They are collected here
so a future request can be answered by citation rather than re-argued.

| Refused | Where the reason is | Note |
|---|---|---|
| OS release jump inside a patch run | `patch.ts:133-136`, `:203` | A separate opt-in "release jump" job is not formally refused; every argument in `patch.ts:30-62` weighs against it |
| App-side schedules and time-triggered rules | `patch.ts:37-67`, `rules.ts:6-16` | Host-side cron edit (6e) is the sanctioned route. A window *filter* on rules does not contradict this |
| `prune` in any spelling, `-a`, `--force`, build-cache removal | `docker.ts:568-600`, `:1972-1974` | Blast radius must be a literal list of ids |
| `compose down`, `down -v`, `rm`, `kill`; `.env` values on screen | `compose.ts:1070-1085`, `:28-67` | Shipped stricter than the write-up asked |
| Kubernetes context switch, apply, scale, edit, single-pod delete, agent reach | `kubernetes.ts:34-65`, `tests/jobsNotExposed.test.ts:865-941` | `rollout undo` and `helm upgrade`/`rollback` fall under *edit* by the file's own taxonomy — see item 44 |
| Any write from the database operations panel | `dbOps.ts:16-83` | "If a session must die, that is a job" — item 37 is that job |
| sshd_config write, `systemctl restart sshd`, `setenforce`, fail2ban ban/unban | `posture.ts:127-139` | Sawing the branch off |
| Drift push-to-fix | `drift.ts:1040-1063` | A canary upgraded first looks exactly like a host that drifted |
| Firewall edit, host quarantine — **conditionally** | `posture.ts:100-125` | Precondition is item 36's protocol, proven on a real host |
| `sudo` in the access write | `access.ts:2307-2313` | The decision per-account revoke and sudoers edit must overturn first |
| SQL Server operations | `dbOps.ts:4354-4359` | Never run against one |
| `KEYS`/`SCAN` on Redis | `dbOps.ts:78-83` | Big-key analysis needs an argued exception |
| Full tunnel in WireGuard system mode; macOS system mode; a kill switch; any script directive in a VPN config; agents starting frp or seeing an endpoint or key; an elevated run restarting itself | `drivers/wireguard.ts:1445-1464`, `docs/VPN.md:50-62, 289-294`, `parsers/ovpn.ts:49-175`, `policyEngine.ts:520-524`, `managerApi.ts:34-38` | Unchanged |
| Vulnerability scanner, config DSL, metrics warehouse, ticketing, DNS/TLS management, Kubernetes manifests, unattended patching | The table above this section | Unchanged |

---

### 33. A job composer, and a job list — **SHIPPED**

A `jobs` module (OFF by default, and more deliberately than the read-only ones:
this one writes), `shared/jobCompose.ts` for the vocabulary, and a `JobsPanel`
with list, detail, live output, cancel and a composer. The confirmation is the
one `planJob` demands — the panel does not decide for itself that a verb is
safe, which is the mistake item 35 had to fix in ComposePanel. Waves are
`cohort` labels, so twelve servers three at a time is a blast radius of three
and asks for less than twelve at once. Still open from this item: seeding a
selection from a folder or tag, halt-remaining-across-hosts, and saved
templates.

**The finding above, made concrete.** `src/preload/index.ts:168-199` exposes
`list/get/run/cancel/setDetached/capabilities/onProgress/onOutput`; IPC is wired at
`index.ts:1812-1830`; `planJob` (`jobs.ts:442`) sizes the confirmation on the largest cohort;
`jobApprovalFor` (`:506`) mints the record; `planWaves` (`patch.ts:711-728`) splits targets; the
gate and halt are tested (`tests/jobStages.test.ts:190-396`). `PatchPanel.tsx:286-312` is the only
caller and is a copy-able template. `RulesPanel.tsx:245-255` already composes a multi-step
`command` spec from a textarea.

**What is new.** A `JobsPanel` — list, detail, live output, cancel — and a "New job" composer:
steps textarea, hand-picked targets, wave size, gate toggle, an optional `reboot` flag on a step,
and the confirmation dialog `planJob` asks for. "Re-run as new job" is allowed only if it
re-mints the approval; a saved *template* may hold steps and never targets (`broadcast.ts:13-15`).
Two small broadcast follow-ons ride along: seeding a selection from a folder or tag — a seed,
never a persisted set — and "halt remaining hosts on first failure", which the engine already
does per host (`tests/jobRunner.test.ts:328`) and not across hosts.

**What it must not do.** Reach the bridge (`tests/jobsNotExposed.test.ts`), skip the dialog the
way the rules surface refuses a "run now" button (`rules.ts:613-619`), or run a gate without the
sampler on (`GATE_SAMPLER_NOTE`, `patch.ts:1090-1093`).

**Size.** 1–1.5 weeks. Everything in item 34 is a step kind inside it.

### 34. Typed step kinds: service, package, file, user

This document's non-goal table says the useful subset of configuration management is "about eight
idempotent operations — package, service, user, file, key, line-in-file — and everything past
that is a language." Item 33 gives those operations somewhere to run; this item is four of them,
each a builder in main so the approval record holds structured intent rather than free text, and
each an OFF-by-default module (`modules.ts:82-95`).

| | Exists | New | Refused neighbour | Size |
|---|---|---|---|---|
| **34a service** — **SHIPPED** | — | `start\|stop\|restart\|reload\|enable\|disable` in `shared/serviceStep.ts`, wired as the composer's second mode. Unit names are an enumerated character set, not an escape function, because the value is interpolated into a command that runs as root. sshd is refused outright for every interrupting action — no phrase makes it a good idea, and offering one would imply there is. The name is checked against the units the PICKED servers reported, and `null` services is never read as "runs no units". Every action gets a verify step, because `systemctl start` exits 0 having asked. `stop` on a database unit needs no special rule: `assessCommand` already grades it destructive, so it demands a typed phrase. | | done |
| **34b package** — **SHIPPED** | — | `install\|remove\|hold\|unhold` per manager in `shared/packageStep.ts`, wired as the composer's third mode. The MANAGER IS CHOSEN ONCE for the job, not per server: a job is one step list for every server in it and `verifyApproval` compares that text literally, so a command substituted per server could not be checked against its own approval. Stricter than `patch.ts`, which plans per server, and deliberately so — a patch run is "bring everything up to date", this is "install exactly this". apt removes rather than purges. apk and pacman refuse `hold` OUT LOUD rather than producing a command that does nothing, because "the job succeeded" on a server where the pin was never applied leaves the operator believing a version is held. Every action verifies, since `apt-get install` exits 0 having installed nothing when the name matched a virtual package. No `'package'` JobKind: the engine runs commands, and a second kind would be a second execution path for no gain. | done |
| **34c file push** — **SHIPPED for a NEW file** | — | `shared/fileStep.ts`, the composer's fifth mode. The content goes into the command as base64 and its sha256 beside it, so `verifyApproval`'s literal comparison covers the BYTES — a job whose content was swapped between the dialog and the run does not verify. The host checks the arriving bytes against that hash and refuses if they differ, which is the only step that would notice a truncated transfer. Written to a temporary file and renamed over, because a rename is atomic and a truncate-then-write is not — a process reading a config file mid-write sees half of it. authorized_keys, shadow, passwd, sudoers and any private key are refused, pointing at the screen that stages and rolls back. Base64 rather than a heredoc, which `userUnits.ts` learned the expensive way. REPLACING an existing file is still open: it needs the current checksum read from each server first, and a job is one command for every server, so "what is there" is not one answer. | new file done |
| **34d user** — **SHIPPED** | — | `create\|lock\|unlock\|add-group\|set-expiry\|delete` in `shared/userStep.ts`, wired as the composer's fourth mode. THE PASSWORD RULE IS STRUCTURAL, not a redaction: there is no action that sets one, and the panel says where the field would have been. A step's text is stored, hashed, compared and rendered — redaction happens at the writer, one of those four places — so a password in a step is a password in a record that outlives the job. `create` makes a locked account with no password and access arrives as a key through item 36's gate. `lock` expires the account as well as locking the password, because `usermod -L` alone leaves key logins working and an operator who locks an account believes it is shut. `delete` asks about the home directory separately, and root and the system accounts are refused at any strength. | done |

**Order.** 34a first: it is the smallest, it is the one the inbox needs (item 43), and it proves
the typed-step shape before 34c spends three weeks on it.

### 35. Defects first: the classifier, the silent approval, and the missing rows — **SHIPPED**

**All four, and one of them was bigger than written.** Defect 3 asked for
`execute_command` to grade `docker volume rm` as `high`. It does now, and that
changed nothing on its own: `risk` is read only inside the `decision === 'ask'`
branch, `terminal` is `allow` in all four built-in groups, and an allowed
command never opens a card for a grade to appear on. So the DECISION moved too
— a destructive or elevated command can no longer resolve better than ASK,
which is the rule this file already stated about `DROP TABLE`. Sudo is exempt,
because a group that set it to `allow` had that decided by a human.

Defect 1 turned out to be four traps rather than one: the SELECT wrapper, EXPLAIN
ANALYZE (which executes), SELECT ... INTO, and ANALYZE itself. The existing test
asserted `pg_terminate_backend(1)` bare — the form nobody types.

The classifier moved to `shared/commandRisk.ts`; `jobsNotExposed.test.ts` caught
the import dragging the job engine into the agent-reachable closure.

Not a feature. Four things the audit found that should land before anything above is built on
top of them, because each is a hole in a safety property this document claims.

1. **`policyEngine.ts:425`.** The `READ` regex keys on the leading verb, so `SELECT
   pg_terminate_backend(…)`, `SELECT pg_switch_wal()`, `SELECT pg_stat_statements_reset()` and
   `ANALYZE` are `read` → `low` risk → no prompt with `databaseAccess = allow`, which every
   built-in group grants (`:410-411`). Treat `pg_terminate_backend`, `pg_cancel_backend`,
   `pg_switch_wal`, `*_reset` as mutating and move `analyze` out of `READ`. A day.
2. **`ComposePanel.tsx:162-181`** auto-fills the phrase and calls `jobs.run` with no dialog.
   Correct while `confirmationFor(ordinary, 1)` is `none`; wrong once `sudo` makes the step
   `elevated`. Reuse the job confirm dialog whenever `jobPlan.confirmation.kind !== 'none'`. Half
   a day, and every new compose verb inherits it.
3. **`execute_command` risk.** `mcpServer.ts:833` grades `high` only on `sudo`. Apply
   `assessCommand`'s docker/podman rule (`broadcast.ts:223-230`) so `docker volume rm` from an
   agent is `high`. A day.
4. **Approval-log vocabulary.** `JobApprovalEntry.surface` is `'broadcast' | 'job'`
   (`jobs.ts:557`) and `ApprovalSurface` is `'broadcast' | 'job' | 'k8s-exec'`
   (`broadcast.ts:603-605`). Key add/revoke (`index.ts:1309-1400`), `kubectl exec`, cordon, drain
   and every item-37 statement need a row in `opsmaxx-job-approvals.jsonl`. Widen both unions
   once — `'access'`, `'k8s'`, `'db-statement'` — so item 36's first real revoke is recorded.
   Half a day.

**Size.** A week, all four. Nothing else on this page should merge first.

### 36. The access write gate, and the five things behind it

**36a. Flip `ACCESS_WRITE_ENABLED`.** The code is complete: plan and blocks
(`access.ts:2528-2751`), both builders (`:2753-2812`), staged write with backup, count check,
`chmod 600`, watchdog and arming proof (`:2860-2930`), verify and disarm (`:3057-3140`),
`AccessCommitter` over a fresh unpooled session (`services/access.ts:218-341`), main-side
re-derivation (`index.ts:1309-1334`), and the scope statement on screen. What flips it is not
code: stage a revoke on a RHEL 9 host with `KillUserProcesses=yes` and no lingering, end the
session, and watch whether `authorized_keys` comes back. The residual the design admits is at
`docs/plans/roadmap-execution.md:603-608` — the arming proof catches a watchdog that never
started and cannot catch one killed afterwards — and the five things to try are at `:614-625`.
**36a is ANSWERED.** The RHEL 9.8 check was run (systemd 252, logind
`KillUserProcesses=yes`, real PAM sessions), and it produced the measured table
now in `access.ts`: only a `systemd-run --user --scope` on a LINGERING account
ever survived; `setsid` and `nohup` never fired in either column. So the write
refuses to stage when logind kills user processes and the account does not
linger, and `ACCESS_WRITE_ENABLED = false` became the DEFAULT rather than the
whole gate — `settings.accessWriteEnabled` is the operator's opt-in and main
enforces it in both handlers.

The `nohup` question is answered too, and the answer is not about the launcher.
`SP_KILL` was two-valued, and `no` meant both "logind answered false" and "we
could not ask" — opposite facts, one of which armed a rollback that logind may
have been about to kill. It is three-valued now (`absent`/`no`/`yes`/`unknown`)
and `unknown` refuses alongside `yes`. So a host that fell through to `nohup`
may be written to only where it positively said it will not kill the process:
logind absent, or logind answering false. Four behavioural tests, each driving
a shimmed `loginctl`/`busctl` rather than asserting on the command text.

**36b. Sudoers read — PARSER SHIPPED.** `shared/sudoers.ts` parses `Defaults`, aliases, specs,
tags and include directives, and answers "what does sudo grant this account" by NAME, by GROUP
and through a `User_Alias` — replacing the ADMIN_GROUPS guess, which is wrong in both directions.
Verified against the real `/etc/sudoers` from `debian:12` and `almalinux:9`, captured as
fixtures.

Three things the item did not say and each changed the shape:

`NOPASSWD` is not a boolean. Tags apply to the commands that FOLLOW them, so
`NOPASSWD: /bin/ls, PASSWD: /bin/rm` is one spec where one command needs a password and one does
not — and a boolean answers it wrongly whichever way it is set, the wrong direction reporting
passwordless ROOT for an account with passwordless `ls`. It is `'all' | 'some' | 'none'`.

`#includedir` is a DIRECTIVE that begins with the comment character. Both fixtures use it and
both keep their real rules in `/etc/sudoers.d`, so a parser that treats it as a comment concludes
the host has almost no sudo configuration.

A line that could not be parsed is CARRIED OUT, never dropped, and makes the per-account sentence
say the reading is incomplete. A sudoers parser that silently ignores what it cannot read will
one day ignore the line granting root.

**The consent line is SHIPPED**: `sudoersRead`, a new `AiCapability`, denied on every seeded
group and opted into by none — so an upgraded install backfills it to deny rather than inheriting
an `ask` nobody can answer during an unattended sweep, which is exactly the argument
`firewallRules` makes one line above it. Being allowed to RUN sudo and being allowed to READ who
else can are different grants, and the Sudo Access group has the first and not the second. No MCP
tool exposes it whatever it is set to.

**The probe is SHIPPED** and verified against `debian:12` with four drop-in files planted in
`/etc/sudoers.d`. It reads each file SEPARATELY — "which file grants this" is the first question
anybody asks and the last a concatenation can answer — in `sort` order, because the shell's glob
order is locale-dependent and sudo's is not, and it skips the names sudo itself skips (a `.`
anywhere, or a trailing `~`). Reading those would report rules that are NOT in effect, which is
worse than missing ones: an operator would go and remove a grant that was never granted. Bounded
on the HOST, not here: a 2 GB `/etc/sudoers` must not reach the SSH channel. An unreadable file
makes the answer incomplete rather than absent, and the sentence says the usual cause is a sweep
that was not root.

**The gate is wired**: `sudoersReadGranted` reads the capability and nothing else, exactly as
`firewallRulesGranted` does — `ask` collects nothing, because the sweep is unattended and there
is nobody to answer a prompt — and `readSudoers` is its own exec rather than being folded into
the hourly access command, so a server whose group has not consented is one this never touches.
A failed read returns `null`, never `[]`: a read that did not happen is not a host with no
sudoers rules. The sampler passes the capability per server, exactly as it does for the firewall rules, and the
access panel renders the findings. THREE STATES are kept apart there and the type exists to force
that: `undefined` is nobody consented, `null` is the read was asked for and failed, and an array
is an answer. A server whose read failed says so rather than appearing as a server with no sudo
rules. **Item 36b is complete.**

**36c. Per-account revoke.** Blocked in main, not the planner (`index.ts:1257-1272`). Needs a
per-host command (the connecting-account write resolves `$HOME` on the host, `:2860`, so one
text covers a selection; a per-account write cannot), which turns the confirmed-command equality
into per-host equality — the shape `AccessChangePlan.disarm` already has (`:2503-2505`) — and
needs `sudo` in the write, which `:2307-2313` refuses on the ground that an escalated write is
indistinguishable in the sudo log from an attacker. That refusal must be overturned in writing
before a button. **1–2 weeks after 36a.**

**36d. Firewall edit.** Refused at `posture.ts:118-125` until "a staged write, an independent
re-authentication and an automatic revert" exist — 36a's protocol, pointed at `ufw`/`nft`.
`firewalld --timeout` is native and is the safe first slice; `nft list ruleset` → `nft -f` is
the snapshot/restore for the rest. Verify with a fresh session, which proves only that SSH still
passes — the one thing the app *can* prove. Post-change re-read of the rule listing closes the
"reported done, changed nothing" class. **2–3 weeks after 36a; firewalld alone, one.**

**36e. Host quarantine.** 36d with a fixed ruleset (operator's source only). **2 weeks after 36d.**

**Also behind the gate.** SSH key rotation = add → verify → revoke with the old key under
`protect` (`access.ts:2415-2417`) until the fresh session succeeds (2 weeks after 36a).
Sudoers *edit* needs everything 36c needs and would be the first root-escalated write in the app;
recommend not before 36c lands. Local secret-age tracking on vault entries (`vault.ts:47-48`)
needs none of this and is days.

### 37. A database statement job

**Why one item and not twelve.** `dbOps.ts:16-83` refuses every write from the operations panel —
terminate, `VACUUM`, `PURGE BINARY LOGS`, `OPTIMIZE`, `createIndex`, `killOp`, `BGSAVE`,
`CONFIG SET` — and at `:33-35` names where they belong: "that is a job: it goes through the job
engine's approval model." The job engine has no database target. `JobStep.command` is a shell
string (`jobs.ts:346-347`), `JobTargetRef` is a server (`:405-409`), and `ApprovalSurface` has no
database value. Every one of the twelve is one to three days *after* this surface exists and
weeks *without* it.

**The shape.** Mint `approvalFor({surface:'db-statement', commands:[<the literal statement>],
targets:[{serverId: db.id, serverName: db.name}]})` when the human types the phrase, verify with
`verifyApproval` immediately before executing — the pattern `kubernetes.ts:404-422` reuses
unmodified for `kubectl exec`. Run on `openTransient()` (`db.ts:276`), never the shared client;
bind the value where the engine allows and where it cannot (`PURGE … TO '<file>'`) use a
throwing builder enumerated in a `DB_WRITE_STATEMENT_BUILDERS` list so
`tests/dbOpsRegressions.test.ts:78-127` can see it. Its own risk plan — `destructive`,
type-to-confirm with the pid or file name as the phrase. Output to history, redacted. Never in
the bridge's import closure, and close item 35.1 in the same change.

**Then, per engine, in the order an operator would ask:** PG terminate backend and kill blocker;
MySQL `KILL`; MySQL `PURGE BINARY LOGS TO` with a preflight that reads every replica's current
file *from the replicas* (cross-connection, new); PG `VACUUM`/`ANALYZE` and MySQL
`ANALYZE`/`OPTIMIZE` with the lock-time warning the refusal already wrote; Mongo
`createIndexes`/`dropIndexes` plus the in-progress build monitor that `serverStatus` zeroes
today (`dbOps.ts:2612`); Mongo `killOp` fetching `command` for the one opid named; Redis
`BGSAVE` with a poll on `rdb_bgsave_in_progress`; Redis `CONFIG SET` for `maxmemory-policy`.

**Reads that ride along and need no surface** (each 1–3 days, fixtures required). **PG
`pg_replication_slots` and the blocking TREE are SHIPPED** in `shared/pgBlocking.ts`, both
against fixtures from a real PostgreSQL 16.15 in Docker.

**The live query is FIXED**, which is the part that matters more than the tree module:
`PG_QUERIES.locks` filtered on `cardinality(pg_blocking_pids(a.pid)) > 0` — sessions that are
BLOCKED — and the session holding the lock is not itself blocked. Proven against PostgreSQL
16.15: the old query returned two pids, the fixed one returns three, and the extra one is the
only session an operator can act on. Fixing the query alone would have been a bug — `judgePgLocks`
counted every returned row as a blocked session and `blockedSessions` stored that as a metric, so
both now count blocked rows only, and the verdict names what the blocker is running.

The blocking tree measured out worse than the item describes: with a three-deep chain made from
three concurrent transactions on one row, the session actually HOLDING the lock is not itself
blocked — so the existing read, which returns rows that are blocked, omits the only session an
operator could act on. The tree reports the root first, counts waiters transitively (a count of
direct waiters says one where two are stuck), and carries a seen-set on every walk because a
snapshot taken across a deadlock's resolution can contain a cycle.

Slots repeat `mssqlAlwaysOnStatus`'s trap and it was confirmed on the live server: zero rows is
what a server with no replication returns AND what one whose slots were dropped returns, so an
empty list is `unknown`, never `ok`. An INACTIVE slot is the alarm — the server keeps every WAL
segment it might need, for ever, and the first symptom is a full disk.

**MySQL top-N, Mongo index sizes and Redis persistence are SHIPPED** too
(`shared/dbSlowReads.ts`), against fixtures from MySQL 8.4.11, MongoDB 7 and Redis 7.4.11. Two of
the three thresholds changed because of what those servers returned: a Mongo collection of two
documents holds 58 bytes of data and 24,576 bytes of index — a ratio over 400, because an index
has a minimum size — so a size FLOOR comes before the ratio or every small collection in an
estate is on screen; and three of MySQL's four real digests returned no rows at all, so
`examinedPerRow` is null rather than Infinity, which would sort every INSERT above the statement
actually scanning. `no_index_used` is MySQL's own count and is the signal used, because it is
true on a table too small for a ratio to mean anything.

**The MySQL half is WIRED** as a ninth question, `digests`, with a capture recorded from MySQL
8.4. It is not the slow log: that counts statements crossing a time threshold, and a scan of a
small table is fast. `performance_schema` being off or unreadable is `absent` — a first-class
answer — never "no statement is scanning".

**The Redis verdict was DELETED rather than shipped.** `judgeRedisPersistence` already answers
"what would a restart cost" and answers it better, from runtime state — last BGSAVE status, last
AOF write status, save age, changes since. Mine read only configuration, and a server whose last
BGSAVE failed is healthy by the config and broken in fact. Two judgements of one question is two
things to keep in step and the weaker would have been on screen half the time. What survives is
the parse, because item 38 needs `dir` and `dbfilename` to know where the RDB file is.

Still open: the PG slow-statement threshold in `DB_THRESHOLDS`; MySQL top-N from
`performance_schema.events_statements_summary_by_digest`; Mongo index sizes (the collector never
passes `sizes`, `services/dbOps.ts:700-720`); Redis `CONFIG GET dir dbfilename`. Fixtures for
Redis AOF, Sentinel and Cluster and a Mongo sharded cluster remain captured-or-nothing
(`tests/fixtures/dbops/README.md:8-14`).

**Size.** 2–3 weeks for the surface; then 1–3 days per action.

### 38. Backups, the second half

Item 5 shipped the bundle: encrypted, three destinations, retention with three refusals, read
back and decrypted after every write. The audit found the *database* half is thinner than the
README row implies, and the bundle never contains host data.

**What a dump proves today** (`services/backup.ts:828-923`): the binary exited 0, stdout was
non-empty, the bytes landed and read back with a matching sha256. It does not prove the SQL is
loadable. `DumpRunReport` "has no retention and no restore test, because it is not an encrypted
bundle and nothing here can open it to check" (`shared/backup.ts:490-493`). Dumps are manual —
`backupTick` (`:975-996`) iterates bundle destinations only — plaintext, 512 MB in memory
(`MAX_DUMP_BYTES`), and refused for any database behind a bastion, a VPN or a URI
(`backupTargets.ts:716-727`).

**In order:**

1. **Schedule, stream, encrypt, retain** — the four things the bundle has and the dump does not.
   **RETAIN is SHIPPED**: `planDumpRetention` with `planRetention`'s three refusals, counted PER
   DATABASE — a destination holds dumps of several databases interleaved, so a global "keep 7"
   would keep seven objects rather than seven of each, and a database dumped hourly would evict
   one dumped weekly entirely. The two retentions cannot see each other's objects, which is
   pinned in both directions. `collidingDumpDatabases` surfaces the one real ambiguity: a name
   with a character outside `[A-Za-z0-9_.-]` sanitises into the object name and can collide with
   one already spelled with an underscore, so those two share a group. Schedule, streaming and
   encryption still open.
2. **Dump on the remote host over SSH** as a job, which is what makes bastion/VPN databases
   dumpable and is the only way a large dump ever finishes. Needs the detached path. 1–2 weeks.
3. **`mongodump --archive --gzip`** and a Redis path. Mongo is a stated absence, not a refusal
   (`backupTargets.ts:702-703`), and `--uri` is the *correct* form for it — which inverts the
   URI refusal above and needs a decision on how the credential reaches `mongodump` without
   touching the command line (`shared/backup.ts:449-452`). Redis has no stdout dumper: either
   `BGSAVE` (item 37) then copy `dir/dbfilename` off a host that is a configured server over
   SFTP, or `redis-cli --rdb`. 1 week each.
4. **Restore into a scratch database** — the only restore test that means anything for a dump.
   Needs a target, a scratch-DB policy (DDL, `destructive`), streaming and a job; sits on item
   37. 1–2 weeks per SQL engine.
5. **Restore the bundle's siblings.** `psql < dump` / `mysql < dump` as a job with a typed
   phrase. Host *file* restore is out of scope: the bundle is app state and the README should
   say so where it says "everything".
6. **Binlog position** in MySQL dumps (`--source-data=2`) and `pg_dumpall --globals-only`. Days.

**And the one that is not a database.** A failed scheduled backup reaches a desktop
`Notification` (`index.ts:3517-3531`) and nothing else — no webhook, no inbox row, no history.
`job-failed` is *not* emitted for backups; it comes only from the renderer's job watcher
(`FleetWatcher.tsx:243-250`). A `backup-failed` STATE kind: add to `ALERT_KINDS` and
`STATE_ALERT_KINDS`, a coverage source, a destination-not-host subject (the `hostId: null`
precedent at `index.ts:2809-2811`), raise from `onNewFailure`, resolve on the next `report.ok`,
and surface `skipped` — a vault-locked destination that never runs is the silent failure the file
already warns about (`backup.ts:930-936`). The `Record<Kind,…>` tables fail to type-check until
filled, which is the guard. **2–3 days, and it should go before anything else in this item.**

### 39. Kubernetes reads that are cheap and missing

**All rows below are reachable.** `shared/k8sReview.ts` runs the thirteen reads in one round trip and `KubernetesPanel`'s **Cluster review** button renders them worst-first, with what was NOT read printed above the findings — a short list of findings otherwise reads as a clean cluster. Building it found a real defect: reading PodDisruptionBudgets in the wrong shape made `parseDrainPdbs` return nothing and every workload was then reported as having no budget, so text that yields no objects is now a blind spot rather than an empty cluster.


All reads, all per-`--context`, all with their own `K8sRead` verdict, none agent-reachable. Each
is a few days and none needs a new principle.

| Read | New | Size |
|---|---|---|
| **Node conditions, allocatable, taints** — **SHIPPED** | — | `shared/k8sNodes.ts`, against fixtures from a real k3s v1.31.5 node before and after `kubectl cordon`. The measurement that shaped it: `False` is GOOD for the three pressures and BAD for Ready, so reading them as one boolean inverts three of the four. And a node condition has THREE values — `Unknown` is what the control plane writes when the kubelet has stopped reporting, which is the state an operator most needs and the one a boolean cannot hold. Such a node's other conditions are the last ones it sent and the verdict says so. A cordoned node gets its own verdict and does not count against readiness: it is not broken, and calling it unhealthy sends somebody to investigate their own change. Allocatable quantities are kept as Kubernetes wrote them (`24571576Ki`), because converting them would put a unit decision in a parser. |
| **Requests/limits, node allocatable vs requested** — **SHIPPED** | — | `shared/k8sResources.ts`, with the quantity parser the row asks for: a bare CPU number is CORES and `100m` is millicores, and reading that backwards understates a node a thousandfold and reports every cluster as wildly overcommitted. `Ki` is 1024 and `K` is 1000 and both appear — a node says `24571576Ki`, a manifest says `64Mi`. "No requests set" is an answer: on a stock k3s TWO OF FIVE deployments set none, and a container with no request is not one that needs nothing — it is one the scheduler places blind and the kubelet evicts first, so they are counted and listed rather than added as zero. No allocatable read gives `null`, not a percentage against zero capacity. |
| **HPA** — **SHIPPED** | — | `shared/k8sHpa.ts`, against two fixtures that are THE SAME HPA a minute apart: before the metrics API served and after. The row asked that `<unknown>` render as unmeasured and never 0%; measuring it showed the trap is sharper. An HPA with no metrics reports `desiredReplicas: 0` — a real 0 in the API, not `<none>` — while its minimum is 2, so read as a number it says the autoscaler wants to scale a production deployment to nothing, and on a cluster whose metrics API never serves it says that for ever. `currentUtilization` is the field that separates the two, so `desiredReplicas` is null whenever it is absent. Also names an autoscaler at its ceiling AND over target (it has nothing left to do), and one pinned with min === max (it can never scale). |
| **PDBs as a view** — **SHIPPED** | — | `shared/k8sPdbView.ts`: per-workload "covered by N budgets, allowing M", with the SMALLEST allowance across them, since that is the one a drain actually meets. `matchExpressions` stays `cannot-evaluate` and never `uncovered` — the drain preflight already refuses to guess at one ("an unknown budget is not a permission"), and a view that skipped it would report a workload as unprotected when it may be the best protected thing on the cluster. The measurement that changed the design: an ORPHANED budget — selector pointing at a label nothing carries — reports `disruptionsAllowed: 0`, byte-for-byte what a budget protecting real replicas at its limit reports. They are told apart by `expectedPods`, which is the count the controller itself arrived at and is therefore right for matchExpressions too; re-deriving it from matchLabels would be a second implementation of the controller's matching. |
| **Certificates, three ways** | (1) **SHIPPED** — `/etc/kubernetes/pki`, `/var/lib/kubelet/pki` and the k3s/rke2 `server/tls` trees are cert roots, so the existing `cert-expiry` kind fires for control planes with no new kind. Two things the line did not mention and both mattered: a kubeadm control plane holds TWELVE certificates once `etcd/` and the kubelet are counted, so the 16-file cap had to go to 32 or such a node would report a truncated list of its own and nothing else; and the new roots go AFTER the web roots, because `find` walks its arguments in order and the cap is a `head`. Verified by building a kubeadm layout on disk and searching it with the probe's own depth and name list, not by asserting on the command text; (2) kubeconfig client cert or token `NotAfter` decoded on the host, never echoed; (3) cert-manager `Certificate` Ready/`notAfter`/`renewalTime`, CRD absent being a normal answer | 1 d / 2–3 d / 2 d |
| **RBAC rules and `can-i --list`** — **SHIPPED** | — | `shared/k8sRbac.ts`, against real output for an admin kubeconfig and for a service account bound to a pods-only Role. Three things the output does that a naive parse gets wrong: `system:basic-user` grants the three `selfsubject*` rules to EVERY authenticated identity, so counting them reports five permissions for an account with two and buries the two; a non-resource rule prints with an EMPTY first column, so splitting on whitespace reads `[/api/*]` as the resource name and shifts every column after it (the columns are found by header position instead); and a failed read is `unknown`, never an empty permission set — reporting that as "can do nothing" would describe a cluster-admin token as harmless. |
| **PVs, StorageClasses** — **PVCs and PVs SHIPPED** | — | The fixture's Pending PVC IS `WaitForFirstConsumer`, as the row predicted, and that turned out to be the whole finding: it is k3s's default and EKS's and GKE's, so every claim sits Pending until a pod that mounts it is scheduled. Reporting Pending as a fault would fire on every such cluster for every claim. Pending on an `Immediate` class is the opposite — the provisioner should have bound it and did not — and a class that was not among those read gives `unknown` rather than a guess. `Lost` says the data is gone. PVs and reclaim policy per volume are `shared/k8sPv.ts`, and measuring that changed what the row prints. A RECLAIM POLICY IS NOT A PROPERTY OF THE VOLUME: it is what happens the moment somebody deletes the claim. Measured — a static hostPath PV with `Delete`, bound, had its claim deleted and VANISHED from the API within seconds; no event, no Released state to notice it in. The same test with `Retain` left the volume at `Released` still carrying the deleted claim's `claimRef.uid`, which is why it never rebinds on its own. So a bound volume prints what deleting its claim would do rather than its status, which is `Bound` and unhelpful; `Bound`+`Delete` stays graded `ok` because it is the default on k3s, EKS and GKE and grading it would fire on every volume of every such cluster. Released volumes are counted as held capacity separately, because no claim reports them. StorageClass expansion is still open. |
| **`rollout history`** — **SHIPPED** | — | `shared/k8sRollout.ts`. Measured, and it is not a plain read after all: `kubernetes.io/change-cause` is an ANNOTATION on the deployment that is copied onto every new ReplicaSet until somebody changes it, so it describes whichever rollout last set it and gets carried onto later ones. On the fixture, revisions 2 and 3 both say "bump to 1.37" and revision 3 is `busybox:1.36.1` — a different image wearing revision 2's label. Showing that uncaveated would have an operator roll back to "the one before the 1.37 bump" and land somewhere else. So the IMAGE leads (read from the ReplicaSet, which is a per-revision fact) and a repeated label is marked as probably left over. `rollout status` on demand shipped with the add-on view in `shared/k8sAddon.ts`, where the reason it needs a deadline was measured. |
| **Helm** — **parse PROVEN** | — | Fixtures recorded from helm v3.16.2 against k3s v1.31.5 with two releases in two namespaces, plus a real empty list. The parse is correct. The field worth taking a fixture for was `revision`: helm sends it as a STRING, and the parser's `str()` returns `''` for anything else, so a numeric revision would have vanished silently — a release showing a blank revision with nothing to say why. `app_version` → `appVersion` is the one renamed field and is now pinned. `history`, `status` and the `get values` decision are still open. | parse done |
| **Stale objects** — **SHIPPED** | — | `shared/k8sStale.ts`, report only; deletion stays refused. Two measurements shaped it. `kubectl get pods` prints **Completed** and **Error** in its STATUS column while `.status.phase` says **Succeeded** and **Failed** — two vocabularies for one pod, and a parser keying on one with a comment describing the other is how somebody later "fixes" it to match the docs and breaks it. And **a failed Job records no `completionTime` at all**, so age from that field is null for exactly the jobs most worth noticing; it comes from `startTime` and the sentence says so. A Job's pods are not listed beside the Job — deleting the Job removes them, so the Job is the actionable row. An evicted pod is `Failed` too, and the reason is the only thing separating "the node pushed it off" from "the process exited non-zero". PVCs and ConfigMaps are `shared/k8sUnused.ts`, and the measurement cut both ways. "No pod references this" IS NOT "this is unused": a Deployment scaled to zero mounting a ConfigMap leaves it referenced by nothing that exists, and scaling back up breaks at once — so the result is a candidate list carrying a caveat that names what was not looked at, never a recommendation. And the obvious scan is wrong the other way: `kube-root-ca.crt` is in EVERY namespace and referenced by every pod only from inside a `projected` volume's `sources[]`, in a volume the API server injects and nobody's manifest contains. A scan walking `.spec.volumes[*].configMap.name` — the path anyone writes first — misses it and proposes deleting the service-account CA on every cluster; in the fixture it also sits in `kube-public` and `kube-node-lease`, which hold no pods at all, so there it is unreferenced by construction and forever. The projected path is walked, cluster-owned names and system namespaces are never proposed, and kept rows are still listed rather than hidden. |
| **Add-on verification view** — **SHIPPED** | — | `shared/k8sAddon.ts`, measured on k3s v1.31.5 with two DaemonSets side by side: one healthy, one whose container exits at once. THE BROKEN ONE IS FULLY ROLLED OUT — UP-TO-DATE equals DESIRED, the column every "did the rollout finish" check reads — and it has never started. So availability is asked before up-to-dateness, and "the rollout is complete and the add-on is not running" is a sentence this view can print. Three more measured traps: `numberAvailable` and `numberUnavailable` are both `omitempty`, so each is ABSENT when zero (they are absent on different rows of the one fixture) while `numberReady` is never omitted — absent means zero for those two fields specifically; a DaemonSet with DESIRED 0 satisfies every ratio and means the add-on is installed nowhere; and `rollout status --watch=false` printed "Waiting for … 0 of 1 updated pods are available" and EXITED 0, so `done` requires the exit code and the wording to agree, and the command builder cannot emit a rollout status without a deadline. Warnings are grouped per object and reason because the fixture's eight rows describe two problems, and `InvalidDiskCapacity` — permanent kubelet noise on this shape of cluster — is dropped. |
| | Exists | New | Size |
|---|---|---|---|
| **Compose dialog** (item 35.2) — **SHIPPED** | — | Done as item 35's second defect: the panel asks whenever `planJob` says to, rather than filling in its own phrase. | done |
| **Per-service pull/up** — **SHIPPED** | — | A checkbox per service in the open project; the picks are cleared with the project, because a selection carried across would name another project's services. Empty still means every service, which is what compose means by no argument. Another builder that had validated a `services` list since it was written and never received one. | done |
| **Compose `restart` one service** — **SHIPPED** | — | Routed to the container `act` path, as the row suggested, and measuring said why that is the right end rather than merely the cheaper one. `docker compose restart` was run against a real project first. It DOES NOT APPLY AN EDITED COMPOSE FILE: with the file changed from `V: one` to `V: two`, `compose restart` brought the container back still carrying `V=one` and `up -d` recreated it as `V=two` — so the dialog always carries that sentence and points at `up`. And it touches EVERY replica: a `replicas: 2` service restarted both. Going through `planDockerAction` means the containers are NAMED, the fan-out is visible before it happens, a restart is graded elevated, and two replicas escalate to a typed `RESTART` — which is what two containers going down at once deserves. A service with no container gets a refusal pointing at `up`, because `restart` does not create one. `planComposeServiceRestart` in `shared/compose.ts`, wired into `ComposePanel`. |
| **Validation wording and lint** — **SHIPPED** | — | Measured against compose v5.1.4 refusing six real files, and the row's diagnosis was exactly right: NONE of `service "web" depends on undefined service "nope"`, `yaml: while scanning a quoted scalar…`, `validating …: additional properties 'imagz' not allowed`, `has neither an image nor a build context`, `dependency cycle detected` or `env file … not found` matched `BLOCK_FAILURE`, so all six printed "returned nothing this parser could read" — a sentence about this program instead of the sentence compose wrote about the operator's file. They are now `invalid-project`, whose help line says compose read the file and refused it and whose detail is compose's own line verbatim. The lint (`lintComposeConfig`) covers what compose ACCEPTS and still surprises: a floating or absent tag (with the registry-port colon handled — `registry:5000/app` is untagged, not tagged `5000`), a missing restart policy, and `network_mode: host` alongside a `ports:` block, which compose accepts at exit 0 while the mappings do nothing. A NAMES-ONLY model is refused by the linter itself: every field on it is empty because nothing was read, and linting it would claim every service has no tag and no restart policy. |
| **Render what is parsed** — **chips SHIPPED** | — | A chip row per declared service: `restart:`, `depends_on`, ports, profiles. A service with NO `restart:` is chipped `no (default)` and warned rather than left blank — compose defaults to `no`, so it does not come back after a reboot and nothing else on the screen said so. A profiled service is chipped "not started by a plain up", which is the commonest reason a declared service looks missing. Declared-vs-running restart policy (needs a per-container inspect) and the volume join are still open. | chips done |
| **`docker pull` / `build` as jobs** — **SHIPPED** | — | The row asked whether `build` needs an `ELEVATED` rule. It does, and the reason is the one the row gave: a Dockerfile is a program and `RUN curl … | sh` is an ordinary line in one, so `docker build` and `docker compose build` are graded elevated with "runs a Dockerfile, which can execute anything its author wrote". `pull` deliberately is NOT — it fetches bytes and runs none of them, and a confirmation on the safest thing on the panel teaches people to click through the ones that matter. `compose build --pull` always carries `--pull` (a build reusing a cached base is a build without the security update somebody just asked for) and takes NO build args, because a build arg is free text reaching a `RUN` line and nothing here can show what it will do. `up` still omits `--build`: building and starting are separate decisions, and folding one in runs a Dockerfile behind a button labelled start. The build button only appears where the file declares something built from source. Standalone `buildDockerPullCommand` / `buildDockerBuildCommand` validate the reference, the tag and the context — the context refuses a URL, since `docker build https://…git` fetches and builds code off the internet. `validateImageRef` moved to `shared/docker.ts` and is re-exported from `compose.ts`: compose imports docker, so leaving it would have made the import circular. |
| **Networks** — **SHIPPED** | — | `buildDockerNetworkCommand` / `buildDockerNetworkPreview` in `shared/docker.ts`. The row said "emit only zero-attached" and measuring showed that rule is wrong: `docker network inspect` counts the containers attached RIGHT NOW, so a compose network whose one service is stopped reports zero while `docker ps -a` still shows the container on it. Removing it on that basis is not recoverable by recreating a network of the same name — the container is pinned to the network's ID. Measured end to end: after `docker network rm spnet_back`, `docker compose start b` failed with "network c1fd84b264c9… not found", and only recreating the container fixes it. So attachment comes from `docker ps -a`, whose `{{.Networks}}` column names a stopped container's networks, and `network inspect` is not used at all. `bridge`, `host` and `none` are withheld with the reason rather than filtered, and a network is offered with no size rather than `0 B`, which would read as a measurement. Wired end to end: `DockerReader.networks`, its own IPC channel, and `mergeNetworks` in the panel — networks are a SECOND read, so the confirm-time re-check re-reads both and the preview stays a pure function of the two, which is the only thing that makes that check mean anything. A network read that FAILED goes in as a withheld row saying so, because a silently network-free preview is indistinguishable from a host with no removable networks and only one of those is true. |
| **Targeted engine/compose upgrade** — **SHIPPED, with one part deliberately left to the operator** | — | `shared/engineUpgrade.ts`. The precheck reads `docker info --format '{{json .LiveRestoreEnabled}}'` — measured on a real daemon, which answered `false` — and that flag is READ rather than the behaviour being watched, which is a weaker claim and is worded as one wherever it appears. Anything that is not exactly `true` or `false` is `null`, never `false`: a daemon that could not be asked has not said containers will stop. THE INSTALLED SET IS NOT PARSED, and writing the fixture is what settled that: the first version searched the package block for the package names, and dpkg's own error is `dpkg-query: no packages found matching docker-ce`, which CONTAINS the name — so a host that has never had Docker's packages read as having them. A correct `dpkg-query`/`rpm -q` parser could be written but not verified here, and an unverified parser standing between an operator and a SECOND container engine is worse than no parser, so the block is shown and the operator confirms they read it. All four packages move together (`docker-ce`, `docker-ce-cli`, `containerd.io`, `docker-compose-plugin`), because upgrading only the daemon leaves last release's CLI and runtime beside it, and the job is built by the existing `packageJobSpec` rather than a second builder — it validates every name, quotes them and ends with the manager saying what is installed now. `apk`, `pacman` and `zypper` are refused: Docker publishes no repository for them. WIRED into the Docker panel, where the package block is shown verbatim and a checkbox carries the confirmation the parser cannot; the package manager comes from host facts and a server whose facts are not collected is refused rather than guessed at as apt. The precheck types live in a separate `shared/enginePrecheck.ts` because `shared/docker.ts` needs the probe type and IS agent-reachable — importing the plan half there would drag the job vocabulary into the MCP import closure, which the boundary test caught. |
| **Health log, unhealthy-first** — **SHIPPED** | — | `buildDockerHealthLogCommand` / `parseDockerHealthLogs` / `sortUnhealthyFirst` in `shared/docker.ts`, measured against four real containers in one inspect. Four findings. `.State.Health` IS NULL for a container with no healthcheck — not healthy, not unknown, and "healthy" is the word this must never print for it. Docker keeps only the LAST FIVE entries: measured against a container whose `FailingStreak` was 24 and whose log held 5, so the log is a sample and the streak is the count. `starting` can mean "failing every check": inside a 300-second `start_period` a check exiting 1 reported `Status: starting`, `FailingStreak: 0`, so the log's exit codes are the only thing that says otherwise and a failing starter sorts directly behind the unhealthy. And the output is the check's own stdout verbatim — a measured one carried `https://user:…@host/health?token=…` and an `Authorization: Bearer` header — so the shared parser keeps it RAW and redaction stays in main, where `redactOutput` and the known secrets are; a shared parser promising redaction it cannot enforce would be worse than not promising it. Wired end to end: `DockerReader.healthLogs` is the one read in that file rewritten before it returns — every `Output` goes through `redactOutput` there, so the renderer and anything that later logs what the panel showed never hold the original. `HealthLogPanel` renders it, asked for rather than read on every refresh, and for RUNNING containers only: a stopped one's health is whatever it was when it stopped, and shown beside live answers it reads as current. |
| **`.env` write via the vault** — **SHIPPED** | — | `shared/envWrite.ts`, `EnvValueWrite.tsx`, and the design WAS the work as the row predicted. The image-tag edit's plan-then-confirm shape could not be reused, because for a `.env` THE LINE IS THE SECRET: a plan carrying `before` would carry the thing this module exists never to read. So there is no round trip — the renderer sends a path, a name and a vault REFERENCE, main resolves, reads, plans, applies and writes, and what comes back is a line number. The plan never leaves the process, so the staleness `writeImageTag`'s `before` check exists to catch cannot arise rather than being caught. THE QUOTING WAS MEASURED end to end — `.env` bytes, through interpolation, into a running container's real environment, read back with `env -0 | base64` — and two earlier harnesses were wrong in ways that looked like the escaper was wrong (`printf "$V"` let the container's shell expand `$b` and turn `$$` into PID 1; `config --format json` re-escapes `$` on output), which is precisely why it was measured. What it found: an inline `#` starts a comment so an unquoted value is truncated; trailing whitespace is stripped; `export FOO=v` IS honoured; a repeated name takes the LAST one, so a duplicate is refused rather than half-written; double quotes interpolate `$` and process backslash escapes; and single quotes process nothing but have NO escape for a single quote at all — the shell's own trick is a compose parse error. Apostrophes are common in passwords, so the writer emits double quotes escaping `\` then `"` then `$`, in that order, because escaping `\` last re-escapes the backslashes just added. THE BOUNDARY IS IN THE TYPES: `writeEnvValue(cfg, req, value)` is deliberately NOT on `ComposeBridge`, because that is the interface the preload implements and a value-taking member there would require the renderer to hold one. AND THE MODULE GUARD CAUGHT A REAL LEAK — the first version imported `store/vault` for the entry picker, which would have put every vault password, in plaintext, inside the docker module's renderer half; `shared/vaultIndex.ts` is the names-only answer, a SEPARATE namespace rather than a filtered call, because the namespace is the unit the guard works in. Its projection is a function with an explicit return type, since the inline literal it replaced type-checked cleanly with `password` added to it. |
| **Scanner consumer** — **SHIPPED for trivy** | — | `shared/imageScan.ts`, measured against three real trivy runs, and two of the three findings change what the panel is allowed to say. `alpine:3.18` REPORTS ZERO VULNERABILITIES AND IS PAST END OF SUPPORT — trivy warns "security updates are not provided" — so zero there means nobody is issuing advisories any more, and an EOSL image never renders as clean. `debian:12` reports 221 findings of which FIVE have a fix, and all five are `UNKNOWN`: every one of its 4 CRITICAL and 52 HIGH has no fixed version, so a count without the fixable split invites an `apt upgrade` that clears nothing. `UNKNOWN` is its own bucket (six of them) rather than folded into low. The read is `--format template`, not `--format json` — one Debian image's JSON is 589 KB — and it keeps stderr because the template receives `types.Results` and cannot reach `Metadata.OS.EOSL` at all, so the end-of-support warning is only on stderr. "No scanner" is its own class and grades `unknown`, never `ok`, and nothing installs one. **grype and `docker scout cves` are deliberately NOT parsed**: neither was measured, and a parser written from documentation reports whatever it guessed. The scan does not escalate to sudo either — every other read here does, but escalating means running a third-party binary as root to satisfy a panel. |
| **Podman** — **PROVED, and it found a bug** | — | Measured on podman 5.8.4 in a container on the test host, through the commands `shared/docker.ts` already builds. That module was written anticipating podman — no `--format`, because the engines disagree about field names, and it resolves the `podman` binary as a fallback — and the anticipation held for almost everything: both `system df` forms parse on every column, and the missing `Build Cache` row is simply three rows rather than four because the parser reads a LIST and not a fixed set. WHAT DID NOT HOLD: docker's `system df -v` STATUS column writes `Up 2 hours`, podman's writes the bare state, so `exited` and `created` matched the existing branches by luck of the same word while `running` matched nothing — EVERY RUNNING CONTAINER ON A PODMAN HOST read as `unknown`. WHAT THAT WAS NOT is an unsafe action: the reclaim preview withheld them anyway as "its state could not be read", so the refuse-what-you-cannot-read default held and this was a wrong label rather than a container offered for deletion. That is now pinned separately so the safety never depends on the parse, and mutation established that TWO independent guards keep a running container out of the offered list — removing either alone changes nothing, removing both offers one. `podman volume rm` on an in-use volume differs too (exit 2 and different wording against docker's exit 1) and CANNOT BE REACHED, because rule 1 never offers a volume with `LINKS > 0` and podman reports `LINKS` in the same column; the fixture records it so nobody rediscovers it. **Still open:** `podman-compose`, absent from the stable image — installing it would have measured a pip package rather than what a host runs — and rootless podman, which puts images under `$HOME`. |

### 43. Logs, and getting from an alert to one

**Failed unit → tail deep-link — SHIPPED.** Not from `AlertsPanel`, which this item assumed:
`unit-failed` is deliberately not a store kind (`webhook.ts:154` — failed units are a SET of
names, not a threshold crossing), so no row exists there to click. The failed units render in
`FleetHealth.tsx`, and that is where the link went.

It was not a missing feature so much as a missing WIRE. `LogTailPanel` has taken a `jump` prop
since it shipped and its own comment names the caller it was written for — "the failed-unit list
is the one that matters" — and nothing ever passed it. The same shape as item 33's job engine.
The request is held in `nav` beside `monitorTab`, for the same reason: the list that sets it is
several components from the panel that reads it. A test asserts FleetMonitor actually hands the
prop over, because asserting the store alone would have passed on the broken code.

**Search across hosts.** A one-shot query mode — `journalctl -u U -g PATTERN --since … -n N`,
`grep -F -m N`, `docker logs --since … | grep -F` — fanned out with the non-streaming exec the
pickers use (`logTail.ts:392-426`), pattern validated to a fixed-string class and never
interpolated, results capped per host, and a "hosts that could not answer" list. Rotated files
need the picker to stop excluding `.gz` (`logtail.ts:680`). Storage of lines stays refused;
a live grep is not storage. 1–1.5 weeks, +3 days for `zgrep`.

**An error-rate kind.** `journalctl -p err --since -Xmin | wc -l` per unit on the facts cadence,
a `log-errors` STATE kind, a threshold row. The scope decision comes first — which units, which
window — exactly as item 19 said for OOM, and "could not read the journal" is not zero. 1–2
weeks after the decision.

**Host rotation and audit posture.** `journalctl --disk-usage`, `SystemMaxUse`,
`logrotate.timer`, top-N under `/var/log` (3–5 days); `auditd` installed/active/enabled,
`auditctl -s` and rule count, journald persistent vs volatile, rsyslog forwarding, and counts —
never names — of `sudo` and `USER_AUTH` events in 24 h, the same vocabulary as failed logins
(1 week). Both read-only, both `sudo -n`, both on `get_host_facts` only with a new capability
line.

### 44. Change management: windows, rollback, incidents

**Maintenance window — SHIPPED.** A window is not a new suppression mechanism: it is "snooze
every kind on these servers until T", written as the snooze rows the alert store already has,
which are durable, carry an absolute `until` and are replayed at launch. A second way to silence
an estate would be a second thing to reason about, and only one of them would have been.

All three refusals kept, and said on screen rather than only in a comment: the sampler is not
paused, `webhookNotify` is untouched, and the chips stay up — what stops is the announcing. Two
limits the roadmap did not ask for and both earned their place: a window may not run longer than
24 hours (a silence nobody has to renew is one nobody remembers setting), and it may not open
without a note, because somebody reading the alert log in three weeks will want to know why it
went quiet. Human-only, per the revocation argument. Disabling named rules and the patch-plan
reboot refusal are still open.

**Rollback on the approval — SHIPPED.** `rollback?: JobStep[]` on `JobSpec`, written in the
composer beside the steps because that is the only moment anybody knows how to undo the thing.
Inside the approval hash via `approvalCommands()` — ONE derivation called by the mint and the
verify, since they are two halves of a literal comparison — and prefixed `rollback: ` so a
one-step job with an undo cannot produce the same approved list as a two-step job. Editing or
removing the rollback after the approval is minted fails verification, which is the property the
"covered by the same hash" line was asking for. Running it composes an ordinary job from those
steps and goes through the same dialog, so `planJob` grades it on its OWN commands: undoing a
`start` with a `stop` is still a stop. Offered only once the job has stopped, and a test asserts
`jobRunner.ts` contains no reference to the field at all.

**Deployment rollback.** Compose: a revert is an image edit to the previous tag, and the app
does not remember the previous tag — a small per-project "last applied image" record is new.
1 week. Kubernetes: `rollout undo` **contradicts the header** — it rewrites `.spec.template`,
diverges from git, and "leaves the cluster somewhere the user has to remember to undo", which is
the file's own definition of `edit` (`kubernetes.ts:52-58`, `:1167-1172`). If wanted it is a
recorded reversal in the header, graded like drain, with a caveat that live now differs from
source; `rollout history` as a read is safe now (item 39). Package downgrade should be refused
in-file for the reason `dist-upgrade` is.

**Incident record.** A named span — start at raise, end at resolve — with a note and the alert
rows and jobs inside it, joined by `runbookJobWindow` (`runbooks.ts:333-340`); its own JSON file
for the reason runbooks are not in the history store. Ticketing stays webhook-out; an internal
span that posts the fixed payload shape stays inside that line. 1–2 weeks.

### 45. Housekeeping as a read, then delete-by-id

The Docker reclaim shape — preview a literal list, re-preview on confirm, refuse `prune` — is
the only housekeeping the app does, and it is the right shape for the rest.

**The read** (1–2 weeks): a `housekeeping` posture-like source per host — journald disk usage,
`/var/log` top-N, `/tmp` size and oldest file, `apt-get autoremove --dry-run` / `dnf autoremove
--assumeno` candidate counts, `lvs -o lv_name,origin,snap_percent` for snapshots. Single-line,
capped, no mutation, "could not read `/tmp`" is not empty. **Delete-by-id** (+1 week): a list of
paths or packages, typed confirm, never a blanket verb. Cloud snapshots are a provider-API
product and refused by the DNS/TLS precedent.

**Dead users and keys — SHIPPED.** `staleAccounts(hosts, days)` in `shared/staleAccounts.ts`,
rendered in the access panel with a 30/90/180/365 window. Four verdicts, and the fourth is the
point: a server without `lastlog` answers "no login recorded" about EVERY account including the
one somebody used a minute ago, so that case is `unknown` and the panel says why in those words.
`expired: null` does not exclude an account — a date nobody could parse is not a date in the past
— and an unreadable key file is a finding rather than a skip. The unknowns are counted in the
headline, because a number that shrinks as the estate gets harder to read is the wrong direction
for one somebody uses to decide they are done. Revoke stays behind item 36, and the panel says so
rather than offering a button that would act through a path with no rollback. **Stale Kubernetes objects**:
item 39's last row.

### 46. Facts the fleet is still missing

Read-only additions to `hostFacts`, each a new `FACT_SOURCE_IDS` entry, each updating the
`hostFacts` capability grid text because packages-and-versions is attacker-useful in the same way
security counts are.

| Fact | Why | Size |
|---|---|---|
| **Installed packages and versions** — **SHIPPED** | — | `shared/installedPackages.ts`, written to the EXISTING `facts` table as `pkg:<name>` with `retireFacts`. THE SIZE QUESTION WAS NOT A DECISION, it was arithmetic nobody had run: against the real package count of a real host (1,241 on Ubuntu 24.04), 50 hosts is **62,050 rows = 4.6 MB** at 78 bytes/row, "which hosts have package X" answers in **3 ms** and "which hosts have version 1.2.5\*" in **7 ms**. 200 hosts is about 18 MB. So no cap, no second table, no new schema. FOUR MANAGERS MEASURED, each through the builder — apt on a real server, rpm in almalinux:9, apk in alpine:3.19, pacman in archlinux — all normalised to `name<TAB>version` in the shell so there is one parser rather than four. THREE TRAPS. `dpkg-query -W` LISTS PACKAGES THAT ARE NOT INSTALLED: the measured host had two in `deinstall ok config-files`, removed with their configuration left behind and carrying a version like any other row, so without the status filter this answers "which boxes still have the old openssl" with hosts that removed it — the same trap `kernelStatus` documents, one query over, and it was caught by mutation before shipping. `rpm -qa` REPORTS GPG KEYS AS PACKAGES, and a host trusting several vendor keys has several rows all named `gpg-pubkey`, which would collide on one fact key. `apk info -v` IS NOT PARSEABLE — it prints `alpine-baselayout-3.4.3-r2`, name and version joined by a dash, and names contain dashes (`libcrypto3`), so the installed database's `P:`/`V:` lines are read instead. AND AN EMPTY READ IS NEVER AN EMPTY HOST: the result is a discriminated union, the sampler sets `write.packages` only on `ok`, and retirement runs only then — otherwise a busy dpkg would delete a thousand facts and record a fact-removed event for each. |
| **Per-package security list** — **SHIPPED** | — | `shared/securityUpdates.ts`, on demand per host rather than sampled, and measuring it found that ONE HOST GIVES THREE DIFFERENT ANSWERS. On almalinux:9.3: `updateinfo summary` says **133** security notices, `updateinfo list security` prints **203** rows, and `--security check-update` names **55** packages. 55 is what `dnf upgrade --security` will touch; 133 is the one that sounds biggest; 203 is the advisory×package pairing (one advisory names several packages — `expat` is covered by six). So `check-update` is the spine, the advisories only decorate it, and the note says the two counts are not the same measurement. Worse: `dnf -C --security check-update` on a host with NO CACHE prints `Error: Cache-only enabled but no cache` on stderr and EXITS 0 — dnf's code for "nothing pending" — so every block keeps stderr and that line is a refusal, not an empty list. apt has no such marker (a host with no lists prints exactly what a patched host prints), so its note says the answer is only as good as the cache rather than claiming a detection that does not exist. Severity is the distribution's own word; apt names none and gets an empty string rather than an invented one. |
| **Kernel installed vs running** — **READ SHIPPED**; the install scope still open | — | `shared/kernelStatus.ts`, a Kernel column on the patch table, read per row rather than added to the hourly sweep. Measured on a real Ubuntu 24.04.4 host that WAS ITSELF PENDING A REBOOT — running `6.8.0-136-generic` with `-138` installed — and the recorded output carries TWO TRAPS AT ONCE. `dpkg-query -W 'linux-image-*'` lists `linux-image-unsigned-6.8.0-136-generic  unknown ok not-installed`: a version-bearing name on a package the host does not have, so counting names reports four kernels where there are two. And `linux-image-virtual 6.8.0-138.138 install ok installed` IS installed and is NOT a kernel — a meta package whose version tracks what it wants rather than what is on disk. A third from the same host: `linux-image-generic` was "no packages found" there, so no meta package name may be assumed. THE COMPARISON IS NOT THE PRIMARY SIGNAL and this file does not read the restart marker at all: `hostFacts` already reads it on BOTH families (the flag file on Debian, `needs-restarting -r` on RHEL), two readers of one fact is one of them drifting, and the marker outranks any version inference because it catches what a kernel comparison never would — the measured host's `.pkgs` named `libc6` and `linux-base` beside the kernel, so "restart required" there is not a kernel claim. `compareKernelVersions` is pinned against `dpkg --compare-versions` run on that host, which is how `6.8.0-99 < 6.8.0-100` got fixed: a string comparison has it backwards, and the same host confirmed `sort` puts `-99` AFTER `-136`, so `ls -1 /boot` order is wrong too. A debian:12 container gave the other measured case — dpkg present, ZERO kernel packages, empty `/boot`, and `uname -r` reporting the Docker VM's kernel — which is why `dpkg` is a field: an empty installed list is otherwise indistinguishable from an RPM host nobody asked in its own language. **RPM IS NOW MEASURED TOO**, in almalinux:9 containers with TWO kernels installed — a real configuration, since rpm treats the kernel as installonly. `rpm -qa 'kernel*'` IS THE WRONG QUERY: two kernels give EIGHT rows because `kernel-core`, `kernel-modules` and `kernel-modules-core` match, and prefix-matching does not save you since `kernel-core-5.14.0-…` carries the `kernel-` prefix; `rpm -q kernel` queries the name exactly. That glob output is kept as a fixture because it is also REVERSE SORTED, so it is the ordering case as well. `needs-restarting -r` was measured both ways (exit 1 required, exit 0 not) and is deliberately NOT run here — `hostFacts` already runs it on this family, and the test forbidding a second read of the reboot marker, written for Debian, fired on the RPM side. rpm's own `labelCompare` gives the same four answers dpkg did, so one comparator serves both. What is still NOT verified is the join between `uname -r` and an rpm version on a running RHEL host, so a running kernel that is not among the installed ones is reported as exactly that rather than guessed at. **Still open:** the kernel-only install scope, which is the write half and still sits uneasily with `patch.ts`. |

> **Not built, and why — 6 Sep.** Attempted and stopped at the measurement, not at the code. Every host available here is a CONTAINER, and a container reports a kernel it does not own: measured on almalinux:9.3, `uname -r` says `6.12.76-linuxkit` (the Docker VM's kernel), `rpm -q kernel` says "package kernel is not installed", and `/boot` is empty. So the comparison this row is about — newest installed against running — has nothing to compare, and "nothing installed, something running" must not render as an urgent finding. That container detection (`/.dockerenv`, `/proc/1/cgroup`) is the one part that was measured and is worth keeping for the next attempt. Installing a kernel package into a container to manufacture the normal case was tried and broke the image's coreutils, and the machine then hit 100% disk. The row needs one real Linux host with kernel packages, the same way the podman row needs a podman host; writing the `rpm -q kernel` / `dpkg -l linux-image-*` multi-kernel parser from documentation instead would be a parser that reports whatever it guessed.

| **Storage layout** — **READ SHIPPED**; the write half still open | — | `shared/storageLayout.ts`, rendered in the capacity panel beside the trend it completes — that trend is the ROOT filesystem only, which is exactly the gap the row names. THE FINDING: on the measured Ubuntu 24.04.4 host, which runs Docker AND k3s, `df` lists TWENTY-ONE filesystems and only THREE are somewhere bytes can go. Eight are container overlays, and each reports the same size, the same used figure and the same 14% as `/`, because that is the filesystem beneath them — so rendering `df` renders one filesystem at 14% as nine, and any threshold fires nine times for one problem. THE FILTERING IS IN THE PARSER, NOT THE SHELL: `df -x overlay` was one flag and would have made the exclusion invisible, leaving three rows and no way to know eighteen were dropped, so the command reads everything and the headline always carries the count and the reasons. "NO LVM" IS A MEASUREMENT — `vgs --reportformat json` ran, exited 0 and returned an empty report, which is a different fact from a host with no LVM tooling, so `command -v` runs first and only the empty-report case licenses the sentence. `/boot` is PROMOTED above `/` at equal pressure: it is 913 MB against 200 GB, it is the one filesystem an unattended upgrade fills on its own, and a full `/boot` half-installs a kernel, which is the failure the kernel row next door describes. RECORDING THE FIXTURE CAUGHT A BUG IN THE BUILDER: `df -P --output=…` is refused outright ("mutually exclusive") and prints nothing, so the first recording had an empty section — the argument for recording through the builder rather than by hand. **AND IT WAS BROKEN ON EVERY BSD TARGET**, which `freebsd`, `netbsd` and `openbsd` all are in this build's distro allow-list: BSD `df` rejects `--output` exactly as it rejected `-P` beside it, so the section came back empty and the read reported NO FILESYSTEMS on all of them. Measured on a BSD userland and fixed with `df -Y -k`, the form that carries a Type column; both are always sent, since each engine rejects the other's flag with "invalid option" and writes nothing. That one listing also contained BOTH parsing failures at once — `map auto_home` has a SOURCE containing a space, which shifts every field counted from the left, and a mounted disk image has a TARGET containing spaces, which shifts them counted from the right — so fields are now located by anchoring on the first run of digits, which is the only thing both agree on. `devfs` reports 382 blocks at 100%, permanently full and unfixable, so the BSD pseudo names are excluded beside the Linux ones. And SIX APFS VOLUMES REPORT THE SAME TOTAL AND THE SAME AVAILABLE with different used figures, because they are volumes in one container: they are real filesystems and are not dropped, but six rows each saying "11 GB free" reads as 66 GB when filling any one fills all six, so `sharedPools` names the group — grouped on total AND available together, since size alone would call two ordinary same-model disks a pool. **Still open:** the write half (`lvextend -r`, `resize2fs`, `xfs_growfs`), which needs hosts across the LVM/ext4/xfs matrix this one does not provide. |
| **Service-account classification** — **SHIPPED** | `classifyAccount` (root / system / person / unknown, from the UID and never the NAME — `postgres` at uid 1200 is a person's account somebody called postgres) plus `serviceAccountsWithKeys`, rendered as its own list in the access panel. Ordered by whether the account's own shell would let anyone in, and `nologin` ones are still listed because sshd's ForceCommand can turn the second into the first. root is excluded: a key there is how this app connects. A null shell reads as `null`, never `false`, which would claim a login is possible. Owner/purpose tags not built. | mostly done |
| **Access-review export** — **SHIPPED** | — | `shared/accessExport.ts`, CSV and JSON, downloaded from the access panel. A projection of facts the collector already holds, and the three rules it adds are all about the difference between a fact and a gap. A HOST THAT REFUSED IS A ROW — an export is read as a complete list of who can get in, and a host dropping out of it turns "we could not look at that machine" into "nobody can reach it"; a host that answered and listed nothing gets a different sentence again. A `since` FILTER NEVER SILENTLY DROPS AN UNKNOWN: `lastLoginAt` is null both for an undated login and for an account that never logged in, which the collector already separates, and filtering either out would remove exactly the accounts an auditor is looking for — so they are kept and marked `undated`/`never`. NO KEY MATERIAL, asserted by a test rather than left to review. The coverage section is written into the SAME file as the rows (a caveat in a second download is a caveat nobody has when they read the first) and names every unread host, every sshd reading keys from a path this never opened, every `AuthorizedKeysCommand` that generates keys at login time, and every account whose file refused. A CSV cell beginning `=`, `+`, `-` or `@` is prefixed with a quote: a key comment is attacker-controlled text off a host, so that is an injection into the auditor's spreadsheet rather than a formatting nicety. |
| **Bastion as an access object** — **SHIPPED** | — | `shared/bastion.ts`, the topology graph asked the access question instead of the reboot one. THE TRANSITIVE STEP IS THE FEATURE: `dependentsOf` is one hop deep, so a bastion in front of a bastion looks like it guards two machines when it guards five, and an operator revoking a key there is told about the two. A key on the bastion produces one finding per KEY naming every server it reaches, not one row per key-and-host. Revoking is a CONFIRMATION and not a hard refusal like `rebootBlockFor`, and the difference is deliberate: rebooting a bastion mid-run is a thing a staged run must not contain, whereas revoking a key on one is frequently exactly right — somebody left — and refusing it outright sends people to edit `authorized_keys` by hand where nothing checks anything. An ADDRESS match stays the weaker claim all the way out, and a chain's strength is its FIRST link's, because a path is only as good as its claim about the bastion itself. "Nothing behind it" never renders as silence: `noBastionNote` says what the routes say and appends `unmatchedHopNote` when the graph has holes. The walk is bounded twice on purpose — `seen` makes it correct, a depth ceiling makes a bug in `seen` produce a wrong answer rather than a process that never returns, because a hang reads as broken infrastructure rather than as a defect. |
| **Certbot timer read** — **SHIPPED, generalised to systemd timers** | — | `shared/systemdTimers.ts`, with a "did it run?" control per timer in the cron panel, which already listed `systemd-timers` as a source and could say WHEN but never whether it WORKED. Generalised because that is what could be measured — the test host runs no certbot but runs eleven timers, three that have never fired, and two genuinely failed services. FIVE FINDINGS, four of them traps that produce a confident wrong answer rather than an error. (1) A UNIT THAT DOES NOT EXIST REPORTS SUCCESS: `systemctl show certbot.service` on a host with no certbot answers `Result=success`, `ExecMainStatus=0`, `SubState=dead` and exits 0 — every field says fine, and only `LoadState=not-found` disagrees, so it is checked FIRST and nothing else is believed until it passes. That recording is `detail-absent.txt` and it is the fixture the whole design rests on. (2) `left` IN THE JSON IS NOT A DURATION — it is the same absolute microsecond stamp as `next`, so rendering it as a remaining time gives about fifty-six thousand years. (3) `passed` IS A MONOTONIC STAMP: uptime was 1132793 s and logrotate reported 1088423 s, so it is time since boot and subtracting it from now dates every timer to the 1970s; the age comes from `last`, which is realtime. (4) `last: 0` MEANS NEVER, and fed to a date renders as "56 years ago". (5) A TIMER AND ITS SERVICE HAVE DIFFERENT NORMAL STATES — `inactive` on a timer means it will never fire, on a service it means a oneshot finished — which is also why the SERVICE is read at all: a timer can fire perfectly every day into a service that fails every time, and this host had two services in exactly that state. **Not measured:** certbot's own unit names, so `renewalTimers` is a filter over units the host listed rather than a parser — an unrecognised name is a MISS, never a wrong answer about a different unit — and a timer with an explicit `Unit=` whose service is not the timer's stem, where the verdict names the unit it actually read so the mismatch is visible. |
| **Drift, operator-chosen watches** — **VALIDATION AND APPROVAL SHIPPED** | — | `shared/driftWatch.ts`, the answer to the three things `drift.ts` says a typed path would need first. FOUR GATES, in this order. (1) THE PATH IS INTERPOLATED INTO A SHELL SCRIPT — `buildDriftCommand` embeds each path inside single quotes, which is safe for a fixed catalogue and is a command injection the moment somebody can type one, so the character set is an ALLOWLIST rather than an escape, and it is enforced here rather than at the point of use because a builder that trusts its caller will one day be called by something else. (2) Under `/etc` and nowhere else, with `..` refused as TRAVERSAL rather than accepted for starting with the right four characters. (3) A credential denylist whose bias is the OPPOSITE of `mounts.ts`: there an unknown filesystem is included because a missed one is a disk filling up nobody sees, here a name containing `key`, `secret`, `password`, `token` or a `.pem`/`.env` shape is refused whether or not it holds one, because a wrongly refused config file is a sentence and a wrongly accepted one is a private key in an hourly diff on every host. (4) A one-time typed approval whose phrase CONTAINS THE PATH, so an approval for `/etc/nginx/nginx.conf` cannot be replayed for `/etc/ssl/private/site.key` — the same reason `verifyApproval` compares command text literally. The character check runs before the credential check so a shell-breaking path is named as that rather than as a suspected secret. WIRED: the panel adds and removes watches, the proposal is persisted in settings, and MAIN re-validates every stored entry before the collector sees it (`services/driftWatchStore.ts`) — the same reasoning as `accessWriteGate.ts`, and the sharpest instance of it, because the path is interpolated into the collector script and a renderer-side check constrains only an honest renderer. A stored watch that fails is DROPPED rather than repaired: there is no safe repair for a path that could break out of a shell literal, and quietly fixing one would mean the file being read is not the file that was approved. The catalogue is always first, so a blob cannot shadow one of its paths, and `DriftDeps.watches` takes a FUNCTION so a watch the operator removed is not still read until the next restart. |
| | New | Size |
|---|---|---|
| **DB growth series** — **STORE AND FORECAST SHIPPED**; a `dbSampler` still open | — | `dbBytes` appended to `METRICS` (id 10) and `db:<connectionId>` interns as a subject with no schema change, because `host_key` is opaque TEXT. The budget arithmetic moved to a new `SWEEP_METRICS`: a series written when somebody opens a panel is not 30 rows an hour per host, and counting it in the sweep budget would overstate the cost of adding one by four orders of magnitude — which would make that budget useless for the decision it exists to force. Both counts are pinned, so appending a SWEEP metric still fails a test. The forecast is a SECOND forecaster (`shared/bytesForecast.ts`) rather than a tenth metric passed to `capacity.ts`, for the reason that file states about itself: its whole refusal policy rests on one flat-rise number working for cpu, memory and disk because all three are 0–100, and in bytes that number means nothing — half a gigabyte a week is noise on a 400 GB database and a crisis on a 2 GB one. So the flat rule is RELATIVE (2% of the run's starting size, measured from the start because the latest reading moves with every vacuum). And there is no 90% for bytes: a ceiling is optional, its absence is its own refusal, and **the rate is kept when the date is refused** — "this database has grown 380 MB a day for six days" is what somebody acts on, and withholding it because nobody set a limit would be withholding the useful half. `shared/dbSizeSample.ts` decides which number out of a sizes read may be plotted, and only ONE engine's can be: `pg_database_size` is a true per-database total, while MySQL's `totalBytes` is a sum over the rows its sizes query returned AND THAT QUERY HAS A LIMIT — on a server with more tables than the limit it is the biggest twenty rather than the schema, so a read that came back at the limit is refused rather than recorded. The named database is matched exactly or nothing is recorded: a Postgres sizes read lists every database on the cluster, and falling back to a sum would give a series that silently switches between "this database" and "this whole server", with every rate across the switch fiction. WIRED at the `db:ops` handler rather than inside `dbOps`, so that function stays a pure read with no store dependency; a failed write is swallowed, because an operational read that answered every question must not report itself as failed because a by-product series could not be appended to. The forecast is READ BACK on its own channel (`capacity:db-growth`) and shown as one line above the answers — a separate channel from `capacity:trends` and not a tenth metric on it, because that report carries percentage thresholds and a percentage forecaster and neither means anything in bytes; the ceiling comes from the caller because nothing here knows one, and inventing one would put a crossing date on screen nobody chose. The `dbSampler` — **SHIPPED** (`services/dbSampler.ts`), modelled on `fleetSampler` and deliberately smaller, because what it costs is different in kind: a metrics sweep is an SSH exec channel and this takes a CONNECTION on somebody's database server. So it is OFF by default with its own toggle ("we now connect to your production database every hour" is a thing a person switches on, not one they discover in a connection log), its cadence floor is an HOUR and a settings blob's shorter one is clamped rather than trusted, it never resolves a credential, a locked vault STOPS it rather than making it fail every interval forever, and the lock is re-checked when the timer fires rather than only when it was set. Its probe reuses `dbOps` and `reportSizeSample`, because a second path to a size number would be a second place for MySQL's capped total to be recorded by mistake. |
| **K8s allocatable vs requested** — **SHIPPED** | — | `shared/k8sAllocatable.ts`, rendered in the Kubernetes panel's usage view. Measured on a three-node `kind` cluster built for it, AND CHECKED AGAINST THE SCHEDULER'S OWN ARITHMETIC: `kubectl describe node` prints an `Allocated resources` block, which is what was actually booked, so the tests compute each node's requests from the pod list and compare. On `sp-alloc-worker2` both come to 940m and 514Mi. That check is what caught the finding: KUBERNETES SCHEDULES ON `max(sum(containers), max(initContainers))`, and summing only the app containers gave 440m against the scheduler's 940m — the missing 500m being one init container. THREE MORE FINDINGS. `<none>` is not zero, which the row already said, and the unsized count is reported beside the percentage rather than folded into it, because a cluster at 8% whose pods are unsized has headroom nobody can compute. THE COLUMN CANNOT SAY A POD IS FULLY SIZED: a pod with two containers, one sized and one not, prints ONE value with no placeholder, so the container NAMES are read purely to compare counts — and `kube-proxy` ships with no CPU request, so the unsized count is never zero on a real cluster and is a number to read rather than an alert. A Pending pod is booked nowhere and is named rather than dropped; a `Succeeded`/`Failed` pod keeps its `nodeName` and must not be counted. A CORDONED NODE'S FREE SPACE IS NOT HEADROOM — it is excluded from the total with the exclusion said out loud — and a node whose allocatable could not be read is null rather than zero, because zero renders it as full. The read is ALL NAMESPACES whatever the panel has selected, since a node holds every pod on it, and an empty node list is a blind spot rather than an empty cluster — the rule the PDB read had to learn. **CROSS-VALIDATED against a second, independent cluster:** the shipped read was re-run against a live single-node k3s on a different host and distribution, and agreed to the byte (200m, 140Mi) including the node's OWN printed percentages, 3% and 1%, computed from `6` cores and `12247552Ki` — units the kind fixture never exercises. k3s also ships an unsized system pod of its own (`local-path-provisioner` where kind has `kube-proxy`), so two unrelated distributions both confirm that the unsized count is never zero on a real cluster. |
| **Fleet expansion forecast** — **SHIPPED** | — | `shared/fleetForecast.ts`, rendered as a strip in the capacity panel. The row said refusal-first is the feature and that decided the shape: on a real estate most hosts produce NO forecast, so a ranking needs somewhere to put them, and both obvious answers are wrong. Dropping them makes "nothing is filling up" and "eleven hosts could not be forecast" render identically; sorting them last by a sentinel date puts a host that is ALREADY OVER below one that fills in eighty days, because `already-past` yields no crossing time at all. So there are three bands and the band beats the date — `over` first, then real crossings soonest, then every refusal WITH its reason in the operator's words, because a `stale` host needs somebody to look at it, a `too-few-points` host needs only time, and a `step-change` host needs somebody to find out what was untarred. The headline always carries the denominator ("1 of 3 could be forecast"), an estate with no samples says so rather than reading as an all-clear, and a server whose read FAILED goes in as a refusal rather than being absent. No new IPC: it reuses the per-host `trends` channel across the visible servers, which reads the local history store rather than a host, so a second channel would only be a second place for the forecast policy to drift. |
| **`get_capacity_trends` over MCP** — **SHIPPED** | Registered read-only, gated on `serverMetrics` — the same capability as the tool whose numbers these are over time, rather than a second switch to grant for data the first already gives. The report is computed by ONE function main also uses for `capacity:trends`, wired in the way the fleet sampler is, so an agent cannot end up disagreeing with the panel the operator is looking at. "History is off" is a sentence, not an empty answer: an agent told nothing fills the gap itself. | done |

**Backup, the parts that are not databases.** The bundle is the app's own store and nothing
streams (`backupTargets.ts:22-26`, "kilobytes"). A **remote file backup** — `tar -C / -czf -
<paths>` over an exec channel on the *same* pooled connection `openSftpIo` acquires — needs a
streaming `put`/`get`, a name that is not `.spbackup` so `planRetention` never counts it as a
generation, its own retention, a path allow-list, a sudo decision for `/etc/shadow`, and an
exposure text like `BACKUP_DESTINATION_EXPOSURE` because host files hold secrets too. Built as a
job kind, not a second scheduler, which is item 5's own instruction. **2–3 weeks.** A **Docker
volume backup** is the same source through `docker run --rm -v <vol>:/v … tar`, with quiescing
graded like any container action. **+1–2 weeks.** A **restore drill** of the oldest kept
generation is 2–4 days; a true scratch import 1–2 weeks. None of it is refused; none of it is
agent-reachable, and the vault inside the bundle is why.

### 48. VPN: the alert, the certificate date, and the server nobody manages

**One correction to the README first.** WireGuard is not userspace-only. `VpnMode` is
`'userspace' | 'system'` (`vpn.ts:16`); system mode creates a real TUN and applies routes and
DNS behind a per-launch elevation, refused on macOS and for full-tunnel profiles. "Your routing
table is never touched" is true of the default mode, and the README row should say so.

**Cheap and missing.**

| | Exists | New | Size |
|---|---|---|---|
| **`vpn-down` alert kind** — **SHIPPED** | — | TWO kinds, not one with a `detail`: `vpn-down` and `vpn-degraded`. Up-but-silent and down have different fixes, and one kind carrying both would tell the operator to reconnect when it is not that. `stopped` is null in BOTH columns rather than false — a person pressing Stop is not an outage, and it is not evidence of health either, so `false` would have the app resolve its own alert. The map is `VPN_ALERT_READINGS`, an exhaustive Record in `shared/vpn.ts`, tested without a timer; the poll around it is ten lines. | done |
| **OpenVPN client cert expiry** — **SHIPPED** | — | `clientCertNotAfter` computed at IMPORT from material the parser already holds, so nothing unlocks the vault to draw a date, and stored on the spec beside `remotes` as a non-secret summary. pkcs12 is refused rather than attempted — a password-wrapped container is not a certificate. The alert is `vpn-cert-expiry`, a SIBLING of `cert-expiry` rather than the same kind: the coverage page says where an alert comes from, `cert-expiry` says the posture sweep, and a VPN profile is not a server and is never swept. Tested against a certificate generated with openssl, not bytes written to satisfy the walker. | done |
| **`crl-verify` carry-over** — **SHIPPED** | — | Carried as inline-capable material like `ca`. The direction mattered: every other dropped directive makes the imported profile REFUSE something, and this one made it accept a certificate the issuer had withdrawn. The `crl-verify DIR dir` form has no inline equivalent, so it is dropped with its own sentence rather than read as a file — a profile that reports the gap beats one that fails to start. | done |
| **WireGuard per-peer stats, latency** — **SHIPPED** | — | The aggregate was a SUM, and that was the bug: a site-to-site link with one dead peer and one busy one showed the busy peer's traffic and the busy peer's handshake, and looked healthy. The UAPI already answers per peer — `wg` prints those rows — and the sidecar was discarding the block between `public_key=` lines; `parseIPCGet` now resets the counters at a peer boundary along with everything else, because a peer block that omits `rx_bytes` must not inherit the previous peer's number, which is the one mutation of six the first tests did not catch. `peers` is absent rather than empty when no rows came back: a sidecar from a build that reports none and a tunnel whose peers were removed are different answers. `latencyMs` is populated by the probe below and is a TCP CONNECT TIME, named for what was measured — it includes the peer's forwarding and the far service's accept, so calling it a round trip would be a stronger claim than the number supports. THE KEYS STAY OFF THE AGENT'S SIDE: `list_vpns` promises endpoints and keys are never included, a peer row is a public key beside an endpoint, and `tests/vpnPeerStats.test.ts` reads `mcpServer.ts` and fails if `peers` or `publicKey` appears in it. |
| **Diagnose** — **SHIPPED**, three checks of the five | — | `sidecar/netd/diagnose.go`, rendered by `VpnDiagnose.tsx` on the card. EVERY CHECK RUNS INSIDE THE NETSTACK, through the same two calls a SOCKS5 client uses: a lookup on the host resolver would travel in the clear and leak the very name the tunnel exists to hide, and a host `ping` would measure the path to the peer's public endpoint rather than the path through the tunnel — a number that looks like an answer and is about a different route. THE CALLER NAMES THE TARGET and there is no default, because a default would be this app deciding to open a connection to a third party through somebody's VPN. A SKIPPED CHECK IS NOT A PASSING CHECK: three words and no fourth, a skip always carries its reason, and the guard that stops a failed lookup producing a second redundant TCP timeout is the ONLY one — a duplicate in `connectCheck` silently absorbed the mutation that deleted it, so it was removed rather than tested. Never and long-ago are two sentences, not one: a key that was never right and a peer that has gone away have different fixes. NOT AGENT-REACHABLE — the target is an arbitrary host and port, and an agent able to call this repeatedly would have a port scanner pointed through the operator's VPN; `tests/vpnDiagnose.test.ts` fails if `vpn:diagnose` or `vpnDiagnose` ever appears in `mcpServer.ts`. **The IPv6 leak check is wired**, and it needed no new detector: `detectIpv6Leak` already existed and ran on all three platforms at apply time, and the only thing missing was a row on the card. It is decided in the parent rather than the sidecar because netd sees its own netstack and the UDP socket under it, and nothing of the host's routing table. Userspace mode SKIPS it with the reason — an application reaches that tunnel by connecting to a listener on purpose, so nothing is captured and nothing can bypass it — and a routing table that could not be READ skips too, because a read that did not happen is not a read that found nothing. OpenVPN skips it on a third ground: its routes are pushed by the server at connect time and are not in the stored profile, so `false` would raise a leak warning on every working IPv6 OpenVPN profile and `true` would hide a real one. The wording is `detectIpv6Leak`'s own, so an operator warned at connect and an operator reading this checklist are told the same thing about the same fact.

**TLS reach for OpenVPN is wired too**, and the correction that made it possible is that it needs no netstack at all: the addresses are the profile's own `remotes`, and the useful question is whether THIS machine can reach the server — which is what somebody wants to know when the profile will not come up, so the button is offered whether or not it is connected. It takes NO typed target, because accepting one would make it a port scanner wearing a diagnose label, and the card hides the fields rather than showing inputs the probe ignores. A UDP remote is not tried: sending an OpenVPN control packet is speaking the protocol at somebody's server, which is a different act from seeing whether a port answers. THE FINDING, and it came from working out what a failed handshake means: a server with `tls-auth` or `tls-crypt` — most of them, and all the well-configured ones — silently DROPS an unkeyed ClientHello, so a handshake that does not complete is the expected behaviour of a correct server and reporting it as a failure would send somebody to debug the one thing that was right. TCP reach is therefore the pass condition and the handshake is reported as extra, with the certificate explicitly NOT validated: a private CA is the normal case, so this measures reach and says so rather than letting a green tick imply trust. Measured against real sockets on loopback — a plain listener, a TLS listener with an openssl-generated self-signed certificate, and a closed port.

**DECIDED AGAINST: an MTU probe.** The failure it would catch is real and is not caught by anything above — a tunnel that handshakes, passes small packets and stalls on anything larger, which is what a too-large MTU looks like — but there is no honest way to measure it against an arbitrary target. Writing bytes to somebody's production port to see whether they come back is not something a diagnose button may do, and the alternative, reporting the CONFIGURED MTU as a check, is a number nobody probed dressed as a reading. The netstack's negotiated MSS is derived from that same configured value and adds nothing. So it is refused by name rather than approximated. |
| **OpenVPN edit without re-import** — **SHIPPED**; DNS verification still open | — | `services/vpn/ovpnEdit.ts`. THE OBVIOUS VERSION OF THIS SHIPS A PRIVATE KEY TO THE RENDERER: a stored `configBody` is a vault secret precisely because it carries `<key>` and `<tls-crypt>`, and "let them edit the text" means handing that to a window, a clipboard, a screenshot. So every inline block is replaced by an unmistakable placeholder on the way out and restored in main on the way back, and the operator edits the directives anybody actually edits — `remote`, `cipher`, `verb` — without ever seeing the key. Four placeholder cases are handled rather than assumed: DELETED means remove that block (honoured and reported, since removing `<cert>` silently is the difference between a profile that connects and one that does not), INVENTED is refused because there is nothing to restore, DUPLICATED is refused because it would write the same key twice, and a real `<key>` block PASTED BACK is refused with the sentence that it is an import rather than an edit — accepting it would make the redaction theatre. No sanitising rules live here: the restored body goes to `parseOvpn`, because a rule kept in two places is a rule that drifts.

**WIRED** (`services/vpn/edit.ts`), and the caution in the earlier note was misplaced: the orphan risk it named is one `vpnCommitImport` has always had, not one an edit introduces. An edit is a SESSION — `vpn:editRead` hands out the redacted text and keeps the blocks in main, `vpn:editCommit` puts them back, sanitises through `parseOvpn` and stages a NEW vault entry exactly as an import does, `vpn:editCancel` drops them without waiting for the thirty-minute TTL, and a vault lock forgets every session because key material must not outlive the unlock that made it readable. The old entry is HANDED BACK for the caller to delete after it has saved, never deleted here: save-then-delete leaves a recoverable orphan, delete-then-save leaves a profile pointing at a vault entry that is gone, which is a VPN that cannot connect and a config body nobody has. |
| Missing | What the code says today | What it blocks |
|---|---|---|
| **Somewhere to keep history** | `store.ts` is a single JSON blob, rewritten whole on every save. `fleetSampler` holds a `Map` in memory and `delete`s a host's entry the moment it goes unreachable. There is no database dependency in `package.json` and no time series anywhere in the renderer. | Capacity forecasting, alert hysteresis, job history, drift detection, "what changed on Tuesday" |
| **Somewhere to run long work** | `broadcast.run` is a buffered `exec` — three at a time, 60 seconds each, output capped at 20 kB, nothing surviving a dropped channel. Correct bounds for *a command*; wrong ones for *a task*. | Patching, OS upgrades, backups, restore tests, drains, migrations — every maintenance job |
| **Something that knows what a host IS** | A target is a connection config. `HostMetrics` carries a kernel string and a hostname; nothing reads `/etc/os-release` anywhere in the repo. | Patch management, inventory reporting, compliance, drift, "which boxes still have the old openssl" |

Build those three and most of what follows is one to three weeks each. Skip them and every feature
grows its own scheduler, its own storage and its own timeout bug — which is the mistake this
document already warns about for backups versus cron, generalised.

They are lettered rather than numbered because they are not features and must never be shipped as
one. Nobody wants a database; they want next Tuesday to be answerable.

---

### A. A durable store

Persist samples, events and facts, rather than rendering them once and dropping them.

**What exists.** Everything that produces the rows. `fleetSampler` already sweeps the estate on a
schedule and builds a complete `HostMetrics` per host, including units and listening sockets. It is
thrown away after being rendered. The alert path, the broadcast results and the two JSONL logs are
each a stream of events with no queryable home.

**DECIDED: `node:sqlite`, measured rather than assumed.** The obvious answer was
`better-sqlite3`, and the obvious objection was that this app has already paid the
native-module bill once — `@lydell/node-pty` cost a lazy loader with a kill switch, two
asarUnpack patterns, a files-exclusion glob that shipped two unsigned Windows binaries
into the first 0.8.0 build, a force-install in the release workflow so Intel Macs are not
handed `MODULE_NOT_FOUND`, a 9 KB verify script, a three-OS CI job, and library validation
switched off in the hardened runtime. None of that is hypothetical; all of it is in the
repository.

It turns out neither is needed. Electron 43.4.1 bundles Node 24.18.1, which ships SQLite
3.53.1 as `node:sqlite` — inside the binary this app already distributes. Verified by
running it: `DatabaseSync`, `StatementSync`, `backup` all exported, no experimental
warning, WAL accepted, and a `WITHOUT ROWID PRIMARY KEY(ts, host, metric)` table measured
at **21.9 bytes per row**, where the primary key *is* the table and there is no second
B-tree to pay for.

So the store costs **zero new dependencies, zero prebuilds, zero packaging surface, zero
signing surface**, which is the "one tool, no external dependencies" constraint met
literally rather than approximately. The trade is a dependency risk for a platform-version
risk: the version is whatever Electron bundles. That is the cheaper of the two here, and
the escape hatch stays open because `better-sqlite3` has near-identical `prepare/run/get/all`
semantics — provided the SQL never leaves one repository file. Three tables carry
almost everything below: samples (host, metric, timestamp, value), events (alerts raised and
resolved, jobs, changes, approvals) and facts (host, key, value, first seen, last seen).

**The trap the arithmetic missed, and it is 5x the whole budget.** `HostMetrics` carries
`services: ServiceUnit[] | null` and `listeners: PortListener[] | null`, sampled on every
sweep like everything else. A host with forty systemd units stored naively as samples is
28,800 rows a day *for one host* — 432,000 a day across fifteen, five times the entire
metric budget, none of it changing between sweeps. Units and ports are **facts**, written
only when they change, with the change itself recorded as an event. That is what items C
and 25 want anyway. Decide it before the first write, not after.

**What is genuinely hard, and it is not the schema.** Retention. Fifteen hosts at a two-minute
cadence with eight metrics is roughly 86,000 rows a day — nothing for SQLite, and 30 million a year,
which is a file somebody eventually notices. This needs a downsample rule (full resolution for a
week, hourly means after that, dropped after a quarter) decided before the first write, not after
someone's disk fills. A tool that alerts on disk pressure must not become a cause of it.

Measured, not estimated: the naive schema is 730 MB a year, and 1.27 GB if a separate
index is added. Seven days at full resolution plus eighty-three days of hourly
average/min/max, then dropped, holds **~16 MB in the database in steady state and never
grows** — 19.1 bytes a row, measured on the checkpointed primary, times 843,840 rows. Call
it **~32 MB on disk**: a full `.bak` is taken at every clean launch, so the steady state is
the database twice, and `historyBytes()` counts both because that is what the user's disk
gives up. Ship the retention pass on day one; a store that only gains a retention rule after
someone complains has already written the year of rows.

The `localPty.ts` discipline still applies even without a native module: import lazily
behind an interface, keep a kill switch, and let a machine where the store will not open
still get a working app running on today's in-memory behaviour.

**Size.** 1–2 weeks. Unlocks items 19, 25, 26 and 14, and makes 17 and 5 auditable.

---

### B. A job engine

A job is a command or a sequence, against a target set, whose output streams, whose state is
persisted, and which survives the panel closing, the laptop sleeping and the link dropping.

**What exists, and it is more than half.** Three separate pieces, each already tested:

- **The orchestration.** `broadcast.ts` has bounded concurrency, per-host state, cancel semantics
  where queued hosts never start, and outcome classification.
- **The approval model, which is the hard half of any executor.** `policyEngine.ts`,
  `policyStore.ts` and `approvals.ts`, with `broadcastApproval.test.ts` and
  `accessGroupSummary.test.ts` behind them. Confirmation already scales with both inputs — a
  destructive command on one host because the command is the danger, an ordinary command on twelve
  because the count is. A job engine does not need to invent any of that.
- **The streaming.** `logTail` already carries continuous multi-host output with bounded buffers,
  per-host attribution and backpressure, which is exactly what a running job's output is.

**What is actually new, and it is one question.** What happens when the channel dies mid-task.
Raising `BROADCAST_TIMEOUT_MS` is not an answer: a longer wait still loses everything when the
laptop lid closes at minute nine of an `apt upgrade`. The honest options are to run detached on the
remote side and poll for a marker (`nohup`/`setsid` plus a status file, or a `systemd-run --unit`
where systemd exists), or to accept that jobs die with the connection and say so plainly. The first
is the useful one and costs a real design decision about naming, orphan reclamation and what
happens when two OpsMaxxs poll the same job.

Everything else follows: a job list, a persisted history in A, resumable output, and per-job audit
rows that item 14 can read.

**The finding that reframes this item, and item 17 with it.** The status quo is not "a job
dies with its connection". `sshExec` on timeout resolves and abandons without signalling the
remote process, and when the socket dies sshd sends SIGHUP — which `apt` and `dpkg` do not
ignore. Minute nine of an `apt upgrade` across an estate is therefore not lost output, it is
**`dpkg` interrupted on every host**, and the recovery is `dpkg --configure -a` on each. Item
17 cannot ship on the attached path at all; the attached path is worse than not offering the
feature.

**Decided: a detached launch with a marker directory.** `setsid` writing `cmd`, `instance`,
`pid`, `out` and `rc` under the target user's own state directory, `rc` written
temp-then-renamed so its presence means it is complete. Resume reads from a byte offset,
which is an exact monotonic cursor. Three honest states fall out that today's vocabulary
cannot express — `detached` (launched, channel gone), `orphaned` (marker present, pid gone,
no exit status) and `foreign` (started by another OpsMaxx instance) — and today an
*expected* reboot classifies as `unreachable`, which is the opposite of the truth.

Nothing is installed: no binary, no package, no service, no cron entry, nothing that runs
after the job. One directory, reaped on read, with a Settings switch that turns detached
jobs off entirely and degrades to the honest ephemeral behaviour per host. `systemd-run` is
strictly better where it works and cannot be the only backend — system scope needs root,
which would make every job run as root and invert the risk model that assessed the command
as the user typed it; user scope needs lingering, which is a persistent change to the host.
It belongs later, capability-detected, behind the same interface.

**B3 shipped, and it settled the correction below rather than merely acknowledging it.** The
approval record is `CommandApproval` in `shared/broadcast.ts`, minted where the human answers and
stored whole in `job.approval`: the step text and the resolved target list exactly as confirmed, the
risk, the confirmation kind, and the phrase actually typed. `verifyApproval` re-derives the plan and
refuses on disagreement, at launch and again at resume, and it is called from BOTH surfaces —
`BroadcastPanel` no longer computes a plan and throws it away. The re-consent rule is written down
in `shared/jobs.ts`: a job resumed **within one process lifetime** carries its approval; a job
adopted **after a restart** finishes the hosts already running and may not start one it never
reached, because finishing is not an action and starting is. That makes B2's `reclaim()` refusal
principled rather than incidental. Decisions are written to `opsmaxx-job-approvals.jsonl` — a
third log, not a second caller of `recordAudit`, for the reason the local terminal already has its
own file, and because `auditLog.ts` sits inside the agent-reachable import closure that
`tests/jobsNotExposed.test.ts` guards.

**Correcting this document.** An earlier revision justified the estimate with "the approval
model — the hard half of any executor — is built and tested", naming five files as one
system. They are **two systems with no shared code**: the human confirmation model lives
entirely in `shared/broadcast.ts` and is enforced in the renderer, and the AI capability gate
lives in `policyEngine`/`policyStore`/`approvals`. The two tests cited as proof test the two
different halves, and neither produces what a durable job needs — a **persisted approval
record**. `BroadcastPlan` never reaches main at all; `broadcast:run` takes a run id, a command
and targets, and `main/index.ts` states deliberately that main does not re-derive the model.
A job resuming after a restart therefore has no memory of the dialog that authorised it, and
fixing that reverses a settled decision rather than extending one.

**Split, so item 17 does not wait for all of it.**

| | Scope | Size |
|---|---|---|
| **B1** | Durable one-command jobs on the existing attached path, the store, and a job list | 1.5–3 wk |
| **B2** | The detached backend, the four new states, reconnect with backoff, reclaim and reap, the remote-shell matrix | +2–3 wk |
| **B3** | ~~A persisted approval record, and moving enforcement into main~~ **SHIPPED** | +1 wk |
| **B4** | Stages, the health gate, reboot-and-wait, jump-host exclusion | +1.5–2 wk |

**Size.** **6–9 weeks** for the whole of it, not 1.5–3. B1 alone is the old estimate and is
the version that does *not* unblock item 17. B4 overlaps what item 17 already budgets for
reboot coordination — it belongs here, and item 17 shrinks accordingly rather than paying
twice.

**One guard this item needs that broadcast did not.** Durability defeats revocation: `deny
all pending` resolves requests that are *pending*, and can do nothing about a job already
detached on fifteen hosts, because nothing is pending. An agent-reachable job engine would be
a standing capability the stop-all-AI-access switch cannot revoke. It stays human-only, with
the three-layer guard the local terminal already uses.

---

### C. Host facts

What a host *is*, as opposed to what it is currently doing.

**What exists.** The collection path. `fleetSampler`'s sweep and `metricsSample()` already run
probes over a pooled connection and already respect the distinction that matters most here.

**What is actually new.** A slow-cadence probe — hourly, not every two minutes, because a distro
does not change between samples — reading `/etc/os-release`, the kernel, the package manager, the
count of pending updates and of *security* updates specifically, the reboot-required flag, the
virtualisation type, and the machine's own idea of its uptime. Stored in A, surfaced through the
fleet search query surface that already exists.

**The finding that changes item 17, and it is not a detail.** "Security updates, counted
separately" is item 17's headline number. Research against the real package managers says
it cannot always exist:

| Manager | Pending | Security | Why |
|---|---|---|---|
| apt | yes, from cache, no root | **yes** | `apt-check`, or origins ending `-security`. Best-supported path. |
| zypper | yes | **yes, best of any** | SUSE genuinely models patches by category. |
| dnf / yum | yes (exit 100 means updates) | **only where `updateinfo` exists** | Rocky and Alma publish it, Fedora publishes it, CentOS Stream historically does not, and many internal mirrors strip it. When it is missing dnf returns **zero rows**, which is indistinguishable from "no security updates". |
| pacman | yes, from the local sync DB | **never** | Arch has no security channel. |
| apk | yes | **never** | Alpine tracks secfixes in build metadata, not the installed index. |

So on two of five managers the number can never exist, and on a third it silently reads
zero during exactly the week it matters. A silent zero is the precise failure this item
exists to prevent, so `unsupported` is a first-class status distinct from both `0` and
"not checked", it must render differently in the table, in the fleet-search coverage
sentence and in anything an agent is told — and item 17 must promise "security updates
where the distribution publishes them", not "security updates".

Detecting the dnf case is required work, not a nicety: probe `updateinfo summary`, and if
it answers nothing while pending updates exist, the security count is `unsupported`.

**Three things already exist and shrink the probe.** Kernel, total memory and uptime are
already in `HostMetrics`. Do not collect them twice.

**Two mechanical traps.** `metrics.ts`'s `exec` discards the exit code, and exit status is
the API for three of these probes — dnf signals updates with 100, zypper reboot-needed
with 102, `needs-restarting -r` with 1. And `section()` cuts at the next `__MARKER__`, so
a `PRETTY_NAME` containing one truncates its own section and shifts every later fact.
`cron.ts` already solved the second by accumulating status in a shell variable and
printing it once at the end, where nothing read out of a file can forge it. Copy cron,
not metrics.

**Never mutate.** No `apt update`, no `pacman -Sy`, no `dnf makecache`. All three hit the
network, take seconds, and `pacman -Sy` creates the partial-upgrade state that is the
classic way to break an Arch box. Read the cache and **report its age** — "0 pending
updates" from metadata refreshed forty days ago is a lie of the exact kind this item
forbids. That is a second staleness axis: the fact's own age, and the age of the data
behind it.

**Never source the file.** `. /etc/os-release` on a host under an attacker's control is
arbitrary code execution as the SSH user. Read it and parse in TypeScript.

**What is genuinely hard.** The same `null`-is-not-empty discipline the monitor and fleet search
already enforce, applied where it is most tempting to skip. "No pending updates" and "could not
check for updates" must stay visibly different, or the feature lies during exactly the week a CVE
matters. A host whose facts are four days stale should say so rather than presenting them as now.

**Consent, decided.** This gets its own `hostFacts` capability rather than widening
`serverMetrics`. "How many unpatched security updates, and which kernel" is a
vulnerability report about the host and is arguably the most attacker-useful thing the
bridge could return — materially different from "CPU and memory". The 0.8.0 finding above
was exactly a consent that had drifted wider than its grid text, and the standard it set
is that the grid must describe what is actually taken. A new capability backfills to DENY
for every existing group, which is the correct default here.

**Size.** Revised to **2–3 weeks**, and honestly 1.5 only if apt and dnf ship first with
the other three managers marked `unsupported` on day one. The roadmap assumed the
collection path was the work. It is not — the distribution matrix and the honesty plumbing
are. Item 17 cannot start without it; items 24, 25 and 26 are much weaker without it.

---

## The maintenance tier — the week itself

### 17. Patch and update management

One view: every host, its pending updates, its security updates counted separately, whether it needs
a reboot. Select a set, apply in stages, coordinate the reboots.

**Why this is the flagship.** It is the single most common recurring task in the job the app is
named for, it is on every sysadmin's list without exception, and nothing in the product touches it
today. A user patching fifteen hosts currently opens fifteen tabs.

**What exists.** Nothing directly — and almost everything indirectly. Items B and C are the feature;
`broadcast`'s risk assessment and typed confirmation are the safety model; fleet search is the
"which hosts" query.

**What is actually new, and it is not the package managers.** Abstracting apt, dnf, zypper and pacman
is a day's work and mostly `--dry-run` parsing. The feature is **reboot coordination**, and it is
where this can do real damage: do not reboot both replicas of a database, do not reboot the bastion
you are connected through, do not proceed to host four when host three came back with a failed unit.
That means an explicit ordering, a health gate between stages, a hard refusal to reboot a host that
is a jump host for anything else in the workspace, and a resolved target list shown before anything
runs — the same discipline broadcast already applies to a one-shot command, extended over time.

**What it should not do.** Decide *whether* to patch. Reporting that twelve hosts have security
updates and letting a person choose is honest; auto-patching an estate from a desktop app is a
promise about unattended correctness this app cannot keep.

**Size.** 3–4 weeks after A, B and C. Nothing else on this page is worth more.

---

### 18. Database operations — SHIPPED

**Postgres and MySQL/MariaDB shipped in `c008c8d` and were hardened in `971c47d`. MongoDB and
Redis are now built too**, in four commits: the captured fixtures, the pure command/parse/judge
layer, the collectors, and the panel. Eight questions for MongoDB and nine for Redis — the ninth
is `cluster`, which cannot fold into `replication` because a cluster in state `fail` refuses a
third of the keyspace while every node's `INFO replication` reports a healthy master.

**SQL Server is deliberately not covered**, and `DB_OPS_UNSUPPORTED_NOTE` says so on the page
rather than leaving an empty tab to be discovered: nothing here has been run against one, and a
set of questions written from documentation agrees with whatever its author assumed rather than
with the server.

What the MongoDB and Redis pass cost was not the commands. It was that both engines report a dead
thing with a number that reads as healthy, in the same shape MySQL does and with different field
names. A MongoDB member that is unreachable reports `health: 0` alongside `pingMs: 0`, `uptime: 0`
and an `optimeDate` of the Unix epoch; a Redis replica whose master has gone reports
`master_last_io_seconds_ago: -1`. Neither is a measurement, and every clamp a reviewer would ask
for turns both into zero. Both were captured from real containers rather than reasoned about, and
`tests/fixtures/dbops/README.md` records what could NOT be captured — no sharded cluster, no Redis
Cluster, no Sentinel, no AOF, no `mongodb+srv` — rather than filling the gaps with invention.

The write-up below is kept as the reasoning that produced it.

The five engines are connected and can be queried. That is a client. An operator needs the other
half: backups, replication health, connection counts, slow queries, locks, growth.

**Why it is the best value-to-effort item on this page.** `pg`, `mysql2`, `mssql`, `mongodb` and
`ioredis` are already bundled, already connected through the credential resolver, and already used
for nothing but ad-hoc queries. `dbshell.ts` already runs each engine's native shell. Every answer
below is a query over a connection the app is already holding.

**What is actually new.** Per engine, roughly eight questions and a display: Postgres —
`pg_stat_replication` lag, WAL and archive state, autovacuum age per table, `pg_stat_activity`
counts, `pg_locks`, database sizes, `pg_stat_statements` when installed. MySQL/MariaDB —
`SHOW REPLICA STATUS`, binlog inventory and disk cost, the slow log, `SHOW PROCESSLIST`, table and
index sizes. MongoDB — `rs.status()`, oplog window in hours rather than bytes, index usage,
connections. Redis — `INFO memory` with the eviction policy, persistence state and last save,
replication, `SLOWLOG`, keyspace growth.

**What is genuinely hard.** Nothing technically, and two things editorially. Which eight questions
per engine actually matter — the wrong eight is a dashboard nobody reads. And rendering a number as
a judgement: "replication is 4h 12m behind" belongs in the alert path from item 19, not in a table
cell in a tab nobody has open.

Backups belong to item 5, not here — a database dump is a job with a destination, and building a
second backup path beside `backup.ts` is exactly the two-schedulers mistake in another costume.

**Size.** 1–1.5 weeks per engine. Postgres and MySQL first covers most estates.

**What the estimate got right and wrong.** The eight-questions-per-engine framing held for both
new engines, and the editorial half was indeed the hard part. What it missed is that "roughly
eight questions" is the cheap half of a week and the fixtures are the expensive half: every
finding that changed a judgement came out of a container, and none of them out of documentation.

---

### 19. Alerting, completed — BUILT

**19a (disk) shipped in `7f4e1e2` and was hardened in `1a4cfaa`. 19b is now built**, in six
commits: durable suppression, flap damping, inodes and load, the kinds that have no number, their
producers, the inbox, snooze and acknowledge, and per-host thresholds. Ten kinds fire today —
`cpu`, `ram`, `disk`, `inode`, `load`, `host-unreachable`, `job-failed`, `tunnel-down`,
`db-alarm`, `db-watch` — plus `unit-failed`, which is a set of unit names rather than a crossing
and has always been its own shape.

**Two named kinds are deliberately NOT built**, and the reason is the same for both, first written
down in `a2b06a5`: each needs a new remote probe whose SCOPE is a product decision nobody has taken
— which journal window counts as "recent" for an OOM kill, and which certificates on which paths
count as "ours" for expiry. A half-probe that reports "no OOM kills" when it could not read the
journal is precisely the alert this item spends its length refusing to ship, because a metric that
could not be measured is not zero. They are a separate item, not a loose end in this one.

"Backup failed" IS built, since item 5 shipped and gave it something that could fail. It keys on
the last SUCCESSFUL report rather than `lastRunAt`, which records attempts, and separates four
reasons: never, failed, overdue, unverified. "Replication lag from item 18" IS built, as `db-alarm` and `db-watch` —
item 18 already decides the level and writes it to the durable store with the numbers attached, and
alerting reads that verdict rather than reaching one of its own.

The write-up below is kept as the reasoning, in the past tense where it describes what was wrong.

Four kinds fire today: `cpu`, `memory`, `unit-failed`, `backup-failed`.

**The surprising gap is disk, and it is subtler than "missing".** `hostHealth.ts` treats disk as a
first-class signal already — `DISK_DANGER = 85`, `diskCritical` per host, `diskHosts` in the fleet
summary, `diskLine()` rendering "2 hosts low on disk", and disk pressure is one of exactly two
things that mark a host as needing attention. There is even a comment ranking failed units above it
deliberately, because a unit that is down is an outage already and a disk that is filling is one
that has not happened yet.

What is missing is that disk is not an `AlertKind`. It is computed, ranked and rendered — and then
reaches nobody. A filling disk shows on a screen you have to already be looking at, which is
precisely the failure mode item 16 was built to end. **This is half a day of wiring an existing
signal into an existing bus**, and it should not wait for anything else on this page.

**Then the rest, which does need A.** Inode exhaustion, load, OOM kills from the journal, host
unreachable, job failed, backup failed, replication lag from item 18, certificate expiry for certs
on hosts we manage, tunnel or VPN down. Plus per-host thresholds, hysteresis, flap suppression,
snooze, and an alert *inbox* with a history rather than transient toasts — a disk alert that fires
forty times overnight gets the whole feature muted, which is worse than not shipping it.

**Size.** Disk: half a day. The rest: 2–3 weeks, most of it after A.

---

### 20. Compose

**What exists, and this was underestimated.** `docker.ts` already reads
`com.docker.compose.project` and `com.docker.compose.service` labels — asked for as a separate probe
that is allowed to fail, and carrying `composeLabels: 'read' | 'unavailable'` so "no compose
projects here" stays distinct from "could not read labels". Containers already group by project in
the panel. The mental model is built.

**What is actually new.** The file half: finding compose files on a host (`docker compose ls` where
the engine is new enough, a bounded filesystem search where it is not), parsing and validating them,
showing declared services against running state, `pull` and `up -d` as jobs from item B, and editing
an image tag.

**What is genuinely hard.** `.env` handling, which is the reason this cannot be a thin wrapper.
Compose environment files hold credentials, and displaying them is the one thing this app exists not
to do. They must route through the vault and the redaction pipeline or the feature is a secrets
leak with a nice table.

**Why it ranks above Kubernetes work.** The reference user's estate is compose, not k8s. Most
single-operator infrastructure is.

**Size.** 1.5–2 weeks.

---

### 21. Docker housekeeping

**This is a decision, not a feature.** `docker system df` is already parsed down to reclaimable bytes
and percent per type, and `broadcast.ts` already classifies `docker`/`podman`
`rm|rmi|stop|kill|prune|down` as destructive. The comment in `docker.ts` explaining why prune was
not shipped is the correct instinct: `docker system prune -a` has ruined days.

**SPLIT, after research contradicted the plan.** `docker.ts` already refuses `prune`, and
its stated reason is falsifiable rather than a preference: *"its blast radius is not knowable
from the UI that offers it."* That is an objection to `prune`, not to reclaiming disk — and
it is answered by making the blast radius a literal list of ids.

Research also found the `-a` case is worse than its flag reads. `system prune -a` removes
every stopped container **first**, so images whose only reference was a stopped container
become unreferenced within the same command and are then deleted too. A preview built by
listing images beforehand cannot show them. That is not a race; it is a preview that is
structurally wrong. `-a` is refused, not deferred.

**21a — the itemised view. Shipping now.** `docker system df -v` gives what the summary
cannot: per-image `UNIQUE SIZE`, per-volume size and link count, per-container state, build
cache. Read-only, no deletion. This satisfies the existing comment's own remedy — *"the
disk-usage panel exists precisely so the operator can decide what to remove themselves, in a
shell, with the numbers in front of them"* — by giving them the numbers per item instead of
per category. **3–5 days.**

**21b — reclaim by id. Shipped.** Not `prune`: `docker rm`/`rmi`/`volume rm`/`network rm`
against exactly the ids the preview displayed, so anything that became eligible afterwards
is untouched and the crashed container you were about to debug survives, while anything
that stopped being eligible fails on its own terms in docker's own words, per item.

The re-preview is on the CONFIRM, not on the button that opens the dialog: the window that
matters is the one the operator spends reading the caveats. A re-read that *fails* is a
refusal too. Nothing is pre-selected and there is no select-all, because a select-all is
`prune` reached by a click instead of a flag. Risk is `planK8sRollout`'s shape rather than
`planDockerAction`'s — count is the wrong axis when fifty dangling images are a pull away
and one volume is not — so a volume is destructive and typed-confirm on its own, and
`caveats` rides separately from `reasons`.

Three things are still refused, and each is refused rather than deferred. **`-a`**, for the
structural reason above. **`--force`**, because the checks it overrules are exactly the facts
a preview cannot vouch for. **Build cache**, because a single entry comes out only through
`builder prune --filter`, which is a prune.

**The podman gap remains, and is now stated in the fixtures rather than implied.** Podman's
`rm`/`rmi`/`volume rm` print different success lines and different refusal wording, and no
podman host was available to record on. Nothing was invented to fill it in: an invented
refusal string would read as evidence that podman works. The parser attributes by looking
for the reference inside the line, which is the most runtime-agnostic rule available, and on
podman would most likely report every object as "docker did not say what happened" — the
honest failure rather than a wrong success.

**Engine age, without phoning home.** `{{.Server.BuildTime}}` gives an absolute age that
cannot go stale and cannot be wrong. A baked table of release versions was considered and
rejected: it needs an owner and a refresh cadence, and a table that rots states something
false. Age alone is honest and free.

**Size.** 21a: 3–5 days. 21b: 1.5–2 weeks, spent.

---

### 22. Kubernetes lifecycle — SHIPPED

`kubernetes.ts` refused exec, delete and context switching, and gave reasons that were right at the
time. Two of the three said what the precondition was, so this item is those preconditions.

**Cordon, drain and uncordon.** The file already explains why drain is the dangerous one: ownership
references tell you a pod will be recreated, they do not tell you the workload can afford to lose it
right now. A one-replica Deployment's pod is "safe" by ownership and an outage in fact. Drain needs
endpoint state at the moment of the click and PDB awareness, and without both it should stay unbuilt.

**Exec into a pod**, behind the broadcast approval model — which is what the file said the
precondition was, and which now exists.

**Reads that are missing and cheap.** PVC capacity, ingress, RBAC bindings, secrets *existence*
without values, deprecated API scan against the cluster version, Helm release listing.

**Still not this.** Applying manifests. That is a GitOps pipeline's job and putting it behind a
desktop button is how a staging manifest reaches prod.

**Size.** 3–5 weeks. After Compose, deliberately.

**What shipped, and how the drain decides.** Cordon and uncordon are a plain confirm in both
directions and the plan says out loud, with the pod count, that a cordon evicts nothing — the one
thing everybody misreads about that button. Drain is offered only after a preflight round trip that
reads the node, the pods on it, every PodDisruptionBudget and every EndpointSlice, and it is refused
outright on any of seven things: a pod nothing owns, a budget with `disruptionsAllowed` at zero, a
pod covered by MORE THAN ONE budget, a budget selector using `matchExpressions` that a list read
cannot evaluate, the only Ready endpoint behind a Service, an `emptyDir` volume, and **any read that
did not answer**. That last one is why `safe` is not "no blockers": a Forbidden budget list produces
no blockers because it produces nothing. `--force` and `--delete-emptydir-data` are written
explicitly as false; both turn a blocked drain into a successful one by destroying what blocked it.

The overlapping-budget rule was found by running a drain against a real three-node cluster rather
than reasoning about it: the eviction subresource answers `This pod has more than one
PodDisruptionBudget, which the eviction subresource does not support.` regardless of what either
budget allows, so a check that only read `disruptionsAllowed` would have cleared a drain that cannot
make progress at all. The same recording showed a drain is **not atomic** — it evicted three pods,
stalled on two, and gave up at the timeout with the node cordoned and half empty — which is why the
result carries `partial` and why the check happens before the command is built.

Exec ships behind `approvalFor`/`verifyApproval` from `shared/broadcast.ts`, reused unmodified: the
record carries the command text, so an exec approved as `id` and sent as something else is a
comparison rather than an act of faith. Always type-to-confirm, with no cheap case — `ls` and
`rm -rf /` are the same request from here.

The cheap reads all shipped. Secrets list names and key names and never a value, and that is a
property of the query rather than a rule applied afterwards: a go-template ranging over `$k, $v` and
emitting only `$k` is the only kubectl output form where the value is structurally unreachable.

**Still refused, and unchanged.** Applying manifests, for the reason above. Context switching, which
rewrites the user's kubeconfig for every process on the host. Single-pod deletion — a drain answers
"can this node lose everything on it", which is a question about a node; "can this workload lose
this one pod" is a question about a workload, and `rollout restart` already reaches that remediation
through the controller. And the MCP bridge: none of this is agent-reachable, and
`tests/jobsNotExposed.test.ts` holds the symbols.

**What is untested.** A drain where the remaining nodes cannot fit the evicted pods. Every fixture
came from a `kind` cluster whose nodes are containers on one host and which was never under real
resource pressure; the replacements go Pending, the eviction still succeeds, and `kubectl drain`
still reports the node drained. That path needs a real multi-node cluster with real requests and
limits. See `tests/fixtures/k8s/README.md`.

---

### 23. Fleet key and access management

Which key opens which host, whose it is, and removing one everywhere at once.

**What exists.** Very little, and it is worth being precise: `authorized_keys` appears exactly once
in the repo, in `sshKeys.ts`, as a filename to *skip* when listing a user's own private keys. This
is close to greenfield on top of B, C and the vault.

**Why it is a genuine differentiator.** No GUI SSH client does fleet-wide key inventory well.
"Which of my fifteen hosts still trusts the laptop I sold" is a question every operator has and
nobody can answer quickly. The data is one file per user per host.

**What is actually new.** Read and fingerprint every `authorized_keys` across the estate, attribute
keys to people, cross-reference against last-login where the host will say, and add or revoke across
a selection. Adjacent and nearly free once the reader exists: expired or locked accounts, sudoers
membership, and an access-review export.

**What is genuinely hard, and it deserves fear.** Writing `authorized_keys` is the highest-consequence
write the app could make — a bad one locks you out of the host you would use to fix it. Three rules,
non-negotiable: never remove the key the current session is authenticated with, always verify a
second independent session succeeds before committing the change, and always leave a timestamped
backup of the previous file on the host.

**Shipped, and narrower than the item's title.** The read half answers the question this
item exists for across the whole estate. The write half does not: the staged write resolves
`$HOME/.ssh/authorized_keys` on the host, so one approved command covers a selection — and can
therefore only ever edit the **connecting account's** file. A revoke aimed at another account
is refused rather than silently rewriting the wrong file, which would fail the count check,
change nothing, and report the wrong reason for having done nothing.

Combined with rule 1, which needs sshd to report the session key, revoke works on the
connecting account on hosts with `ExposeAuthInfo` enabled. That is a real capability and it is
not "fleet key management" in the sense the panel's title suggests. Widening it means a
per-account staged write and therefore a per-account approval, which is a different shape of
job, not a bigger loop.

Two follow-ons, both small and both named so they are decisions rather than oversights: the
panel must state the scope before an operator selects a target, and a key revoke — the most
audit-worthy write in the application — currently leaves **no approval-log row**, because
`recordJobApproval`'s surface vocabulary has no value for it.

**Size.** 2–3 weeks, of which the read half is one.

---

### 24. Security posture — reading state, not scanning

Firewall rules (ufw, firewalld, raw iptables/nftables), SELinux or AppArmor mode, sshd config against
a hardening baseline, failed-login summary, and pending security updates specifically.

**The scope discipline is the whole item.** Do not build a vulnerability scanner. The distribution
already knows which of its packages carry security fixes, and `apt list --upgradable` with
`debsecan`, or `dnf updateinfo --list security`, is a better answer than anything a desktop app will
compute from a CVE feed. This item consumes that; it does not recompute it.

**What exists.** Item C collects the update counts already. Everything else is a read probe of the
kind the sampler runs a dozen of.

**Size.** 2–3 weeks.

---

### 25. Configuration drift

Snapshot a file or a setting on one host, compare it across the fleet, alert when it diverges.
"All twelve web servers have this nginx.conf. Three do not."

**What exists.** Fleet search's cross-host query shape, SFTP read, and item A for the baseline.

**What is genuinely hard.** Defining a difference. Whitespace, generated timestamps, hostnames and
per-host stanzas make naive diffing useless within a day of shipping. This needs normalisation rules
per watched file and the honesty to say "differs in ways I was told to ignore".

**Size.** 2–3 weeks.

---

### 26. Capacity trends

"This disk fills in eleven days."

**Why it is small.** Once item A exists this is a query and a chart, not a subsystem. It is listed
separately only so that item A is not judged on the day it ships, when it appears to do nothing.

**What it must not become.** A metrics warehouse. Storing enough history to answer an operator's
question is the goal; competing with Prometheus is not, and that fight is both lost and not worth
entering.

**Size.** 1–2 weeks after A.

---

### 27. A rule engine — the honest answer to item 9

"When this alert fires, run that job, then call that webhook."

**Why this and not n8n.** Item 9 asks the right question and answers it with the wrong thing.
Once items A, B and 19 exist, the app already has events, execution and delivery; a small rule engine
over its own primitives integrates with the policy layer, the audit log and the vault, and an
embedded n8n would need significant bridging to reach any of the three — while adding a second
database, a second auth model, a second credential store and a licence question.

**What it must not do.** Grow into a workflow language. Three clauses — on event, matching filter,
run action, with a rate limit — covers the cases people actually ask for. Anything beyond that is
someone else's product.

**Size.** 1–2 weeks after A and B.

---

### 28. Runbooks attached to alerts

When the disk alert fires, show the three commands that fixed it last time.

**The only part of "documentation" worth building here**, and only because item A makes it nearly
free: the events are already stored, and the jobs run against them are too. A runbook is a note
attached to an alert kind, plus the history of what was actually run the last three times it fired.
Everything else about documentation — diagrams, architecture, inventory prose — belongs in a wiki and
this app should link to one rather than become one.

**Size.** 1–2 weeks.

---

## What this deliberately will not build

A roadmap that only says yes is a wish list. Each of these was considered against the sysadmin week
in the section above and declined, with the reason, so that adding one later is a decision rather
than a drift.

| Not building | Why |
|---|---|
| **DNS and TLS certificate management** | It is a provider-API product — Route 53, Cloudflare, ACME — with almost nothing in common with an SSH console. The only piece worth keeping is certificate expiry as an alert kind in item 19, for certificates sitting on hosts we already manage. |
| **A configuration management DSL** | Not becoming Ansible. The useful subset is about eight idempotent operations — package, service, user, file, key, line-in-file — and everything past that is a language, a compiler and a decade. |
| **A metrics warehouse** | Store enough to answer an operator's question and to forecast. Item 26 says the rest. |
| **A vulnerability scanner** | Item 24: the distribution already knows, and its answer is better than ours. |
| **Embedded n8n (item 9)** | Item 27 gets most of the value with full access to the policy engine, the vault and the audit log, and without a second database, a second auth model and a licence question. |
| **A third-party extension API (item 15b)** | Unchanged and worth restating: a plugin that can call `credentialResolver` is a vault with no lock. `MODULE_FORBIDDEN_IMPORTS` and `MODULE_FORBIDDEN_BRIDGE` exist to make drifting into it impossible by accident. Not before the Tauri decision — an extension API is a compatibility promise, and rewriting the host underneath one is how migrations die. |
| **Ticketing, on-call rotation, incident management** | Webhook out to the tool that already does it. |
| **Ghostty (item 8)** | Cut by the owner. The feasibility study still stands and is worth keeping: libghostty-vt has no PTY at all — zero spawn symbols across its thirty public headers — so it could never replace node-pty, and the full renderer admits macOS and iOS only with an NSView surface, so it cannot be embedded here. The one real prize was `snapshot.h` for session restore, and it is not worth a hand-written FFI against an API whose authors say it will change without warning. |
| **Tauri (item 10)** | Cut by the owner, and the case got weaker while this roadmap was executed rather than stronger. The port was always "rewrite the whole main process": SSH and SFTP over ssh2, five database drivers, the MCP server, the vault, the VPN subsystem with its privileged helpers, the supervisor, the policy engine. This work then added a job engine with detached remote execution, a SQLite store, a host-facts probe, a database-operations layer, an access collector and a posture collector — all of it main-process, none of it portable. Installer size was the prize; the price is now most of a year of rewriting things that work. |
| **Documentation generation, diagrams, architecture prose** | Except item 28, which earns its place by being nearly free once item A exists. |
| **Applying Kubernetes manifests** | Item 22. That is a pipeline's job. |
| **Unattended auto-patching** | Item 17. Reporting and staging, yes. A desktop app quietly upgrading an estate is a promise about unattended correctness this app cannot keep. |

---

## Leverage against cost

The tiers above say what each thing is. They do not say what to build on Monday, because tier is not
priority: the maintenance tier contains both the highest-value item on the page and one that serves
a quarter of the target operators.

### How leverage is scored

Leverage is one number from 1 to 10, and it is a judgement rather than a measurement. It is written
down anyway, because a number that can be argued with beats an instinct that cannot. Four inputs:

- **Reach** — what share of the operators described above hit this at all. A feature for a quarter of
  them starts at a quarter of the score, however good it is.
- **Frequency** — daily, weekly, monthly, per-incident, rare.
- **Pain today** — how bad the current workaround is, 1 to 5. "Fifteen terminal tabs" is a 5.
  "The docker CLI already does this fine" is a 2.
- **Moat** — whether anything else the operator already owns does it. Strong moat raises the score;
  a thing every monitoring tool does lowers it, because it is table stakes rather than a reason to
  choose this app.

Cost is weeks for one focused person, split into **direct** (the item itself) and **blocked-by**
(enablers that must exist first). An item with a small direct cost and an unbuilt dependency is not
a cheap item, and treating it as one is how a quarter disappears.

### The matrix

| # | Item | Reach | Freq | Pain | Moat | **Lev** | **Direct** | Blocked by | Quadrant |
|---|---|---|---|---|---|---|---|---|---|
| 19a | ~~**Disk alert**~~ | 100% | continuous | 4 | none | **8** | **SHIPPED** | — | Done |
| 21a | ~~**Docker itemised disk view**~~ | 60% | monthly | 3 | some | **5** | **SHIPPED** | — | Done |
| 21b | ~~**Docker reclaim by id**~~ | 60% | monthly | 3 | some | **5** | **SHIPPED** | podman tested, ports unverified | Done |
| C | ~~**Host facts**~~ | 100% | continuous | 4 | strong | **3 / 21** | **SHIPPED** | — | Done |
| A | ~~**Durable store**~~ | — | — | — | — | **0 / 30** | **SHIPPED** | — | Done |
| B | ~~**Job engine B1–B4**~~ | — | — | — | — | **0 / 38** | **SHIPPED** | — | Done |
| 18 | ~~**Database operations**~~ | 70% | weekly | 4 | strong | **8** | **SHIPPED** | all five engines | Done |
| 17 | ~~**Patch management**~~ | 100% | weekly | 5 | strong | **10** | **SHIPPED** | — | Done |
| 5 | ~~**Backups to real targets**~~ | 90% | weekly | 5 | strong | **8** | **SHIPPED** | — | Done |
| 19b | ~~**Alerting, the rest**~~ | 100% | continuous | 4 | none | **8** | **SHIPPED** | — | Done |
| 23 | ~~**Fleet key management**~~ | 100% | quarterly | 5 | very strong | **7** | **SHIPPED** | write opt-in, rollback verified on RHEL 9 | Done |
| 20 | ~~**Compose**~~ | 60% | daily | 3 | some | **6** | **SHIPPED** | — | Done |
| 6e | ~~**Cron editing**~~ | 80% | monthly | 3 | some | **5** | **SHIPPED** | — | Done |
| 24 | ~~**Security posture**~~ | 60% | monthly | 3 | some | **5** | **SHIPPED** | — | Done |
| 26 | ~~**Capacity trends**~~ | 70% | monthly | 3 | some | **5** | **SHIPPED** | — | Done |
| 27 | ~~**Rule engine**~~ | 40% | continuous | 3 | some | **5** | **SHIPPED** | — | Done |
| 22 | ~~**Kubernetes lifecycle**~~ | 25% | weekly | 4 | weak | **5** | **SHIPPED** | — | Done |
| 7 | ~~**Credential proxy**~~ | 30% | daily | 3 | very strong | **5** | **SHIPPED** | — | Done |
| 25 | ~~**Configuration drift**~~ | 50% | rare | 4 | strong | **4** | **SHIPPED** | — | Done |
| 28 | ~~**Runbooks on alerts**~~ | 40% | per-incident | 3 | some | **4** | **SHIPPED** | — | Done |
| 14 | ~~**Change log**~~ | 30% solo | per-incident | 3 | strong | **4** / **8** team | **SHIPPED** | — | Done |
| 1 | ~~**pm2 supervision**~~ | 25% | daily | 3 | some | **4** | **SHIPPED** | successor shipped: read + write user units | Done |
| 2 | ~~**frp ngrok UX**~~ | 20% | rare | 2 | some | **3** | **SHIPPED** | — | Done |
| 8 | ~~**Ghostty snapshot**~~ | — | — | — | — | — | **CUT** | — | Not building |
| 10 | ~~**Tauri**~~ | — | — | — | — | — | **CUT** | — | Not building |

### The four quadrants, and the trap in the middle

**Do first — high leverage, trivial cost.** The disk alert at half a day and Docker housekeeping at
a week. Both are finishing something already 90% built. Nothing on this page has a better ratio and
nothing should be built before them.

**Enablers — zero direct leverage, and the highest total leverage on the page.** A, B and C would
each rank last in a naive value-over-effort sort, because on the day they ship a user sees nothing.
That sort is exactly how a roadmap stalls: every high-value item stays permanently "blocked", each
one gets built with its own private scheduler and its own private storage instead, and eighteen
months later there are four schedulers and no history. **Score an enabler by what it unlocks, never
by what it shows.** Their unlock numbers — 30, 38 and 21 leverage points across six, seven and four
downstream items — are the whole argument for building them before anything expensive.

Item C is the exception worth naming: it is the one enabler that ships something visible on its own
day, because "every host, its OS, its version, its pending updates" is a screen operators want
regardless of what it later enables. Build it second for that reason, not third.

**Invest — high leverage, real cost, worth it.** Patching, backups, the rest of alerting, Compose.
These are the product. Each is three to four weeks and each is the reason someone chooses this app
over a terminal with tabs.

**Defer — good features, wrong customer or wrong moat.** Kubernetes lifecycle is the clearest case
and the most likely to be argued: it is genuinely valuable, it is four weeks, and it serves a quarter
of the target operators against k9s and Lens, which are free and better at it. It ranks below Compose
for the same reason Compose ranks above it — most estates this size are Compose. The frp UX and pm2
supervision are the same shape with smaller numbers.

### Two numbers that reorder everything

**Time to first value.** The enablers are five and a half weeks during which a user sees one new
screen (item C's inventory). That is a real risk for a small team — no feedback, no release, no
evidence the direction is right. The plan below deliberately front-loads three weeks of visible,
shippable work first, because the two cheapest wins plus database operations cost less than the
plumbing and can be released while it is still being designed.

**Cost of the dependency, not the item.** Item 17 reads as 3.5 weeks and is really 9 with its
enablers. Item 26 reads as 1.5 weeks and is really 3. Every "quick win" further down this table that
sits behind A or B is quoting the direct number. That is why the enablers are not optional and not
last: **after they exist, eight separate items become one-to-three-week features.** Before they
exist, each of those items is a rewrite of the same missing plumbing.

---

### 29. A renderer that can be tested

**Found while fixing something else, which is how this kind of gap is always found.** Two
defects in the itemised disk view shipped without a test — a stale read rendering one host's
containers under another host's name, and an error state with no way out — because there is
no jsdom, no happy-dom and no testing-library in the tree. `vitest` runs in the node
environment. **No component in this application can be rendered in a test.**

**What exists.** 2280 tests, almost all of the main process, and a genuine workaround in the
panel suites: they read `.tsx` files with `readFileSync` and assert regexes against the
source. That catches "somebody added a second call site" and cannot catch "this renders the
wrong thing".

**Why it ranks where it does.** Every renderer defect found across both waves so far was
found by reading code, not by running it. The operator only ever touches the renderer, the
stated goal is a tool stable enough to daily-drive, and the two largest new surfaces on this
plan — the job list and the inventory table — are both renderer work. Retrofitting tests
after those ship is how the gap becomes permanent.

**Size.** A day for jsdom, testing-library and the first real component test. Then it is
per-feature cost like any other test, rather than a project.

### 30. Two gaps in the gates themselves — SHIPPED

**Both closed since this was written, verified 6 Sep.** `tsconfig.tests.json` exists, covers
`tests/**` plus `src/renderer/src/env.d.ts` for the `window.opsmaxx` augmentation, and
`typecheck:tests` is in the `npm run typecheck` chain — so the test tree is type-checked on
every run, which is how the `.env` picker's `VaultState` mistake and the missing
`ComposeEnvWriteResult` import were caught rather than shipped. `npm audit` reports **0
vulnerabilities** and CI runs it with the registry's own flakiness separated from a finding,
so the gate is green before anyone touches it and can therefore report a change that makes
things worse. The write-up below is kept as the reasoning.

Both found while building item 29, both predating it, and both the same species: a check that
exists and does not check.

**`npm audit` already fails, so the gate that runs it is decoration.** CI runs it as a step,
and it exits non-zero today on three transitive advisories that have fixes available. A gate
that is red before anyone touches it cannot report that a change made things worse — the
signal is indistinguishable from the standing noise. Either fix the three, or pin them with a
stated reason and make the gate assert *that* set rather than emptiness. **Half a day.**

**None of the tests are type-checked.** `tests/` belongs to no tsconfig, so `npm run
typecheck` covers `src/` and skips all 2333 test files. They are linted, which catches style
and unused variables, and not type-checked, which is what catches a test asserting against a
shape the code no longer has. A test that no longer compiles against its subject is the one
most likely to be quietly wrong. **A day, plus whatever the first run turns up — and it will
turn something up.**

**Why these rank at all.** The stated goal is a tool stable enough to daily-drive, and both
of these are places where the project believes it has a check and does not. That is worse
than a known absence, because it is budgeted for.

---

### 31. The firewall rules themselves, not a count of them

**Raised by item 24 rather than planned, and it needs a decision rather than an implementation.**

What shipped reads the firewall in both layers — the front end and the kernel beneath it,
because "ufw is inactive" is not "nothing is filtering" on a cloud image with a boot-loaded
nftables ruleset — and reports scalars: which tool, whether it is active, the default policy,
a rule count, a deny count, the zones. Every one of those goes through the single-line
unforgeable path, which is the strongest safety property this collector has.

**But an operator reading "ufw · 12 rules · in deny" cannot tell whether 3306 is open to the
world**, which is the question they came to ask. The next increment is a bounded, per-line
sanitised list of the actual rules.

**Why it was not built, and why that is a product decision.** A list of what is exposed on
every host is the single most attacker-valuable thing this feature could hold, and it changes
the threat model of the collector's output — which currently carries only counts and fixed
vocabulary, and would then carry addresses and ports. That is the same widening the 0.8.0
review caught when a metrics tool began returning a full service and port inventory under a
consent that described something narrower. It should be decided deliberately, with its own
line in the capability grid, not added because it is obviously useful.

**Size.** Days to build, and the decision is the part worth taking time over.

---

### 32. A retention horizon per event kind — SHIPPED

**Shipped since this was written:** `EVENT_RETENTION_TIERS` in `history.ts` keeps the `alert` kind
400 days and `job-` events 365, with 90 as the default, and `RUNBOOK_LOOKBACK_DAYS` mirrors the
alert tier so the runbook join is no longer bounded by the shorter number. The write-up below is
kept as the reasoning.

**Raised by item 28, and it is a defect at a boundary rather than a missing feature.**

Job rows are kept for a year; alert events for ninety days. The runbook joins the two — "what
was run between this alert raising and clearing" — so it is bounded by the shorter of them.
The consequence is precise and wrong: **a host with a quarterly problem reads "this has never
fired here" while the job that fixed it in January is still on disk.** The evidence survives
and the anchor that would find it does not.

The honest fix is a longer horizon for the `alert` event kind specifically, which means
retention stops being one number and becomes a policy keyed on kind. That is a change to the
store's own retention rules, and item 28's author declined to smuggle it in — correctly, since
retention is the one part of that store that must not acquire exceptions casually. It is
cheap and it is somebody's deliberate decision.

**Size.** A day, most of it deciding what the second number should be and proving the pass
still terminates.

---

## The plan — six months, one focused person

Weeks are sequential because the constraint is one person, not one team. Where two items could be
parallelised by a second person, it says so. Each block names **what a user can see when it lands**,
because a block that ships nothing visible for a month is a block that needs justifying.

### Weeks 1–3 · Ship the cheap wins first

| Week | Build | What the user sees |
|---|---|---|
| 1 (½ day) | **19a. Disk alert** | A filling disk finally reaches a phone instead of a screen nobody is looking at |
| 1 | **21a. Docker itemised disk view** | Which images, volumes and containers are holding the space, per item, with honest per-item sizes |
| 2–3 | **18. Database operations — Postgres** | Replication lag, connection counts, table bloat, slow queries, on a connection the app already holds |

**Why this order and not the plumbing.** These cost three weeks between them, depend on nothing, and
are the only items on the page that are near-complete already. Shipping them first buys a release,
user feedback on the direction, and three weeks of thinking time on the job engine's one hard
question — which is worth more than three weeks of earlier plumbing.

### Weeks 4–9 · The plumbing

| Week | Build | What the user sees |
|---|---|---|
| 4–5 | **A. Durable store** | Nothing. This is the block to defend. |
| 6–7 | **C. Host facts** | Every host with its OS, version, pending updates and reboot flag — a screen worth having on its own |
| 8–9½ | **B. Job engine** | Long-running work that survives closing the panel, with a job list and history |

**The rule for these six weeks.** Do not let them stretch. Every one of them has an obvious "while I
am in here" extension, and each extension delays item 17 by its own length. A is three tables and a
retention rule, not a query language. B is detached execution and a status file, not a workflow
engine.

### Weeks 10–13 · The flagship

**17. Patch and update management.** Every host, its pending and security updates, staged apply,
reboot coordination with an ordering, a health gate between stages, and a hard refusal to reboot a
host that is a jump host for anything else in the workspace.

This is the release the whole plan exists for. At the end of it the product does something no GUI
SSH client does, for the task its user does most often.

### Weeks 14–21 · The maintenance product

| Week | Build | Note |
|---|---|---|
| 14–15 | **18. Database operations — MySQL/MariaDB** | Second engine; Mongo and Redis follow later at a week each |
| 16–17 | **20. Compose** | Label grouping exists; this is file discovery, validate, pull and redeploy as jobs |
| 18–21 | **5. Backups to real targets** | Destinations, retention, database dumps as jobs, and a restore test that actually verifies |

### Weeks 22–26 · Proof and the differentiator

| Week | Build | Note |
|---|---|---|
| 22 | **23a. Key inventory, read-only** | Which key opens which host, whose it is. One week, and nobody else has it |
| 23–24 | **19b. Alerting, the rest** | Hysteresis, inbox, the missing kinds. Needs A, which now exists |
| 25–26 | **23b. Key add and revoke** | Behind the three non-negotiable rules in its section |

### What that adds up to

At week 26 the app patches an estate, backs it up and proves the backup restores, answers database
health, manages Compose, alerts properly with history, and can tell you which keys open which hosts.
That is not a better terminal. That is the console this operator does not currently have.

**After week 26, in rough order and no longer scheduled:** 6e cron editing, 24 security posture,
26 capacity trends, 14 change log, 27 rule engine, 28 runbooks, 18 for Mongo and Redis, then 22
Kubernetes lifecycle and 7 the credential proxy — with 7 promoted immediately if API keys turn out
to be a live problem for real users, because it is the most strategically aligned item in this
document and only its reach keeps it low.

---

## How the ranking moves if the customer moves

The ordering above is a consequence of the operator in "Who this is for". These are the reorderings
that follow from plausible alternatives, written so that a change of target is a deliberate decision
rather than a slow drift in the backlog.

| If the customer becomes… | What rises | What falls | Net effect on the plan |
|---|---|---|---|
| **A team of three to five** | 14 change log (4 → 8), 28 runbooks, shared approvals | Little | Change log moves into the first six months. The plumbing does not change. |
| **Anyone under a compliance regime** | 14 (4 → 9), 23 access review, 24 posture | 20, 21 | 14 and 23 move ahead of Compose. A gains an audit-retention requirement on day one. |
| **A containerised estate** | 20 Compose (6 → 8), 22 Kubernetes (5 → 8), 21 | 17 patching (hosts matter less), 23 | Compose and Kubernetes move ahead of backups. Patching stays, aimed at nodes. |
| **Local-first developers** | 1 pm2 supervision (4 → 8), 8 Ghostty session restore | 17, 5, 23 — all fleet features | A different product. The plumbing survives; almost nothing else does. |
| **Enterprise SRE teams** | — | Everything | Do not. They have Ansible, Prometheus and PagerDuty, and every item here competes with a better incumbent. |

**The pattern worth seeing.** A and B survive every column. The three enablers are the only things on
this page that are correct regardless of which customer is chosen, which is a second and independent
argument for building them early: they are the part of the plan that cannot be wrong.

---

## Dependencies, stated plainly

- Everything that **remembers** follows **A**.
- Everything that **runs longer than a minute** follows **B**.
- **Patching** follows **C**, and is the reason C is not optional.
- **Backups** follow the scheduler in **B**, or the app grows two schedulers.
- **Alert channels** follow the **credential proxy** if that is going to own third-party API keys, or
  they grow two credential stores.
- **Modules** precede heavy features, or they become a refactor instead of a shape. Already done.
- The **third-party extension API** never precedes the **Tauri** decision, because an extension API
  is a compatibility promise and rewriting the host underneath one is how migrations die.
