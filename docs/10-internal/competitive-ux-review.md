---
docgov:
  id: competitive-ux-review
  type: note.internal
  authority: historical
  audience:
    - engineering
  visibility: internal
  status: draft
  generation:
    mode: human-maintained
---
# Competitive UX review

> Internal Note. Historical record. Correct only factual errors. Keep it under 400 lines; 1000 triggers review.

> **Status: analysis, 2026-09-23, revised after an adversarial review the same day.**
> Written against the public pages of `termius.com`, `termius.com/vault`, `sshid.io`,
> `gloriashell.com` and `shellngn.com`, read 2026-09-22/23, and against `src/` at
> `329954be`. Those pages mix live HTML mockups, raster product images and demo videos;
> Shellngn also publishes full-size product screenshots. What follows is what the pages
> show, not a hands-on trial. **This note is a record. The live plan is the set of
> Kangentic backlog items that cite it, labelled `ux`.**

## Why this exists

We were asked to look at the UX of the products we are most often compared with,
document what makes it feel smooth, and find where ours falls short.

The security side of the same comparison is already written:
[the sync security protocol, next to Termius's Vault](../plans/sync-security-protocol.md)
reads our sync against the Termius Vault and SSH ID, and records that OpsMaxx has **no
account, no vendor cloud and no team vault**. This note covers only how those products
look and behave, and does not reopen that decision. That stance is not unique to us:
Termius also advertises locally stored, encrypted data and direct connections, and its
FAQ answers "Do I need an account?".

Screenshots are not committed: they are third-party images and this repository is public.
They are attached to Kangentic task #26, named `<vendor>-<surface>.png`, and cited below by
that name with the page they came from.

---

## 1. What the competitors do well

### Termius — the app

Source: `termius.com`. Attachments: `termius-hero.png`, `termius-hosts-details.png`,
`termius-terminal-themes.png`, `termius-workspace-grid.png`, `termius-session-logs.png`.

- **Host list as cards.** Each host is a tile carrying its distribution's logo, the name,
  and a tag line underneath (`ssh, prod, db`). Groups are cards too, with the count on a
  second line ("Production" / "12 Hosts"). A raster image of the desktop app on the same
  page shows the controls above the list: a NEW HOST button with a menu, TERMINAL and
  SERIAL entry points, grid/list, tag-filter and sort toggles, and counts at scale
  ("AWS", 92 hosts).
- **Details beside the list.** The mockup shows host details in a side panel next to the
  list, with fields that read as sentences — "SSH on [22] port", "Credentials from Team
  Vault" — and one Connect button.
- **An in-session sidebar** with four icon tabs (rocket, `{}`, clock, appearance). The
  appearance tab lists terminal themes, **each with a thumbnail of its palette** —
  Termius Dark, Tokyo Day, Catppuccin Mocha, Gruvbox Dark, Solarized Light, Dracula.
- **Workspaces as tabs holding a grid.** A "Production" workspace tab, shown in green,
  holds a 2×2 grid of sessions; the focused pane has an accent border and a close button.
- **Autocomplete with explanations.** Suggestions carry a plain-English description, e.g.
  "Display processes by memory consumption" → `ps aux --sort=-%mem | head -n 10`.
- **Session logs** as a table — member, host with its distro tile, time and duration,
  device — grouped under Today / Yesterday.

### Termius Vault — UX only

Source: `termius.com/vault`. Attachments: `termius-vault-overview.png`,
`termius-vault-sharing-keychain.png`.

- **Credentials as a card grid**, each titled by name and subtitled with its type: "Type
  ED25519", "SSH Certificate", "Type ED25519-SK" (card "FIDO2"), "Type ECDSA" (card
  "Touch ID"), "Auth password", "Auth key". A static strip beneath lists key types
  (Keygen: ECDSA/ECDSA-SK, ED25519/ED25519-SK, RSA).
- Vault sharing shows each member with an inline role dropdown ("can edit", "can view").
  This is the team feature we are not building; it is recorded only as a pattern.

### SSH ID — UX only

Source: `sshid.io`. Attachment: `sshid-hero.png`.

- One primary call to action ("Create SSH ID with Termius") under a two-line headline.
  Setup is four guided steps — install Termius, set up SSH ID in Settings, add to
  authorized keys, connect. A server then fetches your public keys with one command,
  `curl https://sshid.io/<handle>`.
- Each published key carries a `#device` comment above the full public key
  (`#Macbook Pro`, `#iPhone 17 Pro`, `#HP EliteBook 840`).

### Shellngn

Source: `shellngn.com/images/screenshots/`. Attachments: `shellngn-terminal.png`,
`shellngn-sftp.png`, `shellngn-rdp.png`. Shellngn is browser-based (hosted or a
self-hosted Docker image), so its patterns come from a web app, not a desktop client.

- **Sidebar rows carry a second line**, `host | PROTOCOL` (`demo.shellngn.com | SSH2`,
  `| RDP`), with a per-type icon, under collapsible folders, and a search box with a
  "+" button above them.
- **State is shown in three places and coloured by state**: a dot on every tab (green when
  connected, amber while connecting), a thin progress bar under the tabs while
  connecting, and a status bar reading "Host: demo.shellngn.com … ● Connected" or
  "● Connecting". A per-session toolbar offers snippets, SFTP, find, zoom and fullscreen.
- **SFTP transfers are listed in a side panel**, each with its state ("Complete") and, for
  files, its size, with upload, pause and delete controls — beside a path bar with
  back/forward/home/refresh and sortable columns.

### GloriaOps — Termius's AI DevOps agent (pre-release, early access)

Source: `gloriashell.com`. Attachments: `gloriaops-infra-model.png`,
`gloriaops-approval-card.png`.

- **A constrained harness, read-only by default.** The page says Gloria does not generate
  shell commands but uses purpose-built ones, and that nothing runs with write access
  unless you approve it.
- **A change is proposed as a plan card**: numbered steps, a "Required Capabilities" box
  (`Write: ECS Deployments`), and Approve / Reject.
- **Commands preview their effect.** The `delete --help` example documents `dry_run`
  ("default: true"), and the preview reports a measurement — "47 files matched (1.2 GB
  total)" — with sample paths.
- Alerts arrive as a toast ("New alert received. Starting investigation..."), and the
  page lists three setup steps: install, add your infrastructure (including importing
  `~/.ssh/config`), set up monitoring.

### Cross-cutting practices

1. **State is shown wherever a session appears** — tab, sidebar row, status bar — and it
   is live and coloured by state.
2. **Choose visual settings by looking at them** — thumbnails, not names.
3. **Say what an approval grants**: the capability, and for how long.
4. **Show what a change will do before it runs**, where that can be known safely.
5. **Marketing shows the product full of realistic data.** Empty states belong in the app.

---

## 2. Where OpsMaxx already matches or leads

Paths are relative to `src/renderer/src/components/` unless they start with `hooks/`,
`lib/`, `store/`, `styles/` or `types.ts` (under `src/renderer/src/`) or `src/`.

- **Live state in two of the three places.** Every sidebar server row has a live status
  dot (`connections/ConnectionTree.tsx:274`), and tabs have a `status` slot for "a
  connection dot, a spinner" (`panel/TabStrip.tsx:30`). Workspaces are coloured
  (`layout/StatusBar.tsx:80`, `ws.color`). Split panes keep their session
  (`panel/PaneGrid.tsx:24-27`).
- **Getting back to work.** Dormant tabs are restored on relaunch (`store/app.ts:2541`,
  `terminal/TerminalView.tsx:502`); sessions auto-reconnect after a host reboot
  (`hooks/useSessionRecovery.ts`); up to 10 closed tabs can be reopened
  (`lib/tabs.ts:164-178`). A favorites section sits at the top of the tree
  (`connections/ConnectionTree.tsx:299`).
- **`~/.ssh/config` import** (`connections/SshConfigImport.tsx`) carries ProxyJump across
  and skips wildcard-only `Host *` entries. GloriaOps lists the same step in its setup.
- **Keyboard and settings.** A command palette with fuzzy search
  (`palette/CommandPalette.tsx`, `lib/fuzzy.ts`); rebindable shortcuts with conflict
  detection (`settings/ShortcutManager.tsx`, `lib/shortcuts.ts`); terminal schemes that
  apply to open terminals immediately, plus import of custom schemes
  (`settings/Settings.tsx:1044`, `:1061-1080`).
- **Onboarding** — `onboarding/OnboardingTour.tsx`, `onboarding/SetupCard.tsx` and
  `onboarding/setupQuestions.ts`, with a role picker.
- **Broadcast**, which none of the pages above show: one command across explicitly chosen
  hosts, a confirmation that scales with host count and risk, cancellable, results per
  host (`src/shared/broadcast.ts`). It is also our one existing "blast radius as a
  number".
- **The approval dialog** (`ai/ApprovalDialog.tsx`, `src/shared/approvalRisk.ts`) shows
  a risk band with its reason, the stated consequence, the agent's own intent, a
  countdown, the policy rule that asked, the session's actions so far, what happens if
  you deny, and "Deny and stop all AI access". Deny is always the weighted, focused
  button. Deferred requests stay reachable from a status-bar chip.

### Where the approval dialog falls short of its own label

It does **not** show the capability being granted — GloriaOps does. More seriously, the
button reads **Approve once**, but by default an approval is remembered for the rest of the
agent's session, per server and capability (`src/main/services/mcpServer.ts:797-811`,
`:915`). Only tools flagged `perCall` and CI triggers are single-use (`:715`, `:873`).
This is filed as its own security bug, ahead of every item below.

---

## 3. Opportunities, ranked

Ranked by user-visible impact per unit of effort. Effort is S (under a day), M (a few
days), L (a week or more). Each item is a Kangentic backlog task with an acceptance
criterion; the task is authoritative for scope.

| # | Gap, with evidence | Competitor reference | Effort |
|---|---|---|---|
| 1 | **16 app screenshots in `docs/images/` predate the rename** — eight from the squashed root commit `85041fdb`, the seven `ai-*.png` from `0b6ba280`, and `fleet-monitor.png`. Several show the retired name, some inside commands readers copy (`ai-security.png`). `README.md:44` leads with an empty window. `tests/branding.test.ts` does not scan images. | Termius's populated product images | M |
| 2 | **SFTP cannot download to a folder** — the menu entry only toasts "Saving to a folder is not built yet." (`panel/SftpView.tsx:562-569`). A file dropped during an upload is silently discarded (`:505`), there is no cancel, and overwrite uses `window.confirm` (`:507`). | Shellngn's transfer panel | S–M |
| 3 | **A `write_file` approval hides the content being written** — the action is `write <path> (N bytes)` (`src/main/services/mcpServer.ts:2104`). The content is already in the main process, so it can be shown without a remote call: capped, redacted, visibly escaped, in a frame marked as agent-written. | GloriaOps plan card | S–M |
| 4 | **Three status-bar chips are static** — `local ok`, `Online` and a bell with no handler (`layout/StatusBar.tsx:196-208`). The rest of the bar is live. "Online" must come from local state, never an outside endpoint. | Shellngn's state-coloured status bar | S |
| 5 | **The approval dialog can be drawn under other layers** — it uses `.scrim` at `z-index: 100` (`styles/global.css:1323`), below the palette (200), toasts (300) and the tour (900). No layer or motion tokens exist in `styles/tokens.css`. | — | S |
| 6 | **Server rows are not keyboard-operable** — `ServerRow` has no role, `tabIndex` or key handler (`connections/ConnectionTree.tsx:243`, admitted at `:86-89`), and its status dot is colour-only. | — (accessibility) | S |
| 7 | **Tags exist but cannot be seen or set** — `Server.tags` is in the model and searched (`ConnectionTree.tsx:183`); the only writer is import (`SshConfigImport.tsx:103`). `os` is never drawn and is effectively always `'Linux'` (`store/app.ts:2068`); the real distro is already in sampled host facts. Edit tags in the existing modal. | Termius tag line and distro tile; Shellngn type icons | M |
| 8 | **No theme preview without an open terminal** — `settings/Settings.tsx:1050` is a `<select>`. | Termius theme thumbnails | S |
| 9 | **No saved commands** — none exist, but two are planned (Jobs saved templates, `ROADMAP.md:325`, `:339`; per-alert runbooks, `src/shared/runbooks.ts`). Extend Jobs templates with "run in this terminal" rather than adding a third model; keep them off the MCP bridge. | Termius `{}` sidebar; Shellngn toolbar | M |

Items 4, 5 and 6 reuse the state roles and shape-coded dots defined in the
[fleet panel UX audit](../design/panel-audit.md), section 7.

### Considered and not recommended

- **Accounts, team vaults, cloud sync, per-member roles, a hosted key-handle service.**
  Out of scope by the stance recorded in the
  [sync security protocol](../plans/sync-security-protocol.md).
- **A measured preview of a change's effect** — a file count before `rm`, a remote diff
  before a write, `EXPLAIN ANALYZE` before a statement. Measuring means running something
  on the host before anyone has approved anything, with an agent-chosen path; the result
  is host-controlled text in the trust decision, can reveal files the path rules deny, and
  is stale by the time the call runs. Item 3 is the safe subset.
- **Replacing the server modal with a side panel.** Thirty components use the shared
  `Modal`, most of `AddServerModal.tsx`'s 1,329 lines are domain logic rather than
  layout, and a details column would take width from terminals in an app that already
  has an activity bar, sidebar, tabs and splits.
- **Plan-level approval of several agent calls.** Not rejected on principle — approvals
  are already session-scoped — but it should wait until the "Approve once" bug settles
  what a single approval means.
- **Terminal autocomplete.** A real gap — the terminal is xterm with the fit, search,
  web-links and WebGL addons only — but large, and whether to intercept input at all is
  a product decision for its own proposal.

---

## Open questions

- Whether `write_file` should become a per-call tool, so that item 3's content preview is
  shown for every write rather than only the first per host and session. Owner:
  unassigned; to be decided in the "Approve once" bug task.
- Where competitor analyses live. This note is where DocGov places `note.internal` in the
  full layout; its sibling, the sync security protocol, sits in `docs/plans/` without
  frontmatter. Owner: unassigned.
