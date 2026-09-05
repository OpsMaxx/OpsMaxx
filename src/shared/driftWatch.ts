// Item 46: a drift watch an operator chooses, rather than the fixed catalogue.
//
// `drift.ts` states plainly why its list is fixed, and this file is the answer
// to the three things it says a typed path would need first: a stored
// definition with its own rule selection, an approval story for reading an
// arbitrary path on every host in the estate once an hour, and a harder answer
// to the secrets question -- `/etc/nginx/nginx.conf` is a known quantity,
// "whatever the operator typed" is not.
//
// FOUR GATES, and the order they are in is the design.
//
//  1. THE PATH IS INTERPOLATED INTO A SHELL SCRIPT. `buildDriftCommand` embeds
//     each watched path inside single quotes -- `[ ! -e '/etc/foo' ]` -- which
//     is safe for a fixed catalogue and is a command injection the moment a
//     person can type one. A single quote closes the literal. So the character
//     set is an ALLOWLIST, not an escape, and it is checked here rather than at
//     the point of use, because a builder that trusts its caller is a builder
//     that will one day be called by something else.
//
//  2. UNDER `/etc`, AND NOWHERE ELSE. Not because other paths are worthless but
//     because this read runs on every host in the estate once an hour with no
//     further approval, and `/etc` is the one tree where "this is configuration
//     that should be the same across a role" is a defensible default.
//
//  3. A DENYLIST OF CREDENTIAL STORES, and its bias is the OPPOSITE of the one
//     in `mounts.ts`. There, an unknown filesystem type is included, because a
//     wrongly-excluded filesystem is a disk filling up that nobody sees. Here,
//     the cost of being wrong is a private key in a diff, so the denylist
//     blocks what it knows AND the fourth gate carries the rest.
//
//  4. A ONE-TIME TYPED APPROVAL THAT NAMES THE PATH. The phrase contains the
//     path itself, so an approval for `/etc/nginx/nginx.conf` cannot be
//     replayed for `/etc/ssl/private/site.key` -- the same reason
//     `verifyApproval` compares command text literally rather than comparing a
//     summary.

import { DRIFT_RULE_ORDER, type DriftRuleId, type DriftWatch } from './drift'

/**
 * Every character a watched path may contain.
 *
 * No quote of any kind, no backslash, no whitespace, no shell metacharacter.
 * A real path under `/etc` that this rejects is a path somebody should rename
 * before putting it in front of an hourly estate-wide read.
 */
const PATH_OK = /^\/etc\/[A-Za-z0-9._\-/]+$/

/**
 * Paths and shapes that hold secrets.
 *
 * Exact paths first, then shapes. The shapes are deliberately broad -- a file
 * with `key`, `secret`, `password` or `credential` in its name under `/etc` is
 * refused whether or not it really holds one, because the cost of the two
 * mistakes is not symmetric: a wrongly refused config file is a sentence
 * telling somebody why, and a wrongly accepted one is a private key in an
 * hourly diff on every host in the estate.
 */
export const DRIFT_WATCH_DENY_PATHS: readonly string[] = [
  '/etc/shadow',
  '/etc/gshadow',
  '/etc/shadow-',
  '/etc/gshadow-',
  '/etc/krb5.keytab',
  '/etc/machine-id'
]

export const DRIFT_WATCH_DENY_DIRS: readonly string[] = [
  '/etc/ssl/private/',
  '/etc/pki/tls/private/',
  '/etc/letsencrypt/',
  '/etc/wireguard/',
  '/etc/openvpn/',
  '/etc/ipsec.d/private/'
]

const DENY_SHAPES: readonly RegExp[] = [
  /(^|\/)[^/]*(key|secret|password|passwd|credential|token)[^/]*$/i,
  /\.(pem|key|p12|pfx|jks|kdb|gpg|asc)$/i,
  /(^|\/)\.env(\.|$)/i,
  // `id_rsa`, `id_ed25519` and friends carry no `key` in the name.
  /(^|\/)id_[a-z0-9]+$/i
]

export type DriftWatchRefusal =
  | 'not-absolute'
  | 'outside-etc'
  | 'traversal'
  | 'bad-characters'
  | 'too-long'
  | 'credential-store'
  | 'no-rules'
  | 'unknown-rule'
  | 'duplicate'

export const DRIFT_WATCH_REFUSAL_HELP: Record<DriftWatchRefusal, string> = {
  'not-absolute': 'A watched path has to be absolute.',
  'outside-etc':
    'Only paths under /etc can be watched. This read runs on every server once an hour with no further approval, and /etc is the one tree where “configuration that should match across a role” is a safe default.',
  traversal: 'A watched path cannot contain “..”.',
  'bad-characters':
    'A watched path may contain only letters, digits, dot, dash, underscore and slash. The path is embedded in the collector script, and anything else could change what that script runs.',
  'too-long': 'That path is longer than any real configuration file’s.',
  'credential-store':
    'That path is, or looks like, a credential store. Its contents would be carried back and diffed hourly on every server, and no redaction pattern catches every secret format.',
  'no-rules': 'A watch with no rules would compare nothing.',
  'unknown-rule': 'That comparison rule does not exist in this build.',
  duplicate: 'A watch for that path already exists.'
}

/** As long as any path this could sensibly watch. */
const MAX_PATH = 200

export interface DriftWatchProposal {
  path: string
  label: string
  comment: string
  rules: DriftRuleId[]
}

export type DriftWatchCheck =
  | { ok: true; watch: DriftWatch }
  | { ok: false; reason: DriftWatchRefusal; detail: string }

/** A stable id from the path, so the same file always maps to the same watch
 *  and a stored reading is not orphaned by a rename of the label. */
export function driftWatchId(path: string): string {
  return `custom:${path}`
}

export function isCredentialStore(path: string): boolean {
  if (DRIFT_WATCH_DENY_PATHS.includes(path)) return true
  if (DRIFT_WATCH_DENY_DIRS.some((d) => path.startsWith(d))) return true
  return DENY_SHAPES.some((rx) => rx.test(path))
}

/**
 * Check a proposed watch, in the order the header describes.
 *
 * The character check runs BEFORE the credential check on purpose: a path that
 * could break out of the shell literal is refused for that reason and named as
 * such, rather than being reported as a suspected secret, which would send
 * somebody looking at the wrong problem.
 */
export function checkDriftWatch(
  proposal: DriftWatchProposal,
  existing: readonly DriftWatch[] = []
): DriftWatchCheck {
  const path = proposal.path.trim()
  const no = (reason: DriftWatchRefusal): DriftWatchCheck => ({
    ok: false,
    reason,
    detail: DRIFT_WATCH_REFUSAL_HELP[reason]
  })

  if (!path.startsWith('/')) return no('not-absolute')
  if (path.length > MAX_PATH) return no('too-long')
  // Before the `/etc` test, so `/etc/../root/.ssh/id_rsa` is refused as what it
  // is rather than accepted for starting with the right four characters.
  if (path.includes('..')) return no('traversal')
  if (!PATH_OK.test(path)) {
    return no(path.startsWith('/etc/') ? 'bad-characters' : 'outside-etc')
  }
  if (isCredentialStore(path)) return no('credential-store')
  if (proposal.rules.length === 0) return no('no-rules')
  if (proposal.rules.some((r) => !DRIFT_RULE_ORDER.includes(r))) return no('unknown-rule')
  if (existing.some((w) => w.path === path)) return no('duplicate')

  return {
    ok: true,
    watch: {
      id: driftWatchId(path),
      label: proposal.label.trim() === '' ? path : proposal.label.trim(),
      path,
      // A comment character is a single printable byte or nothing. It reaches
      // the normaliser, not the shell, but an unbounded string here would end
      // up in a regex.
      comment: /^[#;/!%-]{1,2}$/.test(proposal.comment) ? proposal.comment : '#',
      rules: DRIFT_RULE_ORDER.filter((r) => proposal.rules.includes(r)),
      note:
        'Added by an operator. This file is read on every server in this workspace once an hour, ' +
        'as the connecting account and never with sudo.'
    }
  }
}

/**
 * The phrase the operator types, and it CONTAINS THE PATH.
 *
 * A generic word would make one approval reusable for any watch: the dialog
 * says one path, the store keeps another, and nothing in the record would show
 * the difference. This is the same reason `verifyApproval` compares the command
 * text rather than a summary of it.
 */
export function driftWatchPhrase(path: string): string {
  return `WATCH ${path}`
}

/** What the operator is actually asserting, said out loud before they type. */
export function driftWatchApprovalSentence(path: string): string {
  return (
    `Typing this adds ${path} to a read that runs on every server in this workspace once an hour. ` +
    'Its contents are carried back, redacted, hashed and compared. Confirm it is configuration ' +
    'and not a credential store: nothing here can tell the difference for a file it has never seen, ' +
    'and no redaction pattern catches every secret format.'
  )
}

export function verifyDriftWatchApproval(path: string, typed: string): boolean {
  // Trimmed and compared exactly, the way an approval phrase always is. Not
  // case-folded: a phrase that accepts `watch /etc/foo` accepts a slip, and a
  // slip is not a decision.
  return typed.trim() === driftWatchPhrase(path)
}
