import { spawn } from 'node:child_process'
import { platform } from 'node:process'

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
 * A login shell, because these commands are the ones a user would type.
 *
 * `docker`, `kubectl` and `crontab` routinely live somewhere only a login
 * shell's PATH knows about — Homebrew on Apple silicon, asdf, nix, Docker
 * Desktop's own bin. Electron's own PATH is whatever launchd or the desktop
 * session handed it, which on macOS is frequently just /usr/bin:/bin. Without
 * `-l` the local target would report "docker is not installed" on a machine
 * where the user's terminal runs it fine.
 */
function shellFor(command: string): { file: string; args: string[] } {
  if (platform === 'win32') {
    // PowerShell is present on every supported Windows build, and unlike cmd
    // it does not need its own quoting rules for the command strings the
    // shared builders produce.
    return { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', command] }
  }
  return { file: process.env.SHELL || '/bin/sh', args: ['-l', '-c', command] }
}

export function localExec(command: string, timeoutMs = 30_000): Promise<LocalExecResult> {
  return new Promise((resolve) => {
    const { file, args } = shellFor(command)

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
        env: process.env
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
    child.on('close', (code, signal) =>
      finish({ ok: code === 0, code: code ?? null, signal: signal ?? null })
    )
  })
}
