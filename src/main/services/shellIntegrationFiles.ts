import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LocalShell } from '../../shared/local'
import {
  integrationFor,
  snippetFor,
  zshPassthrough,
  type IntegrationShell
} from '../../shared/shellIntegration'

/**
 * Materialises the shell-integration snippets and says how to start a shell
 * that reads them.
 *
 * The snippet TEXT is a compile-time constant in shared/shellIntegration.ts.
 * This module only writes it somewhere and produces the args and env that make
 * a shell source it — the split is deliberate, so the thing a shell executes is
 * reviewable without reading any of the plumbing below.
 *
 * ── Per-shell mechanism, and what is deliberately not attempted ────────────
 *
 * zsh   ZDOTDIR points at our directory; our .zshrc sources the user's own
 *       first, from the real ZDOTDIR handed through in an env var. Crucially we
 *       also write .zshenv/.zprofile/.zlogin passthroughs, because ZDOTDIR
 *       redirects the WHOLE startup chain — a user who sets PATH in ~/.zshenv
 *       would otherwise lose it silently.
 * bash  `--init-file`, which sources our file INSTEAD of ~/.bashrc — so ours
 *       sources theirs. Non-login only: `bash -l` ignores --init-file entirely,
 *       and the workaround is re-implementing bash's profile chain, which would
 *       break the macOS login-PATH behaviour shellDiscovery documents. A login
 *       bash therefore gets no integration, on purpose.
 * fish  A `vendor_conf.d` file under an XDG_DATA_DIRS entry, which fish sources
 *       on its own without displacing anything. `vendor_conf.d` and not
 *       `conf.d`: the latter is read from the user's own config directory, not
 *       from XDG_DATA_DIRS.
 *
 * Everything else — cmd, PowerShell, WSL — gets nothing. That is a supported
 * outcome, not a failure: the renderer simply never sees a prompt mark and
 * leaves the features that depend on one switched off.
 */

let root: string | null = null

/**
 * Where the snippets live. Told once at boot rather than read from `electron`
 * here, so this module stays importable by a test without a stubbed app.
 */
export function setShellIntegrationRoot(dir: string): void {
  root = join(dir, 'shell-integration')
}

export interface SpawnAdditions {
  args: string[]
  env: Record<string, string>
}

/** Written once per app run, then reused; the content is a constant. */
const written = new Set<IntegrationShell>()

function ensure(shell: IntegrationShell): string | null {
  if (!root) return null
  /**
   * `vendor_conf.d`, NOT `conf.d`.
   *
   * fish reads `conf.d` from the USER's config directory and its own data
   * directory; what it reads from every XDG_DATA_DIRS entry is
   * `<entry>/fish/vendor_conf.d`. The first version wrote to `conf.d` under an
   * XDG_DATA_DIRS entry, which fish never looks at — so fish integration was
   * silently inert while Settings said it was on.
   */
  const dir = shell === 'fish' ? join(root, 'fish', 'fish', 'vendor_conf.d') : root
  const file =
    shell === 'zsh' ? join(root, '.zshrc') : shell === 'fish' ? join(dir, 'opsmaxx.fish') : join(root, 'bash-init.sh')
  if (written.has(shell)) return file
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, snippetFor(shell), { encoding: 'utf8', mode: 0o600 })
    if (shell === 'zsh') {
      /**
       * The rest of zsh's startup chain, handed back to the user's own files.
       *
       * ZDOTDIR redirects ALL of `.zshenv`, `.zprofile`, `.zshrc` and
       * `.zlogin`, not just the one we wrote. Without these three, a user who
       * sets PATH in `~/.zshenv` — the file zsh's documentation recommends for
       * it — silently loses it in every shell this app opens.
       */
      for (const f of ['.zshenv', '.zprofile', '.zlogin'] as const) {
        writeFileSync(join(root as string, f), zshPassthrough(f), {
          encoding: 'utf8',
          mode: 0o600
        })
      }
    }
    written.add(shell)
    return file
  } catch {
    // A snippet we cannot write is a session WITHOUT integration, never a
    // session that fails to start. The shell is the product; the marks are a
    // convenience layered on it.
    return null
  }
}

/**
 * What to add to a shell's spawn so it emits OSC 133, or null for "nothing to
 * add" — an unsupported shell, a login bash, or a failed write.
 *
 * `login` is the caller's read of the shell's own args, not a guess: a shell
 * configured with `-l`/`--login` is one whose startup chain we must not
 * displace.
 */
export function integrationSpawn(shell: LocalShell): SpawnAdditions | null {
  const kind = integrationFor(shell.kind, shell.path)
  if (!kind) return null

  // `bash -l` ignores --init-file, so injecting it would look like it worked
  // and silently do nothing. Say no instead of pretending.
  const login = shell.args.some((a) => a === '-l' || a === '--login')
  if (kind === 'bash' && login) return null

  const file = ensure(kind)
  if (!file) return null

  switch (kind) {
    case 'zsh':
      return {
        args: [],
        env: {
          // The user's real ZDOTDIR, so our .zshrc can source their config.
          // ZDOTDIR is frequently unset, in which case zsh uses HOME — so that
          // is what we hand through, rather than an empty string.
          OPSMAXX_USER_ZDOTDIR: process.env.ZDOTDIR || process.env.HOME || '',
          ZDOTDIR: root as string
        }
      }
    case 'bash':
      // An args ARRAY, so the path is never shell-parsed however it is spelled.
      return { args: ['--init-file', file], env: {} }
    case 'fish':
      return {
        args: [],
        env: {
          // Prepended, keeping the system entries: replacing XDG_DATA_DIRS
          // outright would hide every other package's fish completions.
          XDG_DATA_DIRS: [
            join(root as string, 'fish'),
            process.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share'
          ].join(':')
        }
      }
  }
}
