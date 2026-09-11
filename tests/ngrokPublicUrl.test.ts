import { describe, expect, it, vi } from 'vitest'

/**
 * The public URL has to reach the card.
 *
 * ngrok assigns a fresh hostname on every run unless the profile reserved a
 * domain, so the URL exists nowhere else: not in the profile the user saved,
 * not on the sidecar's command line, not in any config file. The card reads it
 * from `status.stats.endpoints`, and the driver used to publish a `connected`
 * status with no `stats` at all — the endpoints went into the module's own
 * `live` map and into one log line, and the card said "connected" and nothing
 * else. `stats()` would have carried them, but nothing polls it while a tunnel
 * is simply running; it is called on a wake nudge.
 *
 * This is the third time a driver has produced something the UI never received
 * (Tailscale's authorise link was the second), so the check runs the real
 * `start()` against a stubbed sidecar rather than matching on source text.
 */

const send = vi.fn()
const close = vi.fn(async () => undefined)

vi.mock('../src/main/services/vpn/netdSession', () => ({
  openNetdSession: async () => ({ send, close })
}))

import { ngrokDriver } from '../src/main/services/vpn/drivers/ngrok'
import type { VpnDriverContext } from '../src/main/services/vpn/driver'
import type { NgrokSpec, VpnProfile, VpnStatus } from '../src/shared/vpn'

const PUBLIC_URL = 'https://forward-lark-4f21.ngrok.app'

function profile(): VpnProfile & { spec: NgrokSpec } {
  return {
    id: 'ngrok-1',
    name: 'Demo',
    workspaceId: 'w1',
    spec: {
      kind: 'ngrok',
      tunnels: [
        {
          name: 'web',
          proto: 'http',
          localPort: 3000,
          // Start refuses an unacknowledged endpoint, and rightly so: it opens
          // a port to the whole internet.
          acknowledgedExposure: true
        }
      ]
    }
  } as VpnProfile & { spec: NgrokSpec }
}

function context(emitted: Partial<VpnStatus>[]): VpnDriverContext {
  return {
    runDir: '/tmp/does-not-matter',
    secrets: { token: 'tok_test' },
    emit: (patch: Partial<VpnStatus>) => emitted.push(patch),
    log: () => undefined,
    dropped: () => undefined,
    askUser: async () => null
  } as unknown as VpnDriverContext
}

describe('a started ngrok tunnel', () => {
  it('publishes the URL on the status the card reads', async () => {
    // The WIRE shape, which is what the sidecar actually sends: `url`, not
    // `publicUrl`. This stub used to use the domain shape -- the one shape the
    // sidecar never sends -- so the test passed while every real endpoint
    // arrived with publicUrl: undefined. A stub is only as right as the
    // contract it was written from; tests/ngrokWireShape.test.ts now reads that
    // contract out of the Go source rather than out of memory.
    send.mockResolvedValueOnce({
      endpoints: [{ name: 'web', url: PUBLIC_URL, proto: 'http', localAddr: '127.0.0.1:3000' }]
    })
    const emitted: Partial<VpnStatus>[] = []

    const result = await ngrokDriver.start(profile(), context(emitted))
    expect(result.ok).toBe(true)

    const connected = emitted.find((s) => s.state === 'connected')
    expect(connected).toBeDefined()
    // The assertion that matters: not that the driver knows the URL, but that
    // it said so where the card is looking.
    expect(connected?.stats?.endpoints?.[0]?.publicUrl).toBe(PUBLIC_URL)
  })
})
