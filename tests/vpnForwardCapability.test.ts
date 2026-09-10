import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A profile that can be chosen as a server's transport must be able to carry
 * one.
 *
 * The Tailscale driver had no `openForward`, so `vpnOpenForward` threw
 * `unsupported` and `vpnDial` took its "system mode routes for real, so there
 * is nothing to forward" branch. That branch is right for WireGuard and
 * OpenVPN in SYSTEM mode — a real TUN device, real routes, a real resolver
 * change — and exactly wrong for tsnet, which is userspace: it installs no
 * route and no resolver entry, so nothing outside the sidecar can reach the
 * tailnet through it.
 *
 * The result was a transport that silently did not exist behind a UI that
 * offered it. A server marked "reach through Tailscale" was dialled straight
 * from the host OS, where the MagicDNS name gave `getaddrinfo ENOTFOUND` and
 * the 100.x address had no route — and the failure named neither Tailscale nor
 * the forward.
 *
 * This is a shape check rather than a behaviour one on purpose: the behaviour
 * needs a real tailnet, and the thing that broke was the CAPABILITY being
 * absent, which is exactly what a shape check catches.
 */

const DRIVERS = join(__dirname, '..', 'src/main/services/vpn/drivers')

/**
 * The drivers that must forward, and the one that must not.
 *
 * The rule is not "every transport forwards" — it is that a transport reaches
 * the tailnet or the VPN either by ROUTING at the OS level or by forwarding,
 * and never by neither.
 *
 * OpenVPN is always system mode: a real device, real routes, a real resolver
 * change. `vpnDial`'s `unsupported` fallback is correct for it, and giving it
 * a forward would be a second path to somewhere it already goes.
 *
 * WireGuard has both modes and forwards in userspace, refusing with
 * `unsupported` in system mode — the shape this whole mechanism was built
 * around.
 *
 * Tailscale is userspace and ONLY userspace. tsnet installs no route and no
 * resolver entry, so it has no OS-level path to fall back on, and a missing
 * forward is not a fallback but an absence.
 */
const MUST_FORWARD = ['tailscale.ts', 'wireguard.ts']
const ROUTES_INSTEAD = ['openvpn.ts']
/** Inbound exposure. Nothing dials out through these, so they must not be
 *  offerable as a server's transport at all — see the picker's own filter. */
const NOT_A_TRANSPORT = ['frp.ts', 'ngrok.ts']

const declaresForward = (file: string): boolean => {
  const src = readFileSync(join(DRIVERS, file), 'utf8')
  // Declared ON the driver object, not merely defined in the file.
  return /^\s*openForward,?\s*$/m.test(src) || /^\s*(async )?openForward\(/m.test(src)
}

describe('a transport reaches its network by routing or by forwarding', () => {
  it('has the drivers this test claims to cover', () => {
    const files = readdirSync(DRIVERS)
    for (const f of [...MUST_FORWARD, ...ROUTES_INSTEAD]) expect(files).toContain(f)
  })

  it('gives a forward to every driver that cannot route', () => {
    expect(MUST_FORWARD.filter((f) => !declaresForward(f))).toEqual([])
  })

  it('does not give one to the driver that routes for real', () => {
    // Not pedantry: if OpenVPN grew a forward, `vpnDial` would stop taking the
    // fallback and start sending system-mode traffic through a loopback hop it
    // does not need.
    expect(ROUTES_INSTEAD.filter(declaresForward)).toEqual([])
  })
})

describe('an inbound-exposure tool is never offered as a transport', () => {
  const PICKER = readFileSync(
    join(__dirname, '..', 'src/renderer/src/components/vpn/VpnTransportSelect.tsx'),
    'utf8'
  )

  it('filters both of them out of the picker', () => {
    // ngrok was missing from this filter, and it failed quietly rather than
    // loudly: picking it set `vpnProfileId`, the driver had no forward, and
    // the `unsupported` branch dialled directly — so the connection worked
    // and the app said it went via ngrok when it did not.
    for (const kind of NOT_A_TRANSPORT.map((f) => f.replace('.ts', ''))) {
      expect(PICKER, `${kind} can still be picked as a transport`).toContain(`!== '${kind}'`)
    }
  })
})

describe('the sidecar answers what the Tailscale driver asks it', () => {
  const main = readFileSync(join(__dirname, '..', 'sidecar/netd/main.go'), 'utf8')
  const driver = readFileSync(join(DRIVERS, 'tailscale.ts'), 'utf8')

  it('registers every ts method the driver sends', () => {
    // A driver calling a method the sidecar does not route gets a protocol
    // error at the moment somebody opens a connection, which is the worst
    // time to find out.
    const sent = [...driver.matchAll(/send<?[^>]*>?\(\s*'(ts\.[a-z.]+)'/g)].map((m) => m[1])
    const alsoSent = [...driver.matchAll(/'(ts\.[a-z.]+)'/g)].map((m) => m[1])
    const wanted = new Set([...sent, ...alsoSent])
    expect(wanted.size).toBeGreaterThan(0)
    for (const method of wanted) {
      expect(main, `sidecar does not route ${method}`).toContain(`case "${method}":`)
    }
  })

  it('dials the forward through the node, not the host', () => {
    // `srv.Dial` is the whole fix: it resolves on the tailnet's own DNS and
    // carries the connection over the node. A plain `net.Dial` here would
    // reintroduce the bug inside the sidecar, where it would be harder to see.
    const ts = readFileSync(join(__dirname, '..', 'sidecar/netd/tailscale.go'), 'utf8')
    const fwd = ts.slice(ts.indexOf('func (s *Server) tsForwardOpen'), ts.indexOf('func (s *Server) tsForwardClose'))
    expect(fwd).toContain('node.srv.Dial(')
    expect(fwd).not.toMatch(/\bnet\.Dial\(/)
  })

  it('closes its listeners when the node goes down', () => {
    // A forward outliving its node accepts connections it can no longer dial
    // anywhere, which reads as a hang rather than a refusal.
    const ts = readFileSync(join(__dirname, '..', 'sidecar/netd/tailscale.go'), 'utf8')
    const down = ts.slice(ts.indexOf('func (s *Server) tsDown'))
    expect(down).toContain('node.forwards')
  })
})
