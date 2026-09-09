# FAQ

Common questions about installing, trusting, and using OpsMaxx.

[← Back to the README](../README.md)

---



### What is OpsMaxx?

OpsMaxx is a free, open-source, cross-platform desktop application that combines an SSH
terminal, an SFTP file browser, an SSH tunnel manager, a multi-engine database client, an
encrypted secrets vault and a secure MCP bridge for AI coding agents (Claude Code, Claude
Desktop, Codex and others) in a single window. It runs on Windows, macOS and Linux, is released
under the MIT licence, and needs no account.

### Which file should I download?

On Windows, `OpsMaxx-x.y.z-setup.exe` unless you specifically want the
portable single-file build. On macOS, `-arm64.dmg` for an M1 or later and
`-x64.dmg` for an Intel Mac. On Linux, the `.AppImage` works on any
distribution, and the `.deb` is there if you would rather install through
`apt` on Debian or Ubuntu. The `.blockmap` and `latest*.yml` files on the
release page are build metadata — you never need to download them.

### Is OpsMaxx really free?

Yes. It is MIT licensed, free for personal and commercial use, with no paid tier, no
session limit and no subscription. Nobody should be charging you for it.

### Is OpsMaxx a good MobaXterm alternative?

It is the closest free alternative for most workflows, and unlike MobaXterm it runs on macOS
and Linux as well as Windows. There is no 12-session cap, no Professional Edition, and the
built-in database client and vault cover work MobaXterm sends you elsewhere for. MobaXterm's
X11 server and its bundled Cygwin toolchain have no equivalent here.

### Can it replace PuTTY?

For day-to-day SSH, yes — with saved sessions, folders, tabs, a searchable scrollback and
right-click paste in the PuTTY style. It also imports the servers you already have in
`~/.ssh/config`, so there is no re-typing. Serial-port connections are not supported.

### Is it an open-source Termius alternative?

Yes. The functional difference is sync: Termius syncs your servers through its cloud on a
paid plan, while OpsMaxx keeps everything local and moves it between machines with a
passphrase-encrypted backup file. Nothing is uploaded and nothing phones home.

### Does OpsMaxx support jump hosts and bastions?

Yes — unlimited chained hops per server, configured in the same dialog as the server itself.
Each hop can either reuse a saved server's credentials or define its own server, port, user and
key. `ProxyJump` entries in `~/.ssh/config` are imported as jump hosts automatically.

### Which databases does it support?

PostgreSQL, MySQL, SQL Server, MongoDB and Redis — each with a table/collection browser, a
query editor and an interactive shell. Any of them can be reached through an SSH tunnel, so a
database that is only routable from inside the network still works.

### How are my passwords and SSH keys stored?

In your operating system's own credential store through Electron `safeStorage` — DPAPI on
Windows, Keychain on macOS, libsecret on Linux. Nothing is written in plaintext. The vault
and encrypted backups add AES-256-GCM with scrypt key derivation on top of that.

### Does OpsMaxx send any data anywhere?

No. There is no account, no telemetry, no analytics and no update ping. Every connection it
makes is one you configured.

### Does it work offline?

Yes, entirely. The app has no online dependency beyond the servers you connect to.

### Does it support two-factor authentication?

Yes. It answers keyboard-interactive challenges, and connections are shared between sessions,
file browsing and monitoring — so you enter a code once rather than once per tab.

### Why does Windows SmartScreen or macOS Gatekeeper warn about it?

Because OpsMaxx is not notarized, and on Windows not signed at all. Both systems expect
an application to carry a code-signing certificate, which costs roughly $200–$400 a year for
Windows and $99 a year for an Apple Developer account — money a free, MIT-licensed project
with no income does not have. The warning means the operating system cannot confirm **who**
published the app, not that the file is unsafe. On Windows choose *More info → Run anyway*;
on macOS use **System Settings → Privacy & Security → Open Anyway** (or right-click →
**Open** on macOS 14 and earlier). Releases up to 0.2.2 can show *"OpsMaxx is damaged and
can't be opened"* instead, which has no button to click through — run
`/usr/bin/xattr -cr /Applications/OpsMaxx.app` for those, not the Trash the dialog
suggests. Full instructions are under
[First run: why your computer shows a warning](install.md#first-run-why-your-computer-shows-a-warning),
and every release publishes SHA-256 checksums so you can verify the download yourself.

### What are the system requirements?

Windows 10 or later, macOS 11 or later (Apple Silicon and Intel), or a modern 64-bit Linux
distribution. Building from source needs Node.js 20 or later.

### Can I connect Claude Code, Claude Desktop or another AI agent to OpsMaxx?

Yes — see [AI Agent Access](ai-agents.md). OpsMaxx runs a local
[MCP](https://modelcontextprotocol.io) server that Claude Code, Claude Desktop, Codex, Gemini CLI
and other MCP-compatible clients can connect to, each session scoped to the workspace(s) and
access group chosen for it. The agent never sees a password, private key, database credential or
Vault secret — it only ever gets a friendly server name and whatever that session's access group
allows.

### Is it safe to let an AI agent run commands on my servers?

It's as safe as the access group you assign it, and that's a real limitation, not a slogan — see
[docs/AI-SECURITY.md](AI-SECURITY.md) for what this design does and does not protect against.
What OpsMaxx does provide: the bridge only listens on `127.0.0.1`, every capability (run
commands, read/write files, SFTP, tunnels, database access, sudo, metrics) is independently
ALLOW/ASK/DENY, sudo/unrestricted shells are hard-blocked regardless of group, and anything marked
ASK stops and waits for you to approve or deny it in OpsMaxx — an agent can never approve its
own request. Every action is logged in the Audit Log with secrets redacted.

### How do I move my setup to another machine?

Settings → Backup & Restore writes a single passphrase-encrypted file containing workspaces,
servers, databases, tunnels, credentials, the vault and trusted host keys. Restore it on the
new machine with the same passphrase.

### How can I help?

Star the repository, report bugs, or open a pull request — see [Contributing](../README.md#contributing).

---

[← Back to the README](../README.md)
