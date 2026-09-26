# AI & MCP — threat model and security boundaries

This document describes what OpsMaxx's MCP bridge is designed to protect against, exactly
where the trust boundary sits, and — just as importantly — what it does **not** claim. For how
the bridge is built and how to use it, see [AI-MCP.md](AI-MCP.md). For OpsMaxx's general
security posture and how to report a vulnerability, see [SECURITY.md](../SECURITY.md).

## The trust boundary

```
AI Agent  --(MCP: stdio or HTTP + Bearer token)-->  OpsMaxx main process
```

Everything to the right of that arrow — policy evaluation, approval, credential lookup, the SSH/
SFTP/database connection itself — runs inside OpsMaxx's own main process, on your machine. The
AI agent is a client on the *left* of that boundary: it sends a tool call and a friendly server
name, and receives back either an error, a text result, or a redacted command output. Nothing
else ever crosses back.

The bridge's HTTP listener binds to `127.0.0.1` only (`startMcpServer`, `mcpServer.ts`). There is
no configuration option that exposes it to a network interface — the boundary is not "trust
whoever can reach this port," it's "nothing beyond this machine can reach this port at all."

**The local terminal is on the human side of that boundary, permanently.** OpsMaxx can open a
shell on the machine it is itself running on — your own zsh, PowerShell, WSL, with your own
privileges — and no part of that surface is reachable from the left of the arrow. It is not a tool,
not a capability and not an ASK prompt, because an agent that can run local commands can read the
vault file, the policy store and the audit log that are supposed to constrain it: every constraint
described in this document is a file on the same disk as that shell. See
["No local terminal" is a narrower claim than "no local process"](#no-local-terminal-is-a-narrower-claim-than-no-local-process)
below for what that does and does not rule out, and the *Local terminal* section of
[SECURITY.md](../SECURITY.md) for what such a shell reaches.

## What an AI agent never receives

Regardless of a session's profile or access group:

- **SSH passwords, private keys or passphrases.** Resolved server-side by
  `credentialResolver.ts` at the moment a connection is opened; no MCP tool response ever
  contains one.
- **Database passwords or connection-string credentials.** Same resolver, same rule — and any
  password embedded in a connection-string URL that shows up in command output is redacted before
  the agent sees it (`secretRedaction.ts`).
- **Vault secrets.** There is no MCP tool that reads the Vault. This isn't a policy that could be
  misconfigured to `allow` — the code path doesn't exist.
- **Sudo / root credentials.** OpsMaxx does not separately store a "sudo password" for any
  server — sudo capability is a policy decision about whether a command that runs as another user
  is allowed to run over the SSH connection that's already authenticated, not a credential handed
  to anything. Unrestricted root shells (`sudo -i`, `sudo su`, `sudo bash`, `pkexec bash`,
  `su -c bash`, bare `su`, `pkexec` or `run0`) are refused whatever the access group says, on
  every profile except Bypass — see [Permission profiles and Bypass](#permission-profiles-and-bypass).

  **How a command is recognised as running as another user** (`classifyCommand`, built on
  `walkCommand`, `policyEngine.ts`). It is the command WORD that counts, in every segment of the
  line, not the first word of the string:

  - the line is split on `;`, `&&`, `||`, `|`, `&` and newlines;
  - shell grammar in front of a command is stepped over: `if`, `then`, `do`, `else`, `elif`,
    `while`, `until`, `!`, `{`, `(`, a `case … in` header and an arm's `pattern)`, a function
    definition (`name()`, `name(){`, `function name`), `coproc [NAME]`, and leading `VAR=value`
    assignments. `[[ … ]]`, `(( … ))` and `for`/`select` headers run nothing themselves;
  - so are the wrappers `env`, `command`, `exec`, `builtin`, `nohup`, `time`, `nice`, `ionice`,
    `stdbuf`, `timeout`, `xargs`, `busybox`, `setsid`, `unbuffer`, `watch`, `flock`, `chrt`,
    `taskset`, `chroot`, `setarch`, `strace`, `ltrace`, `firejail`, `bwrap`, `prlimit` and `.`,
    with their options and, for `timeout`, `flock`, `chrt`, `taskset`, `chroot` and `setarch`,
    their one operand. `setpriv` and `unshare` are stepped over too, unless they change privilege
    (below); `capsh … -- ARGS` is read as `bash ARGS`;
  - words are read with POSIX quoting: outside quotes a backslash escapes the next character
    (`\sudo`, `su\do`); inside double quotes only `\"`, `\\`, `\$`, a backtick and a newline
    are escapes; inside single quotes nothing is, so `sh -c "sh -c \"sh -c 'sudo reboot'\""` and
    shlex.quote's `'\''` come apart exactly where the shell takes them apart. A word that starts
    like a Windows path (`C:\`, `\\server`) keeps its backslashes, which are separators there. The
    command word is then reduced to its basename;
  - the insides of `$(...)`, `<(...)`, `>(...)`, backticks, a shell's command string (`-c`
    anywhere in an option cluster: `bash -lc`, `sh -ec`, `zsh -ic`, `bash -lic`, with the string
    as the first operand after the options), `script -c` (`-qc` included), `su -c`, `sg`, `env -S`,
    `flock -c`, every `find -exec`/`-execdir`/`-ok`/`-okdir` group (each target walked as the argv
    find passes, not a re-joined line, and the tail an unescaped `;` splits off -- whether it starts
    with an action, a predicate or an operator -- walked too), a `parallel` template (or, with none, each of its
    arguments), `watch`, `eval`, and on Windows `cmd /c`, `/r` or
    `/k` (glued on or not, `cmd.exe/c` included), PowerShell's `-Command` (or `-c`, or the implicit
    command a bare `powershell Start-Process …` takes), `iex`/`Invoke-Expression`, the scriptblock
    `Invoke-Command`/`icm`/`Start-Job` runs, and `Start-Process`'s `-ArgumentList`, are walked the
    same way, to a depth of three. Substitutions are found by a scanner that respects quotes and
    escapes and matches parens -- including a `case` arm's `pattern)` -- so `$(case a in a) sudo
    reboot;; esac)` is read whole. Nothing is expanded inside single quotes, as in the shell. A
    backquoted body has its `` \` ``, `\$` and `\\` escapes taken off before it is walked (and `\"`
    inside double quotes), which is how backquotes nest. cmd's `^` escape is removed before the
    command is read; a PowerShell `. cmd` runs `cmd`, so the word after `.` is judged.

  If the command word is `sudo`, `doas`, `su`, `pkexec`, `run0`, `runuser`, `systemd-run`,
  `sudoedit`, `machinectl shell` or `nsenter` (it enters another process's namespaces, commonly pid
  1's); `setpriv` given `--reuid`, `--regid`, `--init-groups`, `--clear-groups`, `--keep-groups` or
  `--groups`; or `capsh` given `--user`, `--uid`, `--gid` or `--` (a bare `--` is a shell) — or,
  on Windows, `runas` (with its `/user:` and `/savecred`
  options), `gsudo`, `sudo.exe` or `Start-Process … -Verb RunAs` — the command is governed by the
  **Sudo** capability, and what it runs is judged too — `sudo env bash` and `gsudo cmd` are
  elevated shells. `unshare -r` / `--map-root-user` is root only inside a new user namespace and
  is everyday rootless tooling, so — while the group's Confirm risky actions switch is on — it
  asks, with that as the reason, rather than counting as sudo, and a remembered approval never
  covers it. A privileged tool asked
  only `--help` or `--version` is describing itself and is not an escalation. So
  `/usr/bin/sudo reboot`, `env sudo reboot`, `if true; then sudo reboot; fi`,
  `\sudo reboot`, `eval sudo reboot` and `su -c "rm -rf /x"` are all sudo, and a group that denies
  sudo denies them. A name in argument position is not a run: `grep sudo /var/log/auth.log`, `echo
  sudo`, `man sudo`, `command -v sudo` and `systemctl status sudo` are ordinary commands.

  **The rule that ends the list: fail toward ask.** If, after everything above has been stepped
  over, a segment's command word still holds shell syntax the walk does not read — an expansion
  (`$(which sudo)`, `${SUDO:-sudo}`, a backtick, cmd's `%VAR%` or `!VAR!`), a brace list
  (`{sudo,reboot}`), a glob (`/usr/bin/ec?o`), a paren, a redirection, or a leading `=` — the
  command cannot be named, so a group that would allow it is asked instead, and `execute_command`
  never lets a remembered approval cover it. The same holds for anything nested deeper than the
  three levels the walk reads (`eval eval eval eval sudo reboot`); for a line whose quotes or
  substitutions do not close or that ends on a bare backslash; for a POSIX shell given no command
  string whose input comes from somewhere else — a pipe (`echo "sudo reboot" | sh`, `curl … |
  bash`), a here-string or here-doc, an input redirection, `-s`, or a process substitution or
  `/dev/stdin` in place of its script — because what it runs is not on the line; for a base64 PowerShell
  `-EncodedCommand` (`-enc`, `-e`); for `Invoke-Command` given its scriptblock any way but
  literally; and for any cmd string containing `^`, `%` or `!`, or run with `/v:on`. cmd is not
  parsed — its `%` and `!` expansions happen after any `&` inside the string, where nothing here can
  follow them — so it fails toward ask instead. That includes the harmless: `cmd /c echo 50%` asks.
  Such a command is asked about, never allowed and never refused on a guess. Only a leading home
  directory is let through: `$HOME/bin/tool`, `${HOME}/bin/tool` and `~/bin/tool` are judged by
  their literal basename, so `~/bin/sudo` is still sudo.

  **Switching Confirm risky actions off does not waive this while sudo is not granted.** A command
  word the walk cannot name may *be* sudo, so it asks whenever the group has not set `sudo` to
  ALLOW, whatever the switch says. On Full Access as shipped — `terminal` ALLOW, `sudo` ASK, switch
  off — `$(which sudo) reboot` therefore asks, as `sudo reboot` does. Only a group that allows sudo
  outright *and* has the switch off runs such a command without asking.

  The quoting is tested with a generated matrix rather than hand-picked cases
  (`tests/escalationQuotingMatrix.test.ts`): every nest of `eval '…'`, `sh -c '…'`, `sh -c "…"`,
  `env -S "…"`, `$(…)`, a `$(case … esac)` with parens of its own, `cat <(…)`, a backquote,
  `bash -lc`, `sh -ec`, `zsh -ic`, `bash -lic`, `script -qc` and `find -exec true \; -exec sh -c`
  (a harmless first group before the payload) — 41,370 nests up to four deep. CI runs depths one to
  three in full and a fixed slice of depth four (every 29th nest, in generation order, so a failure
  reproduces); `OPSMAXX_FULL_MATRIX=1 npx vitest run tests/escalationQuotingMatrix.test.ts` runs all
  of depth four, and a change to the command walk should be checked that way. The nests are
  each quoted the way a careful tool quotes. Around `sudo reboot` under a group that denies sudo,
  and around `cat /etc/shadow` under a path rule that denies it, every nest to depth three must be
  denied and none at depth four allowed; the same nests around `ls /tmp` must never be denied.

  The path rules read the same walk (`extractPathAccesses`), so `bash -c 'cat /etc/shadow'`,
  `timeout 5 cat /etc/shadow` and `echo $(cat /root/.ssh/id_rsa)` meet the `/etc/shadow` and
  `/root/.ssh/**` rules exactly as `cat /etc/shadow` does.

  **What remains best-effort.** A command string can still hide what it runs, and this does not
  claim otherwise. The command word is guarded by the rule above; its ARGUMENTS are not, so these
  still pass as whatever their literal command word says: a variable in an argument
  (`f=/etc/shadow; cat $f`), a relative path after `cd`, a glob in a path, an interpreter's own
  code (`perl -e`, `python3 -c`, `node -e`, `expect -c`), a script file — `bash script.sh`, or one
  read with `.` or `source`, each judged by the script's own name and not by what it contains — a
  PowerShell `ForEach-Object`/`Where-Object` block, a command handed to a long-lived tool that runs
  it later or elsewhere (`tmux`, `screen`, `at`, `crontab`, `docker exec`, `kubectl exec`, `ssh
  localhost '…'`), wrappers not named above, and programs that are not recognised file
  commands. It closes the forms a model
  actually emits, and it only ever tightens — the older start-of-string tests are still applied as
  well. OpsMaxx's own `sudo -n` privileged reads do not pass through it; only the MCP bridge's
  `execute_command` does.
- **A server's real hostname, IP, port or username.** Every tool that names a server takes and
  returns a friendly name (e.g. "Production API"); `get_server_details` returns OS, session profile,
  access group and effective permissions, never connection details.
- **A shell on your own machine.** OpsMaxx's local terminal — the tab that runs your zsh, bash,
  PowerShell or WSL with your own privileges — has no MCP tool, no capability and no ASK prompt,
  and that is deliberate rather than a gap waiting to be filled. There is no setting of either that
  would make it safe: an agent that can run local commands can read the vault file, the policy store
  and the audit log that are supposed to constrain it. So the answer is not "gated", it is "not
  reachable", and `tests/localTerminalNotExposed.test.ts` fails the build if that stops being true —
  it walks the transitive import closure of `mcpServer.ts` and `src/cli/`, so the module cannot even
  be *imported* by anything an agent talks to, let alone called.
- **Third-party API keys, and the proxy that uses them.** The API credential proxy
  (`credProxy.ts`) lets a script call a third-party API without holding its key: the credential is
  resolved through the same `credentialResolver.ts` and injected at the boundary. An agent gets
  neither half of it. It cannot *define a rule*, because a rule is a durable statement of where one
  of your credentials may go — a row in a JSON file that outlives the session that wrote it, with
  nothing pending for `denyAllPending()` to revoke, which is the same objection this document's
  companion makes about the job engine, one turn further. And it cannot *call the proxy*, because
  a caller that does not hold the key is still spending your API budget on somebody else's meter,
  under a credential no audit here can attribute to it. There is no tool, no capability and no ASK
  prompt; `tests/jobsNotExposed.test.ts` walks the same import closure the local terminal relies on
  and fails the build if the module becomes reachable.
- **A VPN's endpoint, keys or listener addresses.** `list_vpns` reports which profiles exist,
  which engine carries each one and whether it is up. The cached record it reads from
  (`CachedVpn`, `mcpDataCache.ts`) does not hold an endpoint, a key ref or a bind address at all,
  so this is a shape that cannot leak one rather than a field somebody remembered not to print.

## "No local terminal" is a narrower claim than "no local process"

Worth drawing out, because the broad version of the claim is false and stating the narrow one is
the only way to keep the guard honest.

OpsMaxx does run programs on this machine while serving an agent. Modules inside the very
import closure that `tests/localTerminalNotExposed.test.ts` walks spawn child processes:
`vpn/supervisor.ts`, `vpn/binaries.ts`, `vpn/drivers/wireguard.ts`, `vpn/netstate.ts`, the three
`vpn/elevation/*.ts`, `vpn/driver.ts`, two modules under `src/cli/`, and — since cloud servers —
`cloud/cloudExec.ts` and the three provider brokers beside it. Bringing up a WireGuard tunnel, or
reaching a GCE instance behind IAP, means executing a binary locally; there is no version of
either feature that does not.

Those are fine, and the reasons they are fine are exactly the properties a shell lacks:

- **The argv is OpsMaxx's, not the agent's.** For the VPN engines an agent supplies a profile
  name and nothing else — never a command, an argument or a path. `vpn/binaries.ts` runs either
  an engine OpsMaxx ships, checked against a manifest of its exact bytes before the first exec,
  or a system-installed one from a fixed allowlist of directories — never a `PATH` search,
  because on Windows the search *is* the vulnerability.

  Cloud servers are the one place an agent's input reaches an argv at all, and they are covered
  separately below.
- **They are behind `vpnControl`, and usually an approval.** On the Auto and Ask first profiles
  starting a VPN asks, and Read only refuses it. On Custom, Read & Write and Sudo Access set it to
  ASK, and on any group whose Confirm risky actions switch is on, starting a VPN asks even at ALLOW.
  Full Access sets it to ALLOW with the switch off, so a Custom session on it can start one unasked
  — see the section below.
- **The two `src/cli` spawns are not agent-driven at all.** They are what `opsmaxx claude`,
  `opsmaxx codex` and `opsmaxx run -- …` do when a human types them in their own terminal:
  launch that agent's CLI as a child of the CLI process, before any MCP session exists. No tool call
  reaches them.

An interactive shell has none of that. Its entire purpose is that the argv is whatever gets typed.
So the claim this document makes — and the one the test enforces — is that **no agent-facing surface
reaches an interactive shell on this machine**, not that no local process ever runs at an agent's
request.

### Cloud servers: where an agent's input does reach an argv

Reaching a Google Cloud, AWS or Azure machine means running the `gcloud`, `aws` or `az` on this
computer, and an agent can address a cloud server — and create or change one — exactly as it can
any other. So the first bullet above does not hold here in its strongest form: an agent supplies a
project id, a zone, an instance name, and those become elements of an argument array.

That was a deliberate decision rather than an oversight, and it is bounded by properties that are
checked in code, not by convention:

- **No command, ever.** Nothing on this path accepts a command string. Every argument is an
  element of an array assembled by a builder in `src/shared/cloudCommands.ts`, and no shell is
  involved at any point — `shell: true` does not appear under `src/main/services/cloud/`, and a
  test fails if it ever does.
- **No flags, either.** Argument arrays stop shell injection but not *flag* injection: a value
  beginning with `-` is read by the CLI as an option, and `gcloud --flags-file=FILE` reads an
  arbitrary local file. Every identifier is matched against an anchored pattern that cannot begin
  with `-` or contain a control character, checked in the connection form, again on an agent
  write, again when the record is read back from disk, and again inside the builder. A value that
  fails is refused before any process starts.
- **No SSH arguments at all.** OpsMaxx never invokes OpenSSH for a cloud server — it brokers a
  credential and a tunnel and then connects with its own SSH engine — so there is no
  `-o ProxyCommand=` to smuggle a local command into. The field that would carry one does not
  exist anywhere in the product.
- **The binary is resolved, not searched for loosely.** Fixed per-platform install locations
  first, then `PATH` on POSIX only, for the reason stated above. A candidate under a
  world-writable directory is refused outright: anyone who can write the directory can replace
  what is in it. The path and version actually used are recorded.

There is no separate capability for this. A cloud server is reached under the same
`viewServer`/`terminal`/`readFiles` grants as any other, and creating or changing one needs
`manageServers`. Adding asks when `manageServers` is ASK; changing asks even at ALLOW on Auto, and on
a Custom group while its Confirm risky actions switch is on. On Auto, adding does not ask; on a
Custom session on Full Access as shipped, neither does. If that trade is not one you want, assign
the workspace a restriction that denies `manageServers`, or keep cloud servers in a workspace your
agent sessions do not cover.

What OpsMaxx still will not do is let an agent choose the *program*. It picks which of three
known tools runs, with which known subcommand, and the agent fills in names that must look like
names.

## Threat model

| Risk | What closes it | Where |
|---|---|---|
| Credential exposure to a model's context (and whatever a provider retains of it) | Credentials are resolved inside the main process at connect time and never placed in a tool response | `credentialResolver.ts` |
| Network/topology exposure — leaking internal IPs, hostnames, usernames just by listing servers | Tool responses carry only names, OS and permissions | `mcpServer.ts` (`list_servers`, `get_server_details`) |
| Prompt-injection or a confused agent running something destructive | Any capability set to ASK — and, on the Auto profile or a Custom group with Confirm risky actions on, any destructive command, database write, tunnel, server change, VPN start or CI run even at ALLOW — blocks until a human approves; the agent has no path to approve its own request. The Read only and Ask first profiles refuse or ask for every change. A session on Bypass, or on a Custom group with the switch off, has none of this — that is what those settings are for | `approvals.ts`, `mcpServer.ts`, `policyEngine.ts` (`applyMode`) |
| An agent raising its own permissions — asking for Bypass, un-protecting a target, widening its group | The profile, Protected targets and access groups are written only over IPC from the OpsMaxx window. No MCP tool references `setSessionMode` or the Protected setter | `mcpAuth.ts` (`setSessionMode`), `policyStore.ts` (`setProtected`), `main/index.ts` |
| Sudo / privilege escalation, including via disguised unrestricted shells | Unrestricted root shells are denied whatever the access group says, on every profile but Bypass; every other command that runs as another user — recognised as the command word of any segment, behind wrappers and inside `sh -c` and `$(...)` — is governed by the Sudo capability (see *How a command is recognised as running as another user* above) | `policyEngine.ts` (`classifyCommand`, `evaluateCommand`) |
| An agent silently changing which network the user's traffic crosses | On the Auto profile, and on a Custom group while its Confirm risky actions switch is on, starting a VPN asks even at ALLOW, and so does stopping one live sessions depend on. Full Access ships with the switch off | `policyEngine.ts` (`evaluateVpnControl`) |
| An agent publishing a local port to the internet through a reverse proxy | `set_vpn` refuses `frp` profiles before the access group is consulted, in either direction; no capability value reaches past it, only a session the user has put on the Bypass profile, on a workspace that is not Protected, and there is no tool that can create one | `policyEngine.ts` (`isVpnKindRefusedForAi`), `mcpServer.ts` (`set_vpn`) |
| Secrets leaking through command output (`env`, a misconfigured app, a `cat` of a file with a key in it) | Known credential values blanked verbatim; pattern rules catch `PASSWORD=`/`TOKEN=`-style assignments, PEM key blocks, bearer tokens, AWS access key IDs, connection-string passwords | `secretRedaction.ts` |
| A leaked or stolen token granting standing access | Only a SHA-256 hash + 4-character preview is ever stored; every session has its own expiry and is individually revocable, or all revocable at once | `mcpAuth.ts` |
| Lateral movement — a session reaching a workspace it wasn't granted | A server outside the session's granted workspace(s) is never in the candidate list a tool call resolves against — invisible, not merely denied. Workspaces are chosen explicitly per session, never "all, including future ones" | `mcpDataCache.ts`, `serverResolver.ts` |
| No record of what an agent actually did | Every decision the bridge makes — allowed, asked, approved, denied, failed — is written to an append-only, redacted audit log, with the session's profile on every row and anything Bypass let through recorded as `bypassed`. It records the *bridge*, not the whole application — see the note under this table | `auditLog.ts` |
| A compromised local process trying to complete CLI pairing on its own | The pairing code is shown only inside the OpsMaxx window, never returned over HTTP to whatever process asked for it | `cliPairing.ts` |

**What the audit log does and does not cover.** `recordAudit` is called from `mcpServer.ts` and
nowhere else, so `opsmaxx-ai-audit.jsonl` is a record of **the MCP bridge**, not of everything
that happens in OpsMaxx. Nothing an agent does is missing from it, so the row above holds for the
threat it names — but do not read the broader claim out of that row.

The local terminal is logged **separately**, to `opsmaxx-local-sessions.jsonl`
(`localSessionLog.ts`, append-only, `0600`, same discipline). One entry when a shell starts and one
when it exits: shell label, resolved path, pid, working directory, exit status. **Never keystrokes,
never output** — a shell session's contents are yours, and a log of them would be a more attractive
target than the thing it was meant to protect. There is a test asserting no field capable of holding
terminal input or output has been added.

Jobs and broadcasts are logged **separately again**, to `opsmaxx-job-approvals.jsonl`
(`approvalLog.ts`, append-only, `0600`, same discipline — a separate module as well as a separate file, because `auditLog.ts` is inside the agent-reachable import closure and `tests/jobsNotExposed.test.ts` refuses to let anything in it import the job vocabulary). One entry per approval
decision — granted, refused, resumed, or sealed — carrying the risk, the confirmation kind, the
phrase the user typed where one was required, the server names and the step commands, all redacted
through the same `redactOutput` rules. **Never output**: a job's output is in the history store
under its own retention, not here.

Three files rather than one is deliberate, and it is the same argument twice. The AI audit log
answers *"what did an agent do"*; its entries are agent-shaped (`agentName`, `capability`,
`approval`) and it is displayed in the AI section. Local terminal rows there would mean an
AI-labelled log full of things no AI did, which is how a log stops being trusted. A job is
human-only by construction — it is not reachable from the bridge and will not be, because
durability defeats revocation: `denyAllPending()` resolves requests that are *pending*, and a job
already detached on fifteen servers has nothing pending to deny. So its rows would be AI-labelled rows
no AI produced, for exactly the local terminal's reason.

**One reader now spans all three, and it does not merge them.** The change log
(`changelog.ts`) reads all three files to answer *"who changed what on this estate, and who
approved it"* — a question none of them answers alone. It reads them; it does not combine them into
a fourth file, and each row keeps the source it came from, so the argument above still holds: an
entry from the local terminal is still labelled as the local terminal, not as an agent. The
separation is in what each file *means*, and that survives being read together. The change log is
also read-only over them — nothing it does writes back, and it is not reachable from the bridge.

**All three are now pruned, on the same six-hourly pass that ages out the history store.** They had
no horizon at all and grew for as long as the app was used; "slow" is not "bounded". A line is kept
for a year — deliberately generous, because these answer *"who did what, and who approved it"*, a
question asked long after the fact — with a second bound of 50,000 lines so a retry loop cannot
outrun the age limit from inside the window.

Two rules make the prune safe to leave running unattended. **A line whose timestamp cannot be read
is kept**, never dropped: deleting a record precisely because it could not be understood is the
worst available reason to destroy one, and a half-written line from a crash is still evidence. And
**the newest hundred lines survive regardless of age**, so a vault used once and left alone for two
years can still say what happened that once.

The append-only property survives it. These files are documented as never rewritten in place so a
crash costs at most the last line; a prune that truncated and rewrote would give that up during the
one operation that touches every line. Survivors are written to a sibling and `rename`d over the
original, which is atomic within a filesystem — at every instant a reader sees the whole old file or
the whole new one. The mode stays `0600` across the rewrite, and the common case, nothing due,
does not touch the file at all.

<a id="permission-modes-and-bypass"></a>

## Permission profiles and Bypass

Every session has one **profile**, applied after its group has answered (`applyMode`,
`policyEngine.ts`): **Read only**, **Ask first**, **Auto**, **Bypass permissions** or **Custom**.
The first four stand on fixed baselines that no one can edit (`profileGroup`, `policyStore.ts`);
Custom is an access group, exactly as written. Every baseline carries the seeded sensitive-path
denies, so no profile short of Bypass reads `/etc/shadow`, SSH keys or shell history unless a Custom
group says it may. Read only refuses every change, Ask first asks for every change, and Auto asks
for sudo and the risky actions. [AI-MCP.md](AI-MCP.md#permission-profiles) has each baseline.

Bypass is the exception, and it is deliberately total: **nothing asks and nothing is refused.** It
stands on Auto's baseline and lifts everything Auto would have asked about, and it also lifts the
refusals this document otherwise describes as holding whatever the access group says —
unrestricted root shells, the seeded path rules on `/etc/shadow` and SSH keys, frp reverse proxies,
a restriction group assigned to a production server — so an agent on Bypass runs `rm -rf`,
`DROP TABLE` and a production pipeline without a prompt.

It exists because the earlier model had exceptions nobody could see: a session set to Full
Access still asked, and still refused, for reasons no screen showed ("even after giving full access
it keeps asking for permission"). The fix was to make every one of those exceptions something a
person can see — a profile that means its one sentence, Confirm risky actions on a Custom group,
Protected on the target — and to offer one profile that says plainly "this runs everything", chosen
on purpose, rather than a permission screen that does not mean what it says.

What bounds it:

- **Only the human sets it.** The profile is written over IPC from the OpsMaxx window
  (`setSessionMode`, `mcpAuth.ts`) and nowhere else; no MCP tool can change a session's profile,
  mark or unmark a Protected target, or edit an access group. Choosing Bypass in the app takes a
  confirmation, and an OAuth consent card cannot grant it at all (`approveConsent`, `mcpOAuth.ts`).
  `get_server_details` and `describe_capabilities` tell the agent its profile and that it cannot
  change it, and the server instructions tell it not to suggest Bypass as a way past a refusal.
  What this does not stop is an agent *asking the user in chat* to switch — the control is that
  the user has to go to the app and do it.
- **Scope still holds.** A target assigned **No AI Access**, a Custom session with no access group,
  and a workspace the session was not granted stay out of reach on every profile. Bypass lifts
  permissions, not scope.
- **Protected caps it.** A workspace or server marked Protected holds every session acting on it at
  Ask first — Auto, Custom and Bypass alike. So to hold a production box even against a Bypass
  session, mark it Protected, or assign it No AI Access to take it out of reach entirely. Assigning
  it a narrower access group does not: that assignment is a permission restriction, and Bypass
  lifts its Deny and Ask like any other permission.
- **Revocation still works.** Stop all AI access, Revoke and expiry end the session whatever its
  profile.
- **It is audited as itself.** Every audit row carries the session's profile, and a call that ran
  only because of Bypass is recorded as `bypassed` rather than `not-required`, so the log alone
  distinguishes what the baseline or group allowed from what Bypass let through.
- **It cannot reach what is not there.** The bridge still has no local shell, no vault read, no job
  runner, no backup run or restore, no tool that reads firewall rules or sudoers, and no tool that
  authors a VPN profile or CI connection. Bypass changes answers; it adds no tools.

## Granting `vpnControl` is a bigger decision than it looks

Read this before setting `vpnControl` to anything other than `deny`.

Every other capability in the model is scoped to one server, one file or one statement.
`vpnControl` is not. **A VPN decides which network the user's later SSH and database sessions
travel over** — including sessions the agent never touches and connections the user opens by hand
afterwards. An agent that can start a VPN is an agent that can change the meaning of "connect to
Production API" without going anywhere near that server's configuration.

Combined with `manageServers`, the two compose into something neither grants alone: an agent could
add a server *and* bring up a VPN that server's traffic is routed through, and both actions would
look ordinary in isolation. `manageServers` now also edits and removes connections, which widens
that composition rather than narrowing it — hence the two rules on it: while the group's Confirm
risky actions switch is on, changing and removing ask even at ALLOW, and an approval is scoped to
the one tool on the one server that was approved, so neither half of the composition can be
assembled silently. **Approve once** covers the one change; the separate
**Allow update_server on *server* for this session** answer also covers further changes to that same
connection for the rest of that session. Neither covers a removal, another connection, or the next
session. That composition is the reason for the three rules below:

- **Starting a VPN asks, even at ALLOW, while the group's Confirm risky actions switch is on**
  (`evaluateVpnControl`, `policyEngine.ts`), and a start that asks is per-call in `gate()`, so
  answering one start "for this session" does not cover the next. This used to hold on every group
  with no exception, and that is the one thing that changed: a VPN now comes up at an agent's
  request without a prompt in exactly two configurations, and both are visible where they are set —
  a Custom session on a group with Confirm risky actions switched off (Full Access ships that way),
  and a session the user has put on Bypass. A Protected workspace holds both at Ask first.
- **Reverse proxies (frp) are refused to every access group**, in both directions, before the
  group is read (`isVpnKindRefusedForAi`). An frp proxy makes a port on the user's own machine
  reachable from the frp server — from the internet — and an approval dialog is not a meaningful
  control there, because "Start VPN office" reads nothing like "publish port 5432 to the internet"
  to the person clicking it. If an frp profile is to run, the user starts it in OpsMaxx
  themselves — or puts the session on Bypass, which is the same decision made for every action at
  once, on a workspace that is not Protected.
- **There is no tool that creates or edits a VPN profile.** No `add_vpn`, no `edit_vpn`, and this
  is asserted by a test rather than left to reviewer memory. An agent can run a profile the user
  wrote; it can never author where one points.

### Tunnels are authorable and VPN profiles are not

`create_tunnel` and `delete_tunnel` exist; `add_vpn` and `edit_vpn` still do not, and the
difference is the point rather than an inconsistency that has not been tidied up yet.

A VPN profile decides which network **everything downstream of it** travels over — sessions the
agent never touches, and connections the user opens by hand afterwards. Its blast radius is not
bounded by anything the approval dialog can name. A tunnel binds **one named port**, is listed in
the Tunnels view under a name the user can read, and does not carry traffic until somebody starts
it: `create_tunnel` writes the record and `set_tunnel` takes its own, separate approval to run it.
So defining one is a bounded act that a person can be shown and can undo, and starting one already
had a control.

Three things did not change:

- **Reverse proxies (frp) are still refused to every access group**, in both directions, before
  the group is read (`isVpnKindRefusedForAi`); only Bypass reaches past it.
- **Defining a tunnel asks even at ALLOW while Confirm risky actions is on** (`evaluateTunnelDefine`),
  and one approval defines one tunnel.
- **A `remote` forward listens on the server.** A non-loopback listen address there publishes the
  port to that server's whole network, which is the one fact a person clicking "define a tunnel"
  would never infer. It is graded higher and the prompt says it in those words.

The reason this is worth writing down rather than simply shipping: the alternative to a jump host
or a tunnel, for an agent asked to reach an internal estate, is a relay process on the bastion
forwarding straight into the internal subnet — which bypasses the jump authentication the bastion
exists to enforce, leaves no record in OpsMaxx, and is subject to no approval at all. Prefer
`jumpHosts` on the server itself to either; the server instructions say so.

**Read Only** and **Commands, no writes** deny `vpnControl`; **Read & Write** and **Sudo Access**
set it to ASK; **Full Access** sets it to ALLOW with Confirm risky actions off, so a Custom session
on Full Access starts a VPN without asking. The predefined profiles allow it too, but Auto asks for
every start, Ask first asks, and Read only refuses. A group saved before `vpnControl` existed
backfills to DENY if it is custom, and to the fresh-install value if it is built in
(`backfillCapabilities`, `policyStore.ts`). The one upgrade that does widen a group is the move to
policy version 3, and only for a Full Access group nobody edited: its `vpnControl` moves from ASK
to ALLOW along with four other keys, and any value you changed yourself is left alone
(`migrateToV3`; the full list is in [AI-MCP.md](AI-MCP.md#access-groups)).

What this does *not* do is make a granted `vpnControl` safe. If you approve a start prompt without
reading it, you have moved your traffic, and the audit entry — `Start VPN "office" (wireguard,
userspace, 2 listeners)` — will record that you meant to.

## `ciRead` and `ciTrigger`: the kill switch does not reach a build

Read this before setting either to anything other than `deny`, and before handing out Full Access.
They are seeded `deny` on every built-in group except **Full Access, which allows both** — with
Confirm risky actions off, so a Custom session on Full Access starts, cancels and re-runs
pipelines without asking. The predefined profiles allow both as well; Auto and Ask first ask for
every trigger, and Read only refuses it. A custom group saved before they existed backfills to `deny`, and an
unedited Full Access moves from `deny` to `allow` on the upgrade to policy version 3.

**`ciRead` returns text a stranger wrote.** Container logs are written by software the user chose
to deploy. A CI job log is written by whoever opened the pull request: anyone who can push a branch
can put any sentence into the output of a build, and `list_runs` and `get_run` are cheaper still —
a run's title is a PR title, its actor a username, its branch a branch name, and all three reach
the model through a read-only tool with no approval prompt, before anybody asks for a log.

The defence is provenance, not filtering. Every provider-supplied string goes through
`remoteText`/`remoteName`, and every CI result is wrapped in a fenced block whose opening and
closing markers carry a random per-call nonce, with the rule stated inside it that a closer without
that nonce is part of the data. An attacker writes their log before the call happens and cannot
know a value drawn afterwards. What this does **not** do is make the text safe: "ignore your
instructions" survives any character filter, which is why OpsMaxx marks authorship rather than
claiming to sanitise. `redactOutput` runs over the body and is pattern-based and not exhaustive —
assume a build log may still contain a credential.

**`ciTrigger` asks while Confirm risky actions is on, and one approval never covers the next
call.** Two rules:

- `evaluateCiTrigger` (`policyEngine.ts`) upgrades `allow` to `ask` whenever the group's Confirm
  risky actions switch is on — always, on Auto's baseline, exactly as `evaluateVpnControl` does for VPNs. It used to do so
  unconditionally, and this document used to say there was no configuration in which a build starts
  silently at an agent's request. There now are two, and both are an explicit, visible choice: a
  Custom session on a group with the switch off (Full Access as shipped), and a session on Bypass. A
  Protected workspace holds both at Ask first.
- `ciTrigger` is excluded from `sessionElevations` in both directions: it never reads an elevation
  and never writes one. For `container_action`, carrying one approval across a session costs one
  more service on a host the user administers. For a build it is an unbounded remote-execution
  loop — one approval buying every pipeline on that CI server for the rest of the session, driven
  by an agent whose next move is shaped by log text a stranger wrote.

The two rules are layered because the elevation exclusion lives in `gate()`'s `ask` branch, and an
`allow` decision never reaches that branch at all. Without the upgrade, the exclusion defends a
path that is never taken.

**And the honest limit: STOP ALL AI ACCESS cannot stop a build the provider has already accepted.**
A dispatched pipeline runs on infrastructure this app cannot reach. `denyAllPending()` resolves
approval requests still waiting and `clearAllSessionElevations()` empties a cache; neither touches
a third party.

That is less unusual than it sounds, and the rest of this app is not as different as an earlier
draft of this section claimed. A VPN the agent started stays up after the switch; a container it
started keeps running; an `execute_command` already in flight is not aborted, because revoking a
session ends the MCP session and not the SSH one. In each case the answer is the same: the human
keeps a lever the agent does not, in the panel for that subsystem.

CI is the same shape. **`cancel_run` is a `ciTrigger` tool, so the switch does take away the
AGENT's cancel** — that much is real, and it is why the agent must never be the only thing that can
stop a run. It is not the only thing: the run detail in the CI/CD panel has a **Stop this run**
button wired straight to the provider, and it is not gated by the AI policy, because it is not the
AI doing it. After the switch is pulled, stopping a run is the operator's to do — from that button,
or in the provider's own UI.

**The switch now says what it cannot stop.** It keeps a list of the runs agents started this
session and names them — in the confirmation before you press it, and in the result afterwards:

    This does NOT stop 2 build(s) an agent started:
      • deploy-prod #4821 on platform-jenkins (running)
      • nightly-e2e on ci-lab (state not reported)
    Stop those on the run in CI/CD, or in the provider.

"state not reported" is not a hedge. Jenkins answers a trigger with a queue item and GitHub
Enterprise answers `204` with no body, so for those there is no run id and nothing has been able to
check on it since. Printing "running" there would be the one claim nobody made.

The list holds only this session, in memory, and drops a run once the poller sees it finish or a
cancel is accepted for it. It does **not** cancel anything: auto-cancelling on the panic button
would be a destructive, unapproved action taken on your behalf, and a pipeline stopped half-way has
done some of its work and not the rest.

**Composition.** `ciRead` + `ciTrigger` is a closed loop — log text shapes the next tool call, and
the next tool call produces more log text — and that pair is the reason a trigger that asks is
always per-call, and the reason to think twice before running it with nothing asking at all. `ciTrigger` plus any file-write capability on an estate host is a deployment path; a
job could always deploy, but the agent now holds both halves.

**No tool creates, edits or deletes a CI connection.** No `add_ci_connection`, no
`edit_ci_connection`, and this is asserted by a test rather than left to reviewer memory — an agent
that could author one would choose the base URL it points at, and could then ask the user to paste
a token into it.

## What this does not claim

This design **reduces** the ways an AI integration can go wrong; it does not make the integration
risk-free, and none of the following should be inferred from anything in this document or the
README:

- **Not "unhackable," "zero risk," or "fully secure."** Access groups and approvals reduce the
  blast radius of a mistake or a malicious prompt; they do not make one impossible. A group you
  configure as `Full Access` genuinely grants full access, and as shipped it asks only for sudo.
- **Bypass is not a safer Full Access.** It removes every prompt and every refusal short of scope,
  Protected and revocation. A prompt-injected agent on Bypass does whatever the injection says, as
  far as its workspaces reach. Use it for work you would be comfortable watching run unattended,
  and mark what must not be touched Protected.
- **Approval quality depends on the human approving.** If you reflexively click Approve without
  reading what an ASK request is actually asking to do, the approval gate provides no protection.
  It only helps if the decision is actually considered.
- **This does not protect against a compromised local machine.** If an attacker has your OS user
  account, they have the same keychain access OpsMaxx itself uses to resolve credentials — the
  MCP policy layer is not a substitute for endpoint security.
- **Redaction is pattern-based, not exhaustive.** `secretRedaction.ts` catches known secret values
  and common secret-*shaped* text (env-style assignments, PEM blocks, bearer tokens, AWS key IDs,
  connection-string passwords). A credential in a format none of those patterns match, and that
  OpsMaxx doesn't already hold as a known value for that server, will not be caught.
- **Cloud servers can start a local process at an agent's request.** The section above sets out
  what bounds it — no command, no flag, no shell, no SSH arguments — but the honest summary is
  that an agent addressing a cloud server causes `gcloud`, `aws` or `az` to run on your computer
  with identifiers it supplied. The validators are what stand between that and something worse,
  and they are ordinary code that can have a bug in it. If you would rather that surface did not
  exist, do not add cloud servers to a workspace an agent session covers.
- **A denied or ASK-gated capability is a policy decision, not a sandbox.** OpsMaxx does not
  run commands inside a container or restricted shell on the target server; `execute_command` runs
  exactly what it's given, over the same SSH session an interactive terminal would use, once
  policy allows it.
- **This document describes the MCP bridge specifically.** It does not extend to OpsMaxx's
  general attack surface (the desktop app itself, its update mechanism, its dependencies) — see
  [SECURITY.md](../SECURITY.md) for that, and to report a vulnerability.
