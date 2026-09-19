import { describe, it, expect, beforeAll, vi } from 'vitest'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setShellIntegrationRoot, integrationSpawn } from '../src/main/services/shellIntegrationFiles'
import { REMOTE_CWD_BOOTSTRAP, parseOsc7 } from '../src/shared/shellIntegration'
import type { LocalShell } from '../src/shared/local'

/**
 * Raised for this file, the way tests/inspect.test.ts and access.test.ts
 * already do for theirs.
 *
 * These cases SPAWN REAL SHELLS on a real pty and wait for a prompt, which is
 * the whole reason they are worth having — but it puts them within a couple of
 * seconds of the 15s global ceiling on an unloaded machine, and the global
 * limit exists so that a test which should never approach it fails loudly when
 * it does. Lifting it everywhere would turn a hung test somewhere else into a
 * slow one nobody notices.
 */
vi.setConfig({ testTimeout: 60_000 })

/**
 * "Follow terminal" in the Files pane, end to end, through real shells.
 *
 * The bug this covers: the renderer registered an OSC 7 handler and the store
 * had a `tabCwd` keyed per pane, but NOTHING in the app ever emitted OSC 7.
 * Following therefore worked only for someone whose own dotfiles happened to
 * emit it, which is why it read as "the button does nothing".
 *
 * A test that asserted `snippetFor('zsh')` contains the string `133;A` would
 * have passed against the broken code and would pass against a snippet that is
 * syntactically invalid, installs its hook into a variable zsh never reads, or
 * is silently displaced by the user's own precmd. So these tests do not read
 * the snippet: they hand the REAL files and the REAL spawn arguments to a REAL
 * shell on a REAL pty, type `cd` into it exactly as a user would, and require
 * the bytes that come back to survive the renderer's own parser.
 *
 * Two mechanisms, because a local shell and an SSH session are genuinely
 * different problems:
 *
 *   local   the app spawns the shell, so the emitter goes in through its
 *           startup files (integrationSpawn).
 *   remote  nothing here spawns it, so the emitter is typed down the channel
 *           (REMOTE_CWD_BOOTSTRAP). Over SSH those are the same bytes on the
 *           same kind of pty, which is what makes a local pty a fair stand-in.
 */

const POSIX = process.platform !== 'win32'
const ZSH = '/bin/zsh'
const BASH = '/bin/bash'

type Pty = {
  write(d: string): void
  onData(cb: (d: string) => void): unknown
  kill(): void
}

async function loadPty(): Promise<{
  spawn(file: string, args: string[], opts: Record<string, unknown>): Pty
}> {
  const raw = await import('@lydell/node-pty')
  return ((raw as { default?: unknown }).default ?? raw) as {
    spawn(file: string, args: string[], opts: Record<string, unknown>): Pty
  }
}

/**
 * Every OSC 7 payload in a chunk of terminal output, as the renderer sees them.
 *
 * Deliberately routed through `parseOsc7`, the function the renderer uses, so a
 * snippet that emits something xterm would hand over but the parser rejects
 * fails here rather than shipping.
 */
function cwdsReported(out: string): string[] {
  const found: string[] = []
  // ESC ] 7 ; <payload> (BEL | ESC \). Control characters are the subject here,
  // not an accident: this is a terminal escape sequence.
  // eslint-disable-next-line no-control-regex
  for (const m of out.matchAll(/\x1b\]7;([^\x07\x1b]*)(?:\x07|\x1b\\)/g)) {
    // The host field must be EMPTY. macOS ships its own OSC 7 emitter in
    // /etc/zshrc and /etc/bashrc which reports `file://<hostname>/path`; without
    // this the test would pass on a Mac whatever OpsMaxx emitted.
    if (!m[1].startsWith('file:///')) continue
    const p = parseOsc7(m[1])
    if (p) found.push(p)
  }
  return found
}

/** Run a shell, type the lines, and collect everything it printed. */
async function transcript(
  file: string,
  args: string[],
  env: Record<string, string>,
  lines: string[]
): Promise<string> {
  const pty = await loadPty()
  const term = pty.spawn(file, args, {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: '/',
    env
  })
  let out = ''
  term.onData((d) => {
    out += d
  })
  // One line at a time with a beat between: a shell that has not finished
  // sourcing its startup files has not installed the hook yet, and a burst
  // would be read by the line editor before the prompt exists.
  for (const line of lines) {
    await new Promise((r) => setTimeout(r, 400))
    term.write(line)
  }
  await new Promise((r) => setTimeout(r, 1200))
  term.kill()
  return out
}

/**
 * A shell environment with none of the developer's own configuration in it.
 *
 * Not to make the test easier: a machine whose ~/.zshrc opens a prompt
 * framework would hang a pty forever, and the thing under test is OpsMaxx's
 * snippet, not the tester's dotfiles. Everything OpsMaxx itself contributes —
 * the arguments, the ZDOTDIR redirection, the file contents — is left exactly
 * as it ships.
 */
function bareEnv(home: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    TERM: 'xterm-256color',
    // macOS's /etc/zshrc and /etc/bashrc emit their own OSC 7 when this is set,
    // and an OpsMaxx that emitted nothing would inherit the credit.
    TERM_PROGRAM: ''
  }
}

let home = ''
let target = ''

beforeAll(() => {
  setShellIntegrationRoot(mkdtempSync(join(tmpdir(), 'opsmaxx-si-')))
  home = mkdtempSync(join(tmpdir(), 'opsmaxx-home-'))
  // A literal path with no symlink in it: `cd /tmp` on macOS leaves PWD as
  // `/tmp` while the real directory is `/private/tmp`, and a test that asserted
  // either one would be asserting the platform rather than the report.
  target = mkdtempSync(join(tmpdir(), 'opsmaxx-cd-'))
})

function shell(path: string): LocalShell {
  return { id: `test-${path}`, label: path, path, args: [], kind: 'posix' }
}

describe('a local shell reports where it is', () => {
  for (const path of [ZSH, BASH]) {
    it.skipIf(!POSIX || !existsSync(path))(
      `${path} emits OSC 7 on cd, through the real injected startup files`,
      async () => {
        const add = integrationSpawn(shell(path))
        // If this is null the shell was never instrumented at all, which is the
        // original defect wearing a different hat.
        expect(add, `${path} got no integration to spawn with`).not.toBeNull()

        const env = { ...bareEnv(home), ...add!.env }
        // zsh's snippet sources the user's own .zshrc from here. Pointed at an
        // empty directory it finds none, which is a legitimate configuration —
        // the redirection itself, the part that can go wrong, still happens.
        if ('OPSMAXX_USER_ZDOTDIR' in env) env.OPSMAXX_USER_ZDOTDIR = home

        const out = await transcript(path, add!.args, env, [`cd '${target}'\n`])
        const seen = cwdsReported(out)

        expect(seen, `no OSC 7 from ${path}; transcript: ${JSON.stringify(out.slice(-400))}`).not
          .toHaveLength(0)
        expect(seen).toContain(target)
      },
      20_000
    )
  }

  it.skipIf(!POSIX || !existsSync(BASH))(
    'reports nothing extra when integration is not spawned — the plain shell is untouched',
    async () => {
      const out = await transcript(BASH, ['--norc', '--noprofile', '-i'], bareEnv(home), [
        `cd '${target}'\n`
      ])
      expect(cwdsReported(out)).toHaveLength(0)
    },
    20_000
  )
})

describe('a remote shell can be asked, by typing into it', () => {
  // A bare `-i` shell with no startup files is the closest local stand-in for
  // what ssh2 gives us: a pty running the account's login shell, which this app
  // did not spawn and cannot pass arguments or environment to.
  const REMOTE = [
    { path: BASH, args: ['--norc', '--noprofile', '-i'] },
    { path: ZSH, args: ['--no-rcs', '-i'] }
  ]

  for (const { path, args } of REMOTE) {
    it.skipIf(!POSIX || !existsSync(path))(
      `${path} reports its cwd on every prompt after the bootstrap`,
      async () => {
        const out = await transcript(path, args, bareEnv(home), [
          REMOTE_CWD_BOOTSTRAP,
          `cd '${target}'\n`,
          'cd /\n'
        ])
        const seen = cwdsReported(out)
        // Every prompt, not just the first: a bootstrap that reported once and
        // then went quiet is the same broken button with a slower onset.
        expect(seen, `no OSC 7 from ${path} after bootstrap`).toContain(target)
        expect(seen).toContain('/')
      },
      20_000
    )
  }

  /**
   * The bootstrap is typed blind into whatever the far end runs, so a shell it
   * does not fit must be left alone rather than shown a parse error.
   *
   * fish is the one that matters: `f() { … }` is a syntax error there, so the
   * snippet body must never reach fish's parser. It does not, because the body
   * is the argument to an `eval` behind a `test` fish evaluates as false.
   */
  it.skipIf(!POSIX)('is inert in a shell it does not fit', async () => {
    const fish = ['/opt/homebrew/bin/fish', '/usr/local/bin/fish', '/usr/bin/fish'].find((p) =>
      existsSync(p)
    )
    const dash = ['/bin/dash', '/usr/bin/dash'].find((p) => existsSync(p))
    const probe = fish ?? dash
    if (!probe) {
      // Neither is installed here. The property is still asserted, on the
      // artifact rather than on a shell: the whole body lives inside a single
      // pair of quotes, which is what keeps it from being parsed.
      expect(REMOTE_CWD_BOOTSTRAP).toMatch(/&& eval '[^']*'\n$/)
      return
    }
    const args = probe === fish ? ['-i'] : ['-i']
    const out = await transcript(probe, args, bareEnv(home), [REMOTE_CWD_BOOTSTRAP])
    // No complaint about the snippet's syntax, and no claim to be reporting.
    expect(out.toLowerCase()).not.toMatch(/syntax error|unexpected|unsupported use/)
  }, 20_000)
})
