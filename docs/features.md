# Features

Everything OpsMaxx does, what it replaces, and the shapes of work it was built for.

[← Back to the README](../README.md)

---

## Features


| | |
|---|---|
| **SSH terminal** | Full xterm terminal with GPU rendering, search, split panes, copy-on-select and configurable zoom |
| **Local terminal** | Your own zsh, bash, PowerShell, Git Bash, MSYS2 or WSL in a tab beside the SSH ones — discovered per platform, a login shell on macOS, and reachable by no AI agent |
| **Jump hosts / bastions** | Unlimited chained hops per server, each with its own credentials |
| **Two-factor auth** | Answers keyboard-interactive challenges; connections are shared so you enter a code once, not per session |
| **SFTP browser** | Browse, edit, upload, rename and delete files over the same connection |
| **Remote desktop** | RDP to a Windows host in a tab, through a bastion when the host is only reachable from one — with the server certificate pinned on first use |
| **Server monitoring** | Live CPU, memory, disk and network docked under the terminal, with alerts on CPU, memory and failed systemd units |
| **Background checking** | Sample every server on a schedule, so a server that runs hot or a unit that dies at 3am is noticed while you are looking at something else |
| **Webhook alerts** | POST alerts to Slack, Discord, Teams or any HTTPS endpoint — friendly server name and what fired, never a hostname, an IP or a log line |
| **SSH tunnels** | Local forwards, remote forwards and a SOCKS5 proxy |
| **WireGuard** | Userspace WireGuard with **no administrator rights** — the tunnel appears as a local SOCKS5 proxy and forwards, and your routing table is never touched |
| **OpenVPN** | Bundled on macOS and Linux, driven over its management interface, with one-time codes and split tunnelling |
| **frp** | Publish a local port through an frp server, with a per-proxy confirmation naming exactly what becomes reachable |
| **Traffic inspector** | Read the HTTP and HTTPS a machine is actually making — a Burp- or Fiddler-style proxy with one-click certificate install, terminals and SSH sessions routed automatically, and a host that pins its certificate named rather than silently missing |
| **SSH & databases over VPN** | Point a server or a database at a VPN profile and it is brought up, waited for, and torn down with the session |
| **Databases** | PostgreSQL, MySQL, SQL Server, MongoDB and Redis — with an interactive shell per engine |
| **Databases over SSH** | Reach a database that is only routable from a bastion |
| **Vault** | AES-256-GCM encrypted store for URLs, logins, API keys and free-form key/value pairs |
| **Workspaces** | Isolated, optionally password-protected spaces per client or environment |
| **Encrypted backup** | One passphrase-protected file containing everything, portable across machines |
| **Host key verification** | Trust-on-first-use, with a hard stop when a key changes |
| **Rebindable shortcuts** | Every shortcut is remappable per context, with conflict detection and export/import |
| **AI & MCP** | Let Claude Code, Claude Desktop, Codex and other MCP clients operate your servers — scoped by access group, with human approval on sensitive actions |

Fleet operations — <kbd>Ctrl</kbd>+<kbd>M</kbd>, and each one **off until you turn it on**:

| | |
|---|---|
| **Inventory** | Every server, its OS and version, what it has pending, and when it was last seen |
| **Patching** | What is pending per server, applied in waves that stop on the first server that comes back unhealthy rather than rolling on |
| **Run one command everywhere** | Broadcast across selected servers with a confirmation naming exactly what runs where, per-server results, and a job that survives the app being closed |
| **Log tailing** | Follow a file across many servers at once, in one pane |
| **Fleet search** | Search across what has already been collected, without touching a server |
| **Docker** | Containers, images and volumes with honest per-item sizes, and reclaim by id against exactly what the preview showed — never a blind `prune` |
| **Compose** | Read a project's services, their state and their drift from the file on disk |
| **Kubernetes** | Workloads, cordon, drain and exec — drain refuses seven ways and treats a read that did not answer as a refusal in itself |
| **Databases, operated** | Replication lag, slow queries, table sizes and connection counts for PostgreSQL, MySQL/MariaDB, MongoDB and Redis |
| **Backups** | Scheduled dumps to a local path or S3-compatible storage, with restore **verified by restoring**, not by checking a file exists |
| **Security posture** | SSH config, sudo rules, listening ports and firewall state as they actually are on the server |
| **Firewall rules** | The rules themselves rather than a count of them — off by default, behind its own consent, never stored, and unreadable by an agent at any setting |
| **Configuration drift** | What changed on a server since the last time you looked |
| **Capacity trends** | Where disk and memory are heading, from history already collected |
| **Rules** | "When this fires, run that" — with the run needing the same approval it would need by hand |
| **Cron** | Read and edit crontabs, planned against the server and written through approval |
| **Runbooks** | On an alert, what was run the last three times it fired on that server |
| **Change log** | Who approved what, when, and what it did |
| **Access & keys** | Which key opens which server, and whose it is |
| **Supervised processes** | Keep local processes running, with nothing auto-starting: what survives a restart is the list, not a running command |

## Real-world use cases


- **Production troubleshooting** — ask an agent to check a service's status, tail a log, or sample
  CPU/memory on a server named in plain English, without ever handing it that server's key.
- **Bastion / jump-server operations** — the same friendly-name resolution works through chained
  hops; an agent scoped to a workspace behind a bastion never needs the bastion's credential
  either.
- **Database investigation** — an agent with `databaseAccess` allowed can query a database that is
  only reachable through an SSH tunnel, the same way a human session would reach it.
- **Log investigation** — a `Read Only` or purpose-built "Logs Only" access group lets an agent
  search and summarise logs across a fleet without any path to modify anything.
- **Controlled production changes** — set the capability that matters to ASK; a config edit or a
  restart waits for your explicit approval instead of running unattended.
- **AI-assisted DevOps generally** — the same terminal, SFTP, database and monitoring tools you use
  by hand are available to an agent, scoped by workspace and access group exactly like a second,
  more limited pair of hands.

## OpsMaxx vs MobaXterm, PuTTY, Termius and SecureCRT


If you are looking for a **free MobaXterm alternative**, a **modern PuTTY replacement**, or an
**open-source Termius alternative** that does not put your saved servers behind a subscription,
this is the short version:

| | **OpsMaxx** | MobaXterm | PuTTY | Termius | SecureCRT |
|---|---|---|---|---|---|
| Price | **Free, MIT** | Free tier, paid Pro | Free | Free tier, paid Pro | Paid licence |
| Open source | **Yes** | No | Yes | No | No |
| Windows / macOS / Linux | **All three** | Windows only | All three | All three | All three |
| Account required | **No** | No | No | Yes for sync | No |
| Telemetry | **None** | Some | None | Yes | Some |
| Saved sessions limit | **Unlimited** | 12 on free tier | Unlimited | Limited on free tier | Unlimited |
| Chained jump hosts | **Unlimited** | Yes | Manual | Yes | Yes |
| SFTP browser | **Built in** | Built in | Separate app | Built in | Built in |
| SSH tunnels + SOCKS5 | **Yes** | Yes | Yes | Yes | Yes |
| Database client | **PostgreSQL, MySQL, SQL Server, MongoDB, Redis** | No | No | No | No |
| Encrypted secrets vault | **Yes, AES-256-GCM** | Password store | No | Cloud vault | No |
| Live server monitoring | **Yes** | Basic | No | No | No |
| Rebindable shortcuts | **Every one** | Partial | Partial | Partial | Yes |
| AI agent integration (MCP) | **Yes, access-group scoped** | No | No | No | No |

The point of difference is the **database client and the vault**. Every other tool in that table
sends you to a second application the moment you need to query a table or look up an API key.

---

[← Back to the README](../README.md)
