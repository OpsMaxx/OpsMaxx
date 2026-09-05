import type { JobSpec, JobStep } from './jobs'

// Item 34a: the first TYPED step kind.
//
// The difference from item 33's free-text composer is the whole point of item
// 34. A free-text step is a line somebody typed; a typed step is an ACTION and
// a UNIT, checked here, with the command built from them. The approval record
// then holds structured intent rather than a string, and the things that must
// never be typed by accident can be refused before anything is confirmed.
//
// WHY THE COMMAND IS STILL BUILT AS TEXT. `verifyApproval` compares the step
// text literally, so a spec whose command was substituted per server could not
// be checked against the record at all. The action and unit are validated, and
// then one command is produced for every server in the job.

export const SERVICE_ACTIONS = ['start', 'stop', 'restart', 'reload', 'enable', 'disable'] as const
export type ServiceAction = (typeof SERVICE_ACTIONS)[number]

/**
 * The units this will not touch, at any strength of confirmation.
 *
 * Restarting sshd from a tool whose only channel to the server IS sshd is,
 * in posture.ts's words, the definition of sawing the branch off. That module
 * refuses it as a posture action; refusing it here too is not duplication --
 * this is a different surface, and the operator arriving at it has not read
 * that file.
 *
 * Not a confirmation. There is no phrase that makes this a good idea from a
 * panel, and offering one would imply there is.
 */
export const PROTECTED_UNITS = [
  'ssh',
  'sshd',
  'ssh.service',
  'sshd.service',
  'ssh.socket',
  'sshd.socket'
]

/** Actions that would interrupt the session this runs over. `start` and
 *  `enable` cannot, so they are allowed even on sshd. */
const INTERRUPTING: ServiceAction[] = ['stop', 'restart', 'reload', 'disable']

// Anchored, and deliberately narrow. This value is interpolated into a command
// that runs as root on a machine nobody is looking at, so what is allowed is an
// enumerated character set rather than an escape function: `@` for templated
// units (`getty@tty1`), `.` `-` `_` `\` and `:` because systemd unit names
// really do contain them. No spaces, no quotes, no `$`, no `;`.
const UNIT_RE = /^[A-Za-z0-9@._:\\-]{1,128}$/

const SUFFIXES = [
  '.service', '.socket', '.timer', '.target', '.mount', '.path', '.slice', '.scope'
]

/** `nginx` means `nginx.service`, the way systemctl itself reads it. Made
 *  explicit here so the approval record says which unit, not which shorthand. */
export function normaliseUnit(unit: string): string {
  const u = unit.trim()
  return SUFFIXES.some((s) => u.endsWith(s)) ? u : `${u}.service`
}

export type ServiceStepCheck = { ok: true } | { ok: false; reason: string }

/**
 * Whether this action on this unit can be built at all.
 *
 * `known` is the unit names this server has actually reported. When it is
 * supplied and the unit is not in it, this refuses: a typo in a unit name
 * produces a job that reports success on every server while doing nothing,
 * because `systemctl start not-a-unit` is a failure systemd reports and a
 * wave gate does not read. When it is not supplied -- the facts have not been
 * collected -- the name is allowed and the check says so is not the same as
 * saying it exists.
 */
export function checkServiceStep(
  action: ServiceAction,
  unit: string,
  known?: string[]
): ServiceStepCheck {
  const raw = unit.trim()
  if (raw === '') return { ok: false, reason: 'Name the unit this acts on.' }
  if (!UNIT_RE.test(raw)) {
    return {
      ok: false,
      reason:
        'A unit name may only contain letters, digits and @ . _ : - characters. This one has something else in it, and it would be run as root on every server you picked.'
    }
  }
  const full = normaliseUnit(raw)
  // Normalised first, so `ssh`, `ssh.service` and `ssh.socket` are one check
  // rather than three spellings somebody has to remember to add.
  if (INTERRUPTING.includes(action) && PROTECTED_UNITS.includes(full)) {
    return {
      ok: false,
      reason: `ShellPilot will not ${action} ${full}. Its only channel to the server is that service, so this would cut the connection it needs to tell you what happened — and to put it back.`
    }
  }
  if (known !== undefined && known.length > 0) {
    const set = new Set(known.map(normaliseUnit))
    if (!set.has(full)) {
      return {
        ok: false,
        reason: `No server in this job has reported a unit called ${full}. A misspelt unit name is a job that fails on every server at once, so the name is checked against what they actually run.`
      }
    }
  }
  return { ok: true }
}

/**
 * The verification step, which is why this is a typed kind and not a textarea.
 *
 * `systemctl start` exits 0 having asked. Whether the unit is RUNNING a moment
 * later is a different question, and it is the one the operator meant. A unit
 * that starts and immediately dies -- the commonest outcome of a bad config --
 * exits 0 from the start command.
 *
 * Written as a positive assertion in both directions rather than relying on
 * `is-active`'s exit code alone, so the job output says which state was found.
 */
function verifyCommand(action: ServiceAction, unit: string, sudo: boolean): string {
  const s = sudo ? 'sudo -n ' : ''
  if (action === 'stop') {
    return `if ${s}systemctl is-active --quiet '${unit}'; then echo "${unit} is still active" >&2; exit 1; else echo "${unit} is not active"; fi`
  }
  if (action === 'disable') {
    return `if ${s}systemctl is-enabled --quiet '${unit}'; then echo "${unit} is still enabled" >&2; exit 1; else echo "${unit} is not enabled"; fi`
  }
  if (action === 'enable') {
    return `${s}systemctl is-enabled '${unit}'`
  }
  // start, restart, reload: the unit has to be active afterwards.
  return `${s}systemctl is-active '${unit}'`
}

export interface ServiceStepOpts {
  sudo?: boolean
  /** Skip the verification step. Off by default and worth a reason to turn on:
   *  without it the job reports that it ASKED, not that it worked. */
  skipVerify?: boolean
}

/**
 * The job spec for one service action.
 *
 * Two steps, not one, and the second is the point. `kind` stays `'command'`
 * because the ENGINE runs commands -- a JobKind of its own would be a second
 * execution path for no gain. What makes this typed is that the text was built
 * here from a checked action and a checked unit.
 */
export function serviceJobSpec(
  action: ServiceAction,
  unit: string,
  opts: ServiceStepOpts = {}
): JobSpec {
  const full = normaliseUnit(unit)
  const s = opts.sudo ? 'sudo -n ' : ''
  const steps: JobStep[] = [{ command: `${s}systemctl ${action} '${full}'` }]
  if (opts.skipVerify !== true) steps.push({ command: verifyCommand(action, full, opts.sudo === true) })
  return {
    kind: 'command',
    title: `${action[0].toUpperCase()}${action.slice(1)} ${full}`,
    steps
  }
}
