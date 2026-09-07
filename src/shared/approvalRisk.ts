// The words an AI approval prompt is allowed to say.
//
// An approval modal is the one screen in ShellPilot where the person deciding
// did not start the thing they are deciding about. Everywhere else — a cordon,
// a drain, a broadcast — the operator typed the intent themselves and the
// dialog only has to describe the blast radius. Here the operator arrives cold,
// mid-something-else, with an agent's sentence in front of them and a fuse
// burning, and the dialog has to supply the intent as well as the consequence.
//
// So this file holds three things, all pure, all testable without a DOM:
//
//   1. WHAT THE RISK WORD MEANS. `high` on its own is a label with no scale. A
//      label with no scale cannot be read: the operator cannot tell whether it
//      is the top of three or the middle of five, and after a week of every
//      prompt saying HIGH the word has stopped carrying information at all.
//      `riskPosition` puts the word on its own scale so the prompt can print
//      "HIGH — 3 of 3", which is a fact rather than an adjective.
//
//   2. WHY THIS ONE SCORED IT. The bridge scores risk and throws the reasoning
//      away — `ApprovalRequest` carries the word and not the derivation. Rather
//      than invent a reason, `riskReasons` restates the rules the bridge
//      actually applies (they are read off src/main/services/mcpServer.ts's
//      gate() call sites) against the facts the request does carry. When none
//      of them fits, it says so; it never fills the gap.
//
//   3. WHAT THE ACTION WILL DO. `describeConsequence` matches a small set of
//      command shapes and capability defaults. It is deliberately small and
//      deliberately refuses to guess — see NO_CONSEQUENCE_TEXT.
//
// THE RULE THIS FILE EXISTS TO UPHOLD: a value nobody measured must never
// render as though it were measured. Nothing here returns a cheerful default.
// An unrecognised risk word does not fall to the bottom of the scale, an
// unrecognised command does not get a soothing paraphrase, and a missing reason
// is printed as a missing reason.

import type { AiCapability } from './mcp'

/**
 * The scale, low to high, in order. Exported because the modal prints its
 * length ("3 of 3") — a hard-coded 3 in the component is how a fourth level
 * added here would silently start rendering as "3 of 3" forever.
 */
export const APPROVAL_RISK_SCALE = ['low', 'medium', 'high'] as const

export type ApprovalRiskLevel = (typeof APPROVAL_RISK_SCALE)[number]

/**
 * What the prompt is being asked to describe.
 *
 * `risk` is typed `string`, not `ApprovalRiskLevel`, and that is deliberate.
 * The value arrives over IPC from the main process; the renderer's type
 * annotation is a claim about it, not a guarantee. Typing it as the union here
 * would make the unknown-level branch unreachable as far as TypeScript is
 * concerned, and an unreachable branch is one somebody deletes as dead code —
 * which is exactly how a level the bridge starts emitting next year would
 * render as an all-clear.
 */
export interface ApprovalSubject {
  capability: AiCapability | string
  action: string
  risk: string
  serverName: string
  workspaceName?: string
}

/**
 * Where a level sits on the scale, or null when it is not on the scale at all.
 *
 * Null is the honest answer for an unrecognised word and the callers below
 * treat it as *more* serious than `high`, never less. Defaulting an unknown
 * level to `low` — the tempting one-liner — would take the single case where
 * ShellPilot understands the request least and render it as the case where
 * there is least to worry about.
 */
export function riskPosition(level: string): { ordinal: number; of: number } | null {
  const i = APPROVAL_RISK_SCALE.indexOf(level as ApprovalRiskLevel)
  if (i < 0) return null
  return { ordinal: i + 1, of: APPROVAL_RISK_SCALE.length }
}

/** "HIGH — 3 of 3", or a sentence saying the word is not on the scale. */
export function formatRiskLabel(level: string): string {
  const pos = riskPosition(level)
  if (!pos) return `${level.toUpperCase() || 'UNLABELLED'} — not on ShellPilot's ${APPROVAL_RISK_SCALE.length}-level scale`
  return `${level.toUpperCase()} — ${pos.ordinal} of ${pos.of}`
}

/**
 * Which colour family the band wears. An unknown level is `danger`, for
 * riskPosition's reason: the one thing that must not happen is for a word this
 * build cannot interpret to arrive wearing the calm colour.
 */
export function riskTone(level: string): 'danger' | 'warn' | 'neutral' {
  if (level === 'high') return 'danger'
  if (level === 'medium') return 'warn'
  if (level === 'low') return 'neutral'
  return 'danger'
}

// Matches the shape used for the same judgement in shared/kubernetes.ts rather
// than importing it: that module is 127KB of cluster parsing and the approval
// path should not pull it in for one regex, and the constant is not exported
// there anyway. Widened by one character class — whitespace is a separator
// here, because ShellPilot server names are display names ("Nginx Server Prod")
// and not DNS labels, and the k8s version would have missed that one entirely.
const PROD_RE = /(^|[\s\-_./:])(prod|production|prd|live)([\s\-_./:]|$)/i

/** The first of the request's own names that reads as production, or null. */
export function productionHint(s: ApprovalSubject): string | null {
  return [s.serverName, s.workspaceName ?? ''].find((v) => v && PROD_RE.test(v)) ?? null
}

/**
 * Why this action carries the score the bridge gave it.
 *
 * Every clause below restates a rule the bridge actually applies — read off the
 * gate() call sites in mcpServer.ts — against a fact the request carries. That
 * constraint is what keeps this from becoming plausible-sounding fiction: if a
 * clause cannot be traced to a line in the bridge or a substring of the action,
 * it does not belong here.
 */
export function riskReasons(s: ApprovalSubject): string[] {
  const out: string[] = []
  const action = s.action
  const high = s.risk === 'high'
  const starts = /^start\b/i.test(action)

  // The bridge scores execute_command high on exactly this test and medium
  // otherwise, so this pair covers the whole of its shell-command rule.
  if (/\bsudo\b/.test(action)) out.push('the command runs as root, through sudo')
  else if (s.capability === 'terminal' || s.capability === 'sudo')
    out.push('it runs a shell command of the agent’s own composition on the host')

  if (s.capability === 'writeFiles')
    out.push('it overwrites a file on the host, and the previous contents are not kept anywhere')
  if (s.capability === 'databaseAccess')
    out.push(
      high
        ? 'the statement was not classified as a read, so ShellPilot is treating it as one that changes data'
        : 'it reads from a database through the host'
    )
  if (s.capability === 'hostFacts')
    out.push('it returns which security updates the host is missing, which is what the host is unpatched against')
  if (s.capability === 'serverMetrics')
    out.push('it returns the host’s listening ports and failed services, not only its CPU and memory')
  if (s.capability === 'sshTunnel')
    out.push(
      starts
        ? 'it opens a network path between this machine and a port on the server'
        : 'it closes a tunnel that other things may still be using'
    )
  if (s.capability === 'vpnControl')
    out.push(
      starts
        ? 'it changes which network your later SSH and database sessions travel over'
        : 'it stops a VPN that other sessions may depend on'
    )
  if (s.capability === 'manageServers')
    out.push('it writes to ShellPilot’s own connection list and stores a credential there')

  const prod = productionHint(s)
  if (prod) out.push(`"${prod}" reads as production`)
  return out
}

export interface RiskExplanation {
  level: string
  position: { ordinal: number; of: number } | null
  /** "HIGH — 3 of 3" */
  label: string
  tone: 'danger' | 'warn' | 'neutral'
  reasons: string[]
  /** False when nothing above fitted. The band still renders — see `sentence`. */
  reasonKnown: boolean
  /** The line under the label. Always a sentence, never an empty string. */
  sentence: string
}

/**
 * The whole risk band, ready to render.
 *
 * `sentence` is never empty and never omitted, which is the point. A band that
 * renders a reason when it has one and blank space when it does not teaches the
 * operator that blank space means "nothing to say", when what it actually means
 * is "ShellPilot did not record why". Those are opposite readings of the same
 * pixels.
 */
export function explainRisk(s: ApprovalSubject): RiskExplanation {
  const reasons = riskReasons(s)
  const position = riskPosition(s.risk)
  const word = position ? s.risk.toUpperCase() : 'This'
  return {
    level: s.risk,
    position,
    label: formatRiskLabel(s.risk),
    tone: riskTone(s.risk),
    reasons,
    reasonKnown: reasons.length > 0,
    sentence: reasons.length
      ? `${word} because: ${reasons.join('; ')}.`
      : position
        ? `ShellPilot did not record why this scored ${s.risk.toUpperCase()}, and cannot derive it from the request. Judge it from the command below, not from the word.`
        : `ShellPilot does not recognise the risk word "${s.risk}" and cannot place it on its own scale. Treat this as unscored, not as safe.`
  }
}

// ---------------------------------------------------------------------------
// Consequence
// ---------------------------------------------------------------------------

/**
 * Printed whenever nothing below matches.
 *
 * This sentence is the reason the whole consequence layer is safe to have. A
 * describe-the-command feature that silently prints nothing for the commands it
 * does not know turns its own blind spot into reassuring white space — and the
 * command it is most likely not to know is the unusual one, which is the one
 * that most deserved a second look. Saying "I cannot describe this" is itself a
 * risk signal, so it renders as loudly as any other line here.
 */
export const NO_CONSEQUENCE_TEXT =
  'ShellPilot cannot describe what this command does. It matched none of the shapes ShellPilot knows, so the command itself is the only evidence there is.'

export interface Consequence {
  /** Always a sentence. NO_CONSEQUENCE_TEXT when `known` is false. */
  text: string
  known: boolean
}

interface CommandShape {
  match: RegExp
  say: (m: RegExpMatchArray, host: string) => string
}

// Small on purpose. Every entry here is a shape whose consequence is the same
// on every Linux host ShellPilot talks to; anything whose effect depends on the
// host's own configuration is left out, because a confident sentence about
// something that varies is worse than NO_CONSEQUENCE_TEXT.
const COMMAND_SHAPES: CommandShape[] = [
  {
    match: /\bsystemctl\s+(?:--\S+\s+)*(restart|stop|start|reload|enable|disable)\s+([\w@.:\-\\]+)/i,
    say: (m, host) => {
      const unit = m[2]
      switch (m[1].toLowerCase()) {
        case 'restart':
          return `Restarts ${unit} on ${host}. Every connection it is serving right now is dropped, and it comes back only if the unit starts cleanly — if it does not, the service stays down and nothing here starts it again.`
        case 'stop':
          return `Stops ${unit} on ${host} and leaves it stopped. Nothing in ShellPilot starts it again.`
        case 'start':
          return `Starts ${unit} on ${host}. If it is already running this changes nothing.`
        case 'reload':
          return `Makes ${unit} re-read its configuration on ${host}. Existing connections are kept — but a configuration it cannot parse can still take it down.`
        default:
          return `Changes whether ${unit} starts at boot on ${host}. It does not start or stop the service right now, so the host looks unchanged until it next reboots.`
      }
    }
  },
  {
    match: /(^|[\s;&|])rm\s/,
    say: (_m, host) => `Deletes files on ${host}. There is no recycle bin over SSH — what this removes is gone.`
  },
  {
    match: /(^|[\s;&|])(reboot|poweroff|halt|shutdown)\b|\binit\s+[06]\b/,
    say: (_m, host) =>
      `Takes ${host} down. Every SSH session, tunnel and service on it stops, and whether it comes back is up to the machine, not to ShellPilot.`
  },
  {
    match: /(^|[\s;&|])(kill|pkill|killall)\s/,
    say: (_m, host) =>
      `Signals running processes on ${host}. Whatever they were part-way through is lost, and a supervised process may be restarted immediately while an unsupervised one will not be.`
  },
  {
    match: /\b(apt|apt-get|dnf|yum|zypper|pacman|apk)\s+(?:-\S+\s+)*(install|remove|purge|upgrade|update|autoremove|dist-upgrade)\b/i,
    say: (_m, host) =>
      `Changes the installed packages on ${host}. A package manager restarts the services it touches as a side effect, so the blast radius is wider than the package named.`
  },
  {
    match: /\b(ufw|iptables|ip6tables|nft|firewall-cmd)\b/i,
    say: (_m, host) =>
      `Changes what ${host} accepts network traffic on. A firewall edit made over SSH can lock this very connection out of the host, and recovering from that needs console access.`
  },
  {
    match: /\b(chmod|chown|chgrp)\s/,
    say: (_m, host) => `Changes who can read, write or run those paths on ${host}.`
  },
  {
    match: /\b(useradd|adduser|userdel|deluser|usermod|passwd|visudo)\b/,
    say: (_m, host) => `Changes who can log in to ${host}, or what they can do once they are in.`
  },
  {
    match: /\b(mkfs(\.\w+)?|fdisk|parted|wipefs)\b|\bdd\s+.*\bof=/,
    say: (_m, host) =>
      `Writes to a disk or partition on ${host} directly, underneath the filesystem. Whatever is on it is destroyed and no backup ShellPilot knows about is taken first.`
  },
  {
    match: /\bcrontab\b|\/etc\/cron/,
    say: (_m, host) =>
      `Changes what ${host} runs on a schedule. A scheduled job edited here runs unattended later, when nobody is watching this screen.`
  },
  {
    match: /\bdocker\s+(rm|stop|kill|prune)\b|\bdocker(-|\s+)compose\s+down\b/i,
    say: (_m, host) => `Stops or removes containers on ${host}. Anything not on a named volume goes with them.`
  },
  {
    match: /\bkubectl\s+delete\b/i,
    say: (_m, host) =>
      `Deletes objects from the Kubernetes cluster ${host} talks to. A controller may recreate some of them and will not recreate others; kubectl does not tell you which before it runs.`
  }
]

/**
 * What this action does to the host, in one sentence, or the honest refusal.
 *
 * Shell commands get NO capability-level fallback, unlike every other
 * capability here. "Runs a command on the host" is true of every shell command
 * ever written and would have satisfied the check that a consequence exists
 * while telling the operator nothing — which is the failure this function is
 * for. If the shape is not recognised, the answer is that it is not recognised.
 */
export function describeConsequence(s: ApprovalSubject): Consequence {
  const host = s.serverName
  const action = s.action

  if (s.capability === 'terminal' || s.capability === 'sudo') {
    for (const shape of COMMAND_SHAPES) {
      const m = action.match(shape.match)
      if (m) {
        const root = /\bsudo\b/.test(action) ? ' It runs as root.' : ''
        return { text: `${shape.say(m, host)}${root}`, known: true }
      }
    }
    return { text: NO_CONSEQUENCE_TEXT, known: false }
  }

  const path = action.replace(/^(read|write|list)\s+/, '').replace(/\s+\(\d+ bytes\)$/, '')
  const starts = /^start\b/i.test(action)

  switch (s.capability) {
    case 'readFiles':
      return {
        text: /^list\s/.test(action)
          ? `Lists what is in ${path} on ${host}. Nothing on the host changes; what the agent learns is the filenames.`
          : `Reads ${path} from ${host} and hands the contents to the agent. Nothing on the host changes — what changes is that the contents have left it.`,
        known: true
      }
    case 'writeFiles':
    case 'sftpUpload':
      return {
        text: `Overwrites ${path} on ${host}. The previous contents are not kept anywhere ShellPilot can restore them from.`,
        known: true
      }
    case 'sftpDownload':
      return { text: `Copies ${path} off ${host} to this machine.`, known: true }
    case 'databaseAccess':
      return {
        text: `Runs this statement against a database on ${host}. ShellPilot does not dry-run it first, and a statement that changes rows cannot be undone from here.`,
        known: true
      }
    case 'serverMetrics':
      return {
        text: `Returns ${host}’s CPU, memory, disk and uptime — and every failed service and listening port with the process behind it, which is a service inventory of the host.`,
        known: true
      }
    case 'hostFacts':
      return {
        text: `Returns ${host}’s distribution, kernel and how many security updates it is waiting on. That tells the agent what this host is unpatched against.`,
        known: true
      }
    case 'sshTunnel':
      return {
        text: starts
          ? `Opens a tunnel between this machine and a port on ${host}. It stays open until somebody closes it.`
          : `Closes that tunnel. Anything currently using it loses its connection.`,
        known: true
      }
    case 'vpnControl':
      return {
        text: starts
          ? `Starts a VPN profile. Your later SSH and database sessions travel over it until it is stopped.`
          : `Stops a VPN profile. Sessions that reach their host through it drop.`,
        known: true
      }
    case 'manageServers':
      return {
        text: `Adds a server to ShellPilot’s own connection list and stores a credential for it. It does not give the agent any access to the server it adds.`,
        known: true
      }
    case 'viewServer':
      return {
        text: `Lets the agent see that ${host} exists and read what it is permitted to do there. No hostname, username or key is disclosed.`,
        known: true
      }
    default:
      return { text: NO_CONSEQUENCE_TEXT, known: false }
  }
}

/**
 * What denying costs, said plainly.
 *
 * The operator's unspoken question at a modal like this is "if I say no, do I
 * break something I will have to go and fix?". Leaving it unanswered is what
 * makes a tired person click the affirmative, so the answer is on the screen.
 */
export function describeDenial(s: ApprovalSubject): string {
  return `Denying tells the agent this action was rejected. It stays connected and can do something else — nothing runs on ${s.serverName}.`
}

// ---------------------------------------------------------------------------
// The fuse
// ---------------------------------------------------------------------------

/**
 * "1:43" from milliseconds, or null when there is nothing trustworthy to show.
 *
 * Null for a null input, and that is load-bearing rather than defensive. The
 * configured approval timeout comes from the main process; when the renderer
 * has not got it, the choice is between showing no countdown and showing one
 * built on an assumed two minutes. A countdown is a promise about when the
 * request dies, and a wrong one is worse than none — the operator budgets
 * against it and comes back to a request that was denied a minute before the
 * clock said it would be.
 */
export function formatFuse(msRemaining: number | null): string | null {
  if (msRemaining === null || !Number.isFinite(msRemaining)) return null
  const total = Math.max(0, Math.ceil(msRemaining / 1000))
  const m = Math.floor(total / 60)
  const sec = total % 60
  return `${m}:${sec.toString().padStart(2, '0')}`
}

/**
 * When a request will be auto-denied, in epoch ms, or null when unknowable.
 *
 * `timeoutSeconds` is null whenever the renderer could not read the setting,
 * and an unparseable `createdAt` is treated the same way. Both return null
 * rather than picking a plausible deadline, for formatFuse's reason.
 */
export function fuseDeadline(createdAt: string, timeoutSeconds: number | null): number | null {
  if (timeoutSeconds === null || !Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) return null
  const started = Date.parse(createdAt)
  if (Number.isNaN(started)) return null
  return started + timeoutSeconds * 1000
}
