import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { ChildProcess } from 'node:child_process'
import { VpnError } from '../errors'
import { captureStderr } from './stderrCapture'
import type {
  ElevatedProcess,
  ElevationExit,
  ElevationProbe,
  ElevationRequest,
  Elevator
} from './index'

// macOS elevation is `osascript -e 'do shell script "…" with administrator
// privileges'` and nothing else.
//
// The Apple dialog collects the password; OpsMaxx never sees it, never
// stores it and never transports it. That is the whole reason to go through
// AppleScript rather than pipe a password into `sudo -S` ourselves.
//
// KNOWN LIMIT: this gives you root. It does not give you the user's
// authorization session.
//
// `do shell script … with administrator privileges` has the security framework
// start the command, detached, outside the login session that authenticated
// it. Anything that only needs uid 0 — writing a file, binding a low port,
// configuring an interface — works exactly as it would under `sudo`. Anything
// that goes through the Security server on behalf of a *session* may be
// dropped, and dropped quietly.
//
// Measured, on macOS 15.7.3 (Darwin 24), Mosyle-managed, while chasing a
// traffic-inspector bug (the long version is in
// `src/main/services/inspectTrust.ts`, above `darwinAdminTrustScript`):
//
//   sudo security add-trusted-cert -d -r trustRoot -p ssl \
//        -k /Library/Keychains/System.keychain <cert>
//
// run in Terminal wrote the admin trust setting and `verify-cert -p ssl` then
// exited 0. The identical command through this elevator imported the
// certificate into the system keychain, wrote NO trust setting, and exited 0
// anyway. Same command, same machine, same minute.
//
// So: never treat exit 0 from this route as proof that a Security-framework
// change landed. Verify the state you wanted, from a process running as the
// user, and have a route that does not need this elevator at all when the
// verification fails.
//
// NOT SMJobBless. NOT a launchd privileged helper. NOT a setuid binary.
// All three require a Developer ID certificate this project does not have —
// electron-builder.yml signs ad-hoc (`identity: '-'`) and does not notarize,
// so a privileged helper would either fail to install or install unsigned code
// as root. This is not a preference that can be tuned later by someone who
// thinks the prompt is annoying; it is forced by the signing situation, and it
// changes only when a certificate exists.

const OSASCRIPT = '/usr/bin/osascript'

// AppleScript's "user cancelled" error. `do shell script` surfaces it when the
// authentication dialog is dismissed, and it also covers the case where the
// user gives up after three wrong passwords.
const USER_CANCELLED = -128

// stderr is only read to classify the failure, so a runaway writer must not be
// allowed to grow the buffer without bound.
const STDERR_CAP = 8 * 1024

let cached: ElevationProbe | null = null

export function resetDarwinProbe(): void {
  cached = null
}

/** POSIX single-quote escaping: everything inside the quotes is literal, and
 *  an embedded quote closes, escapes and reopens.
 *
 *  This is a command-injection boundary, not a formatting nicety. The string
 *  built here is handed to /bin/sh by `do shell script`, so an unquoted
 *  `$(…)`, backtick, newline or semicolon in a path or argument would run as
 *  the user's own shell code — and a path containing a space is the common
 *  case, not the exotic one. */
export function posixQuote(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`
}

/** AppleScript string literal escaping. Applied to the already-shell-quoted
 *  command, because the text passes through two parsers: osascript's, then
 *  /bin/sh's. A literal cannot contain a raw newline, so control characters
 *  become their escapes rather than being dropped. */
export function appleScriptQuote(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
  return `"${escaped}"`
}

// An environment variable name cannot be quoted — it sits to the left of the
// `=` where the shell parses it as syntax — so a name that is not a plain
// identifier is refused rather than escaped.
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** The /bin/sh command line that `do shell script` will run. */
export function buildShellCommand(req: ElevationRequest): string {
  const parts: string[] = []
  if (req.cwd) parts.push('cd', posixQuote(req.cwd), '&&')
  for (const [name, value] of Object.entries(req.env ?? {})) {
    if (!ENV_NAME.test(name)) {
      throw new VpnError('config-invalid', `${name} is not a usable environment variable name.`)
    }
    parts.push(`${name}=${posixQuote(value)}`)
  }
  // exec replaces the shell, so the pid the caller sees belongs to the engine
  // and not to a shell that happens to be waiting on it.
  parts.push('exec', posixQuote(req.command), ...req.args.map(posixQuote))
  return parts.join(' ')
}

/** The exact argv handed to osascript. Exported because the escaping above is
 *  the security-critical part of this file and is asserted directly in tests.
 *
 *  `req.reason` is not in the script: `do shell script` takes no prompt
 *  parameter, so macOS always says "osascript wants to make changes". The
 *  reason still belongs on the interface — Windows and polkit can show it —
 *  and OpsMaxx shows it in its own UI before this is ever called. */
export function buildOsascriptArgs(req: ElevationRequest): string[] {
  const script = `do shell script ${appleScriptQuote(buildShellCommand(req))} with administrator privileges`
  return ['-e', script]
}

/** osascript's own framing around an AppleScript error. The two numbers are
 *  character offsets into the script we generated, which is noise to everyone;
 *  what follows them is the error's message. Optional because the offsets are
 *  the one part of the shape not worth depending on. */
const OSASCRIPT_FRAMING = /^\s*(?:\d+:\d+:\s*)?(?:execution|syntax) error:\s*/

/** What the failed command complained about, as far as this route can know it.
 *
 *  `do shell script` raises an AppleScript error whose message is the command's
 *  stderr — or, when stderr was empty, a generic sentence of AppleScript's own.
 *  osascript prints that as `0:117: execution error: <message> (<status>)`,
 *  joining a multi-line stderr with CR, because CR is AppleScript's line
 *  separator and not a character anything downstream splits on.
 *
 *  Measured on Darwin 24.6 for `do shell script` WITHOUT `with administrator
 *  privileges`: a command writing `route: writing to routing socket: File
 *  exists` to stderr and exiting 68 arrives as exactly
 *  `0:117: execution error: route: writing to routing socket: File exists (68)`.
 *  With stderr empty and the same exit, the message is instead `The command
 *  exited with a non-zero status.` — so a message that is not that sentence is
 *  the command's own words.
 *
 *  NOT measured, and deliberately not depended on: the same thing *with*
 *  administrator privileges, which is the only form this elevator uses. That
 *  variant cannot be run without the authentication dialog, so it cannot be
 *  exercised non-interactively, and the security framework starts the command
 *  outside our session — the message may well be AppleScript's generic sentence
 *  rather than the command's. This is therefore wired up to make a failure
 *  *readable*, and nothing decides anything from its content. The one decision
 *  that used to hang off it — whether a retried `route add` collided with its
 *  own earlier route — is taken from the route table instead, in
 *  `routing/darwin.ts`.
 *
 *  The trailing `(N)` is left in the text for the same reason. If the message
 *  turns out to be the generic sentence, that number is the only fact in it,
 *  and dropping it would make this worse than the `route exited 1` fallback it
 *  displaces. */
function commandComplaint(stderr: string): string | undefined {
  const text = stderr.replace(OSASCRIPT_FRAMING, '').replace(/\r/g, '\n').trim()
  return text || undefined
}

/** What osascript's stderr says about a non-zero exit.
 *
 *  `do shell script` raises an AppleScript error whose number is the shell
 *  command's own exit status, and osascript then exits 1 whatever went wrong.
 *  So osascript's exit code alone cannot distinguish "the user cancelled" from
 *  "the engine exited 2", and the trailing `(N)` in the error text is the only
 *  place that distinction survives. */
export function parseOsascriptFailure(stderr: string): ElevationExit {
  if (/User cancell?ed/i.test(stderr)) return { code: null, declined: true }
  const match = /\((-?\d+)\)\s*$/m.exec(stderr.trim())
  const number = match ? Number(match[1]) : null
  // A decline is the dialog talking, not the command, so it carries no stderr.
  if (number === USER_CANCELLED) return { code: null, declined: true }
  return { code: number, declined: false, stderr: commandComplaint(stderr) }
}

export function createDarwinElevator(): Elevator {
  // `do shell script … with administrator privileges` hands the command to
  // the macOS security framework, which starts it detached — anything written
  // to osascript's own stdin goes nowhere near it.
  return { method: 'osascript', carriesStdin: false, probe: probeDarwin, run: runDarwin }
}

async function probeDarwin(): Promise<ElevationProbe> {
  if (cached) return cached
  cached = existsSync(OSASCRIPT)
    ? { available: true, method: 'osascript' }
    : {
        available: false,
        method: 'none',
        reason: `${OSASCRIPT} is missing, so OpsMaxx cannot ask macOS for administrator rights. Use a userspace WireGuard profile, which needs none.`
      }
  return cached
}

async function runDarwin(req: ElevationRequest): Promise<ElevatedProcess> {
  const probe = await probeDarwin()
  if (!probe.available) throw new VpnError('unsupported', probe.reason)

  // cwd and env are inside the shell command, not on the spawn: the elevated
  // process is started by the security framework, not forked from osascript,
  // so nothing set on osascript itself is inherited by it.
    if (req.stdin !== undefined) {
    // Refused, not dropped. This route starts the elevated command detached
    // from us, so a write here would go nowhere and the engine would sit on an
    // empty pipe with no error anywhere — much worse than being told to use a
    // file. See `Elevator.carriesStdin`.
    throw new VpnError(
      'unsupported',
      'Administrator elevation on this platform cannot pass data on standard input.'
    )
  }

const child = spawn(OSASCRIPT, buildOsascriptArgs(req), {
    stdio: ['ignore', 'pipe', 'pipe']
  })

  return adopt(child)
}

function adopt(child: ChildProcess): ElevatedProcess {
  // The same accumulator Linux uses, and now for the same reason as well: this
  // route does surface the text, so it has to be redacted before it is capped,
  // not after. A privileged command echoing its own arguments back is the
  // ordinary case, and `do shell script` puts the command line in the argv of
  // osascript itself. The other two reasons have always applied here — the old
  // `length < cap` test ran before the append, so one oversized chunk stored all
  // of it, and `String(chunk)` mangled any UTF-8 sequence a pipe split in half,
  // which on a localised macOS is the error message we are trying to read.
  const stderr = captureStderr(child, STDERR_CAP)

  let settled: Promise<ElevationExit> | null = null
  const wait = (): Promise<ElevationExit> => {
    if (settled) return settled
    settled = new Promise<ElevationExit>((resolve, reject) => {
      child.once('error', (cause) => {
        reject(new VpnError('unsupported', `${OSASCRIPT} could not be run.`, { cause }))
      })
      // 'close' rather than 'exit', so stderr has been drained and the failure
      // can actually be classified.
      child.once('close', (code: number | null) => {
        if (code === 0) return resolve({ code: 0, declined: false })
        const parsed = parseOsascriptFailure(stderr())
        // No `(N)` in the text means the exit status never made it through the
        // AppleScript error, so osascript's own is the best available — but
        // whatever it did say is still worth keeping.
        resolve(parsed.code === null && !parsed.declined ? { ...parsed, code } : parsed)
      })
    })
    return settled
  }

  return {
    pid: child.pid ?? null,
    wait,
    // Signals reach osascript. They do not reach the root-owned process it
    // started, which has a different session and is not our child — stopping
    // that one is the engine driver's job, over its control channel.
    kill: async (force?: boolean) => {
      child.kill(force ? 'SIGKILL' : 'SIGTERM')
    }
  }
}
