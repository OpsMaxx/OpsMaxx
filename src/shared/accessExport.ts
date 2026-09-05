// Item 46's access-review export: the answer to "who can get into what", in a
// file somebody can hand to an auditor.
//
// It is a projection of facts the access collector already holds, so nothing
// here reads a host. What it adds is three rules, and all three are about the
// difference between a fact and a gap.
//
//  1. A HOST THAT REFUSED IS A ROW. An export is read as a complete list of
//     access, and a host that could not be read dropping out of it turns "we
//     could not look at that machine" into "nobody can get into that machine".
//     Every host appears, and one that was not read says so in its own column.
//
//  2. A `since` FILTER NEVER SILENTLY DROPS AN UNKNOWN. `lastLoginAt` is null
//     for an account whose last login could not be dated -- and for one that
//     has never logged in at all, which are different things the collector
//     already separates. Filtering "logged in since March" by a null would
//     quietly remove exactly the accounts an auditor is looking for, so they
//     are kept and marked.
//
//  3. NO KEY MATERIAL, EVER. The row carries a fingerprint, a type, a size, a
//     comment and the options. `AuthorizedKey` holds no blob to begin with, and
//     this file adding a column that reconstructed one would be the leak the
//     whole access feature is built to avoid. Its absence here is deliberate
//     and is asserted by a test rather than left to review.

import type { AccessAccount, AccessStatus, AuthorizedKey, HostAccess } from './access'
import { classifyAccount, type AccountClass } from './staleAccounts'

export interface AccessExportInput {
  serverId: string
  serverName: string
  /** null when the collector never got an answer for this host. */
  access: HostAccess | null
  /** Why, when `access` is null. */
  error?: string | null
}

/** How an account's last login relates to the `since` cut-off. */
export type LoginRecency =
  /** Logged in on or after the cut-off. */
  | 'since'
  /** Logged in, and before it. */
  | 'before'
  /** Has never logged in, and the host said so. */
  | 'never'
  /** Logged in at a time this could not be dated, so neither of the above can
   *  be claimed. Kept in every view for that reason. */
  | 'undated'

export interface AccessExportRow {
  serverId: string
  serverName: string
  /** Empty for a host-level row that carries no account. */
  user: string
  uid: number | null
  klass: AccountClass | ''
  /** null when no shell was read -- not false, which claims a login is possible. */
  loginDisabled: boolean | null
  adminGroups: string
  shell: string
  passwordLocked: boolean | null
  expired: boolean | null
  lastLogin: string
  recency: LoginRecency | ''
  /** One row per key. Empty on an account with none, or with none readable. */
  keyFingerprint: string
  keyType: string
  keyBits: number | null
  keyComment: string
  keyOptions: string
  keyRestricted: boolean | null
  /** What the collector managed to see for this account's keys. */
  keysStatus: AccessStatus | ''
  /** Set on a row that exists because the HOST could not be read. */
  hostProblem: string
}

const EMPTY: Omit<AccessExportRow, 'serverId' | 'serverName'> = {
  user: '',
  uid: null,
  klass: '',
  loginDisabled: null,
  adminGroups: '',
  shell: '',
  passwordLocked: null,
  expired: null,
  lastLogin: '',
  recency: '',
  keyFingerprint: '',
  keyType: '',
  keyBits: null,
  keyComment: '',
  keyOptions: '',
  keyRestricted: null,
  keysStatus: '',
  hostProblem: ''
}

export function loginRecency(a: AccessAccount, since: number | null): LoginRecency {
  if (a.neverLoggedIn) return 'never'
  if (a.lastLoginAt === null) return 'undated'
  if (since === null) return 'since'
  return a.lastLoginAt >= since ? 'since' : 'before'
}

function keyRows(
  base: Omit<AccessExportRow, 'serverId' | 'serverName'>,
  keys: AuthorizedKey[] | null
): Omit<AccessExportRow, 'serverId' | 'serverName'>[] {
  if (keys === null || keys.length === 0) return [base]
  return keys.map((k) => ({
    ...base,
    keyFingerprint: k.fingerprint ?? '',
    keyType: k.type ?? k.rawType ?? '',
    keyBits: k.bits,
    keyComment: k.comment ?? '',
    keyOptions: k.options.join(' '),
    keyRestricted: k.restricted
  }))
}

export interface AccessExportOptions {
  /** Epoch milliseconds. Accounts that logged in before it are excluded, but an
   *  undated or never-used account is NOT -- see rule 2. */
  since?: number | null
}

/**
 * One row per account, or per key where an account has several.
 *
 * A host with no answer produces exactly one row naming the problem, so the
 * export's row count is never smaller than the estate.
 */
export function buildAccessExport(
  hosts: AccessExportInput[],
  opts: AccessExportOptions = {}
): AccessExportRow[] {
  const since = opts.since ?? null
  const out: AccessExportRow[] = []
  for (const h of hosts) {
    const at = { serverId: h.serverId, serverName: h.serverName }
    if (h.access === null) {
      out.push({
        ...at,
        ...EMPTY,
        hostProblem: h.error ?? 'this host was not read, so nothing is known about who can reach it'
      })
      continue
    }
    // The host answered and named no accounts at all. Still a row: an empty
    // section in an access review is a question, and a missing one is not.
    if (h.access.accounts.length === 0) {
      out.push({ ...at, ...EMPTY, hostProblem: 'the host answered and listed no accounts' })
      continue
    }
    for (const a of h.access.accounts) {
      const recency = loginRecency(a, since)
      if (since !== null && recency === 'before') continue
      const { klass, loginDisabled } = classifyAccount(a)
      const base = {
        ...EMPTY,
        user: a.user,
        uid: a.uid,
        klass,
        loginDisabled,
        adminGroups: (a.adminGroups ?? []).join(' '),
        shell: a.shell ?? '',
        passwordLocked: a.passwordLocked,
        expired: a.expired,
        lastLogin: a.lastLoginText ?? '',
        recency,
        keysStatus: a.keysStatus
      }
      for (const row of keyRows(base, a.keys)) out.push({ ...at, ...row })
    }
  }
  return out
}

export interface AccessCoverageRow {
  serverId: string
  serverName: string
  /** When the facts in this export were collected. null for a host with none. */
  collectedAt: number | null
  /** False means sshd reads keys from somewhere this collection did not look,
   *  so the key list for that host is INCOMPLETE. null means it could not be
   *  settled. */
  keyFileIsDefault: boolean | null
  readsTheFileWeRead: boolean | null
  /** A host whose sshd runs a command to produce keys has an inventory this
   *  cannot see at all. */
  authorizedKeysCommand: string
  accountsWithUnreadKeys: number
  problem: string
}

/**
 * The line that travels with the export.
 *
 * NOT a footnote. An export is read as a complete list, and every field here is
 * a way for it not to be one -- a host that refused, an sshd reading keys from
 * a path this never opened, an `AuthorizedKeysCommand` generating them at login
 * time, an account whose file could not be read. Handing over the rows without
 * this is handing over a list whose gaps are invisible.
 */
export function accessExportCoverage(hosts: AccessExportInput[]): AccessCoverageRow[] {
  return hosts.map((h) => {
    if (h.access === null) {
      return {
        serverId: h.serverId,
        serverName: h.serverName,
        collectedAt: null,
        keyFileIsDefault: null,
        readsTheFileWeRead: null,
        authorizedKeysCommand: '',
        accountsWithUnreadKeys: 0,
        problem: h.error ?? 'this host was not read'
      }
    }
    const unread = h.access.accounts.filter((a) => a.keysStatus !== 'ok' && a.keysStatus !== 'absent')
    const problems: string[] = []
    if (h.access.keyFileIsDefault === false) {
      problems.push('sshd reads authorized keys from a path this collection did not open')
    }
    if (h.access.keyFileIsDefault === null) {
      problems.push('sshd’s key-file configuration could not be settled')
    }
    if (h.access.readsTheFileWeRead === false) {
      problems.push('sshd does not read the file this collection read, so these keys grant nothing')
    }
    if (h.access.authorizedKeysCommand !== null) {
      problems.push(
        `sshd generates keys with ${h.access.authorizedKeysCommand}, which produces them at login time and cannot be listed from disk`
      )
    }
    if (unread.length > 0) {
      problems.push(`${unread.length} account(s) whose keys could not be read`)
    }
    return {
      serverId: h.serverId,
      serverName: h.serverName,
      collectedAt: h.access.collectedAt,
      keyFileIsDefault: h.access.keyFileIsDefault,
      readsTheFileWeRead: h.access.readsTheFileWeRead,
      authorizedKeysCommand: h.access.authorizedKeysCommand ?? '',
      accountsWithUnreadKeys: unread.length,
      problem: problems.join('; ')
    }
  })
}

export const ACCESS_EXPORT_COLUMNS: readonly (keyof AccessExportRow)[] = [
  'serverName',
  'user',
  'uid',
  'klass',
  'loginDisabled',
  'adminGroups',
  'shell',
  'passwordLocked',
  'expired',
  'lastLogin',
  'recency',
  'keyFingerprint',
  'keyType',
  'keyBits',
  'keyComment',
  'keyOptions',
  'keyRestricted',
  'keysStatus',
  'hostProblem'
]

/** A CSV cell. `null` is EMPTY and never the word "null" or a zero: a spreadsheet
 *  reading `0` for "we could not tell" is the whole failure this app avoids. */
function cell(v: string | number | boolean | null): string {
  if (v === null) return ''
  const s = typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v)
  // A leading `=`, `+`, `-` or `@` makes a spreadsheet treat the cell as a
  // FORMULA. A key comment is attacker-controlled text from a host, so this is
  // an injection into the auditor's spreadsheet rather than a formatting nicety.
  const guarded = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s
  return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded
}

export function accessExportCsv(rows: AccessExportRow[]): string {
  const head = ACCESS_EXPORT_COLUMNS.join(',')
  const body = rows.map((r) => ACCESS_EXPORT_COLUMNS.map((c) => cell(r[c])).join(','))
  return [head, ...body].join('\n')
}

export function accessCoverageCsv(rows: AccessCoverageRow[]): string {
  const cols: (keyof AccessCoverageRow)[] = [
    'serverName',
    'collectedAt',
    'keyFileIsDefault',
    'readsTheFileWeRead',
    'authorizedKeysCommand',
    'accountsWithUnreadKeys',
    'problem'
  ]
  return [
    cols.join(','),
    ...rows.map((r) => cols.map((c) => cell(r[c] as string | number | boolean | null)).join(','))
  ].join('\n')
}

/**
 * The JSON form, coverage FIRST.
 *
 * Order matters in a file somebody scrolls: the rows are the interesting part
 * and the coverage is the part that says whether the rows are the whole story,
 * so it goes where it will be seen rather than after four thousand lines.
 */
export function accessExportJson(
  rows: AccessExportRow[],
  coverage: AccessCoverageRow[],
  opts: { since?: number | null; generatedAt: number } = { generatedAt: 0 }
): string {
  return JSON.stringify(
    {
      generatedAt: opts.generatedAt,
      since: opts.since ?? null,
      coverage,
      accounts: rows
    },
    null,
    2
  )
}
