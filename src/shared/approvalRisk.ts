// The words an AI approval prompt is allowed to say.
//
// An approval modal is the one screen in OpsMaxx where the person deciding
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
//   2. WHY THIS ONE SCORED IT. The bridge now sends the rule that fired, on
//      `ApprovalRequest.riskReason`, and `explainRisk` prefers it over anything
//      derived here — main is where the grading happens, so main is where the
//      reason is true. `riskReasons` below stays as the FALLBACK, for a request
//      from a gate() call site that supplied none: it restates the rules the
//      bridge applies (read off src/main/services/mcpServer.ts) against the
//      facts the request does carry, and is accurate only for as long as
//      somebody keeps the two in step. When neither fits, `explainRisk` says
//      so; it never fills the gap.
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

import { englishT, st, type Translate } from './i18n'
import type { AiCapability, ContentPreview } from './mcp'

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
  /** Null for a workspace-wide read, which is about the workspace and no server in it. */
  serverName: string | null
  workspaceName?: string
  /**
   * The rule main applied, when the gate() call site recorded one. Optional
   * because a call site can forget — and a forgotten reason must fall back to
   * the local derivation rather than blanking the band.
   */
  riskReason?: string
}

/**
 * Where a level sits on the scale, or null when it is not on the scale at all.
 *
 * Null is the honest answer for an unrecognised word and the callers below
 * treat it as *more* serious than `high`, never less. Defaulting an unknown
 * level to `low` — the tempting one-liner — would take the single case where
 * OpsMaxx understands the request least and render it as the case where
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
  if (!pos) {
    return st('shared.approvalRisk.riskLabel.offScale', {
      level: level.toUpperCase() || st('shared.approvalRisk.riskLabel.unlabelled'),
      size: APPROVAL_RISK_SCALE.length
    })
  }
  return st('shared.approvalRisk.riskLabel.onScale', { level: levelWord(level), ordinal: pos.ordinal, of: pos.of })
}

/** "HIGH", in the reader's language. Only for a level riskPosition placed. */
// The sentence frame ends with its own full stop, and a reason from main
// usually ends with one too: "…production traffic.." on every approval.
const joinReasons = (reasons: string[]): string => reasons.map((r) => r.replace(/[.\s]+$/, '')).join('; ')

function levelWord(level: string): string {
  return st(`shared.approvalRisk.level.${level as ApprovalRiskLevel}`)
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
// here, because OpsMaxx server names are display names ("Nginx Server Prod")
// and not DNS labels, and the k8s version would have missed that one entirely.
const PROD_RE = /(^|[\s\-_./:])(prod|production|prd|live)([\s\-_./:]|$)/i

/** The first of the request's own names that reads as production, or null. */
export function productionHint(s: ApprovalSubject): string | null {
  return [s.serverName ?? '', s.workspaceName ?? ''].find((v) => v && PROD_RE.test(v)) ?? null
}

/**
 * What a request is about, as a phrase: the server, or -- for a workspace-wide
 * read, which names none -- the workspace. Never "null" and never blank: an
 * operator reading "act on" followed by nothing cannot tell what a yes reaches.
 */
export function approvalTarget(r: { serverName: string | null; workspaceName?: string }, t: Translate = st): string {
  return (
    r.serverName ??
    t('shared.approvalRisk.workspaceTarget', {
      workspace: r.workspaceName ?? t('shared.approvalRisk.unnamedWorkspace')
    })
  )
}

/** The Where line: "Workspace / Server", or the workspace alone and said to be whole. */
export function approvalWhere(r: { serverName: string | null; workspaceName: string }): string {
  return r.serverName === null
    ? st('shared.approvalRisk.whereWorkspace', { workspace: r.workspaceName })
    : `${r.workspaceName} / ${r.serverName}`
}

/**
 * Why this action carries the score the bridge gave it — DERIVED LOCALLY.
 *
 * The fallback, not the primary: `explainRisk` uses main's own `riskReason`
 * whenever the request carries one. This runs for a request that carries none,
 * which today means a gate() call site that did not fill it in.
 *
 * Every clause below restates a rule the bridge actually applies — read off the
 * gate() call sites in mcpServer.ts — against a fact the request carries. That
 * constraint is what keeps this from becoming plausible-sounding fiction: if a
 * clause cannot be traced to a line in the bridge or a substring of the action,
 * it does not belong here. It is still a hand-kept copy of somebody else's
 * rules, which is precisely why it is no longer what the operator reads first.
 */
export function riskReasons(s: ApprovalSubject): string[] {
  const out: string[] = []
  const action = s.action
  const high = s.risk === 'high'
  const starts = /^start\b/i.test(action)

  // The bridge scores execute_command high on exactly this test and medium
  // otherwise, so this pair covers the whole of its shell-command rule.
  if (/\bsudo\b/.test(action)) out.push(st('shared.approvalRisk.reason.sudo'))
  else if (s.capability === 'terminal' || s.capability === 'sudo')
    out.push(st('shared.approvalRisk.reason.shell'))

  if (s.capability === 'writeFiles')
    out.push(st('shared.approvalRisk.reason.writeFiles'))
  if (s.capability === 'databaseAccess')
    out.push(
      high
        ? st('shared.approvalRisk.reason.databaseWrite')
        : st('shared.approvalRisk.reason.databaseRead')
    )
  if (s.capability === 'hostFacts')
    out.push(st('shared.approvalRisk.reason.hostFacts'))
  if (s.capability === 'serverMetrics')
    out.push(st('shared.approvalRisk.reason.serverMetrics'))
  // Four verbs now, not two. `starts` alone was enough while set_tunnel was the
  // only tool here; "Define" and "Remove" would both have fallen to its else
  // branch and told the reader a tunnel was being closed when one was being
  // written. Each verb is matched on the action string the tool actually builds.
  if (s.capability === 'sshTunnel')
    out.push(
      /^define\b/i.test(action)
        ? st('shared.approvalRisk.reason.tunnelDefine')
        : /^remove\b/i.test(action)
          ? st('shared.approvalRisk.reason.tunnelRemove')
          : starts
            ? st('shared.approvalRisk.reason.tunnelOpen')
            : st('shared.approvalRisk.reason.tunnelClose')
    )
  if (s.capability === 'vpnControl')
    out.push(
      starts
        ? st('shared.approvalRisk.reason.vpnStart')
        : st('shared.approvalRisk.reason.vpnStop')
    )
  // Same problem, same fix: this capability grew two verbs that destroy or
  // rewrite rather than add, and a single sentence about "writes ... and stores
  // a credential" describes none of what a removal does.
  if (s.capability === 'manageServers')
    out.push(
      /^remove\b/i.test(action)
        ? st('shared.approvalRisk.reason.serverRemove')
        : /^(change|update)\b/i.test(action)
          ? st('shared.approvalRisk.reason.serverChange')
          : st('shared.approvalRisk.reason.serverAdd')
    )

  const prod = productionHint(s)
  if (prod) out.push(st('shared.approvalRisk.reason.production', { name: prod }))
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
  /**
   * Where `reasons` came from. `bridge` is main's own rule; `derived` is this
   * file's local restatement of main's rules; `none` is the honest gap.
   *
   * Exported rather than kept private because the difference is real: `derived`
   * is a copy that can drift out of step with the bridge, and a test that
   * cannot tell the two apart cannot notice when the plumbing stops arriving.
   */
  reasonSource: 'bridge' | 'derived' | 'none'
  /** The line under the label. Always a sentence, never an empty string. */
  sentence: string
}

/**
 * The whole risk band, ready to render.
 *
 * MAIN'S REASON WINS. `s.riskReason` is the rule that actually fired inside the
 * gate() call that raised this request; `riskReasons()` is this file's guess at
 * what that rule must have been. Preferring the guess when the fact is present
 * would be re-deriving something already known, and re-derivation is how the
 * two drift: change the bridge's grading and the modal keeps confidently
 * printing last year's reason. An empty or whitespace-only `riskReason` counts
 * as absent — a call site that passed `''` recorded nothing.
 *
 * `sentence` is never empty and never omitted, which is the point. A band that
 * renders a reason when it has one and blank space when it does not teaches the
 * operator that blank space means "nothing to say", when what it actually means
 * is "OpsMaxx did not record why". Those are opposite readings of the same
 * pixels.
 */
export function explainRisk(s: ApprovalSubject): RiskExplanation {
  const fromBridge = typeof s.riskReason === 'string' ? s.riskReason.trim() : ''
  const reasons = fromBridge ? [fromBridge] : riskReasons(s)
  const position = riskPosition(s.risk)
  return {
    level: s.risk,
    position,
    label: formatRiskLabel(s.risk),
    tone: riskTone(s.risk),
    reasons,
    reasonKnown: reasons.length > 0,
    reasonSource: fromBridge ? 'bridge' : reasons.length ? 'derived' : 'none',
    sentence: reasons.length
      ? position
        ? st('shared.approvalRisk.because', { level: levelWord(s.risk), reasons: joinReasons(reasons) })
        : st('shared.approvalRisk.thisBecause', { reasons: joinReasons(reasons) })
      : position
        ? st('shared.approvalRisk.unrecorded', { level: levelWord(s.risk) })
        : st('shared.approvalRisk.unrecognised', { risk: s.risk })
  }
}

// ---------------------------------------------------------------------------
// The agent's stated intent
// ---------------------------------------------------------------------------

/**
 * How much of an agent's stated intent the dialog will show.
 *
 * A cap and not a scrollbar. The intent sits above the Deny button in a modal
 * that also has to fit a consequence, a command and a fuse; an agent that can
 * write 4,000 characters here can push every one of those below the fold and
 * decide, by length alone, what the operator reads before answering. 240 is
 * about two lines — enough for "restarting nginx after the config change you
 * asked about" and not enough to be a layout.
 */
export const INTENT_MAX_CHARS = 240

/** Left in place of a phrase that claimed the action was already approved. */
export const INTENT_REDACTION = '[removed: a claim that this was already approved]'

// Control characters, and the invisible formatting ones. The second half is
// the important half: U+202E and friends reorder what a human sees without
// changing what the string contains, so "restart nginx" can be made to display
// as something else entirely, and zero-width characters split words apart so
// that a phrase check below sees "app roved". Neither belongs in a sentence.
// Matching control characters is the entire job of this expression, so the lint
// that objects to finding them in a pattern is objecting to the point of it.
// eslint-disable-next-line no-control-regex
const INTENT_INVISIBLE = /[\u0000-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g

// A speaker label at the head of the line. After whitespace has been flattened
// the head is the ONLY place text can pass itself off as a different voice —
// there are no line breaks left to build a fake row out of — so this is a
// complete rule rather than a sample of one. The bracket form is capped short
// so it cannot swallow INTENT_REDACTION.
const INTENT_SPEAKER_LABEL =
  /^\s*(?:\[[^\]]{0,24}\]|(?:opsmaxx|system|admin(?:istrator)?|operator|user|security|note|notice|warning|important|assistant|claude|codex)\s*[:>»\-–—])\s*/i

// Claims that the decision has already been made. These are the sentences that
// would actually change an operator's answer, and every one of them is a lie
// by construction: OpsMaxx is asking BECAUSE nothing has approved this. They
// are replaced rather than deleted, so the operator can see that the agent
// asking for permission also tried to tell them permission was not needed.
const INTENT_IMPERSONATION: RegExp[] = [
  /\bopsmaxx\b[^.!?]{0,60}?\b(?:approv\w*|authoris\w*|authoriz\w*|verified|whitelist\w*|permits?|allows?)\b[^.!?]*/gi,
  /\b(?:pre-?approved|auto-?approved|already approved|previously approved|no approval (?:is )?(?:required|needed)|approval (?:is )?not (?:required|needed))\b[^.!?]*/gi,
  /\b(?:the )?(?:user|operator|admin(?:istrator)?|human)\b[^.!?]{0,40}?\b(?:already )?(?:approved|authoris\w+|authoriz\w+|consented|signed off)\b[^.!?]*/gi
]

/**
 * An agent's stated intent, made safe to put on the screen — or null.
 *
 * WHY THIS EXISTS AT ALL. Every other string in this dialog is written by
 * OpsMaxx or read off a host. This one is written by the party asking for
 * permission, which makes the justification the human reads an input controlled
 * by the thing being judged. That is a prompt-injection surface pointed at a
 * person rather than at a model, and the person is the last check in the chain:
 * if this text can make itself look like OpsMaxx's own copy, the agent gets
 * to write the sentence that decides its own approval.
 *
 * So the intent is treated as DATA end to end. Nothing here is parsed, matched
 * against a policy, or allowed to influence risk — it is only ever printed, as
 * an attributed quotation, after:
 *
 *   - control and bidi/zero-width characters are removed (they let a string
 *     display as something other than what it is, and evade the phrase checks);
 *   - every newline and tab is flattened to a space, so a multi-line block that
 *     imitates the dialog's own rows cannot be built;
 *   - phrases claiming the action was already approved are replaced with a
 *     visible marker rather than dropped silently;
 *   - a leading speaker label ("OpsMaxx:", "[SYSTEM]", "Warning —") is
 *     stripped, so the quotation cannot open in somebody else's voice;
 *   - the result is capped at INTENT_MAX_CHARS.
 *
 * Returns null for a non-string, an empty string, or one that was nothing but
 * whitespace and stripped markup — because "the agent said nothing" and "the
 * agent said something empty" are the same fact, and both must render as the
 * absence rather than as a blank line.
 */
export function sanitizeAgentIntent(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  // Order matters. Redaction runs before the speaker-label strip so that a
  // marker beginning with "[" cannot then be eaten as a label; both run before
  // the single whitespace collapse, which is the LAST step so that nothing a
  // preceding rule leaves behind — a doubled space where a phrase was removed,
  // the gap left by a stripped label — reaches the screen.
  let s = raw.replace(INTENT_INVISIBLE, ' ')
  for (const rx of INTENT_IMPERSONATION) s = s.replace(rx, INTENT_REDACTION)
  // Loop: "[SYSTEM] OpsMaxx: ..." is two labels, and stripping one would
  // leave the other doing exactly the job the strip was for.
  for (;;) {
    const next = s.replace(INTENT_SPEAKER_LABEL, '')
    if (next === s) break
    s = next
  }
  s = s.replace(/\s+/g, ' ').trim()
  if (!s) return null
  return s.length > INTENT_MAX_CHARS ? `${s.slice(0, INTENT_MAX_CHARS).trimEnd()}…` : s
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
export const NO_CONSEQUENCE_TEXT = englishT('shared.approvalRisk.noConsequence')

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
// on every Linux host OpsMaxx talks to; anything whose effect depends on the
// host's own configuration is left out, because a confident sentence about
// something that varies is worse than NO_CONSEQUENCE_TEXT.
const COMMAND_SHAPES: CommandShape[] = [
  {
    match: /\bsystemctl\s+(?:--\S+\s+)*(restart|stop|start|reload|enable|disable)\s+([\w@.:\-\\]+)/i,
    say: (m, host) => {
      const unit = m[2]
      switch (m[1].toLowerCase()) {
        case 'restart':
          return st('shared.approvalRisk.consequence.restart', { unit, host })
        case 'stop':
          return st('shared.approvalRisk.consequence.stop', { unit, host })
        case 'start':
          return st('shared.approvalRisk.consequence.start', { unit, host })
        case 'reload':
          return st('shared.approvalRisk.consequence.reload', { unit, host })
        default:
          return st('shared.approvalRisk.consequence.bootSetting', { unit, host })
      }
    }
  },
  {
    match: /(^|[\s;&|])rm\s/,
    say: (_m, host) => st('shared.approvalRisk.consequence.rm', { host })
  },
  {
    match: /(^|[\s;&|])(reboot|poweroff|halt|shutdown)\b|\binit\s+[06]\b/,
    say: (_m, host) =>
      st('shared.approvalRisk.consequence.shutdown', { host })
  },
  {
    match: /(^|[\s;&|])(kill|pkill|killall)\s/,
    say: (_m, host) =>
      st('shared.approvalRisk.consequence.kill', { host })
  },
  {
    match: /\b(apt|apt-get|dnf|yum|zypper|pacman|apk)\s+(?:-\S+\s+)*(install|remove|purge|upgrade|update|autoremove|dist-upgrade)\b/i,
    say: (_m, host) =>
      st('shared.approvalRisk.consequence.packages', { host })
  },
  {
    match: /\b(ufw|iptables|ip6tables|nft|firewall-cmd)\b/i,
    say: (_m, host) =>
      st('shared.approvalRisk.consequence.firewall', { host })
  },
  {
    match: /\b(chmod|chown|chgrp)\s/,
    say: (_m, host) => st('shared.approvalRisk.consequence.permissions', { host })
  },
  {
    match: /\b(useradd|adduser|userdel|deluser|usermod|passwd|visudo)\b/,
    say: (_m, host) => st('shared.approvalRisk.consequence.accounts', { host })
  },
  {
    match: /\b(mkfs(\.\w+)?|fdisk|parted|wipefs)\b|\bdd\s+.*\bof=/,
    say: (_m, host) =>
      st('shared.approvalRisk.consequence.disk', { host })
  },
  {
    match: /\bcrontab\b|\/etc\/cron/,
    say: (_m, host) =>
      st('shared.approvalRisk.consequence.schedule', { host })
  },
  {
    match: /\bdocker\s+(rm|stop|kill|prune)\b|\bdocker(-|\s+)compose\s+down\b/i,
    say: (_m, host) => st('shared.approvalRisk.consequence.containers', { host })
  },
  {
    match: /\bkubectl\s+delete\b/i,
    say: (_m, host) =>
      st('shared.approvalRisk.consequence.kubectlDelete', { host })
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
  if (s.serverName === null) return describeWorkspaceConsequence(s)
  const host = s.serverName
  const action = s.action

  if (s.capability === 'terminal' || s.capability === 'sudo') {
    for (const shape of COMMAND_SHAPES) {
      const m = action.match(shape.match)
      if (m) {
        const text = shape.say(m, host)
        return {
          text: /\bsudo\b/.test(action) ? st('shared.approvalRisk.consequence.asRoot', { text }) : text,
          known: true
        }
      }
    }
    return { text: st('shared.approvalRisk.noConsequence'), known: false }
  }

  const path = action.replace(/^(read|write|list)\s+/, '').replace(/\s+\(\d+ bytes\)$/, '')
  const starts = /^start\b/i.test(action)

  switch (s.capability) {
    case 'readFiles':
      return {
        text: /^list\s/.test(action)
          ? st('shared.approvalRisk.consequence.list', { path, host })
          : st('shared.approvalRisk.consequence.read', { path, host }),
        known: true
      }
    case 'writeFiles':
    case 'sftpUpload':
      return {
        text: st('shared.approvalRisk.consequence.overwrite', { path, host }),
        known: true
      }
    case 'sftpDownload':
      return { text: st('shared.approvalRisk.consequence.download', { path, host }), known: true }
    case 'databaseAccess':
      return {
        text: st('shared.approvalRisk.consequence.database', { host }),
        known: true
      }
    case 'serverMetrics':
      return {
        text: st('shared.approvalRisk.consequence.serverMetrics', { host }),
        known: true
      }
    case 'hostFacts':
      return {
        text: st('shared.approvalRisk.consequence.hostFacts', { host }),
        known: true
      }
    case 'sshTunnel':
      return {
        text: /^define\b/i.test(action)
          ? st('shared.approvalRisk.consequence.tunnelDefine')
          : /^remove\b/i.test(action)
            ? st('shared.approvalRisk.consequence.tunnelRemove')
            : starts
              ? st('shared.approvalRisk.consequence.tunnelOpen', { host })
              : st('shared.approvalRisk.consequence.tunnelClose'),
        known: true
      }
    case 'vpnControl':
      return {
        text: starts
          ? st('shared.approvalRisk.consequence.vpnStart')
          : st('shared.approvalRisk.consequence.vpnStop'),
        known: true
      }
    case 'manageServers':
      return {
        text: /^remove\b/i.test(action)
          ? st('shared.approvalRisk.consequence.serverRemove')
          : /^(change|update)\b/i.test(action)
            ? st('shared.approvalRisk.consequence.serverChange')
            : st('shared.approvalRisk.consequence.serverAdd'),
        known: true
      }
    case 'viewServer':
      return {
        text: st('shared.approvalRisk.consequence.viewServer', { host }),
        known: true
      }
    // The host IS named here, unlike vpnControl and manageServers above. A VPN
    // profile's name adds nothing to "your traffic moves"; which CI server a
    // build starts on is most of the blast radius, because that is the estate
    // it can reach and the credentials it runs with.
    //
    // What this sentence must not do is describe the pipeline. OpsMaxx has
    // never read it and has no way to: naming a deploy, an environment or a
    // target here would be a guess printed in the one place an operator is
    // entitled to trust. So it names what is certain -- something starts, we
    // cannot see what, and we cannot stop it.
    case 'ciTrigger':
      return {
        text: /^cancel\b/i.test(action)
          ? st('shared.approvalRisk.consequence.ciCancel', { host })
          : st('shared.approvalRisk.consequence.ciStart', { host }),
        known: true
      }
    case 'ciRead':
      return {
        text: st('shared.approvalRisk.consequence.ciRead', { host }),
        known: true
      }
    default:
      return { text: st('shared.approvalRisk.noConsequence'), known: false }
  }
}

/**
 * The workspace-wide reads. Each is named by its tool, because one capability
 * (fleetRead) covers three reads that disclose very different things, and the
 * sentence is the operator's only way to tell them apart. Every one of them
 * reads what OpsMaxx already holds and opens no connection.
 */
function describeWorkspaceConsequence(s: ApprovalSubject): Consequence {
  const ws = approvalTarget(s)
  switch (s.action) {
    case 'fleet_inventory':
      return {
        text: st('shared.approvalRisk.consequence.fleetInventory', { workspace: ws }),
        known: true
      }
    case 'fleet_drift':
      return {
        text: st('shared.approvalRisk.consequence.fleetDrift', { workspace: ws }),
        known: true
      }
    case 'list_alerts':
      return {
        text: st('shared.approvalRisk.consequence.listAlerts', { workspace: ws }),
        known: true
      }
    case 'backup_status':
      return {
        text: st('shared.approvalRisk.consequence.backupStatus', { workspace: ws }),
        known: true
      }
    case 'list_ci_connections':
      return {
        text: st('shared.approvalRisk.consequence.ciConnections', { workspace: ws }),
        known: true
      }
    default:
      return { text: st('shared.approvalRisk.noConsequence'), known: false }
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
  return s.serverName === null
    ? st('shared.approvalRisk.denial.workspace', { target: approvalTarget(s) })
    : st('shared.approvalRisk.denial.server', { server: s.serverName })
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

/**
 * The deadline to count down to: main's if it sent one, ours if it did not.
 *
 * `deadlineAt` is the moment main's own `setTimeout` will fire, so it is the
 * only value that survives an extension. The derivation above assumes the fuse
 * has not moved since the request was created, which stopped being true the
 * moment "Give me more time" existed: after an extension it points at a moment
 * that has been cancelled, and the operator would watch a countdown reach zero
 * on a request that is still perfectly alive — the same class of lie as a
 * countdown built on an assumed timeout, just later in the story.
 *
 * An unparseable `deadlineAt` falls through to the derivation rather than to
 * null: a malformed timestamp is a reason to distrust that field, not a reason
 * to throw away a countdown that was working before it arrived.
 */
export function resolveFuseDeadline(
  deadlineAt: string | undefined,
  createdAt: string,
  timeoutSeconds: number | null
): number | null {
  if (deadlineAt) {
    const at = Date.parse(deadlineAt)
    if (!Number.isNaN(at)) return at
  }
  return fuseDeadline(createdAt, timeoutSeconds)
}

// ---------------------------------------------------------------------------
// What write_file will write
// ---------------------------------------------------------------------------

/** What secretRedaction.ts puts where a secret was. See contentPreview. */
const REDACTION_MARKER = '[REDACTED]'

/** The most of an agent's file content the dialog shows. See contentPreview. */
export const PREVIEW_MAX_CHARS = 4096
export const PREVIEW_MAX_LINES = 80

// Everything a reader cannot see, or sees in the wrong order, by Unicode
// category rather than by a hand-kept list of code points:
//
//   \p{Cc}  controls (C0, DEL, C1) -- except tab and newline, below
//   \p{Cf}  format characters: soft hyphen, the Arabic letter mark, every
//          zero-width and directional mark, the bidi embeddings, overrides
//          and isolates, the invisible operators, the BOM, the interlinear
//          annotation marks, and the TAG block U+E0000-E007F, which spells
//          ASCII no screen shows ("ASCII smuggling")
//   \p{Zl} \p{Zp}  the line and paragraph separators
//   \p{Cs}  a lone surrogate, which renders as a replacement character
//
// plus the characters that are letters or marks by category and blank on
// screen anyway: the combining grapheme joiner U+034F, the Hangul fillers
// U+115F, U+1160, U+3164 and U+FFA0, the braille pattern blank U+2800, the
// Mongolian vowel separator U+180E, and the variation selectors U+FE00-FE0F
// and U+E0100-E01EF. The `u` flag is what lets the class see anything above
// U+FFFF at all.
//
// A lone CR is spelled out too -- it is how a line hides its own start in a
// terminal -- while the CR of a CRLF pair, the newline and the tab are left
// alone, because every Windows file and every Makefile would otherwise read as
// an attack.
//
// sanitizeAgentIntent and remoteText strip the same kind of character, and
// this does the opposite. Those are sentences, where deleting the character is
// the repair. This is a FILE the operator is about to put on a server:
// deleting a U+202E from the preview would show them a file that is not the
// one being written, which is the exact lie the preview exists to stop. So
// each one is kept, and spelled out.
const PREVIEW_INVISIBLE =
  // The class holds lone combining marks ON PURPOSE -- matching a variation
  // selector by itself, rather than as part of the character it modifies, is
  // how it gets spelled out -- which is what this lint exists to object to.
  // eslint-disable-next-line no-misleading-character-class
  /\r(?!\n)|(?![\t\n\r])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}\u034f\u115f\u1160\u180e\u3164\uffa0\u2800\ufe00-\ufe0f\u{e0100}-\u{e01ef}]/gu

/** `\u202e` becomes `⟨U+202E⟩`, `\u{e0041}` becomes `⟨U+E0041⟩`: printed, never obeyed. */
export function showInvisibles(text: string): string {
  return text.replace(
    PREVIEW_INVISIBLE,
    (c) => `⟨U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}⟩`
  )
}

/**
 * The head of an agent's file content, made fit to show a human.
 *
 * Takes ALREADY-REDACTED text. The redactor lives in main (secretRedaction.ts)
 * because it needs the server's known secret values, and it has to run over the
 * whole content before this cuts it: a known password straddling the cut would
 * otherwise survive as its first half, which no pattern recognises.
 *
 * Capped by characters and by lines, whichever bites first, because either one
 * alone lets a single payload fill the dialog -- one 4 KB line, or eighty
 * one-character ones. The cut is taken on the source text and the invisible
 * characters are spelled out afterwards, so an agent cannot use them to make
 * the preview longer than the cap, and the omitted counts describe the file
 * rather than the rendering.
 */
export function contentPreview(redacted: string): ContentPreview {
  let head = redacted.slice(0, PREVIEW_MAX_CHARS).split('\n').slice(0, PREVIEW_MAX_LINES).join('\n')
  // Nor on part of a redaction marker. Nothing leaks -- the secret was replaced
  // before the cut -- but "[REDAC" reads as file content rather than as
  // OpsMaxx having removed something, so the marker is shown whole or not at
  // all. REDACTION_MARKER must match PLACEHOLDER in secretRedaction.ts; the
  // preview tests run real redactOutput output through here to hold them to it.
  const open = head.lastIndexOf('[')
  if (open >= 0 && head.length - open < REDACTION_MARKER.length && redacted.startsWith(REDACTION_MARKER, open)) {
    head = head.slice(0, open)
  }
  // Never end on half a surrogate pair: it renders as a replacement character
  // that the file does not contain.
  if (/[\ud800-\udbff]$/.test(head)) head = head.slice(0, -1)
  const breaks = (s: string): number => s.split('\n').length - 1
  return {
    text: showInvisibles(head),
    omittedChars: redacted.length - head.length,
    omittedLines: breaks(redacted) - breaks(head)
  }
}
