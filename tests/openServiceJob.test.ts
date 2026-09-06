// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { stubBridge } from './setup/renderer'
import { openServiceJob, useNav } from '../src/renderer/src/store/nav'
import { PROTECTED_UNITS, checkServiceStep } from '../src/shared/serviceStep'

// The other half of the failed-unit moment. `serviceStep` already had restart,
// checked, with its protected units; it was reachable only by going to Jobs and
// retyping the unit name you were looking at.

beforeEach(() => {
  stubBridge({})
  useNav.setState({ jobComposerJump: null, monitorTab: 'overview' })
})

const code = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n')

describe('openServiceJob', () => {
  it('lands on the composer with the step filled in', () => {
    openServiceJob('srv-1', 'restart', 'nginx.service')
    expect(useNav.getState().jobComposerJump).toMatchObject({
      serverId: 'srv-1',
      mode: 'service',
      action: 'restart',
      unit: 'nginx.service'
    })
    expect(useNav.getState().monitorTab).toBe('jobs')
  })

  // THE distinction from `openLogTail`, which lands on lines. Reading is safe;
  // a service action is a write on somebody's server, and the confirmation is
  // the point of the composer rather than a step to skip by arriving with an
  // intention.
  it('fills the form and runs nothing', () => {
    const panel = code('../src/renderer/src/components/monitor/JobsPanel.tsx')
    const effect = panel.slice(panel.indexOf('if (!jump || jump.nonce === lastJump.current) return'))
    const body = effect.slice(0, effect.indexOf('}, [jump])'))
    expect(body).toContain('setUnit(jump.unit)')
    // Nothing in the jump handler plans, confirms or launches.
    for (const forbidden of ['planJob', 'launch', 'confirm', 'run(']) {
      expect(body, forbidden).not.toContain(forbidden)
    }
  })

  // Asking twice for the same unit must re-fill rather than be swallowed.
  it('is keyed on a nonce, not on the value', () => {
    openServiceJob('srv-1', 'restart', 'nginx.service')
    const first = useNav.getState().jobComposerJump!.nonce
    openServiceJob('srv-1', 'restart', 'nginx.service')
    expect(useNav.getState().jobComposerJump!.nonce).not.toBe(first)
  })
})

describe('the button the failed-unit list shows', () => {
  const fh = code('../src/renderer/src/components/monitor/FleetHealth.tsx')

  // ABSENT, not disabled. sshd is refused at any strength of confirmation, and
  // a button that always says no teaches people that refusals are noise.
  it('is not rendered for a unit the check refuses', () => {
    expect(fh).toContain("checkServiceStep('restart', u.name).ok && (")
    for (const unit of PROTECTED_UNITS) {
      expect(checkServiceStep('restart', unit).ok, unit).toBe(false)
    }
  })

  it('is rendered for an ordinary unit', () => {
    expect(checkServiceStep('restart', 'nginx.service').ok).toBe(true)
    expect(fh).toContain("openServiceJob(row.id, 'restart', u.name)")
  })

  // The refusal covers every spelling, because `normaliseUnit` runs first.
  it('refuses ssh however it is spelt', () => {
    for (const spelling of ['ssh', 'sshd', 'ssh.service', 'sshd.socket']) {
      expect(checkServiceStep('restart', spelling).ok, spelling).toBe(false)
    }
  })

  // start and enable cannot interrupt the session, so they are allowed even
  // there — which is why the button is specifically a RESTART button.
  it('would still allow starting sshd, which is why this button is restart', () => {
    expect(checkServiceStep('start', 'sshd.service').ok).toBe(true)
    expect(checkServiceStep('restart', 'sshd.service').ok).toBe(false)
  })
})
