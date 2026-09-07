import { describe, it, expect } from 'vitest'

import {
  checkServiceStep,
  normaliseUnit,
  serviceJobSpec,
  SERVICE_ACTIONS,
  type ServiceAction
} from '../src/shared/serviceStep'
import { planJob } from '../src/shared/jobs'

const targets = (n: number): { serverId: string; serverName: string }[] =>
  Array.from({ length: n }, (_, i) => ({ serverId: `s${i}`, serverName: `web-${i}` }))

describe('the unit name, which is interpolated into a command that runs as root', () => {
  it('refuses anything that is not a unit name', () => {
    for (const bad of [
      'nginx; rm -rf /',
      'nginx && reboot',
      "nginx'",
      'nginx $(id)',
      'nginx `id`',
      'nginx | tee /etc/passwd',
      'ngi nx'
    ]) {
      expect(checkServiceStep('restart', bad), bad).toMatchObject({ ok: false })
    }
  })

  it('allows the characters systemd unit names really contain', () => {
    for (const good of ['nginx', 'getty@tty1', 'my-app_2.service', 'srv-data.mount']) {
      expect(checkServiceStep('restart', good), good).toEqual({ ok: true })
    }
  })

  it('reads a bare name the way systemctl does, and records which unit it meant', () => {
    expect(normaliseUnit('nginx')).toBe('nginx.service')
    expect(normaliseUnit('backup.timer')).toBe('backup.timer')
  })
})

describe('the service ShellPilot reaches the server through', () => {
  // Restarting sshd from a tool whose only channel to the server IS sshd is,
  // in posture.ts's words, sawing the branch off. Not a confirmation: there is
  // no phrase that makes it a good idea, and offering one would imply there is.
  it('will not stop, restart, reload or disable sshd, at any strength', () => {
    for (const unit of ['ssh', 'sshd', 'ssh.service', 'sshd.service', 'ssh.socket']) {
      for (const action of ['stop', 'restart', 'reload', 'disable'] as ServiceAction[]) {
        expect(checkServiceStep(action, unit), `${action} ${unit}`).toMatchObject({ ok: false })
      }
    }
  })

  it('explains that it is the connection, rather than just refusing', () => {
    const r = checkServiceStep('restart', 'sshd')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('cut the connection')
  })

  it('still allows the two that cannot interrupt anything', () => {
    expect(checkServiceStep('start', 'sshd')).toEqual({ ok: true })
    expect(checkServiceStep('enable', 'sshd')).toEqual({ ok: true })
  })
})

describe('a unit name checked against what the servers actually run', () => {
  // A misspelt unit is a job that fails on every server at once. Worse, the
  // failure looks like an outage rather than a typo.
  it('refuses a name no server has reported', () => {
    expect(checkServiceStep('restart', 'ngnix', ['nginx.service', 'cron.service'])).toMatchObject({
      ok: false
    })
  })

  it('accepts one they have, in either spelling', () => {
    expect(checkServiceStep('restart', 'nginx', ['nginx.service'])).toEqual({ ok: true })
    expect(checkServiceStep('restart', 'nginx.service', ['nginx'])).toEqual({ ok: true })
  })

  it('does not refuse when the facts were never collected, because absent is not empty', () => {
    expect(checkServiceStep('restart', 'anything')).toEqual({ ok: true })
    expect(checkServiceStep('restart', 'anything', [])).toEqual({ ok: true })
  })
})

describe('the spec it builds', () => {
  it('verifies afterwards, because `systemctl start` exits 0 having asked', () => {
    // A unit that starts and immediately dies -- the commonest outcome of a bad
    // config -- exits 0 from the start command.
    const spec = serviceJobSpec('start', 'nginx')
    expect(spec.steps).toHaveLength(2)
    expect(spec.steps[1].command).toContain('is-active')
  })

  it('checks the opposite state for stop and disable, and fails loudly', () => {
    expect(serviceJobSpec('stop', 'nginx').steps[1].command).toContain('is still active')
    expect(serviceJobSpec('disable', 'nginx').steps[1].command).toContain('is still enabled')
  })

  it('quotes the unit into every command it builds, for every action', () => {
    for (const a of SERVICE_ACTIONS) {
      for (const step of serviceJobSpec(a, 'getty@tty1', { sudo: true }).steps) {
        expect(step.command, `${a}: ${step.command}`).toContain("'getty@tty1.service'")
      }
    }
  })

  it('names the unit in the title, since that is what the job list shows later', () => {
    expect(serviceJobSpec('restart', 'nginx').title).toBe('Restart nginx.service')
  })

  it('is still graded by the same classifier as anything else', () => {
    // `systemctl stop` is destructive and `restart` elevated, and a typed step
    // does not get a discount for being typed.
    expect(planJob(serviceJobSpec('stop', 'postgresql'), targets(1)).risk).toBe('destructive')
    expect(planJob(serviceJobSpec('restart', 'nginx'), targets(1)).risk).toBe('elevated')
    expect(planJob(serviceJobSpec('start', 'nginx'), targets(1)).risk).toBe('ordinary')
  })
})
