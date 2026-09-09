import { spawn } from 'node:child_process'
import { platform } from 'node:process'
import { windowsPosixShell } from './shellDiscovery'

/**
 * Runs one command on THIS machine, with the same result shape as sshExec.
 *
 * Docker, Kubernetes, cron, host facts and the rest already take their command
 * runner by injection, so a local target needs no change inside any of them —
 * only a second implementation of the function they were already calling. That
 * is what this is.
 *
 * ── Why this module is quarantined ──────────────────────────────────────────
 *
 * This must never become reachable from the MCP bridge or the CLI. An agent
 * that can run a command on this machine can read the vault file, the policy
 * store and the audit log that are supposed to constrain it — the same
 * reasoning that keeps the local terminal off those surfaces, and for the same
 * reason it is enforced by reachability rather than by a capability check.
 *
 * tests/localTerminalNotExposed.test.ts walks the import closure of
 * mcpServer.ts and everything under src/cli, and fails if this module's
 * basename appears anywhere in it. The dispatch that chooses between this and
 * sshExec therefore lives in main's renderer-facing IPC handlers, never in a
 * helper the agent-facing entry points also import.
 *
 * If that test fails after a change here: the failure is the feature. Move the
 * helper that pulled this in, do not relax the assertion.
 */

/** Matches sshExec's ExecResult so an injected reader cannot tell the two apart. */
export interface LocalExecResult {
  ok: boolean
  stdout: string
  stderr: string
  code: number | null
  signal: string | null
  error?: string
  truncated: boolean
  elided: number
}

/** The same per-stream cap sshExec applies, for the same reason. */
const OUTPUT_CAP = 200_000

/**
 * The user's login PATH, resolved once.
 *
 * `docker`, `kubectl` and `crontab` routinely live somewhere only a login
 * shell's PATH knows about — Homebrew on Apple silicon, asdf, nix, Docker
 * Desktop's own bin. Electron's own PATH is whatever launchd or the desktop
 * session handed it, which on macOS is frequently just /usr/bin:/bin, so
 * without this the local target reports "docker is not installed" on a machine
 * whose terminal runs it fine.
 *
 * Resolved through the login shell but NOT used to run the commands — see
 * runShell for why that distinction is load-bearing.
 */
let loginPath: string | null = null

async function resolveLoginPath(): Promise<string> {
  if (loginPath !== null) return loginPath
  const shell = process.env.SHELL
  if (!shell || platform === 'win32') {
    loginPath = process.env.PATH ?? ''
    return loginPath
  }
  loginPath = await new Promise<string>((resolve) => {
    let out = ''
    const child = spawn(shell, ['-l', '-c', 'printf %s "$PATH"'], { windowsHide: true })
    const done = (value: string): void => {
      clearTimeout(timer)
      resolve(value.trim() || process.env.PATH || '')
    }
    // A login shell that hangs on a slow profile must not wedge every read.
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      done('')
    }, 5000)
    child.stdout?.on('data', (c: Buffer) => (out += c.toString('utf8')))
    child.on('error', () => done(''))
    child.on('close', () => done(out))
  })
  return loginPath
}

/**
 * The POSIX shell to use on Windows, resolved once.
 *
 * `undefined` means "not looked yet"; `null` means "looked, and there is none".
 * The lookup reads the registry, so it is worth not repeating per command.
 */
let winShell: string | null | undefined

async function resolveWinShell(): Promise<string | null> {
  if (winShell === undefined) winShell = await windowsPosixShell()
  return winShell
}

export const NO_POSIX_SHELL =
  'Reading this machine needs a POSIX shell, which was not found. Install Git for Windows (or MSYS2) and try again.'

/**
 * A POSIX shell, with the login shell's PATH handed to it on Unix.
 *
 * The commands come from the shared builders in src/shared, which are written
 * for the POSIX shell that `ssh host 'command'` lands in. Running them under
 * the user's own interactive shell is not equivalent, and the difference is not
 * cosmetic: zsh sets `nomatch` by default, so an unquoted glob that sh passes
 * through as a literal makes zsh abort the command instead. The Kubernetes
 * reader's `custom-columns=…containerStatuses[*].ready…` is exactly that shape,
 * and under zsh it failed with "no matches found" while the same string works
 * on every server in the estate.
 *
 * So: the login shell answers "what is on PATH", and sh runs the command.
 */
function runShell(
  command: string,
  path: string,
  shell: string | null
): { file: string; args: string[]; env: NodeJS.ProcessEnv } {
  if (platform === 'win32') {
    /**
     * A real POSIX shell, NOT PowerShell.
     *
     * This used to spawn `powershell.exe -Command <command>`, and the commands
     * come from the shared builders in src/shared, which are written for the
     * shell `ssh host 'command'` lands in. PowerShell has no `command -v`, does
     * not chain with `&&`/`||`, and does not understand `2>/dev/null` — so
     * every local Docker, Kubernetes and Compose read on Windows failed, and
     * failed in the worst possible way: the probe returned nothing, and
     * "nothing" is exactly what the parsers read as "it is not installed".
     * A Windows user was told their own Docker Desktop was absent.
     *
     * `shell` is non-null here because localExec refuses before calling this.
     */
    return {
      file: shell as string,
      args: ['-c', command],
      // Not the login PATH: that was resolved through $SHELL, which on Windows
      // is not this bash. Git Bash builds its own PATH from /etc/profile.
      env: process.env
    }
  }
  return { file: '/bin/sh', args: ['-c', command], env: { ...process.env, PATH: path } }
}

export async function localExec(command: string, timeoutMs = 30_000): Promise<LocalExecResult> {
  const path = await resolveLoginPath()
  const shell = platform === 'win32' ? await resolveWinShell() : null
  if (platform === 'win32' && !shell) {
    // Said plainly, once, rather than letting every parser conclude the tool
    // being probed is missing. `ok: false` is right: the command genuinely did
    // not run, which is what a reader treats as "could not reach this target".
    return {
      ok: false,
      stdout: '',
      stderr: '',
      code: null,
      signal: null,
      error: NO_POSIX_SHELL,
      truncated: false,
      elided: 0
    }
  }
  return new Promise((resolve) => {
    const { file, args, env } = runShell(command, path, shell)

    let stdout = ''
    let stderr = ''
    let elided = 0
    let settled = false

    const finish = (result: Partial<LocalExecResult> & { ok: boolean }): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        stdout,
        stderr,
        code: null,
        signal: null,
        truncated: elided > 0,
        elided,
        ...result
      })
    }

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(file, args, {
        // No shell:true — the command is already going to a shell as a single
        // argument, and letting the OS layer parse it too would mean two
        // rounds of quoting for one command string.
        shell: false,
        windowsHide: true,
        env
      })
    } catch (err) {
      return finish({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ ok: false, error: `Timed out after ${timeoutMs}ms`, signal: 'SIGKILL' })
    }, timeoutMs)

    /** Caps a stream and counts what was dropped, as sshExec does. */
    const append = (current: string, chunk: Buffer): string => {
      if (current.length >= OUTPUT_CAP) {
        elided += chunk.length
        return current
      }
      const text = chunk.toString('utf8')
      const room = OUTPUT_CAP - current.length
      if (text.length <= room) return current + text
      elided += text.length - room
      return current + text.slice(0, room)
    }

    child.stdout?.on('data', (c: Buffer) => (stdout = append(stdout, c)))
    child.stderr?.on('data', (c: Buffer) => (stderr = append(stderr, c)))

    child.on('error', (err) => finish({ ok: false, error: err.message }))
    /**
     * `ok` means the command RAN, not that it succeeded — the same meaning
     * sshExec gives it, which is the whole point of this module matching its
     * shape.
     *
     * This used to be `code === 0`, and the divergence was not cosmetic. Every
     * injected reader is written against the SSH meaning: DockerReader.attempt
     * routes `!ok` to `onTransportFailure` precisely so that "docker is not
     * installed" is never reported for a host that was simply unreachable. Under
     * `code === 0` a local `docker ps` with the daemon stopped exited non-zero,
     * took that branch, and told the user their own machine "could not be
     * reached" — while discarding the stdout that would have classified it. It
     * also made the sudo failover dead code locally, since that only retries a
     * `permission-denied` reason the parser never got the chance to produce.
     *
     * A shell that cannot find the binary exits 127 through this same path, so
     * the exit code reaches the parser and stays the classifier it already is
     * for remote hosts. Genuine run failures — spawn refused, timeout — are
     * still `ok: false` with `error` set, as they are in sshExec.
     */
    child.on('close', (code, signal) =>
      finish({ ok: true, code: code ?? null, signal: signal ?? null })
    )
  })
}
