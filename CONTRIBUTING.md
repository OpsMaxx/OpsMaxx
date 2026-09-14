# Contributing to OpsMaxx

Thanks for considering a contribution. Bug reports, documentation, translations
and code are all welcome, and you do not need to be an Electron expert to help.

## Getting set up

```bash
git clone https://github.com/OpsMaxx/OpsMaxx.git
cd OpsMaxx
npm install
npm run dev
```

Requires **Node.js 20+**.

Before opening a pull request:

```bash
npm run typecheck    # must pass — main, preload and renderer
npm run build        # must succeed — must run before `test`, see note below
npm run test         # must pass
```

> A few integration tests spawn the compiled CLI at `out/cli/index.js` as a real MCP server, and
> that is a build artifact — so `build` has to run before `test` or they skip, saying so. CI
> enforces the same order.

Build installers on the platform you are targeting — a Windows installer has to
be built on Windows.

> Working in WSL? Note that `node_modules` is platform-specific. If you run
> `npm install` in Windows and then build in WSL (or vice versa) you will get
> errors about missing `@rollup/rollup-*` or `@esbuild/*` binaries. Delete
> `node_modules` and reinstall in whichever environment you are building from.

## Architecture

OpsMaxx is Electron + React + TypeScript, built with electron-vite. Three
processes, three source trees:

```
src/
  main/         Node.js. Owns all I/O: SSH, SFTP, databases, crypto, files.
    services/   One module per subsystem — includes the AI/MCP bridge
                (mcpServer.ts, mcpAuth.ts, policyEngine.ts, approvals.ts, ...)
  preload/      The only bridge between main and renderer. Defines the IPC API.
  renderer/     React UI. No Node access at all.
    src/
      components/   Feature-grouped UI — components/ai/ is the AI & MCP settings panel
      store/        zustand state (app.ts) and persistence (persist.ts)
      hooks/        Shortcuts, metrics polling, click-outside
      lib/          Small shared helpers
  shared/       Types and pure functions used by more than one process
  cli/          The `opsmaxx` CLI launcher (pairing, bridge, per-client registration),
                compiled separately to out/cli/ and wrapped by bin/opsmaxx.{cmd,sh}
tests/          vitest suite — ~386 files across the whole app, not just the AI/MCP
                bridge. Assume your change needs one
```

Working on the AI/MCP bridge specifically? [docs/AI-MCP.md](docs/AI-MCP.md) covers its
architecture, and [docs/AI-SECURITY.md](docs/AI-SECURITY.md) covers the security model any change
there needs to preserve.

### Rules that keep it safe

1. **Secrets never reach the renderer.** The UI sends a `serverId`; the main
   process merges credentials from the encrypted store. Do not pass passwords
   or key material through IPC in the other direction.
2. **The renderer has no Node access.** `contextIsolation` is on,
   `nodeIntegration` is off. Everything goes through `preload/index.ts`.
3. **Never `eval` user input.** Shell and query input is parsed — see
   `main/services/relaxed-json.ts` for the pattern.
4. **Write files atomically.** Temp file plus rename, so a crash cannot
   truncate a user's data. See `main/services/vault.ts`.
5. **Build SSH hop lists with `sshHopsFor()`** in `renderer/src/lib/ssh.ts`.
   Hand-rolling that mapping is how hops end up with no credentials.
6. **Anything the app produces for a user to send outward goes through
   `redactOutput()`** in `main/services/secretRedaction.ts` — a log line, an
   audit entry, captured command output, anything destined for a clipboard or an
   issue. Redact at the writer, not at the display, so the stored copy is
   already clean.

   The **diagnostics block** shows both halves of this. Its own fields need no
   pass: every one is a version string, a count or a boolean, so there is
   nothing in the type for `redactOutput()` to act on. Its crash fields are the
   opposite — an `Error` the app did not write, so `main/services/diagnostics.ts`
   runs each through `redactOutput()` and only then caps it, and
   `scrubPaths()` cuts file paths to basenames on top of that. Redact before
   capping, never after: a cap can cut the END marker off a PEM block, and the
   private-key pattern then matches nothing.

   That split is also the rule for extending it. A field whose value the app
   composes itself belongs in `Diagnostics` as it is; a field carrying text from
   somewhere else needs a pass, and needs to say so. Neither removes the
   reader's job — `redactOutput()` has no hostname rule, so a crash message can
   still name a host, which is why the crash screen shows the text before it
   copies anything. The comment at the top of `shared/diagnostics.ts` is the
   long version.

### Things worth knowing

- **Connections are pooled.** `main/services/ssh.ts` keeps one authenticated
  connection per hop, shared by terminals, SFTP and metrics. This is what makes
  two-factor auth bearable. If you add a feature that opens SSH, use
  `acquire()` / `release()` — never `openChain()` directly.
- **Every tab stays mounted.** Views hide with `display: none` rather than
  unmounting, so sessions survive switching tabs, views and workspaces. If you
  add background work (polling, timers), gate it on **visibility**, not on
  being rendered.
- **State shape changes need a migration.** `replaceAll` in `store/app.ts`
  normalises older saved data. Add a default there rather than assuming a
  field exists.

## Making a change

1. Fork, then branch from `main`: `git checkout -b fix/short-description`
2. Keep the change focused — one problem per pull request
3. Match the surrounding style; comments explain **why**, not what
4. Run `npm run typecheck` and `npm run build`
5. Describe what you changed, why, and how you tested it

### Commit messages

Conventional commits, please:

```
fix(ssh): carry key path onto jump hops
feat(vault): search across custom fields
docs(readme): document folder drag and drop
```

## Reporting bugs

A good report includes:

- OpsMaxx version and how you installed it
- OS and version
- What you did, what you expected, what happened
- The exact error text, if there is one
- Whether it involves a jump host, two-factor auth, a tunnel, a VPN profile,
  the local terminal or the AI & MCP bridge — those paths have the most moving
  parts
- A screenshot or a short recording, for anything about how something looks.
  Six of this project's fixes were diagnosed from a picture of the running app
  and could not have been from prose

### The bug button

There is a **bug icon in the left rail**, above the gear, and on `Ctrl+K` as
"Report a bug". It collects the report, shows it to you, and opens the issue
form with your version and OS already filled in. Nothing is written or sent
until you have read it and pressed the button underneath.

For anything that **fails, misbehaves or hangs**, do this first:

1. Press the bug button and choose **Start recording**. It closes and gets out
   of the way; the bug icon keeps a dot while it runs.
2. Make the bug happen again. Restarting OpsMaxx is fine — the recording
   survives it.
3. Press the bug button again. That stops the recording and builds the report.
4. **Save report…**, then drag the saved file into the issue.

Every step is on the bug button. You never have to go and find a setting first,
which is deliberate: the version of this that began "open Settings → Advanced"
is the one nobody used.

Without step 1 the report still carries your versions, counts and feature
states, which is enough for a good many bugs. With it, the report also carries
which internal operations ran, how long each took and which ones failed —
which is the difference between "the tunnel panel is empty" and a line saying
what the tunnel list call actually returned.

Settings → Advanced shows how big the recording has got and has a **Delete**
button, but it is not how you start one.

**What a debug trace contains.** Channel names, timings and error text. Never
the arguments to a call, so passwords, passphrases and key material are not in
it by construction rather than by filtering. Secret-shaped strings are stripped
before anything is written. **Hostnames, usernames, file paths and command text
are not**, and cannot be — no rule tells a hostname from an ordinary word. That
is why the app shows you the whole report before it writes it. Read it, and
delete any line you would rather not publish.

**Settings → Advanced → Copy diagnostics** is still there and is still the right
answer when all that is wanted is the version block: it holds nothing secret to
begin with — versions, counts and on/off states by construction, not a filter
run over something larger.

Anything you paste **by hand** still needs **hostnames, usernames, keys and IPs
taken out** first. Attach a long log as a file rather than pasting it: an
attachment is inert, while pasted text renders as Markdown and is read by
automation, and output captured from a remote host is whatever that host chose
to print.

## Suggesting features

Open a discussion or an issue describing the problem you hit, not only the
solution you have in mind. The [issue tracker](https://github.com/OpsMaxx/OpsMaxx/issues)
lists what is already planned, and the roadmap is kept there.

## Where help is most needed

- **Tests.** The suite is broad — 448 files — so the useful contribution is
  usually a case nobody thought of rather than a first test for a bare module:
  the input that lands in the wrong branch, the platform that answers
  differently, the failure that currently reads as a success.
- **Replacing placeholder UI.** Three Settings pages — Connections, SFTP and
  Notifications — still fall through to a generic "Reset this section" row whose
  button toasts that there is nothing to reset. Each wants the real controls its
  page name promises.
- **Accessibility.** Keyboard navigation and screen-reader labels.
- **Documentation and translations.**

## Licence

By contributing you agree that your work is licensed under the
[MIT Licence](LICENSE) that covers this project.
