import type { AccessAccount, AccessStatus } from './access'

// Item 45's "dead users and keys": which accounts still hold a working key
// nobody has used.
//
// A PURE VERDICT and nothing else. Revoking stays behind item 36's gate, and
// this deliberately produces no command, no plan and no button — the finding is
// the product. An operator who is told "this key has not been used in 400 days"
// can act on it through a path that has a rollback; one who is handed a Revoke
// button here would be acting through a path that does not.
//
// THE FAILURE THIS IS WRITTEN AGAINST is not "we missed a stale account". It is
// calling an account stale because the HOST could not answer. `lastlog` is
// absent on a growing number of distributions -- it was dropped from
// util-linux's defaults and Fedora and Debian ship without it -- so "no login
// recorded" is the answer a working host with no lastlog gives, and it is
// identical to the answer for an account nobody has touched since 2019. Reading
// the first as the second would have an operator revoke a key somebody used
// this morning.

export type StaleVerdict =
  /** A live key, and the host says the account has never been used. */
  | 'never-used'
  /** A live key, and the last login is older than the window asked about. */
  | 'stale'
  /** A live key, used inside the window. */
  | 'active'
  /** Something needed to answer could not be read. NOT a synonym for stale. */
  | 'unknown'

export interface StaleAccountFinding {
  serverId: string
  serverName: string
  user: string
  verdict: StaleVerdict
  /** Whole days since the last login, or null when there is no date to subtract. */
  daysSinceLogin: number | null
  /** How many keys would still work. Null when the key file could not be read. */
  keyCount: number | null
  /** One sentence, in the app's own words. Never the host's. */
  because: string
}

export interface StaleAccountsInput {
  serverId: string
  serverName: string
  accounts: AccessAccount[] | null
}

/** Statuses that mean "we did not get to look", as opposed to "we looked and
 *  there is nothing". `absent` is a real answer; these are not. */
const COULD_NOT_TELL: AccessStatus[] = ['denied', 'unknown', 'no-tool', 'unsupported', 'partial']

const DAY = 86_400_000

/**
 * Accounts worth a second look, across a set of servers.
 *
 * Only accounts that could still BE USED are considered:
 *
 *  - an account with no keys and a readable key file is not a finding. It is
 *    not a way in.
 *  - an account whose expiry date has passed is not a finding either: sshd
 *    already refuses it, and listing it would bury the ones that still work.
 *    `expired: null` is NOT that -- a date nobody could parse is not a date in
 *    the past -- so only an explicit `true` excludes.
 *  - an account whose key file could not be read IS a finding, of the
 *    `unknown` kind. "We could not see whether this account has keys" is
 *    something an operator should know, and silence would present it as clean.
 */
export function staleAccounts(hosts: StaleAccountsInput[], days: number, now = Date.now()): StaleAccountFinding[] {
  const out: StaleAccountFinding[] = []
  const window = Math.max(1, Math.floor(days)) * DAY

  for (const host of hosts) {
    // `null` accounts is a server that was never read, not a server with no
    // accounts. It contributes nothing rather than a clean bill.
    if (host.accounts === null) continue

    for (const a of host.accounts) {
      if (a.expired === true) continue

      const unreadableKeys = a.keys === null || COULD_NOT_TELL.includes(a.keysStatus)
      const keyCount = a.keys === null ? null : a.keys.length
      if (!unreadableKeys && (keyCount ?? 0) === 0) continue

      const base = { serverId: host.serverId, serverName: host.serverName, user: a.user, keyCount }

      if (unreadableKeys) {
        out.push({
          ...base,
          verdict: 'unknown',
          daysSinceLogin: null,
          because: `The keys on ${a.user} could not be read, so whether this account is a way in is unknown.`
        })
        continue
      }

      // The host said, in as many words, that this account has never been used.
      // Distinct from the case below it, and a stronger finding: a key that has
      // never been used is a key nobody will miss.
      if (a.neverLoggedIn) {
        out.push({
          ...base,
          verdict: 'never-used',
          daysSinceLogin: null,
          because: `${a.user} holds ${keyCount} key(s) and has never logged in.`
        })
        continue
      }

      // No parsed date, and the host did not say "never". That is the lastlog
      // case, and it is the whole reason this function is careful.
      if (a.lastLoginAt === null) {
        out.push({
          ...base,
          verdict: 'unknown',
          daysSinceLogin: null,
          because: a.lastLoginText
            ? `${a.user}'s last login could not be turned into a date, so how long its ${keyCount} key(s) have been idle is unknown.`
            : `This server did not report a last login for ${a.user}, so how long its ${keyCount} key(s) have been idle is unknown. A server without lastlog answers this way about accounts in daily use.`
        })
        continue
      }

      const idle = Math.floor((now - a.lastLoginAt) / DAY)
      out.push({
        ...base,
        verdict: now - a.lastLoginAt >= window ? 'stale' : 'active',
        daysSinceLogin: idle,
        because:
          now - a.lastLoginAt >= window
            ? `${a.user} holds ${keyCount} key(s) and last logged in ${idle} days ago.`
            : `${a.user} logged in ${idle} days ago.`
      })
    }
  }
  return out
}

/**
 * The headline, which has to carry the unknowns.
 *
 * A count of stale accounts with the unknowns dropped is a number that gets
 * smaller as the estate gets harder to read, which is the wrong direction for a
 * number an operator uses to decide they are done.
 */
export function summariseStaleAccounts(findings: StaleAccountFinding[]): {
  stale: number
  neverUsed: number
  unknown: number
  headline: string
} {
  const stale = findings.filter((f) => f.verdict === 'stale').length
  const neverUsed = findings.filter((f) => f.verdict === 'never-used').length
  const unknown = findings.filter((f) => f.verdict === 'unknown').length

  if (stale === 0 && neverUsed === 0 && unknown === 0) {
    return { stale, neverUsed, unknown, headline: 'Every account with a key has been used recently.' }
  }
  const parts: string[] = []
  if (neverUsed > 0) parts.push(`${neverUsed} never used`)
  if (stale > 0) parts.push(`${stale} idle`)
  if (unknown > 0) parts.push(`${unknown} that could not be answered`)
  return { stale, neverUsed, unknown, headline: `Accounts holding keys: ${parts.join(', ')}.` }
}
