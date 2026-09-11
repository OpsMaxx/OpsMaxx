import { describe, expect, it } from 'vitest'
import { isLoopbackHostKeyId } from '../src/shared/ssh'

/**
 * Which trusted-host entries are wreckage.
 *
 * Until 0.36.2 a hop routed through a VPN or tunnel was rewritten to dial
 * `127.0.0.1:<a freshly allocated port>` and its host key was filed under that,
 * so every connection asked again and left another entry behind. They name no
 * particular machine, which is the hazard: a later unrelated local service on
 * that port inherits the trust.
 */

describe('entries that look like tunnel wreckage', () => {
  for (const id of ['127.0.0.1:62778', '127.0.0.1:22', 'localhost:2222', '[::1]:51234', '::1:22', '127.0.1.1:22']) {
    it(`flags ${id}`, () => expect(isLoopbackHostKeyId(id)).toBe(true))
  }
})

describe('entries that are real servers', () => {
  for (const id of [
    '169.58.227.88:22',
    '10.21.15.193:22000',
    '100.79.104.100:22',
    'db01.internal:22',
    '2a02:c207:2348:6272::1:22'
  ]) {
    it(`keeps ${id}`, () => expect(isLoopbackHostKeyId(id)).toBe(false))
  }

  it('does not mistake a private range for loopback', () => {
    // 10.x and 100.64/10 (Tailscale's CGNAT range) are ordinary reachable
    // addresses, and a user's whole estate can live on them.
    expect(isLoopbackHostKeyId('10.0.0.1:22')).toBe(false)
    expect(isLoopbackHostKeyId('100.79.104.100:22')).toBe(false)
  })
})
