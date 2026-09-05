// Item 36b: what sudo actually grants, instead of "is in the wheel group".
//
// `access.ts` decides an account has sudo by looking at ADMIN_GROUPS, and says
// so in a comment. That is a guess with two failure directions: an account in
// `wheel` on a host whose sudoers does not mention wheel has no sudo, and an
// account in no admin group at all can hold a NOPASSWD line granting ALL.
//
// THE FILE IS ATTACKER-CONTROLLED TEXT. It is read off a machine this app does
// not own, so every value that leaves this parser is capped and every line that
// could not be understood is REPORTED rather than dropped. A sudoers parser
// that silently ignores what it cannot read is a parser that will one day
// ignore the line granting root.
//
// WHAT THIS IS NOT. It does not evaluate whether a given command matches a
// spec: sudoers command matching involves globs, directories, `sudoedit`,
// argument matching and negation, and a half-implementation would answer
// "no" for a command that in fact runs. It answers the questions whose answers
// are unambiguous -- who is named, whether a password is required, and whether
// the grant is ALL -- and reports the rest verbatim for a person to read.

/** Per value, because these strings are rendered. A sudoers file with a
 *  100 KB alias is a file designed to break whatever displays it. */
const VALUE_CAP = 512
/** Lines parsed per file. A real sudoers is tens of lines. */
export const SUDOERS_MAX_LINES = 2000

const cap = (s: string): string => (s.length > VALUE_CAP ? `${s.slice(0, VALUE_CAP)}…` : s)

export type SudoersAliasKind = 'User_Alias' | 'Runas_Alias' | 'Cmnd_Alias' | 'Host_Alias'

export interface SudoersAlias {
  kind: SudoersAliasKind
  name: string
  members: string[]
}

export interface SudoersSpec {
  /** `alice`, `%wheel`, `+netgroup`, or an alias name. Verbatim. */
  who: string
  hosts: string
  /** What it may run AS. `ALL` when unqualified, which is what an unadorned
   *  `ALL=ALL` means. */
  runAs: string
  /**
   * Whether a password is required for the commands in this spec.
   *
   * THREE VALUES, not a boolean, because sudoers tags apply to the commands
   * that FOLLOW them: `NOPASSWD: /bin/ls, PASSWD: /bin/rm` is one spec in
   * which one command needs a password and the other does not. A boolean
   * answers that wrongly whichever way it is set, and the wrong direction --
   * `true` -- would report an account as having passwordless root when it has
   * passwordless `ls`.
   */
  noPassword: 'all' | 'some' | 'none'
  /** The command list, verbatim and capped. `ALL` is the one this file
   *  interprets, because it is unambiguous. */
  commands: string
  /** True when the command list is exactly ALL -- root, in one word. */
  grantsAll: boolean
  /** 1-based, so a finding can be pointed at. */
  line: number
}

export interface SudoersReading {
  aliases: SudoersAlias[]
  specs: SudoersSpec[]
  /** `Defaults` lines, verbatim. Not interpreted: `Defaults!` and per-user
   *  forms change behaviour in ways this does not model. */
  defaults: string[]
  /** Files this one pulls in. Reported so a caller knows the reading is
   *  INCOMPLETE without them. */
  includes: string[]
  /** Lines that could not be understood, with their numbers. Never dropped. */
  unparsed: { line: number; text: string }[]
  /** True when the file was longer than SUDOERS_MAX_LINES. */
  truncated: boolean
}

const ALIAS_RE = /^(User_Alias|Runas_Alias|Cmnd_Alias|Host_Alias)\s+([A-Z][A-Z0-9_]*)\s*=\s*(.+)$/
// `who hosts = rest`. The user list may be comma-separated, so the HOST field
// is the last bare token before the `=`.
const SPEC_RE = /^(\S.*?)\s+(\S+)\s*=\s*(.+)$/

/**
 * One sudoers file.
 *
 * Continuations are joined first: sudoers uses a trailing `\` and a spec split
 * across three lines is one rule, which a line-at-a-time reader would see as
 * three unparsable fragments.
 */
export function parseSudoers(text: string): SudoersReading {
  const out: SudoersReading = {
    aliases: [],
    specs: [],
    defaults: [],
    includes: [],
    unparsed: [],
    truncated: false
  }

  const raw = text.split('\n')
  if (raw.length > SUDOERS_MAX_LINES) out.truncated = true
  const lines = raw.slice(0, SUDOERS_MAX_LINES)

  // Join continuations, keeping the FIRST line's number so a finding points at
  // where the rule starts.
  const joined: { line: number; text: string }[] = []
  let buf = ''
  let start = 0
  lines.forEach((l, i) => {
    if (buf === '') start = i + 1
    if (l.endsWith('\\')) {
      buf += `${l.slice(0, -1)} `
      return
    }
    joined.push({ line: start, text: buf + l })
    buf = ''
  })
  if (buf !== '') joined.push({ line: start, text: buf })

  for (const { line, text: rawLine } of joined) {
    const t = rawLine.trim()
    if (t === '') continue

    // `#include` and `#includedir` are DIRECTIVES that happen to start with the
    // comment character. Reading them as comments is how a parser concludes a
    // host has no sudoers rules while /etc/sudoers.d holds all of them.
    const inc = /^[#@]include(dir)?\s+(\S+)/.exec(t)
    if (inc) {
      out.includes.push(cap(inc[2]))
      continue
    }
    if (t.startsWith('#')) continue

    if (/^Defaults/.test(t)) {
      out.defaults.push(cap(t))
      continue
    }

    const alias = ALIAS_RE.exec(t)
    if (alias) {
      out.aliases.push({
        kind: alias[1] as SudoersAliasKind,
        name: alias[2],
        members: alias[3].split(',').map((m) => cap(m.trim())).filter(Boolean)
      })
      continue
    }

    const spec = SPEC_RE.exec(t)
    if (spec) {
      let rest = spec[3].trim()
      let runAs = 'ALL'
      const ra = /^\(([^)]*)\)\s*(.*)$/.exec(rest)
      if (ra) {
        runAs = cap(ra[1].trim())
        rest = ra[2].trim()
      }
      // Tags run in front of the command list and may repeat:
      // `NOPASSWD: SETENV: /bin/ls`. Consumed one at a time rather than with a
      // single regex, so an unknown tag does not swallow the commands.
      // Tags run in front of the command list and may repeat:
      // `NOPASSWD: SETENV: /bin/ls`. Consumed one at a time rather than with a
      // single regex, so an unknown tag does not swallow the commands.
      const TAG_RE = /^(NOPASSWD|PASSWD|NOEXEC|EXEC|SETENV|NOSETENV|LOG_INPUT|NOLOG_INPUT|LOG_OUTPUT|NOLOG_OUTPUT|FOLLOW|NOFOLLOW|MAIL|NOMAIL):\s*/
      let leading = false
      for (;;) {
        const tag = TAG_RE.exec(rest)
        if (!tag) break
        if (tag[1] === 'NOPASSWD') leading = true
        if (tag[1] === 'PASSWD') leading = false
        rest = rest.slice(tag[0].length)
      }
      // A tag appearing LATER in the command list applies from there on, so the
      // spec is mixed and neither answer is true of all of it.
      const laterTag = /,\s*(NOPASSWD|PASSWD):/.test(rest)
      const noPassword: SudoersSpec['noPassword'] = laterTag ? 'some' : leading ? 'all' : 'none'
      out.specs.push({
        who: cap(spec[1].trim()),
        hosts: cap(spec[2].trim()),
        runAs,
        noPassword,
        commands: cap(rest.trim()),
        grantsAll: rest.trim() === 'ALL',
        line
      })
      continue
    }

    // Everything else. A line nobody could read might be the one that grants
    // root, so it is carried out of here.
    out.unparsed.push({ line, text: cap(t) })
  }
  return out
}

export interface SudoFinding {
  who: string
  runAs: string
  noPassword: 'all' | 'some' | 'none'
  grantsAll: boolean
  commands: string
  line: number
  /** How the account was matched: directly, through a group, or through a
   *  User_Alias. Reported because "why does this account have root" is the
   *  question being asked. */
  via: 'name' | 'group' | 'alias'
}

/**
 * What sudo grants one account, according to the file rather than to a group
 * list.
 *
 * `groups` is what the host said the account is in. A spec naming `%wheel`
 * matches an account in wheel; a spec naming a User_Alias matches if the
 * account or one of its groups is a member of that alias.
 *
 * Netgroups (`+name`) are NOT resolved: they come from NIS or sssd and this
 * app cannot see them. A spec naming one is left out of the findings and stays
 * visible in the reading's own spec list, which is the honest place for a rule
 * whose membership we cannot evaluate.
 */
export function sudoPrivilegesFor(
  user: string,
  groups: string[],
  reading: SudoersReading
): SudoFinding[] {
  const userAliases = new Set(
    reading.aliases
      .filter((a) => a.kind === 'User_Alias')
      .filter((a) => a.members.some((m) => m === user || (m.startsWith('%') && groups.includes(m.slice(1)))))
      .map((a) => a.name)
  )

  const out: SudoFinding[] = []
  for (const s of reading.specs) {
    for (const who of s.who.split(',').map((w) => w.trim()).filter(Boolean)) {
      let via: SudoFinding['via'] | null = null
      if (who === user) via = 'name'
      else if (who.startsWith('%') && groups.includes(who.slice(1))) via = 'group'
      else if (userAliases.has(who)) via = 'alias'
      if (via === null) continue
      out.push({
        who,
        runAs: s.runAs,
        noPassword: s.noPassword,
        grantsAll: s.grantsAll,
        commands: s.commands,
        line: s.line,
        via
      })
      break
    }
  }
  return out
}

/** The sentence for one account. Says what is unknown as loudly as what is
 *  granted, because an incomplete sudoers reading is the case where "no sudo"
 *  is most likely to be wrong. */
export function describeSudo(findings: SudoFinding[], reading: SudoersReading): string {
  const gaps: string[] = []
  if (reading.includes.length > 0) gaps.push(`${reading.includes.length} included file(s) not read`)
  if (reading.unparsed.length > 0) gaps.push(`${reading.unparsed.length} line(s) this could not read`)
  if (reading.truncated) gaps.push('the file was longer than this reads')
  const tail = gaps.length > 0 ? ` — but ${gaps.join(', ')}, so this is not the whole picture.` : ''

  if (findings.length === 0) return `No sudoers rule names this account${tail || '.'}`
  const root = findings.filter((f) => f.grantsAll)
  const free = findings.filter((f) => f.noPassword === 'all')
  const mixed = findings.filter((f) => f.noPassword === 'some')
  if (root.length > 0 && free.length > 0) {
    return `Can run ANY command, WITHOUT a password${tail || '.'}`
  }
  if (root.length > 0) return `Can run any command, with a password${tail || '.'}`
  if (free.length > 0) return `Can run ${free.length} listed command set(s) without a password${tail || '.'}`
  // Said rather than rounded to one side: some of these commands need a
  // password and some do not, and which is which is per command.
  if (mixed.length > 0) {
    return `Named by ${findings.length} rule(s), some of whose commands need no password${tail || '.'}`
  }
  return `Named by ${findings.length} rule(s), with a password${tail || '.'}`
}
