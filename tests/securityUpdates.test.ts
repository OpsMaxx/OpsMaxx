import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import {
  aptSecurityListing,
  joinDnfSecurity,
  parseAptSecurityList,
  parseDnfAdvisoryCount,
  parseDnfSecurityCheck,
  parseDnfSecurityList,
  parseSecurityListOutput,
  SEC_MARKERS,
  sortBySeverity,
  buildSecurityListCommand
} from '../src/shared/securityUpdates'

// Item 46's security-update list. The fixtures are one almalinux:9.3 answering
// the same question three ways, and one debian:12 with a single security
// update pending.

const DIR = fileURLToPath(new URL('./fixtures/secupdates', import.meta.url))
const read = (n: string): string => readFileSync(join(DIR, `${n}.txt`), 'utf8')
const list = (): ReturnType<typeof parseDnfSecurityList> => parseDnfSecurityList(read('dnf-list'))
const check = (): ReturnType<typeof parseDnfSecurityCheck> =>
  parseDnfSecurityCheck(read('dnf-check-update'))
const joined = (): ReturnType<typeof joinDnfSecurity> =>
  joinDnfSecurity(check(), list(), parseDnfAdvisoryCount(read('dnf-summary')))

describe('one host, three different answers', () => {
  // THE finding. 133 advisories, 203 advisory-and-package rows, 55 packages
  // that will actually change.
  it('reads all three numbers and does not confuse them', () => {
    expect(read('dnf-list').trim().split('\n')).toHaveLength(203)
    expect(parseDnfAdvisoryCount(read('dnf-summary'))).toBe(133)
    expect(check()).toHaveLength(55)
  })

  it('deduplicates the 203 rows down to the same 55 packages', () => {
    // The advisory listing pairs each advisory with each package it names, so
    // it is longer than the package list and describes the same set.
    expect(list()).toHaveLength(55)
    expect(list().map((u) => u.name).sort()).toEqual(check().map((u) => u.name).sort())
  })

  it('says out loud that the two counts are not the same measurement', () => {
    const j = joined()
    expect(j.updates).toHaveLength(55)
    expect(j.advisories).toBe(133)
    expect(j.note).toContain('one advisory can name several packages')
  })

  it('keeps every advisory that covers a package', () => {
    // `expat` is covered by six of them in the fixture.
    const expat = joined().updates.find((u) => u.name === 'expat')!
    expect(expat.advisories.length).toBeGreaterThan(1)
    expect(expat.advisories[0]).toMatch(/^ALSA-\d{4}:\d+$/)
  })
})

describe('splitting a package name from its version', () => {
  // The fiddly part: a package name may contain hyphens, so the version is
  // found from the right.
  it('keeps a hyphenated package name whole', () => {
    const names = list().map((u) => u.name)
    expect(names).toContain('curl-minimal')
    expect(names).toContain('coreutils-single')
    expect(names).not.toContain('curl')
  })

  it('reads the version and drops the architecture', () => {
    const acl = list().find((u) => u.name === 'acl')!
    expect(acl.candidate).toBe('2.4.0-1.el9_8')
    expect(acl.candidate).not.toContain('aarch64')
  })

  it('drops a row it cannot split rather than guessing at it', () => {
    expect(parseDnfSecurityList('ALSA-2026:1 Important/Sec. nonsense')).toEqual([])
  })

  it('ignores a bugfix notice in a security listing', () => {
    expect(parseDnfSecurityList('ALBA-2026:1 None/Bugfix acl-2.4.0-1.el9_8.aarch64')).toEqual([])
  })
})

describe('severity, as the distribution words it', () => {
  it('keeps the distribution’s own word', () => {
    expect(new Set(list().map((u) => u.severity))).toEqual(new Set(['Important', 'Moderate', 'Low']))
  })

  it('gives a package the worst severity across its advisories', () => {
    // A package under both a Moderate and an Important notice is an Important
    // one; taking whichever arrived first would understate it.
    const both = parseDnfSecurityList(
      'ALSA-1:1 Moderate/Sec. acl-1-1.el9.aarch64\nALSA-1:2 Important/Sec. acl-1-1.el9.aarch64'
    )
    expect(both[0].severity).toBe('Important')
  })

  it('does not let a word it has never seen outrank Critical', () => {
    const sorted = sortBySeverity([
      { name: 'a', candidate: '1', current: '', advisories: [], severity: 'Spicy' },
      { name: 'b', candidate: '1', current: '', advisories: [], severity: 'Critical' }
    ])
    expect(sorted.map((u) => u.name)).toEqual(['b', 'a'])
  })

  it('sorts worst first', () => {
    const s = sortBySeverity(joined().updates)
    expect(s[0].severity).toBe('Important')
    expect(s[s.length - 1].severity).toBe('Low')
  })
})

describe('apt, which names no severity at all', () => {
  it('reads the package, both versions, and the security origin', () => {
    const [u] = parseAptSecurityList(read('apt-inst'))
    expect(u).toEqual({
      name: 'libpcre2-8-0',
      current: '10.42-1',
      candidate: '10.42-1+deb12u1',
      advisories: [],
      severity: ''
    })
  })

  it('leaves severity empty rather than inventing one', () => {
    // Debian publishes none on this line, and a word nobody said is worse than
    // a blank.
    expect(parseAptSecurityList(read('apt-inst'))[0].severity).toBe('')
  })

  it('ignores an upgrade that is not from a security archive', () => {
    const ordinary = 'Inst libfoo [1.0] (1.1 Debian:12/stable [arm64])'
    expect(parseAptSecurityList(ordinary)).toEqual([])
  })

  it('does not call an empty apt answer an all-clear', () => {
    // Measured: a Debian host with no package lists prints NOTHING from the
    // simulated upgrade, which is exactly what a patched host prints. There is
    // no way to tell them apart from this read, so the note says so instead of
    // claiming a detection that does not exist.
    const note = aptSecurityListing([]).note
    expect(note).toContain('never downloaded')
    expect(note).toContain('check the cache age')
  })

  it('reports no advisory count rather than zero', () => {
    // apt publishes none on this path. Zero would be a measurement.
    expect(aptSecurityListing(parseAptSecurityList(read('apt-inst'))).advisories).toBeNull()
  })
})

describe('the authoritative list is check-update, not the advisories', () => {
  it('does not add a package that only an advisory names', () => {
    // A notice can cover a package this host does not have installed.
    const j = joinDnfSecurity(
      [{ name: 'acl', candidate: '2', current: '', advisories: [], severity: '' }],
      [
        { name: 'acl', candidate: '2', current: '', advisories: ['A:1'], severity: 'Low' },
        { name: 'not-installed', candidate: '9', current: '', advisories: ['A:2'], severity: 'Important' }
      ],
      2
    )
    expect(j.updates.map((u) => u.name)).toEqual(['acl'])
  })

  it('takes the severity and advisories from the listing onto it', () => {
    const j = joinDnfSecurity(
      [{ name: 'acl', candidate: '2', current: '', advisories: [], severity: '' }],
      [{ name: 'acl', candidate: '2', current: '', advisories: ['A:1'], severity: 'Low' }],
      1
    )
    expect(j.updates[0]).toMatchObject({ severity: 'Low', advisories: ['A:1'] })
  })

  it('does not caveat two numbers that agree', () => {
    const one = [{ name: 'acl', candidate: '2', current: '', advisories: [], severity: '' }]
    expect(joinDnfSecurity(one, one, 1).note).not.toContain('not the same measurement')
  })
})

// ---------------------------------------------------------------------------
// The whole read, against four real hosts.
// ---------------------------------------------------------------------------

describe('one round trip', () => {
  const probe = (n: string): ReturnType<typeof parseSecurityListOutput> =>
    parseSecurityListOutput(read(n))

  it('was captured with the command this builds', () => {
    expect(read('command')).toContain(buildSecurityListCommand())
  })

  it('detects the package manager on the host, never in a second command', () => {
    // Round-tripping a value the host chose and interpolating it into a command
    // is the shape of the injection this app has already had once.
    const cmd = buildSecurityListCommand()
    expect(cmd).toContain('command -v dnf')
    expect(cmd).toContain(SEC_MARKERS.manager)
  })

  it('never refreshes metadata or takes a lock', () => {
    const cmd = buildSecurityListCommand()
    expect(cmd).not.toContain('apt-get update')
    expect(cmd).not.toContain('makecache')
    expect(cmd).toContain('Debug::NoLocking=true')
    expect(cmd).toContain('-C -q')
  })

  it('reads a dnf host with a warm cache', () => {
    const p = probe('roundtrip-dnf')
    expect(p.ok).toBe(true)
    if (!p.ok) return
    expect(p.listing.source).toBe('dnf')
    expect(p.listing.updates).toHaveLength(55)
    expect(p.listing.advisories).toBe(133)
  })

  // THE cache trap, measured. `dnf -C --security check-update` on a host with
  // no cache prints an error on STDERR and exits 0 -- which is dnf's code for
  // "nothing is pending". A consumer reading the exit code and dropping stderr
  // reports a fully patched server for one it could not examine at all.
  it('does not read a host with no cache as a host with no updates', () => {
    const p = probe('roundtrip-dnf-nocache')
    expect(p.ok).toBe(false)
    if (p.ok) return
    expect(p.detail).toContain('Cache-only enabled but no cache')
    expect(p.detail).toContain('the same one it uses for "nothing pending"')
  })

  it('keeps stderr on every package-manager block, which is the only place that error appears', () => {
    const cmd = buildSecurityListCommand()
    // Scoped to the blocks that ask a package manager something. The
    // `command -v` probes above them keep `2>/dev/null` on purpose: a missing
    // binary is the answer there, not an error worth printing.
    for (const call of ['--security check-update', 'updateinfo list security', 'updateinfo summary']) {
      const at = cmd.indexOf(call)
      expect(at).toBeGreaterThan(0)
      expect(cmd.slice(at, at + call.length + 20)).toContain('2>&1')
    }
    expect(cmd).toContain('Debug::NoLocking=true upgrade 2>&1')
  })

  it('reads an apt host', () => {
    const p = probe('roundtrip-apt')
    expect(p.ok).toBe(true)
    if (!p.ok) return
    expect(p.listing.source).toBe('apt')
    expect(p.listing.updates.map((u) => u.name)).toEqual(['libpcre2-8-0'])
  })

  // "No security updates" and "nothing here knows how to ask" are different
  // answers, and only one of them is good news.
  it('refuses to report a host with no package manager as clean', () => {
    const p = probe('roundtrip-none')
    expect(p.ok).toBe(false)
    if (p.ok) return
    expect(p.detail).toContain('no apt, dnf or yum')
  })

  it('refuses output that names no manager at all', () => {
    expect(parseSecurityListOutput('')).toEqual({
      ok: false,
      detail: 'the host did not say which package manager it has'
    })
  })
})
