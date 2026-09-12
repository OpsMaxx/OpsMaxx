# Contributing to OpsMaxx

Thanks for considering a contribution. Bug reports, documentation, translations
and code are all welcome, and you do not need to be an Electron expert to help.

## Getting set up

```bash
git clone https://github.com/OpsMaxx/OpsMaxx.git
cd opsmaxx
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

> The AI/MCP test suite (`tests/`) spawns the compiled CLI at `out/cli/index.js`, so `build` has
> to run before `test` — CI enforces the same order.

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
tests/          vitest suite — currently covers the AI/MCP services end to end
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

The easy way to supply the first two: **Settings → Advanced → Copy diagnostics**
puts a block of text on your clipboard — versions, platform, which features are
on. It holds nothing secret to begin with: it is versions, counts and on/off
states by construction, not a filter run over something larger. Paste that.

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

- **Tests.** `tests/` covers the AI/MCP services end to end, but the rest of the app has no
  coverage yet. The parsers in `shared/sshconfig.ts` and `main/services/relaxed-json.ts` and the
  crypto in `main/services/` are pure and easy to cover.
- **Replacing placeholder UI.** Several Settings controls hold local state and
  do nothing; they are tracked as issues.
- **Accessibility.** Keyboard navigation and screen-reader labels.
- **Documentation and translations.**

## Licence

By contributing you agree that your work is licensed under the
[MIT Licence](LICENSE) that covers this project.
