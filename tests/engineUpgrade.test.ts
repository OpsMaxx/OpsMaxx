import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import { planEngineUpgrade } from '../src/shared/engineUpgrade'
import {
  buildEnginePrecheckCommand,
  ENGINE_PACKAGES,
  ENGINE_PRECHECK_MARKERS,
  ENGINE_REFUSAL_HELP,
  engineRepoExists,
  parseEnginePrecheck,
  type EnginePrecheck
} from '../src/shared/enginePrecheck'

// Item 42's targeted engine upgrade.
//
// The fixture is HALF measured and the halves are labelled. The live-restore
// and container-count blocks came off a real daemon; the package block is a
// hand-written dpkg error, because there is no Linux host here carrying
// Docker's packages. That limitation is why the installed set is not parsed at
// all -- see the module header, and the test below that pins it.

const DIR = fileURLToPath(new URL('./fixtures/engine', import.meta.url))
const read = (n: string): string => readFileSync(join(DIR, `${n}.txt`), 'utf8')

const precheck = (over: Partial<EnginePrecheck> = {}): EnginePrecheck => ({
  liveRestore: false,
  packagesText: 'docker-ce 5:27.0.3-1~debian.12~bookworm install ok installed',
  running: 4,
  ...over
})

describe('the precheck', () => {
  it('asks the daemon what it is configured to do', () => {
    const cmd = buildEnginePrecheckCommand('apt')
    expect(cmd).toContain("docker info --format '{{json .LiveRestoreEnabled}}'")
    for (const m of Object.values(ENGINE_PRECHECK_MARKERS)) expect(cmd).toContain(m)
  })

  it('reads the packages with the manager’s own query', () => {
    expect(buildEnginePrecheckCommand('apt')).toContain('dpkg-query -W')
    expect(buildEnginePrecheckCommand('dnf')).toContain("rpm -q 'docker-ce'")
  })

  it('never escalates and never fails on a missing binary', () => {
    const cmd = buildEnginePrecheckCommand('apt')
    expect(cmd).not.toContain('sudo')
    expect(cmd.split('|| true').length - 1).toBeGreaterThanOrEqual(2)
  })

  // Measured on a real daemon: `false`.
  it('reads the live-restore flag off a real daemon’s answer', () => {
    const p = parseEnginePrecheck(read('precheck-macos'))
    expect(p.liveRestore).toBe(false)
    expect(p.running).toBe(10)
  })

  // A daemon that is not running prints an error here. Reading that as `false`
  // would produce the confident sentence "your containers will stop" about a
  // host where nothing was asked.
  it('reads anything that is not true or false as unknown, never as false', () => {
    const out = `${ENGINE_PRECHECK_MARKERS.liveRestore}\nCannot connect to the Docker daemon\n${ENGINE_PRECHECK_MARKERS.packages}\n`
    expect(parseEnginePrecheck(out).liveRestore).toBeNull()
  })

  it('reads a missing container count as unknown rather than zero', () => {
    const out = `${ENGINE_PRECHECK_MARKERS.running}\n`
    expect(parseEnginePrecheck(out).running).toBeNull()
  })

  it('keeps the package block verbatim for the operator to read', () => {
    expect(parseEnginePrecheck(read('precheck-macos')).packagesText).toContain('dpkg-query')
  })
})

describe('what it refuses', () => {
  it('refuses a manager Docker publishes no repository for', () => {
    for (const m of ['apk', 'pacman', 'zypper'] as const) {
      expect(engineRepoExists(m)).toBe(false)
      expect(planEngineUpgrade(m, precheck(), { precheckRead: true }).refusal).toBe('no-repo')
    }
    for (const m of ['apt', 'dnf', 'yum'] as const) expect(engineRepoExists(m)).toBe(true)
  })

  it('refuses before anything has been read from the server', () => {
    const p = planEngineUpgrade('apt', null)
    expect(p.refusal).toBe('unchecked')
    expect(p.spec).toBeNull()
    expect(ENGINE_REFUSAL_HELP.unchecked).toContain('neither can be assumed')
  })

  // THE finding, and it came from writing the fixture. The first version
  // decided this by searching the package block for the names, and dpkg's own
  // error -- `dpkg-query: no packages found matching docker-ce` -- CONTAINS the
  // name, so a host that has never had Docker's packages read as having them.
  it('does not decide from the package text, which can name a package it lacks', () => {
    const denial = precheck({
      packagesText: 'dpkg-query: no packages found matching docker-ce'
    })
    expect(planEngineUpgrade('apt', denial).refusal).toBe('not-installed')
    // And the same text with the operator's confirmation is allowed through,
    // which is the point: the human is the check this build cannot be.
    expect(planEngineUpgrade('apt', denial, { precheckRead: true }).ok).toBe(true)
  })

  it('says why the human is the check', () => {
    expect(ENGINE_REFUSAL_HELP['not-installed']).toContain('SECOND, conflicting engine')
    expect(ENGINE_REFUSAL_HELP['not-installed']).toContain('nothing in this build can tell those two cases apart')
  })
})

describe('what it warns about', () => {
  // The first caveat is always what happens to the containers: it is the thing
  // an operator running this at four in the afternoon has not thought about.
  it('leads with the containers stopping when live-restore is off', () => {
    const p = planEngineUpgrade('apt', precheck({ liveRestore: false, running: 4 }), {
      precheckRead: true
    })
    expect(p.caveats[0]).toContain('stops all 4 running container(s)')
  })

  it('does not invent a count it does not have', () => {
    const p = planEngineUpgrade('apt', precheck({ liveRestore: false, running: null }), {
      precheckRead: true
    })
    expect(p.caveats[0]).toContain('stops every container')
    expect(p.caveats[0]).not.toContain('null')
  })

  // A weaker claim than watching a restart, and said as one.
  it('says live-restore ON is what the daemon claims, not what was observed', () => {
    const p = planEngineUpgrade('apt', precheck({ liveRestore: true }), { precheckRead: true })
    expect(p.caveats[0]).toContain('nothing here has watched it happen')
  })

  it('says unknown is unknown rather than no', () => {
    const p = planEngineUpgrade('apt', precheck({ liveRestore: null }), { precheckRead: true })
    expect(p.caveats[0]).toContain('unknown rather than no')
  })

  it('says all four packages move together and no version is pinned', () => {
    const p = planEngineUpgrade('apt', precheck(), { precheckRead: true })
    expect(p.caveats.join(' ')).toContain('All four')
    expect(p.caveats.join(' ')).toContain('does not pin a version')
  })
})

describe('the job it builds', () => {
  it('names every one of Docker’s four packages', () => {
    const p = planEngineUpgrade('apt', precheck(), { precheckRead: true })
    expect(p.spec).not.toBeNull()
    const cmd = p.spec!.steps[0].command
    for (const n of ENGINE_PACKAGES) expect(cmd).toContain(`'${n}'`)
  })

  // Not a second builder. The existing one validates every name, quotes them
  // and appends the manager's own "what is installed now" step, which is the
  // only honest way to end an upgrade.
  it('ends with the manager saying what is installed now', () => {
    const p = planEngineUpgrade('apt', precheck(), { precheckRead: true })
    expect(p.spec!.steps).toHaveLength(2)
    expect(p.spec!.steps[1].command).toContain('dpkg-query')
  })

  it('escalates for the install, because installing a package needs root', () => {
    expect(planEngineUpgrade('apt', precheck(), { precheckRead: true }).spec!.steps[0].command).toContain(
      'sudo -n '
    )
  })
})
