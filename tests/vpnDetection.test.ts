import { afterEach, describe, expect, it, vi } from 'vitest'

// What is on this machine, and what that means — the two questions the engine
// resolver answers without running anything. Both had the same failure shape:
// a check that was cheap and almost right, producing a sentence that was
// confidently wrong on an ordinary machine.

const { net, present, route, absent } = vi.hoisted(() => ({
  net: { current: {} as Record<string, unknown[]> },
  present: new Set<string>(),
  route: { stdout: '' },
  // "this machine has no openvpn of its own", which is the only state in which
  // the not-found message is composed at all. Without it the case below passes
  // or fails on whether the person running the suite happens to have one in
  // /opt/homebrew/sbin — the same reason `/Applications` is faked.
  absent: { openvpn: false }
}))

vi.mock('node:os', async (orig) => {
  const real = await orig<typeof import('node:os')>()
  return { ...real, networkInterfaces: () => net.current }
})

// The routing table is faked for the same reason `/Applications` is below: the
// developer's own Mac is not a fixture. `activeTunnelInterfaces` reads
// `netstat -rn -f inet` on darwin now, so without this every expectation here
// would depend on whether the person running the suite has a VPN connected.
// The route half has its own file — tests/vpnTunnelRoutes.test.ts — and these
// cases are about the address half, so the default is an empty table.
vi.mock('../src/main/services/vpn/netstate', async (orig) => {
  const real = await orig<typeof import('../src/main/services/vpn/netstate')>()
  return {
    ...real,
    readCommand: () => Promise.resolve({ code: 0, stdout: route.stdout, stderr: '' })
  }
})

// `stat` is faked for `/Applications` and nowhere else.
//
// That tree is the one `otherVpnClients` probes, and the developer's own Mac
// is not a fixture: this machine has OpenVPN Connect installed, so a mock that
// fell through to the real filesystem made every expectation below depend on
// what the person running the suite happens to have in their Dock. Everything
// outside `/Applications` stays real, because `checkExecutable` asking the
// actual filesystem about the candidate binary is the half these cases are
// testing.
vi.mock('node:fs/promises', async (orig) => {
  const real = await orig<typeof import('node:fs/promises')>()
  return {
    ...real,
    stat: (p: Parameters<typeof real.stat>[0], ...rest: unknown[]) => {
      const path = String(p)
      if (!path.startsWith('/Applications/')) {
        return (real.stat as (...a: unknown[]) => unknown)(p, ...rest)
      }
      return present.has(path)
        ? Promise.resolve({ isFile: () => false, isDirectory: () => true, mode: 0o755, size: 0 })
        : Promise.reject(new Error(`ENOENT: ${path}`))
    },
    // `checkExecutable` resolves every candidate before it stats it, so this is
    // where a machine's real openvpn has to be taken away to reach the
    // not-found branch deterministically.
    realpath: (p: Parameters<typeof real.realpath>[0], ...rest: unknown[]) => {
      const path = String(p)
      if (absent.openvpn && /[/\\]openvpn$/.test(path)) {
        return Promise.reject(new Error(`ENOENT: ${path}`))
      }
      return (real.realpath as (...a: unknown[]) => unknown)(p, ...rest)
    }
  }
})

const {
  activeTunnelInterfaces,
  coexistenceAdvisories,
  otherVpnClients,
  resetBinaryCache,
  resolveSystem
} = await import('../src/main/services/vpn/binaries')
const { isVpnError } = await import('../src/main/services/vpn/errors')

let platformDescriptor: PropertyDescriptor | undefined

function stubPlatform(value: NodeJS.Platform): void {
  platformDescriptor ??= Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value, configurable: true })
}

afterEach(() => {
  if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor)
  platformDescriptor = undefined
  net.current = {}
  present.clear()
  route.stdout = ''
  absent.openvpn = false
  // The route read is held for five seconds, which is longer than this whole
  // file takes to run, so one case's table would otherwise answer the next.
  resetBinaryCache()
})

/** One `networkInterfaces()` entry, in the shape Node actually returns. */
function v6(address: string, scopeid: number): Record<string, unknown> {
  return {
    address,
    netmask: 'ffff:ffff:ffff:ffff::',
    family: 'IPv6',
    mac: '00:00:00:00:00:00',
    internal: false,
    cidr: `${address}/64`,
    scopeid
  }
}

function v4(address: string, netmask = '255.255.255.255'): Record<string, unknown> {
  return {
    address,
    netmask,
    family: 'IPv4',
    mac: '00:00:00:00:00:00',
    internal: false,
    cidr: `${address}/32`
  }
}

describe('which interfaces count as a tunnel that is up', () => {
  // Both fixtures are one sample off one macOS machine, split in two: utun0-5
  // were there with no VPN running at all, and utun6 appeared when one
  // connected. They are the case and the control, and they coexisted.
  const NOISE = {
    lo0: [{ ...v4('127.0.0.1', '255.0.0.0'), internal: true }],
    en0: [v4('192.168.1.74', '255.255.255.0')],
    // iCloud Private Relay, AWDL/Handoff and Continuity. Link-local only:
    // these reach the link they are on and nothing beyond it.
    utun0: [v6('fe80::ce81:b1c:bd2c:69e', 14)],
    utun1: [v6('fe80::b8b9:9bff:fe3d:4a21', 15)],
    utun2: [v6('fe80::4c1a:5aff:fe9c:1', 16)],
    utun3: [v6('fe80::e4a0:22ff:fe11:302', 17)],
    utun4: [v6('fe80::1c2d:88ff:fe44:9a1', 18)],
    utun5: [v6('fe80::ac31:7bff:fe0d:22c', 19)]
  }

  it('ignores the link-local utuns every Mac holds open', async () => {
    net.current = NOISE
    expect(await activeTunnelInterfaces()).toEqual([])
  })

  it('reports a tunnel that actually has a route', async () => {
    net.current = { ...NOISE, utun6: [v4('10.107.0.60')] }
    expect(await activeTunnelInterfaces()).toEqual(['utun6'])
  })

  it('ignores an interface that only got a self-assigned address', async () => {
    // 169.254.0.0/16 is what an interface ends up with when nothing assigned
    // it anything — the IPv4 statement of the same "no route" fact.
    net.current = { tun0: [v4('169.254.31.7', '255.255.0.0')] }
    expect(await activeTunnelInterfaces()).toEqual([])
  })

  it('ignores a loopback, however it is named', async () => {
    net.current = { tun9: [{ ...v4('127.0.0.2', '255.0.0.0'), internal: true }] }
    expect(await activeTunnelInterfaces()).toEqual([])
  })

  it('still counts a routable IPv6 tunnel', async () => {
    // fe80::/10 is fe80 through febf, so rejecting on the first two nibbles
    // alone would take fec0:: and 2001:db8:: with it.
    net.current = { wg0: [v6('2001:db8::1', 0)] }
    expect(await activeTunnelInterfaces()).toEqual(['wg0'])
  })
})

describe('other people’s VPN clients on macOS', () => {
  it('notices WireGuard, as the Windows branch already did', async () => {
    stubPlatform('darwin')
    present.add('/Applications/WireGuard.app')
    expect(await otherVpnClients()).toEqual(['WireGuard'])
  })

  it('warns that it may already have a tunnel up', async () => {
    stubPlatform('darwin')
    present.add('/Applications/WireGuard.app')
    expect((await coexistenceAdvisories()).join(' ')).toContain('WireGuard is also installed')
  })
})

describe('what the interface advisory is allowed to claim', () => {
  it('does not present the interfaces it found as the whole picture', async () => {
    // Measured on this Mac, twice: with a live full-tunnel OpenVPN connection,
    // `os.networkInterfaces()` listed utun0-utun5 and never the utun carrying
    // the traffic, because macOS runs that tunnel inside a NetworkExtension
    // owned by nesessionmanager. So a list of one interface is a floor, and
    // the sentence has to say so or the reader will read it as a total.
    stubPlatform('darwin')
    net.current = { utun6: [v4('10.107.0.60')] }
    const said = (await coexistenceAdvisories()).join(' ')
    expect(said).toContain('utun6')
    expect(said).toContain('There may be others it cannot see')
  })

  it('stays silent rather than reporting an all-clear', async () => {
    // The case that matters most and reads worst if got wrong: nothing visible
    // on a machine that may well have a VPN up. Silence is the only honest
    // output — an "all clear" sentence here would be false on most Macs.
    stubPlatform('darwin')
    net.current = {}
    expect(await coexistenceAdvisories()).toEqual([])
  })
})

describe('the sentence about another app’s copy of OpenVPN', () => {
  const MISSING = '/opt/nowhere-at-all/openvpn'

  it('reaches the user who took the UI up on “Set the path”', async () => {
    // The whole point: this branch is where a confirmed `binaryPath` is
    // refused, and it used to compose only "<path> does not exist." while the
    // no-path branch explained why the Tunnelblick copy they were reaching for
    // is not an option.
    stubPlatform('darwin')
    present.add('/Applications/Tunnelblick.app')
    const err = await resolveSystem('openvpn', { binaryPath: MISSING, confirmed: true }).catch(
      (e) => e
    )
    expect(isVpnError(err) && err.code).toBe('config-invalid')
    expect(String(err.message)).toContain(
      'Tunnelblick is installed, but its copy of OpenVPN belongs to that app'
    )
  })

  it('does not credit WireGuard with a copy of OpenVPN it does not have', async () => {
    // WireGuard is worth naming as a coexisting tunnel and worthless here:
    // there is no `openvpn` inside WireGuard.app to belong to anything.
    stubPlatform('darwin')
    present.add('/Applications/WireGuard.app')
    const err = await resolveSystem('openvpn', { binaryPath: MISSING, confirmed: true }).catch(
      (e) => e
    )
    expect(String(err.message)).not.toContain('copy of OpenVPN')
  })
})

describe('a hand-typed path to OpenVPN Connect', () => {
  it('is named on macOS, not merely refused for being in /Applications', async () => {
    stubPlatform('darwin')
    const err = await resolveSystem('openvpn', {
      binaryPath: '/Applications/OpenVPN Connect/OpenVPN Connect.app/Contents/MacOS/OpenVPN Connect',
      confirmed: true
    }).catch((e) => e)
    expect(String(err.message)).toContain('is OpenVPN Connect, which cannot run tunnels')
    // The Windows instruction would send a Mac user to a drive they do not have.
    expect(String(err.message)).not.toContain('C:\\Program Files')
  })

  it('names its CLI too', async () => {
    stubPlatform('darwin')
    const err = await resolveSystem('openvpn', {
      binaryPath: '/usr/local/bin/ovpnconnect',
      confirmed: true
    }).catch((e) => e)
    expect(String(err.message)).toContain('is the OpenVPN Connect CLI')
  })
})

describe('when no openvpn is anywhere OpsMaxx looks', () => {
  it('names the login-PATH limitation and the way out of it', async () => {
    // The bug report this sentence exists to pre-empt: a Finder-launched
    // Electron app inherits launchd's PATH, not the login shell's, so an
    // openvpn from nix, asdf or a custom prefix is on `which openvpn` in a
    // terminal and invisible here. Being told it is "not installed" while
    // looking at it is the worst shape a report takes.
    stubPlatform('darwin')
    absent.openvpn = true
    const err = await resolveSystem('openvpn').catch((e) => e)
    expect(isVpnError(err) && err.code).toBe('binary-missing')
    const said = String(err.message)
    expect(said).toContain('login shell')
    expect(said).toContain('which openvpn')
    // The remedy, spelled the way the button is spelled in useVpnProfiles.tsx.
    // A caveat with no way out of it is just a longer dead end.
    expect(said).toContain('Set the path')
  })

  it('does not blame PATH on Windows, which never searches it', async () => {
    // Windows refuses a PATH search by design (E44) and already says so. Adding
    // "your login shell's PATH differs" there would describe a search that
    // never happened.
    stubPlatform('win32')
    absent.openvpn = true
    const err = await resolveSystem('openvpn').catch((e) => e)
    const said = String(err.message)
    expect(said).toContain('does not search PATH on Windows')
    expect(said).not.toContain('login shell')
  })
})
