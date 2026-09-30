---
docgov:
  id: screenshot-demo
  type: engineering.development
  authority: audience
  audience:
    - engineering
  visibility: internal
  status: draft
  generation:
    mode: human-maintained
---
# Screenshot demo

> Development Guide. Written for its reader, not for the architecture. Link depth rather than embedding it. Keep it under 500 lines; 800 triggers review.

The screenshots on opsmaxx.dev come from a development build running against an
invented estate: fifteen servers, three workspaces, a vault, an AI audit log and
a pending approval. No network is used. Every SSH connection is answered by a
fake client, and the app's own parsers turn those answers into what the screens
show, so each shot is the real renderer drawing real (invented) data.

## Prerequisites

- A development checkout with `npm install` done. The demo is not in any
  release: a production build does not contain it, and a packaged app ignores
  the variables below.
- macOS may ask for keychain access the first time. Seeding writes the vault and
  the audit chain's head through the OS secure store, as a real install does.

## Setup

Nothing to set up. `scripts/demo.mjs` wipes and re-seeds a profile in the OS
temp directory on every run, so a shot never depends on what the last run left.

The profile is **never** the real one. A development run shares its data
directory with an installed OpsMaxx, and seeding writes the data file, the vault
and the audit log, so `src/main/demoGuard.ts` refuses the real path and
`src/main/demo/index.ts` checks that every file resolved inside the demo profile
before it writes anything.

## Running

```sh
npm run demo                 # open the invented estate and click around
npm run demo:shots [outdir]  # walk every screen, save the PNGs, quit (default out/shots)
```

`demo:shots` takes about two minutes and opens a window while it runs. Each
shot is 1800×909, the site's 99:50 frame. The walk, and which screen each file
is, lives in `src/main/demo/shots.ts`. The site turns them into its webp
variants with its own `scripts/shots.mjs`.

The locked workspace and the vault use the password `demo-password`.

Where things live, in `src/main/demo/`:

| File | What it holds |
|---|---|
| `fixtures.ts` | The servers, workspaces and files. Invented names, RFC 1918 and `203.0.113.0/24` addresses, `example.com` domains only: this repo and every screenshot are public. |
| `responder.ts` | What each probe prints: metrics, host facts, Docker, kubectl, posture. The output is in the exact format the real command produces. |
| `fakeSsh.ts` | The stand-in SSH client: exec, an interactive shell, a small SFTP. |
| `seed.ts` | Fills a fresh profile through the app's own services. |
| `index.ts` | Installs the above, fakes the few non-SSH channels (database queries, HTTP) and keeps "This machine" out of the posture panel. |
| `capture.ts`, `shots.ts` | The walk and the capture. |

## Testing

`tests/demoMode.test.ts` pins the three properties that matter:

- a packaged app never enters the demo;
- the real profile is refused;
- the production bundle contains none of it. This check runs in CI only,
  because any development run, including `npm run demo`, writes a
  development bundle to `out/`.

The screens themselves are not asserted. The capture is the check: open the
PNGs.

## Troubleshooting

- **A shot is missing.** Its step failed; the run names it and saves the whole
  window as `_failed-<name>.png`. Usually a button was renamed: steps find
  controls by the words on screen.
- **A panel is empty.** A probe the responder does not recognise was answered
  with nothing, and logged once as `[demo] no canned answer for: ...` in the
  terminal that ran `npm run demo`. Add its output to `responder.ts` in the
  format that command prints.
- **`[demo] refusing to start`.** A file resolved outside the demo profile.
  Something now evaluates before `portable.ts`. Do not work around it; find what
  moved. The demo module must stay a static import directly after
  `portable.ts` in `src/main/index.ts`.
