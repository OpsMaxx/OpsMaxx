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

No account, no telemetry, no analytics. Nothing about you, your estate or how you use the app
is collected or sent anywhere.

One connection you did not configure: OpsMaxx checks for a new release on launch and every six
hours after that, and downloads one it finds. That is on by default. It fetches release metadata
from this project's GitHub releases — so GitHub sees what any HTTP request shows it, your IP
address and the app's user agent — and it carries no identifier and nothing from your estate.
Turn it off under
**Settings → General → Automatic updates** with "Check for updates automatically"; the
**Check for updates** button is then the only thing that reaches out.

Every other connection is one you configured.

### What is in "Copy diagnostics"?

Facts about the installation itself: your app version and update channel, whether this is a
packaged or portable build, this platform with its Electron, Chrome and Node versions, which
password store the OS offered, how many workspaces, servers, databases, tunnels and VPN
profiles exist, which optional modules are on, and whether each configurable feature is both
switched on and actually set up. Counts, version strings and on/off states — no names out of
your estate. No hostnames, addresses, usernames, file paths or credentials, and nothing read
from any server: that is the shape of what it collects, not a filter applied afterwards.

On the crash screen it also carries that crash's message and stack, and those are different in
kind — they are text the app did not write, so they get filtered rather than shaped. Secrets
are stripped and every path is cut to its last segment, but an error that failed to reach a
host usually names it, and no pattern can reliably tell a hostname from any other word. So the
crash screen shows you the whole report before it copies anything: read it first, and once you
have pasted it, delete any line you would rather not post. It is not sent anywhere and nothing
is written to disk — the button puts the text on your clipboard, and you decide where it goes.

### Does it work offline?

Yes, entirely. The app has no online dependency beyond the servers you connect to.

### Does it support two-factor authentication?

Yes. It answers keyboard-interactive challenges, and connections are shared between sessions,
file browsing and monitoring — so you enter a code once rather than once per tab.

### Why does Windows SmartScreen warn about it?

Because the Windows build carries no code-signing certificate. One costs roughly
$200–$400 a year, which a free, MIT-licensed project with no income does not have. The
warning means Windows cannot confirm **who** published the app, not that the file is
unsafe — see [Install](install.md) for how to get past it and for the scan results.

**macOS does not warn any more.** Since 0.30.1 the macOS build is signed with an Apple
Developer ID and notarized by Apple, with the ticket stapled into the app, so it opens
normally even offline. `spctl -a -vvv /Applications/OpsMaxx.app` reports
`source=Notarized Developer ID`.

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
