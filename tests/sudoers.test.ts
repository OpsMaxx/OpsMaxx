import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import {
  describeSudo,
  parseSudoers,
  sudoPrivilegesFor,
  SUDOERS_MAX_LINES
} from '../src/shared/sudoers'

// Item 36b. `access.ts` decides an account has sudo by looking at ADMIN_GROUPS
// and says so in a comment. That is a guess with two failure directions: an
// account in `wheel` on a host whose sudoers never mentions wheel has no sudo,
// and an account in no admin group at all can hold a NOPASSWD line granting
// ALL.
//
// The two fixtures are the real files, taken out of debian:12 (with sudo
// installed, since the image ships without it) and almalinux:9. A parser
// tested only against input written to satisfy it is a parser tested against
// itself.

const DIR = fileURLToPath(new URL('./fixtures/sudoers', import.meta.url))
const fixture = (n: string): string => readFileSync(join(DIR, n), 'utf8')

describe('the files two real distributions actually ship', () => {
  it('reads Debian 12: root and %sudo get everything, and sudoers.d is included', () => {
    const r = parseSudoers(fixture('debian-12.txt'))
    const specs = r.specs.map((s) => `${s.who} ${s.runAs} ${s.commands}`)
    expect(specs).toContain('root ALL:ALL ALL')
    expect(specs).toContain('%sudo ALL:ALL ALL')
    // `@includedir` is a DIRECTIVE, not a comment. Reading it as one is how a
    // parser concludes a host has no rules while /etc/sudoers.d holds them all.
    expect(r.includes).toEqual(['/etc/sudoers.d'])
  })

  it('reads AlmaLinux 9: root and %wheel, and the tab-separated form', () => {
    const r = parseSudoers(fixture('rhel9.txt'))
    const who = r.specs.map((s) => s.who)
    expect(who).toContain('root')
    expect(who).toContain('%wheel')
    // `#includedir` -- the older spelling, still shipped.
    expect(r.includes).toContain('/etc/sudoers.d')
  })

  it('does not mistake the commented-out examples for rules', () => {
    // Both files are mostly commented Cmnd_Alias examples. A parser that read
    // them would report an estate as wildly more permissive than it is.
    const r = parseSudoers(fixture('rhel9.txt'))
    expect(r.aliases).toEqual([])
    expect(r.specs.every((s) => !s.commands.includes('#'))).toBe(true)
  })

  it('finds no unreadable rule in either file', () => {
    for (const f of ['debian-12.txt', 'rhel9.txt']) {
      expect(parseSudoers(fixture(f)).unparsed, f).toEqual([])
    }
  })
})

describe('what a rule grants', () => {
  const text = [
    'User_Alias ADMINS = alice, %ops',
    'Cmnd_Alias SERVICES = /usr/bin/systemctl restart nginx',
    'Defaults env_reset',
    'root ALL=(ALL:ALL) ALL',
    '%wheel ALL=(ALL) ALL',
    'bob ALL=(root) NOPASSWD: /usr/bin/systemctl restart nginx',
    'ADMINS ALL=(ALL) NOPASSWD: SERVICES',
    'carol ALL=(ALL) NOPASSWD: SETENV: /bin/ls',
    'dave ALL=(ALL) NOPASSWD: /bin/ls, PASSWD: /bin/rm'
  ].join('\n')
  const r = parseSudoers(text)

  it('separates the run-as list from the commands', () => {
    const root = r.specs.find((s) => s.who === 'root')!
    expect(root.runAs).toBe('ALL:ALL')
    expect(root.grantsAll).toBe(true)
  })

  it('sees NOPASSWD, and does not let an unknown tag swallow the commands', () => {
    expect(r.specs.find((s) => s.who === 'bob')!.noPassword).toBe('all')
    const carol = r.specs.find((s) => s.who === 'carol')!
    expect(carol.noPassword).toBe('all')
    expect(carol.commands).toBe('/bin/ls')
  })

  // Tags apply to the commands that FOLLOW them, so this one spec has a
  // command that needs a password and one that does not. A boolean answers it
  // wrongly whichever way it is set, and `true` would report an account as
  // having passwordless root when it has passwordless `ls`.
  it('calls a spec whose tags change mid-list what it is: mixed', () => {
    expect(r.specs.find((s) => s.who === 'dave')!.noPassword).toBe('some')
    expect(describeSudo(sudoPrivilegesFor('dave', [], r), r)).toContain('some of whose commands')
  })

  it('matches an account by name, by group, and through a User_Alias', () => {
    expect(sudoPrivilegesFor('bob', [], r).map((f) => f.via)).toEqual(['name'])
    expect(sudoPrivilegesFor('erin', ['wheel'], r).map((f) => f.via)).toEqual(['group'])
    // alice is a member of ADMINS by name; anyone in `ops` is by group.
    expect(sudoPrivilegesFor('alice', [], r).map((f) => f.via)).toEqual(['alias'])
    expect(sudoPrivilegesFor('frank', ['ops'], r).map((f) => f.via)).toEqual(['alias'])
  })

  it('names nobody who is not named', () => {
    expect(sudoPrivilegesFor('nobody', ['users'], r)).toEqual([])
  })

  it('says the dangerous combination in the strongest words it has', () => {
    const wheel = describeSudo(sudoPrivilegesFor('erin', ['wheel'], r), r)
    expect(wheel).toContain('any command')
    const bob = describeSudo(sudoPrivilegesFor('bob', [], r), r)
    expect(bob).toContain('without a password')
  })
})

describe('what it refuses to pretend it read', () => {
  it('carries an unreadable line out rather than dropping it', () => {
    // A line nobody could read might be the one that grants root.
    const r = parseSudoers('root ALL=(ALL) ALL\n>>> this is not sudoers <<<\n')
    expect(r.unparsed).toHaveLength(1)
    expect(r.unparsed[0].line).toBe(2)
  })

  it('says the reading is incomplete when the file includes another', () => {
    const r = parseSudoers('@includedir /etc/sudoers.d\n')
    expect(describeSudo([], r)).toContain('not the whole picture')
  })

  it('says so when a line it could not read exists, even for an account with no rules', () => {
    const r = parseSudoers('!!! nonsense !!!\n')
    const text = describeSudo([], r)
    expect(text).toContain('could not read')
    expect(text).toContain('not the whole picture')
  })

  it('joins continuations, so a rule split over lines is one rule', () => {
    const r = parseSudoers('alice ALL=(ALL) \\\n  NOPASSWD: /bin/ls\n')
    expect(r.unparsed).toEqual([])
    expect(r.specs).toHaveLength(1)
    expect(r.specs[0].noPassword).toBe('all')
    // Pointed at where the rule starts, not where it ends.
    expect(r.specs[0].line).toBe(1)
  })

  it('stops at a length no real sudoers reaches, and says it stopped', () => {
    const r = parseSudoers('# x\n'.repeat(SUDOERS_MAX_LINES + 10))
    expect(r.truncated).toBe(true)
  })

  it('caps a value designed to break whatever renders it', () => {
    const r = parseSudoers(`alice ALL=(ALL) ${'/bin/x'.repeat(500)}\n`)
    expect(r.specs[0].commands.length).toBeLessThan(600)
  })

  it('leaves a netgroup rule out of the findings rather than guessing', () => {
    // `+name` comes from NIS or sssd and this app cannot see the membership.
    const r = parseSudoers('+admins ALL=(ALL) ALL\n')
    expect(r.specs).toHaveLength(1)
    expect(sudoPrivilegesFor('alice', [], r)).toEqual([])
  })
})
