# Security Policy

OpsMaxx handles SSH keys, passwords and database credentials. Security
reports are taken seriously and are welcome.

For the AI & MCP bridge's threat model specifically — what an AI agent can and cannot reach, and
where that design's limits are — see [docs/AI-SECURITY.md](docs/AI-SECURITY.md).

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Use GitHub's [private vulnerability reporting](../../security/advisories/new),
or email the maintainer at <aliwaqarofficial@gmail.com>. Include:

- what the issue is and roughly how severe you think it is
- steps to reproduce, or a proof of concept
- affected version and platform

You can expect an acknowledgement within a few days. We will keep you updated
while a fix is prepared, and credit you in the release notes unless you would
rather stay anonymous.

### If you have already posted something publicly

Deleting a GitHub comment does not un-publish it. Edits keep an edit history,
the original has already gone out in notification emails, and anything public
for a few minutes may have been indexed or mirrored. So if you pasted a log, a
diagnostics block or a screenshot and then spotted a credential in it:

1. **Rotate that credential.** This is the part that actually fixes it.
2. Then tell the maintainer, so the content can be taken down as well.

In that order. The takedown is housekeeping; the rotation is the remedy.

## Supported versions

Fixes land on the latest release. There is no long-term support branch yet.

## How secrets are handled

Knowing the design may help you assess a finding.

This covers what OpsMaxx writes that bears on a credential, a trust decision,
or a record of what was done. It is **not** a complete directory listing:
preference files (window layout, shortcuts, startup choices, update settings)
are left out, and so are the run directories that hold only pid files and
sockets for the life of a process. `src/main/services/backup.ts` carries the
complete list, file by file, with the reasoning for each inclusion and
exclusion.

| Data | Storage | Protection |
|---|---|---|
| SSH passwords, key paths, key passphrases; credential-proxy token values; **the traffic inspector's CA private key** | `opsmaxx-secrets.json` | Electron `safeStorage` — DPAPI / Keychain / libsecret. Machine and user bound, with one Linux exception: the backend is whichever password store the desktop session offers, and `basic_text` is Electron's name for *no system keyring was recognised*. There `safeStorage` reports no encryption available, and the app refuses to persist rather than store in the clear — so on such a desktop a credential does not survive a restart and has to be entered again; the diagnostics payload names the store as `secretStoreBackend`, beside `secretStore.available`. This is the only file of `safeStorage`-sealed **credentials** — not the only thing the app seals, because the biometric unlock key two rows down is the vault's derived key under the same `safeStorage`, and not everything it persists is sealed at all, because the MCP client configs further down this table hold a live bearer token in plaintext. What is in here includes the root CA the traffic inspector mints: that key can impersonate any site to a machine that trusts the certificate, and it is only ever written sealed — if the OS store is unavailable it is kept in memory for the session and a new authority is minted next launch rather than written in plaintext. |
| Vault entries | `opsmaxx-vault.json` | AES-256-GCM, key from the master password via scrypt (N=32768). Password never stored. Decrypted entries are sent to the renderer while the vault is open, so they live in the renderer's memory too — not only in the main process. |
| Biometric unlock key (opt-in, off by default) | main-process memory, or `opsmaxx-vault-bio.json` | The vault's **derived key**, wrapped with Electron `safeStorage`. By default this is held in memory only and dies with the process, so nothing is written to disk. The file exists only if you explicitly choose to keep biometric unlock across restarts. |
| Workspace passwords | `opsmaxx-wslocks.json` | scrypt verifier with a random salt, compared with `timingSafeEqual`. Not reversible. |
| Trusted SSH host keys | `opsmaxx-known-hosts.json` | SHA-256 fingerprints, plaintext (not secret). |
| Trusted RDP server certificates | `opsmaxx-rdp-certs.json` | SHA-256 fingerprints, plaintext (not secret). Trust-on-first-use, and a changed pin is refused — the same policy as SSH host keys, because RDP servers are self-signed by default. |
| Which vault entries were written into a host's `.env` | `opsmaxx-env-secrets.json` | **References only** — a server id and a vault entry id, both non-secret. No value is stored. It is resolved out of the vault at redaction time, so a locked vault redacts nothing rather than a plaintext copy being kept on disk to make an output filter nicer. |
| Credential-proxy rules and token records | `opsmaxx-credproxy.json` | Plaintext. A rule names a vault entry rather than carrying a credential, and token **records** are stored while the token values are sealed with `safeStorage` into `opsmaxx-secrets.json` (one row up) keyed by id — so the file can be read, backed up and diffed without yielding a credential. |
| Credential-proxy call log | `opsmaxx-credproxy-audit.jsonl` | Plaintext, append-only, `0600`. Refusal and error text is redacted **before** being capped, never after: capping first can cut the end marker off a PEM block, after which the private-key pattern matches nothing and the body is stored as prose. |
| Job and broadcast approvals | `opsmaxx-job-approvals.jsonl` | Plaintext, append-only, `0600`. What a human was asked before a job ran and what they answered. Titles, hosts and command text go through the same secret redaction at the writer. **Never a job's output.** Kept separate from the AI audit log so that every row in that file is an agent's. |
| Metrics, job output and fleet inventory | `opsmaxx-history.db` | Plaintext SQLite, `0600`, under its own retention. Job output is redacted and capped by the caller before it reaches the store. It holds an inventory of every host, unit and open port in the estate, which is why it is not left readable to other accounts on a shared machine. |
| Backups | user-chosen `.spbackup` file | AES-256-GCM under a passphrase you supply. Credentials are unsealed from the keychain and re-encrypted so the file is portable. |
| Servers, folders, workspaces | `opsmaxx-data.json` | Plaintext. Contains no credentials. |
| AI/MCP agent sessions | `opsmaxx-mcp-sessions.json` | Only a SHA-256 hash and a 4-character preview of the bearer token is stored — never the raw token. |
| AI/MCP audit log | `opsmaxx-ai-audit.jsonl` | Plaintext, append-only, `0600`. Free-text fields are passed through the same secret-redaction as command output before being written, so it should never contain a credential. |
| Local terminal sessions | `opsmaxx-local-sessions.jsonl` | Plaintext, append-only, `0600`. One entry when a local shell starts and one when it exits — shell label, resolved path, pid, working directory, exit status. **Never keystrokes and never output.** Kept separate from the AI audit log, which answers a different question. |
| AI/MCP access-group policy | `opsmaxx-ai-policy.json` | Plaintext. Contains no credentials — capability rules and file-path patterns only. |
| Runbook notes attached to alerts | `opsmaxx-runbooks.json` | Plaintext, `0600`. Free text a person wrote about their own estate, so it names hosts and whatever else they chose to type. Unlike every log above it is **not** passed through secret redaction — a note is authored, not captured, and silently editing what someone wrote is worse than storing it — so a credential pasted into a note is stored verbatim. Control and bidi characters are stripped and the text is capped at 4000 characters; nothing else is changed. No retention: a note is kept until deleted, which is the point of keeping it outside the history store. |
| Automation rules | `opsmaxx-rules.json` | Plaintext, `0600`. Trigger conditions, the command each rule runs, pinned server ids, and the approval records for rules that required one. |
| Managed long-running processes | `opsmaxx-processes.json` | Plaintext, `0600`. Command lines, the hosts they run on, and the vault entry ids resolved at start time. No credential value. |
| Where backups go | `opsmaxx-backup-targets.json` | Plaintext, `0600`. Schedules plus the endpoint, bucket and remote path of every destination, and the vault entry ids that unlock them — **references only**, no credential value. It is still a map of where copies of this estate's secrets are kept. |
| MCP bridge settings | `opsmaxx-mcp-config.json` | Plaintext, `0600`. Whether the bridge is enabled, its port, session lifetime, and which access group a new agent session starts on. No credential — but it is the configuration that decides what an agent is granted. |
| The bridge entry written into an agent's own MCP config, and the `.opsmaxx-backup` copy taken before each write | `claude_desktop_config.json` under `~/Library/Application Support/Claude`, `~/.config/Claude` or `%APPDATA%\Claude`; `~/.codex/config.toml` | **A live bearer token, in plaintext**, `0600` — the backup copy too. Plaintext because the agent that launches the bridge has to read the token to present it; it is a session token, minted for named workspaces and a single access group, and not a credential for any host. These are the only files the app writes **outside its own data directory**, so the `0700` on that directory does not cover them and the mode is set on each file instead. The entry is merged into what was already there, and a config that cannot be parsed is left untouched rather than replaced. |
| Remote files opened in your own editor | `external-edit/` | **Plaintext file contents** pulled down from hosts in the estate, under a hash of the remote path. Whatever you opened is on local disk until it is cleaned up. |
| Captured HTTP bodies | `inspect-capture/` | Plaintext request and response bodies spilled to disk by the traffic inspector. Cleared on every inspector start, so usually empty — but a session that was interrupted leaves its bodies, and bodies routinely carry bearer tokens and session cookies. |
| The traffic inspector's CA **certificate** and the system proxy settings it replaced | `inspect/` | The certificate is written `0644` **deliberately** — it is the half meant to be handed out, and it is the one you install into your OS trust store, so confirm its fingerprint before you do. The private key is **not** here; it is sealed into `opsmaxx-secrets.json` (above). `system-proxy-backup.json`, `0600`, records your proxy settings as they were before capture so they can be put back. |
| VPN engine state | `vpn-state/` | Durable, `0700`. Holds engine **key material** — a tsnet node's private key is what makes it the same device on the tailnet next launch, so unlike the run directories this one is meant to outlive the process and nothing sweeps it. |

### SSH host keys

OpsMaxx does trust-on-first-use host key checking against its own
`opsmaxx-known-hosts.json`. Without it, ssh2 accepts any key presented, so
anything on the path to a server could capture the session and the credentials
sent over it.

It also **reads** `~/.ssh/known_hosts` (and `known_hosts2`), but never inherits
trust from it. Adopting that file wholesale would silently take on every trust
decision it has accumulated, including whatever `StrictHostKeyChecking=accept-new`
waved through unattended. So an entry there only changes what the prompt says:
a host whose exact key OpenSSH already has is presented as recognised, and the
dialog defaults to Trust instead of Cancel. A human still confirms it once.

Two cases there are not merely informational:

- **`@revoked`** matching the presented key refuses the connection outright. It
  is a negative signal, so acting on it without asking only ever restricts.
- **A host present under a different key** is called out explicitly in the
  prompt, since that is either a rebuilt server or an interception.

`@cert-authority` lines are ignored. They authorise certificates rather than
naming a host key, and OpsMaxx cannot validate a certificate chain — so they
are treated as no evidence rather than as trust.

Once a host is trusted, a *changed* key is always refused outright and never
re-prompted: the user has to forget the saved key in Settings → Security first.

### Process hardening

macOS builds run with the **hardened runtime**, which blocks
`DYLD_INSERT_LIBRARIES` injection and debugger attach. This matters more than
any of the vault's own protections: without it, a process running as the same
user can inject into OpsMaxx and read an unlocked vault key out of memory,
and no amount of encryption at rest or biometric gating prevents that.

The hardened runtime does not require an Apple Developer certificate — it works
with the ad-hoc signature these builds already carry.

Library validation is disabled by entitlement, because `asarUnpack` keeps the
ssh2 and cpu-features native binaries outside the archive deliberately. That
gives back one of the three protections the hardened runtime provides and keeps
the two that defend an unlocked vault.

### Workspaces and the vault

Workspaces isolate **servers, databases and tunnels** — each record carries a
workspace id and is filtered by it. A password-protected workspace keeps those
out of sight until it is unlocked.

**The vault is filtered by workspace, not separated by it.** A vault entry can
belong to a workspace — new entries belong to the one they were created in —
and the entry list then shows that workspace's entries plus any marked shared.
Entries written before this existed have no workspace recorded, so they stay
shared and can be moved deliberately.

What that is worth, stated precisely: it stops another client's credentials
being in front of you, and it stops you saving a credential into the wrong
place by accident. It is **not** a cryptographic boundary. The vault remains
one encrypted file under one master password, so anything that can read the
unlocked vault can read every entry in it regardless of workspace. Locking a
workspace does not lock the vault.

Per-workspace cryptographic separation would mean a master password per
workspace, which is a different product; this is a view over one vault.

### What biometric unlock actually protects

Worth stating plainly, because it is easy to assume more.

Electron's `promptTouchID` authenticates the person at the keyboard. It does not
return a key. So enabling Touch ID unlock stores the vault's derived key on disk
under `safeStorage`, with a biometric prompt in front of reading it — a **gate**,
not a cryptographic binding. Software running under your macOS account can read
that key without ever triggering the prompt.

The stronger designs — a Keychain item with a biometry ACL, or a Secure Enclave
key wrapping the vault key — both require the macOS data-protection keychain,
which requires entitlements authorised by a provisioning profile, which requires
a paid Apple Developer account. OpsMaxx is ad-hoc signed and has none, so
neither is available to it. (Apple's TN3137 documents this; it is the design, not
a gap we have failed to close.)

This is why biometric unlock is **session-scoped by default**: the wrapped key
is held in main-process memory and dies with the app, so an attacker who can
read your files finds nothing to read. You type the master password once per
launch and Touch ID reopens the vault after that. It is the same design
KeePassXC uses, and it is what makes the feature defensible without the
entitlements above.

Keeping it across restarts is a separate, explicit choice, and it is the one
that writes the key to disk.

Two consequences worth being concrete about:

- With biometric unlock **off**, the master password exists nowhere on the
  machine, and the vault is the only OpsMaxx data an attacker with your files
  and your logged-in session cannot read. Turning it on gives that up.
- Your SSH credentials in `opsmaxx-secrets.json` have always been protected
  by `safeStorage` alone. So enabling this moves the vault down to the protection
  the rest of the app already has, rather than opening a new category of risk.

It remains a real barrier against someone who picks up an unlocked laptop, and it
is why the feature exists. It is not a barrier against code running as you.

### Local terminal

OpsMaxx can open a shell on the machine it is running on — your own zsh or
bash, PowerShell, Git Bash, a WSL distribution — in a tab next to the SSH ones.
Two things about that are worth stating, and they pull in opposite directions.

**It is not a new privilege.** The shell runs as you, in your environment, with
whatever your account can already reach. Terminal.app, Windows Terminal and your
desktop's own launcher have always been one click away, and nothing here hands a
person at your keyboard anything they did not already have. Read no more into it
than that.

**What changes is the distance.** Two statements above rest on an assumption this
feature does not break but does bring within reach: *Process hardening* says the
hardened runtime is what stops a process running as the same user reading an
unlocked vault key out of memory, and *What biometric unlock actually protects*
says it "is not a barrier against code running as you."
After this feature, code running as you is a UI affordance inside the same
window, while the vault is open. Concretely, a shell started from that tab can
read — with no prompt, no elevation and no OpsMaxx involvement:

- `opsmaxx-vault-bio.json`, if you chose to keep biometric unlock across
  restarts. It holds the vault's **derived key**, and `safeStorage` unwraps it
  for anything running as you. (This is the same point the section above makes;
  it is repeated here because the terminal is where it becomes convenient.)
- `opsmaxx-secrets.json` — SSH passwords, key paths and key passphrases. On
  Windows (DPAPI) and Linux (libsecret) `safeStorage` is scoped to the user, not
  to the application, so any process running as you decrypts it.
- `opsmaxx-ai-policy.json` — the access-group rules that constrain an AI
  agent.
- `opsmaxx-mcp-sessions.json` — which agent sessions exist and when they
  expire.
- `opsmaxx-ai-audit.jsonl` — the record of what an agent did. Append-only to
  OpsMaxx; an ordinary writable file to a shell.

**That list is exactly why the local terminal is a human-UI-only surface.** It is
not exposed over the MCP bridge or the `opsmaxx` CLI, it is not behind an AI
capability, and it is not behind an ASK prompt — because no value of either would
make it safe. Every constraint OpsMaxx advertises to an agent is a file on the
same disk as the shell, so an agent that can run one local command can read the
policy store that limits it and the audit log that records it. The answer is "not
reachable", not "gated".

That is enforced by `tests/localTerminalNotExposed.test.ts` rather than by
reviewer memory. It asserts the tool list the bridge actually serves against a
reviewed whitelist, walks the transitive import closure of
`src/main/services/mcpServer.ts` and everything under `src/cli/` to prove neither
can so much as import the pty module, and checks that no AI capability names a
local shell. If one of those fails, the failure is the finding.

The `local:*` IPC handlers are gated in the main process
(`src/main/services/localGate.ts`), not only in the renderer: the
`localTerminalEnabled` setting is mirrored on the main side and the connect
arguments — session id, working directory, terminal dimensions — are validated
there, because a renderer-side flag constrains only an honest renderer. Starting
OpsMaxx with `ELECTRON_DISABLE_LOCAL_TERMINAL=1` stops the pseudo-terminal
binding being loaded at all. Neither is a security boundary against someone at
your keyboard — they have a terminal either way — they are there so a machine can
run OpsMaxx without the feature.

## The traffic inspector's certificate authority

Reading HTTPS means terminating it, and terminating it means holding a
certificate authority this machine trusts. That authority is the most dangerous
key OpsMaxx handles: whoever has it can impersonate any website to this
computer. It is treated accordingly.

**The private key never leaves the two places it has to be.** It is generated
inside the `opsmaxx-netd` sidecar, sealed with the operating system's secure
store through `safeStorage`, and handed back to a running sidecar on stdin —
never on the command line, never in an environment variable, never to the
renderer, and never to disk unsealed. If the OS keychain is unavailable the key
is kept in memory for that session only and a new authority is minted next
launch; OpsMaxx will not write it in plaintext as a fallback. Generation
deliberately bypasses the process supervisor's log ring, for the same reason
WireGuard key generation does: the answer to the request is a private key.

**It is only trusted while you say so.** Nothing is installed at first run.
Installing into the system trust store is one explicit action behind one
administrator prompt, it installs nothing permanent that can later become root,
and there is a matching removal for every store OpsMaxx can write to. The
certificate's SHA-256 fingerprint is shown in the panel in the same colon-separated
form Keychain Access and `certmgr.msc` use, so you can confirm the certificate
your machine trusts is the one the running proxy signs with.

**The authority is constrained.** It is a P-256 root with a one-year lifetime,
`pathLenConstraint: 0` so it cannot issue intermediates, and the certificates it
mints last thirty days and carry a single host name each.

**A proxy off loopback needs a password.** A listener on 127.0.0.1 is reachable
only by processes already running as you, who can read the traffic anyway. A
listener on any other address is an open proxy for the network that also
decrypts TLS — so OpsMaxx refuses to start one without credentials rather
than warning about it, generates them itself, and puts them in the environment
it hands out.

**Upstream verification stays on.** OpsMaxx validates the real server's
certificate against the system trust store on the outbound half of every
intercepted connection, so interception does not silently downgrade a
connection that was previously authenticated. Extra roots can be added for
internal services. Verification can be turned off, but only deliberately, and
the panel and the log both say so for as long as it is off.

**Some traffic is never intercepted.** Certificate revocation endpoints,
platform update services and OpsMaxx's own update endpoints are excluded by
default and tunnelled untouched. Standing in the middle of an OS update while
holding a key that can forge its signature is not a debugging feature.

**Captured traffic is not shown to AI agents.** The MCP bridge and the
`opsmaxx` CLI have no access to flows. Request and response bodies routinely
carry bearer tokens and session cookies, and the agent gateway's promise that it
never sees key material is worth more than the convenience.

**What a backup contains.** An encrypted backup includes the sealed CA key
along with every other stored credential, re-encrypted under your backup
passphrase. Restoring on another machine restores an authority that machine may
still trust. Use `Forget certificate` in the traffic panel before exporting a
backup you intend to share.

## What the system proxy setting changes

Capturing "this whole machine" changes your operating system's proxy settings
and puts them back afterwards. The previous settings are written to disk
**before** anything is changed, and the restore runs on stop, on quit, and again
on the next launch if OpsMaxx died in between. If a restore fails the record
is kept rather than discarded, so it is retried rather than forgotten. This
ordering exists because the failure it prevents — a machine left pointing at a
port nothing is listening on, with no working internet and no obvious cause —
is the worst thing this feature could do to someone.

## Known limitations

These are design decisions, not bugs. Please do not report them as
vulnerabilities — but do open a discussion if you disagree with the tradeoff.

- **Workspace passwords gate the UI only.** They do not encrypt that
  workspace's servers on disk.
- **A backup passphrase cannot be recovered.** There is no escrow and no
  backdoor.
- **`safeStorage` is machine bound.** Copying the config folder to another
  machine will not carry credentials — use an encrypted backup instead.
- **Releases are not code-signed.** Verify checksums if you need assurance
  about a download.
- **Tunnels carrying something other than HTTP are broken, not just
  unreadable.** A CONNECT to an IMAP, SMTP or SSH port is handed to an HTTP
  parser and dropped. OpsMaxx detects this, names the host and port, and
  offers to let it through untouched — but the first connection is already
  lost. Add such hosts to the passthrough list before capturing machine-wide.
- **A WebSocket's frames are not recorded.** The upgrade handshake is
  captured in full; what follows is another protocol on the same connection
  and is relayed untouched.
- **Recorded bodies are capped in total, not just per body.** Past 512 MiB the
  oldest recorded bodies are deleted; their flows keep their headers, sizes and
  inline preview.
- **Certificate pinning defeats traffic inspection.** An application that
  checks for a specific certificate cannot be intercepted by OpsMaxx, Burp,
  Fiddler or anything else short of patching that application. OpsMaxx
  detects it, names the host, and offers to stop intercepting it. It does not
  ship a bypass.
- **Per-process capture is not offered on any platform.** Choosing "intercept
  only this application" needs a notarised system extension on macOS, an eBPF
  redirector on Linux and a kernel driver on Windows. Capture is per-session or
  machine-wide instead.
