import { describe, it, expect } from 'vitest'

import { VPN_ALERT_READINGS } from '../src/shared/vpn'
import { STATE_ALERT_KINDS, ALERT_KINDS } from '../src/shared/webhook'

// Item 48's first row. The poll around this map is ten lines of timer; the map
// is the feature, so it is tested and the timer is not.

describe('what a VPN state says about being down', () => {
  it('calls an errored VPN down, and a connected one not down', () => {
    expect(VPN_ALERT_READINGS.error.down).toBe(true)
    expect(VPN_ALERT_READINGS.connected.down).toBe(false)
  })

  // The one that would be wrong in the most annoying way. A person pressing
  // Stop is not an outage -- and it is not evidence the VPN is healthy either,
  // so it is null in BOTH columns rather than false. `false` would have the app
  // resolve its own down alert because somebody stopped the profile.
  it('does not call a VPN somebody stopped an outage, or a recovery', () => {
    expect(VPN_ALERT_READINGS.stopped).toEqual({ down: null, silent: null })
  })

  it('says nothing while a VPN is still coming up', () => {
    for (const s of ['starting', 'authenticating', 'reconnecting'] as const) {
      expect(VPN_ALERT_READINGS[s], s).toEqual({ down: null, silent: null })
    }
  })
})

describe('up-but-silent is not down', () => {
  // vpn.ts calls this "the single most useful thing this UI shows". One kind
  // carrying both would tell the operator to reconnect when the fix is to find
  // out why a tunnel that thinks it is up carries nothing.
  it('reports a degraded VPN as silent and NOT as down', () => {
    expect(VPN_ALERT_READINGS.degraded).toEqual({ down: false, silent: true })
  })

  it('gives them separate kinds, on the wire and in the store', () => {
    for (const k of ['vpn-down', 'vpn-degraded'] as const) {
      expect(STATE_ALERT_KINDS as readonly string[]).toContain(k)
      expect(ALERT_KINDS as readonly string[]).toContain(k)
    }
  })
})

describe('the map is exhaustive, which is why it is a Record', () => {
  it('answers for every state a VPN can be in', () => {
    // Anti-vacuity: if VpnState grew and this list did not, the Record would
    // fail to compile -- but the list here also has to be the real one, or
    // this test would pass on a map missing half its rows.
    const states = [
      'stopped', 'starting', 'authenticating', 'connected', 'reconnecting', 'degraded', 'error'
    ] as const
    expect(Object.keys(VPN_ALERT_READINGS).sort()).toEqual([...states].sort())
    for (const s of states) {
      const r = VPN_ALERT_READINGS[s]
      expect([true, false, null], s).toContain(r.down)
      expect([true, false, null], s).toContain(r.silent)
    }
  })

  it('never claims a VPN is both down and merely silent', () => {
    for (const r of Object.values(VPN_ALERT_READINGS)) {
      expect(r.down === true && r.silent === true).toBe(false)
    }
  })
})
