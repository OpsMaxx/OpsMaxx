import { describe, it, expect } from 'vitest'
import { sweepBlock } from '../src/renderer/src/store/fleetStatus'
import type { FleetSamplerStatus } from '../src/shared/fleet'

// The panels' half of the same failure samplerWarning.test.ts describes.
//
// Found by running it against a real estate: the vault had auto-locked, the
// sweep was breaking out of its target loop on the first host, and Security
// posture, Fleet keys and access, and Capacity trends were all empty. Each
// said the same paragraph — reads hourly, server might be new, press Check
// now, make sure background checking is on — and Check now called the sweep
// that was already breaking on the lock. The button spun, reported success,
// and the panel repeated the instruction to press it.
//
// The status bar two inches below said "Checks paused" and knew exactly why.
// The panels never asked. These tests are that the panels now ask.

const status = (over: Partial<FleetSamplerStatus> = {}): FleetSamplerStatus => ({
  running: true,
  targetCount: 2,
  ...over
})

describe('what a read-only panel says when it has collected nothing', () => {
  it('names the vault lock, which is the case that prompted this', () => {
    const b = sweepBlock(status({ running: false, idleReason: 'vault-locked' }), true)
    expect(b.kind).toBe('vault-locked')
    expect(b.reason).toMatch(/vault is locked/i)
  })

  it('offers unlocking rather than sweeping when the vault is locked', () => {
    // The whole bug in one assertion. Check now runs the sweep that is
    // breaking on the lock, so offering it is offering a press that cannot
    // work — and the old copy offered exactly that.
    const b = sweepBlock(status({ running: false, idleReason: 'vault-locked' }), true)
    expect(b.action).toBe('unlock-vault')
    expect(b.action).not.toBe('check-now')
  })

  it('says so explicitly, so nobody presses Check now and waits', () => {
    const b = sweepBlock(status({ running: false, idleReason: 'vault-locked' }), true)
    expect(b.fix).toMatch(/Check now cannot help/i)
  })

  it('points at settings when checking is switched off', () => {
    const b = sweepBlock(status({ running: false, idleReason: 'disabled' }), false)
    expect(b.kind).toBe('checks-off')
    expect(b.action).toBe('open-settings')
  })

  it('trusts the setting over a stale status when checking was just turned off', () => {
    // status still says running; the switch is the newer fact.
    expect(sweepBlock(status(), false).kind).toBe('checks-off')
  })

  it('names an empty workspace rather than blaming the sweep', () => {
    const b = sweepBlock(status({ running: false, idleReason: 'no-targets', targetCount: 0 }), true)
    expect(b.kind).toBe('no-targets')
  })

  it('reports a stalled loop, which no amount of waiting fixes', () => {
    const b = sweepBlock(status({ running: false }), true)
    expect(b.kind).toBe('stalled')
    expect(b.fix).toMatch(/off and on/i)
  })

  it('offers Check now only when the sweep is actually healthy', () => {
    const b = sweepBlock(status(), true)
    expect(b.kind).toBe('not-yet')
    expect(b.action).toBe('check-now')
  })

  it('does not accuse anything before the first poll returns', () => {
    // status is null until the first poll. Claiming a fault on every launch is
    // the same lie in the other direction.
    const b = sweepBlock(null, true)
    expect(b.kind).toBe('not-yet')
  })

  it('always gives exactly one thing to press', () => {
    const cases: (FleetSamplerStatus | null)[] = [
      null,
      status(),
      status({ running: false }),
      status({ running: false, idleReason: 'vault-locked' }),
      status({ running: false, idleReason: 'disabled' }),
      status({ running: false, idleReason: 'no-targets' })
    ]
    for (const s of cases) {
      for (const enabled of [true, false]) {
        const b = sweepBlock(s, enabled)
        expect(['unlock-vault', 'open-settings', 'check-now']).toContain(b.action)
        // Every kind states a reason and a fix. An empty half would put the
        // panel back to saying nothing useful.
        expect(b.reason.length).toBeGreaterThan(0)
        expect(b.fix.length).toBeGreaterThan(0)
      }
    }
  })
})
