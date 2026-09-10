# Working on OpsMaxx

The app and the GitHub repo are both `OpsMaxx` — the slug is `OpsMaxx/OpsMaxx`.
The product's former name is retired everywhere, including in URLs, and
`tests/branding.test.ts` fails the build if any spelling of it reappears. That test
is the authority; this file deliberately does not repeat the word, so that the
check can run with no exemptions at all.

**Never create a repository at this project's previous name.** GitHub left a 301
there when it was renamed, and that redirect is what keeps every already-published
release-asset URL working. A repository at the old name replaces the redirect and
breaks all of them permanently. Nothing needs the old name for any other reason —
if you find yourself wanting to type it, you are working around the rename rather
than finishing it.

## Release surfaces

Shipping a version touches more than this repo. Pushing a `v*` tag starts it:

| Surface | Where | Automated? |
|---|---|---|
| Installers, scans, notes | `.github/workflows/release.yml` | **Yes** — on tag push |
| opsmaxx.dev download links | `OpsMaxx/opsmaxx.dev` | **Yes** — deploy hook, then daily cron |
| Homebrew cask | `OpsMaxx/homebrew-tap` | **Yes** — dispatch on release, then daily cron |
| winget manifest | `packaging/winget/` here | **No** — hand-written PR each version |
| `@opsmaxx/mcp` on npm | `OpsMaxx/opsmaxx-mcp` | **No** — but only when the bridge changes |
| MCP registry entry | `OpsMaxx/opsmaxx-mcp` `server.json` | **No** — follows an npm publish |

So a routine release is: **tag, then open the winget PR.** Everything else lands on its own.

### What the release workflow does

Builds all three platforms, scans (ClamAV over every artifact, Defender on the Windows
installer, VirusTotal on `.exe` and `.dmg` **only** — Linux artifacts are not
VirusTotal-scanned, so do not claim they are), publishes the notes with a SHA-256 table,
then pings the Cloudflare Pages deploy hook.

then tells the Homebrew tap and the site to update.

Both notifications are skipped for prereleases and neither can fail the run — the release
is already public by then, and both surfaces have a daily cron as a backstop. They need
`CF_PAGES_DEPLOY_HOOK` and `TAP_DISPATCH_TOKEN` on this repo.

`TAP_DISPATCH_TOKEN` has to be a token that can reach **the other repository**:
`github.token` is scoped to this one and a cross-repo `repository_dispatch` with it
returns 404. Without the secret the cask still updates, just on its own schedule — which
is the state that made this worth wiring. The tap has carried the
`repository_dispatch: [opsmaxx-release]` trigger since it was written and nothing ever
sent it, so `brew install` could hand someone a build up to a day old with no hint a
newer one existed. Seven releases went out in one evening and the cask sat four versions
behind the whole time.

### The site reads releases at build time

`opsmaxx.dev/src/lib/releases.ts` resolves the latest release **when the site builds**, so
the site has to rebuild for a new version to appear. Three layers: the GitHub API, then a
no-API path (`/releases/latest` redirects to the tag, asset names follow
electron-builder's scheme, a `HEAD` gives each size), then the releases page. The
unauthenticated API allows 60 requests/hour per IP and Cloudflare's builders share IPs, so
layer 2 exists because layer 1 genuinely failed in production. Setting `GITHUB_TOKEN` in
the Pages environment makes layer 1 reliable. The chosen layer is printed in the build log.

The site is deployed as an **assets-only Worker**, not classic Pages: `wrangler.jsonc`
declares `assets.directory` and `not_found_handling: "404-page"`. Without that file
`wrangler deploy` tries an interactive `astro add cloudflare` and every deploy fails while
the build still reports success — check the Cloudflare dashboard, not just `git push`.

## Running the tests

`npm run build` first, or three integration tests skip: `cliPairing` and
`connectAgent` spawn `out/cli/index.js` as a real MCP server, and it is a build
artifact. CI builds before it tests, so they only skip locally, and they say so
when they do. A fresh git worktree also has no `node_modules` of its own —
dependencies live at the main checkout — so anything resolving a package should
ask the resolver rather than assume a relative path.

## Traps that have already cost time

- **`tests/releaseWorkflow.test.ts` ratchets the release job.** Every inline `run` step
  must be listed in `CEILING` with a line limit. Adding a step without registering it
  turns `main` red.
- **winget calls NSIS `nullsoft`**, not `nsis`. `ReleaseDate` must be quoted or a YAML
  parser hands the schema a date object. `Scope: user`, because `nsis.perMachine` is
  `false`. Validate against the published v1.6.0 JSON schemas before opening a PR.
- **Homebrew's main cask repo has a notability threshold** (~75 stars) this project does
  not meet, hence the own tap. Third-party taps also need `brew trust` before they load —
  say so in any install instructions.
- **The MCP registry is case-sensitive**: the namespace is `io.github.OpsMaxx`, matching
  the org's exact login. `mcpName` in the npm package must equal the server name exactly,
  and it lives inside the tarball, so fixing it needs a version bump. Descriptions are
  capped at 100 characters.
- **`mcp-publisher login github` (device flow) only grants your personal namespace.** Org
  namespaces need `read:org`, which that flow does not request. Use
  `mcp-publisher login github --token "$(gh auth token)"`.

## Claims about the product

This repo is public and the audience checks things. Two claims that were wrong on the site
and had to be corrected: "sudo is refused" (only escalation *shells* — `sudo -i`, `su`,
`sudo bash` — are refused; `sudo -n` is used for privileged reads and is on by default),
and "every release is scanned by 70+ engines" (VirusTotal covers `.exe` and `.dmg` only).

Verify against `src/`, not the README, before repeating a security claim.
