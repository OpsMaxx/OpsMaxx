import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Test connection through a VPN that is up but not carrying traffic.
 *
 * Reported against Tailscale: Test failed on a new server, the user saved it
 * anyway, and the saved server connected. The real connect (vpnDial) refuses a
 * node that is not `connected` with a sentence naming the reason; Test takes
 * the unpooled path (openChainOverVpn), which had no such check and forwarded
 * through an unauthorised node until the SSH handshake timed out.
 */

const vpnOpenForward = vi.fn(async () => ({ port: 1, close: () => {} }))
vi.mock('../src/main/services/vpn/manager', () => ({
  vpnStart: vi.fn(async () => ({ ok: true })),
  vpnStatus: vi.fn(() => ({ state: 'authenticating' })),
  vpnOpenForward
}))

const { sshTest } = await import('../src/main/services/ssh')

describe('Test connection over a VPN', () => {
  it('names an unauthorised node instead of timing out through it', async () => {
    const r = await sshTest({
      host: '100.64.0.7',
      port: 22,
      username: 'root',
      auth: 'password',
      password: 'x',
      vpnProfileId: 'ts-1'
    } as never)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/not been authorised yet/)
    expect(vpnOpenForward).not.toHaveBeenCalled()
  })
})

describe('the ssh:test handler', () => {
  const MAIN = readFileSync(join(__dirname, '..', 'src/main/index.ts'), 'utf8')
  const handler = MAIN.slice(MAIN.indexOf("ipcMain.handle('ssh:test'"), MAIN.indexOf("ipcMain.handle('ssh:credential-shape'"))

  it("tests the form's VPN, not the saved record's", () => {
    // The spread puts the record's annotation first and the form's choice
    // after it. Reversed, an edited server is tested through its old tunnel.
    expect(handler).toMatch(/\.\.\.preparedSshTarget\(cfg\),\s*vpnProfileId:[^\n]*cfg\.vpnProfileId/)
  })
})
