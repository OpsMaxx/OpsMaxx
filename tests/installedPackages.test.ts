import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  PKG_FACT_PREFIX,
  PKG_MARKER,
  PKG_MAX_ROWS,
  buildInstalledPackagesCommand,
  packageFacts,
  packageNameFromFact,
  parseInstalledPackages
} from '../src/shared/installedPackages'

// Item 46's inventory row -- "which boxes still have the old openssl".
//
// FOUR MANAGERS, each recorded through the builder: apt on a real Ubuntu 24.04
// server, rpm in almalinux:9, apk in alpine:3.19, pacman in archlinux. All four
// emit `name<TAB>version`, which is the point of normalising in the shell
// rather than writing four parsers.

const fx = (n: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/host/packages/${n}`, import.meta.url)), 'utf8')

describe('every manager, measured', () => {
  it('reads a real Ubuntu server’s twelve hundred packages', () => {
    const r = parseInstalledPackages(fx('ubuntu-2404-apt.txt'))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.packages.length).toBe(1239)
    expect(r.truncated).toBe(false)
    // A version with letters in the middle -- `4.0.1really4.0.1-0ubuntu…` is a
    // real Debian epoch-avoidance trick and must survive verbatim.
    expect(r.packages.find((p) => p.name === 'apparmor')?.version).toBe(
      '4.0.1really4.0.1-0ubuntu0.24.04.7'
    )
  })

  it('reads rpm, apk and pacman through the same parser', () => {
    for (const [file, atLeast] of [
      ['almalinux9-rpm.txt', 100],
      ['alpine319-apk.txt', 10],
      ['arch-pacman.txt', 100]
    ] as const) {
      const r = parseInstalledPackages(fx(file))
      expect(r.ok, file).toBe(true)
      if (!r.ok) continue
      expect(r.packages.length, file).toBeGreaterThan(atLeast)
      for (const p of r.packages.slice(0, 5)) {
        expect(p.name, file).not.toContain('\t')
        expect(p.version, file).not.toBe('')
      }
    }
  })

  // FINDING 1b, and a bug caught before shipping: `dpkg-query -W` lists
  // packages that are NOT installed. The measured host had two in `deinstall ok
  // config-files` -- removed, configuration left behind, carrying a version
  // like any other row. Without the status filter the inventory answers "which
  // boxes still have the old openssl" with hosts that removed it.
  it('asks dpkg only for what is actually installed', () => {
    const cmd = buildInstalledPackagesCommand('apt')!
    expect(cmd).toContain('${Status}')
    expect(cmd).toContain('install ok installed')
    // The two removed ones are 1241 minus 1239.
    const r = parseInstalledPackages(fx('ubuntu-2404-apt.txt'))
    expect(r.ok && r.packages.length).toBe(1239)
  })

  // The other three databases contain only what is installed, so none of them
  // needs an equivalent filter -- asserted so nobody adds one by symmetry.
  it('does not filter the databases that hold only installed packages', () => {
    for (const m of ['dnf', 'apk', 'pacman'] as const) {
      expect(buildInstalledPackagesCommand(m), m).not.toContain('install ok installed')
    }
  })

  // FINDING 1: rpm reports GPG keys as packages. A host trusting several vendor
  // keys has several rows all named `gpg-pubkey`, which would collide on one
  // fact key and record whichever came last.
  it('does not record rpm’s gpg-pubkey as a package', () => {
    expect(fx('almalinux9-rpm.txt')).toContain('gpg-pubkey')
    const r = parseInstalledPackages(fx('almalinux9-rpm.txt'))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.packages.map((p) => p.name)).not.toContain('gpg-pubkey')
  })

  // FINDING 2: `apk info -v` prints `alpine-baselayout-3.4.3-r2` -- name and
  // version joined by a dash, and names contain dashes, so no split is right in
  // general. The installed database has them on separate lines.
  it('reads apk from the database rather than from an unparseable listing', () => {
    expect(buildInstalledPackagesCommand('apk')).toContain('/lib/apk/db/installed')
    expect(buildInstalledPackagesCommand('apk')).not.toContain('apk info')
    const r = parseInstalledPackages(fx('alpine319-apk.txt'))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const byName = new Map(r.packages.map((p) => [p.name, p.version]))
    // The trap, concretely: `apk info -v` would have produced the NAME
    // `alpine-baselayout-3.4.3` and no version at all.
    expect(byName.get('alpine-baselayout')).toBe('3.4.3-r2')
    expect(byName.has('alpine-baselayout-3.4.3')).toBe(false)
    // And a name that legitimately ENDS in a digit survives whole, which is
    // what makes the dash-split unfixable rather than merely awkward.
    expect(byName.get('libcrypto3')).toBe('3.1.8-r1')
    expect(byName.get('libssl3')).toBe('3.1.8-r1')
    // A version containing an underscore and a date, also verbatim.
    expect(byName.get('musl')).toBe('1.2.4_git20230717-r5')
  })

  // dnf, yum and zypper are all rpm underneath, which is why the opensuse and
  // almalinux measurements produced identical shapes.
  it('uses one rpm query for dnf, yum and zypper', () => {
    const rpmQuery = buildInstalledPackagesCommand('dnf')
    expect(buildInstalledPackagesCommand('yum')).toBe(rpmQuery)
    expect(buildInstalledPackagesCommand('zypper')).toBe(rpmQuery)
    // Equal is not enough: all three equal to the WRONG thing would pass that.
    // It has to be the rpm query, which is what the opensuse measurement
    // established works for zypper.
    for (const m of ['dnf', 'yum', 'zypper'] as const) {
      expect(buildInstalledPackagesCommand(m), m).toContain('rpm -qa --qf')
      expect(buildInstalledPackagesCommand(m), m).not.toContain('zypper se')
    }
  })

  it('has nothing to run for a host with no known manager', () => {
    expect(buildInstalledPackagesCommand(null)).toBeNull()
  })
})

describe('an empty read is never an empty host', () => {
  // THE rule, and it matters more here than for units and ports because of the
  // volume: retiring on a failed probe would record over a thousand
  // fact-removed events per host, once, the first time dpkg was busy.
  it('reports a failure rather than an empty inventory', () => {
    const r = parseInstalledPackages(`${PKG_MARKER}\n`)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.detail).toContain('returned nothing')
  })

  it('carries the host’s own words when it said something', () => {
    const r = parseInstalledPackages(`${PKG_MARKER}\ndpkg-query: no packages found\n`)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.detail).toContain('no packages found')
  })

  // A row with no version has no tab left after `trimEnd`, so it falls to the
  // same guard that rejects a line which is not name-tab-version at all.
  it('skips a row with no version rather than storing an empty one', () => {
    const r = parseInstalledPackages(`${PKG_MARKER}\nghost\t\nopenssl\t3.0.13\n`)
    expect(r.ok && r.packages).toEqual([{ name: 'openssl', version: '3.0.13' }])
  })

  // A line beginning with a tab, and one whose name is only spaces. A position
  // check can see the first and not the second, which is why the name is
  // checked after trimming rather than by where the tab is.
  it('ignores a row with no name', () => {
    const r = parseInstalledPackages(`${PKG_MARKER}\n\t1.0\n   \t2.0\nopenssl\t3.0.13\n`)
    expect(r.ok && r.packages).toEqual([{ name: 'openssl', version: '3.0.13' }])
  })

  it('ignores a line that is not name-tab-version', () => {
    const r = parseInstalledPackages(`${PKG_MARKER}\nnot a package row\nopenssl\t3.0.13\n`)
    expect(r.ok && r.packages).toEqual([{ name: 'openssl', version: '3.0.13' }])
  })

  // A repeated name would collide on one fact key, silently recording the last.
  it('keeps the first of a repeated name rather than the last', () => {
    const r = parseInstalledPackages(`${PKG_MARKER}\nfoo\t1.0\nfoo\t2.0\n`)
    expect(r.ok && r.packages).toEqual([{ name: 'foo', version: '1.0' }])
  })
})

describe('what goes in the facts table', () => {
  it('keys on the prefix the retirement sweep uses', () => {
    const f = packageFacts([{ name: 'openssl', version: '3.0.13-0ubuntu3.4' }])
    expect(f).toEqual({ 'pkg:openssl': '3.0.13-0ubuntu3.4' })
    expect(Object.keys(f)[0].startsWith(PKG_FACT_PREFIX)).toBe(true)
  })

  it('gets the name back out for a search result', () => {
    expect(packageNameFromFact('pkg:openssl')).toBe('openssl')
    expect(packageNameFromFact('unit:ssh.service')).toBeNull()
  })

  // The measured Ubuntu host is 1241; a full desktop reaches about 2800.
  it('bounds a pathological answer well above any real host', () => {
    expect(PKG_MAX_ROWS).toBeGreaterThan(5000)
    expect(buildInstalledPackagesCommand('apt')).toContain(`head -n ${PKG_MAX_ROWS}`)
  })

  it('says when it hit the cap rather than silently returning a partial list', () => {
    const rows = Array.from({ length: PKG_MAX_ROWS }, (_, i) => `p${i}\t1.0`).join('\n')
    const r = parseInstalledPackages(`${PKG_MARKER}\n${rows}\n`)
    expect(r.ok && r.truncated).toBe(true)
  })
})

describe('the sampler wiring', () => {
  const code = (rel: string): string =>
    readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n')

  // THE rule, and the reason it is a discriminated union rather than an array:
  // `write.packages` is set ONLY on `ok`, so a failed read leaves the stored
  // inventory alone instead of retiring over a thousand facts per host.
  it('stores and retires only when the read succeeded', () => {
    const fs = code('../src/main/services/fleetSampler.ts')
    expect(fs).toContain('if (pkgs.ok) write.packages = pkgs.packages')
    expect(fs).toContain('if (w.packages) {')
    expect(fs).toContain('store.retireFacts(w.serverId, w.at, PKG_FACT_PREFIX')
  })

  // It needs the facts probe's `packageManager` to know what to ask, and a host
  // that just refused one read will refuse the next.
  it('runs after a successful facts probe, using the manager it reported', () => {
    const fs = code('../src/main/services/fleetSampler.ts')
    expect(fs).toContain('.samplePackages(fleetKey(t.serverId), t.cfg, probe.facts.packageManager)')
  })

  // No second detection: `read()` already establishes the manager on the same
  // clock, and a second one is a second thing to keep in step.
  it('takes the manager rather than probing for one again', () => {
    const svc = code('../src/main/services/hostFacts.ts')
    expect(svc).toContain('async packages(cfg: unknown, manager: PackageManager | null)')
    expect(svc).toContain("detail: 'this host has no package manager this build can query'")
  })

  // Optional, so a sampler built without it behaves exactly as before.
  it('is optional on the deps, like the facts probe beside it', () => {
    expect(code('../src/main/services/fleetSampler.ts')).toContain('samplePackages?: (')
  })
})
