import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import {
  buildSudoersCommand,
  describeSudo,
  parseSudoers,
  parseSudoersOutput,
  sudoAcrossFiles,
  sudoPrivilegesFor,
  SUDOERS_FILE_MARKER,
  SUDOERS_MARKER,
  SUDOERS_MAX_BYTES,
  SUDOERS_MAX_FILES,
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

// ---------------------------------------------------------------------------
// The consent line
// ---------------------------------------------------------------------------
//
// Item 36b requires this behind its own consent line, "like firewall rule
// lines", and not on by default. Firewall rules say what a server is exposed
// on; sudoers says who can become root on it and whether they need a password,
// which is the shortest description of how to take the machine.

describe('reading sudoers is consented to separately, and never by an agent', () => {
  it('is denied on every group the app ships', async () => {
    const { listGroups, resetPolicyCacheForTests } = await import(
      '../src/main/services/policyStore'
    )
    resetPolicyCacheForTests()
    for (const g of listGroups()) {
      // Including Full Access. A new capability backfills to deny for every
      // existing group, and seeding it at `ask` on the permissive ones would
      // hand upgraded installs an `ask` instead of a `deny`.
      expect(g.capabilities.sudoersRead, g.name).toBe('deny')
    }
  })

  it('is not something an access group can be talked into by allowing sudo', async () => {
    // Being allowed to RUN sudo and being allowed to READ who else can are
    // different grants, and the second is the inventory.
    const { listGroups, resetPolicyCacheForTests } = await import(
      '../src/main/services/policyStore'
    )
    resetPolicyCacheForTests()
    const sudoGroup = listGroups().find((g) => g.id === 'grp-sudo')!
    expect(sudoGroup.capabilities.sudo).not.toBe('deny')
    expect(sudoGroup.capabilities.sudoersRead).toBe('deny')
  })

  it('says on the consent line what the reading actually is', async () => {
    const { AI_CAPABILITIES } = await import('../src/shared/mcp')
    const cap = AI_CAPABILITIES.find((c) => c.id === 'sudoersRead')!
    expect(cap.detail).toContain('never by an agent')
    // And that it replaces a guess, which is the reason to turn it on.
    expect(cap.detail).toContain('wrong in both directions')
  })
})

// ---------------------------------------------------------------------------
// Reading the files off a host
// ---------------------------------------------------------------------------
//
// The fixture is the probe's own output, run against debian:12 with sudo
// installed and four drop-in files placed in /etc/sudoers.d: two real ones,
// one ending `.bak` and one ending `~`.

describe('the probe, against a host with drop-in files', () => {
  const files = (): ReturnType<typeof parseSudoersOutput> =>
    parseSudoersOutput(fixture('probe-debian12.txt'))

  it('keeps each file apart, because "which file grants this" is the first question', () => {
    const paths = files().map((f) => f.path)
    expect(paths).toContain('/etc/sudoers')
    expect(paths).toContain('/etc/sudoers.d/10-ops')
    expect(paths).toContain('/etc/sudoers.d/20-deploy')
  })

  // sudo SKIPS a file with a dot or a trailing tilde. Reading them would
  // report rules that are NOT in effect, which is worse than missing ones: an
  // operator would go and remove a grant that was never granted.
  it('skips exactly the files sudo itself skips', () => {
    const paths = files().map((f) => f.path)
    expect(paths).not.toContain('/etc/sudoers.d/99-disabled.bak')
    expect(paths).not.toContain('/etc/sudoers.d/50-old~')
    // And the rules in them are nowhere in the result.
    expect(JSON.stringify(files())).not.toContain('should-be-skipped')
    expect(JSON.stringify(files())).not.toContain('also-skipped')
  })

  it('finds a grant that lives only in a drop-in file', () => {
    // The whole reason to traverse the directory: Debian's own /etc/sudoers
    // grants nothing to `ops`.
    const r = sudoAcrossFiles('ops', [], files())
    expect(r.findings).toHaveLength(1)
    expect(r.sentence).toContain('without a password')
  })

  it('matches a group named only in a drop-in file', () => {
    const r = sudoAcrossFiles('alice', ['deployers'], files())
    expect(r.findings.map((f) => f.via)).toEqual(['group'])
  })

  // The include was FOLLOWED. Counting it as a gap would have every host on
  // earth report an unread include and every sentence say "not the whole
  // picture".
  it('does not call the directory it just read an unread include', () => {
    const r = sudoAcrossFiles('ops', [], files())
    expect(r.sentence).not.toContain('not the whole picture')
  })

  it('says a file it could not read made the answer incomplete', () => {
    // The commonest cause is a sweep that was not root, and a host reporting
    // "no rules name this account" when it could not read the file is the
    // exact wrong answer this module exists to avoid.
    const denied = parseSudoersOutput(
      `${SUDOERS_MARKER}\n${SUDOERS_FILE_MARKER}/etc/sudoers===\nSP_UNREADABLE\n`
    )
    expect(denied[0].unreadable).toBe(true)
    const r = sudoAcrossFiles('ops', [], denied)
    expect(r.unreadable).toEqual(['/etc/sudoers'])
    expect(r.sentence).toContain('not root')
  })

  it('bounds the read on the host, not here', () => {
    // A 2 GB /etc/sudoers must not reach the SSH channel at all.
    const cmd = buildSudoersCommand()
    expect(cmd).toContain(`head -c ${SUDOERS_MAX_BYTES}`)
    expect(cmd).toContain(`head -n ${SUDOERS_MAX_FILES}`)
    // `sudo -n`: the one escalation that cannot sit waiting for a password on
    // an unattended sweep.
    expect(cmd).toContain('sudo -n ')
  })

  // THE FIXTURE CANNOT CATCH THIS. It was captured with the command as it
  // stands, so deleting the skip from the command does not change a recorded
  // file -- the fixture proves what happened once, and this proves what the
  // command still says.
  it('still tells the shell to skip them, which the fixture cannot show', () => {
    expect(buildSudoersCommand()).toContain('case "$SP_F" in *.*|*~) continue ;; esac')
  })

  it('reads the directory in sudo’s order, not the shell’s', () => {
    // Glob order is locale-dependent; sudo's is not.
    expect(buildSudoersCommand()).toContain('| sort |')
  })
})

// ---------------------------------------------------------------------------
// The gate, in main
// ---------------------------------------------------------------------------

describe('the read runs only where the group consented', () => {
  const group = (v: string): never => ({ capabilities: { sudoersRead: v } }) as never

  it('is granted only by allow, never by ask and never by absence', async () => {
    const { sudoersReadGranted } = await import('../src/main/services/access')
    expect(sudoersReadGranted(group('allow'))).toBe(true)
    // `ask` collects nothing: the sweep is unattended and there is nobody to
    // answer a prompt.
    expect(sudoersReadGranted(group('ask'))).toBe(false)
    expect(sudoersReadGranted(group('deny'))).toBe(false)
    expect(sudoersReadGranted(null)).toBe(false)
    expect(sudoersReadGranted({ capabilities: {} } as never)).toBe(false)
  })

  it('is not widened by being allowed to run sudo', async () => {
    const { sudoersReadGranted } = await import('../src/main/services/access')
    // The capability has its own line in the grid precisely so that no other
    // grant reaches it.
    expect(sudoersReadGranted({ capabilities: { sudo: 'allow', sudoersRead: 'deny' } } as never)).toBe(
      false
    )
  })

  it('returns null when the read failed, not an empty list of files', async () => {
    const { readSudoers } = await import('../src/main/services/access')
    // A read that did not happen is not a host with no sudoers rules, and the
    // two must never render the same.
    const failed = await readSudoers(async () => ({ ok: false, output: 'permission denied' }), {})
    expect(failed).toBeNull()
  })

  it('parses what the host said when it did answer', async () => {
    const { readSudoers } = await import('../src/main/services/access')
    const out = `${SUDOERS_MARKER}\n${SUDOERS_FILE_MARKER}/etc/sudoers===\nroot ALL=(ALL) ALL\n`
    const files = await readSudoers(async () => ({ ok: true, output: out }), {})
    expect(files).toHaveLength(1)
    expect(files![0].specs[0].who).toBe('root')
  })
})
