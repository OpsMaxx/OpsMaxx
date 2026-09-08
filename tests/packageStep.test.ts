import { describe, it, expect } from 'vitest'

import {
  checkPackageStep,
  packageJobSpec,
  PACKAGE_ACTIONS,
  type PackageAction
} from '../src/shared/packageStep'
import { PACKAGE_MANAGERS } from '../src/shared/hostFacts'
import { planJob } from '../src/shared/jobs'

// Item 34b. Like 34a, an action and a name checked before any command exists --
// but the command depends on which manager the server runs, and a job is ONE
// step list for every server in it. So the manager is chosen once and a server
// running a different one is not a target for this job. Stricter than patch.ts,
// which plans per server, and stricter on purpose: a patch run is "bring
// everything up to date"; this is "install exactly this", where a silent
// substitution is the whole danger.

const targets = [{ serverId: 's1', serverName: 'web-1' }]

describe('the package name, which is run as root', () => {
  it('refuses anything that is not one', () => {
    for (const bad of ['nginx; rm -rf /', 'nginx && reboot', 'nginx $(id)', '-rf /', 'ngi nx', "n'x"]) {
      expect(checkPackageStep('apt', 'install', [bad]), bad).toMatchObject({ ok: false })
    }
  })

  it('allows the characters real package names contain', () => {
    // g++ has a plus, libc6:i386 has apt's architecture suffix, a pinned
    // version has = and ~.
    for (const good of ['nginx', 'g++', 'libc6:i386', 'nginx=1.24.0~ubuntu1', 'python3.11']) {
      expect(checkPackageStep('apt', 'install', [good]), good).toEqual({ ok: true })
    }
  })

  it('refuses a list too long to read before confirming it', () => {
    expect(checkPackageStep('apt', 'install', Array.from({ length: 26 }, (_, i) => `p${i}`))).toMatchObject({
      ok: false
    })
  })

  it('refuses an empty list rather than building a bare verb', () => {
    // `apt-get -y remove` with no argument is a command that runs and does
    // nothing, which would read as a successful job.
    expect(checkPackageStep('apt', 'remove', ['  ', ''])).toMatchObject({ ok: false })
  })
})

describe('the managers that cannot hold a package', () => {
  // "The job succeeded" on a server where the pin was never applied is the
  // worst of the three possible answers: the operator now believes a version
  // is held.
  it('refuses hold on apk and pacman, and says why', () => {
    for (const m of ['apk', 'pacman'] as const) {
      for (const a of ['hold', 'unhold'] as PackageAction[]) {
        const r = checkPackageStep(m, a, ['nginx'])
        expect(r.ok, `${m} ${a}`).toBe(false)
        if (!r.ok) expect(r.reason.length).toBeGreaterThan(40)
      }
    }
  })

  it('allows hold on the ones that can', () => {
    for (const m of ['apt', 'dnf', 'yum', 'zypper'] as const) {
      expect(checkPackageStep(m, 'hold', ['nginx']), m).toEqual({ ok: true })
    }
  })

  it('never builds a command for a manager that has none', () => {
    expect(() => packageJobSpec('apk', 'hold', ['nginx'])).toThrow()
    expect(() => packageJobSpec('pacman', 'hold', ['nginx'])).toThrow()
  })
})

describe('the commands it builds', () => {
  it('quotes every name, for every manager and every action it supports', () => {
    for (const m of PACKAGE_MANAGERS) {
      for (const a of PACKAGE_ACTIONS) {
        if (!checkPackageStep(m, a, ['g++']).ok) continue
        for (const step of packageJobSpec(m, a, ['g++']).steps) {
          expect(step.command, `${m} ${a}`).toContain("'g++'")
        }
      }
    }
  })

  it('removes rather than purges on apt, because purge deletes configuration', () => {
    const cmd = packageJobSpec('apt', 'remove', ['nginx']).steps[0].command
    expect(cmd).toContain('remove')
    expect(cmd).not.toContain('purge')
  })

  it('keeps the config files and the non-interactive frontend apt needs', () => {
    // A prompt on a server nobody is looking at is a job that hangs to its
    // timeout.
    const cmd = packageJobSpec('apt', 'install', ['nginx']).steps[0].command
    expect(cmd).toContain('DEBIAN_FRONTEND=noninteractive')
    expect(cmd).toContain('--force-confold')
  })

  it('asks the manager what actually happened, because install exits 0 having done nothing', () => {
    // A name that matches a virtual package installs nothing and succeeds.
    expect(packageJobSpec('apt', 'install', ['nginx']).steps[1].command).toContain('dpkg-query')
    expect(packageJobSpec('dnf', 'install', ['nginx']).steps[1].command).toContain('rpm -q')
  })

  it('verifies a removal as an absence, not as a query that is allowed to fail', () => {
    const v = packageJobSpec('apt', 'remove', ['nginx']).steps[1].command
    expect(v).toContain('still installed')
    expect(v).toContain('exit 1')
  })

  it('does not add a verify step to a hold, which changes no installed state', () => {
    expect(packageJobSpec('apt', 'hold', ['nginx']).steps).toHaveLength(1)
  })
})

describe('a typed step gets no discount for being typed', () => {
  it('is graded by the same classifier as anything else', () => {
    expect(planJob(packageJobSpec('apt', 'remove', ['nginx']), targets).risk).toBe('elevated')
    expect(planJob(packageJobSpec('apt', 'install', ['nginx']), targets).risk).toBe('elevated')
  })
})
