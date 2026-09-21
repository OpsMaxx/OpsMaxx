import { afterEach, describe, expect, it, vi } from 'vitest'

// The routing table, as the second source for "is a tunnel already up".
//
// `os.networkInterfaces()` alone was blind to the common case. Measured on a
// Mac with a live full-tunnel OpenVPN: `ifconfig` showed
// `utun6: inet 10.107.0.60 --> 10.107.0.1` and Node listed utun0-utun5 and
// stopped — utun6 was absent entirely, because the tunnel belongs to
// NetworkExtension (`nesessionmanager`) rather than to an `openvpn` process.
// That is how OpenVPN Connect v3 and every App Store VPN run, so the coexistence
// warning was blind to precisely the machines it exists for.
//
// The fixtures below are real `netstat -rn -f inet` shapes, not invented ones.

const { net, route } = vi.hoisted(() => ({
  net: { current: {} as Record<string, unknown[]> },
  route: { stdout: '', code: 0, calls: [] as string[][] }
}))

vi.mock('node:os', async (orig) => {
  const real = await orig<typeof import('node:os')>()
  return { ...real, networkInterfaces: () => net.current }
})

// The route read is faked so the suite does not depend on whether the person
// running it happens to have a VPN up. Everything else in netstate stays real.
vi.mock('../src/main/services/vpn/netstate', async (orig) => {
  const real = await orig<typeof import('../src/main/services/vpn/netstate')>()
  return {
    ...real,
    readCommand: (cmd: string, args: string[]) => {
      route.calls.push([cmd, ...args])
      return Promise.resolve({ code: route.code, stdout: route.stdout, stderr: '' })
    }
  }
})

// `/Applications` is faked for the same reason tests/vpnDetection.test.ts fakes
// it: `otherVpnClients` probes that tree, and the developer's own Mac is not a
// fixture. Everything outside it stays real.
vi.mock('node:fs/promises', async (orig) => {
  const real = await orig<typeof import('node:fs/promises')>()
  return {
    ...real,
    stat: (p: Parameters<typeof real.stat>[0], ...rest: unknown[]) => {
      const path = String(p)
      if (!path.startsWith('/Applications/')) {
        return (real.stat as (...a: unknown[]) => unknown)(p, ...rest)
      }
      return Promise.reject(new Error(`ENOENT: ${path}`))
    }
  }
})

const { activeTunnelInterfaces, coexistenceAdvisories, defaultRouteTunnels, resetBinaryCache } =
  await import('../src/main/services/vpn/binaries')

let platformDescriptor: PropertyDescriptor | undefined

function stubPlatform(value: NodeJS.Platform): void {
  platformDescriptor ??= Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value, configurable: true })
}

afterEach(() => {
  if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor)
  platformDescriptor = undefined
  net.current = {}
  route.stdout = ''
  route.code = 0
  route.calls = []
  resetBinaryCache()
})

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

// Measured on a Mac with no VPN running, trimmed of the couple of hundred ARP
// host routes that say nothing here. The control: no tunnel interface appears
// in the inet table at all.
const NO_VPN = `Routing tables

Internet:
Destination        Gateway            Flags               Netif Expire
default            10.0.0.1           UGScg                 en0
10/21              link#14            UCS                   en0      !
10.0.0.1           48:a9:8a:18:6e:74  UHLWIir               en0   1200
10.0.1.188         2:27:ee:5f:d0:43   UHLWI                 en0   1164
127                127.0.0.1          UCS                   lo0
127.0.0.1          127.0.0.1          UH                    lo0
169.254            link#14            UCS                   en0      !
224.0.0/4          link#14            UmCS                  en0      !
255.255.255.255/32 link#14            UCS                   en0      !
`

// The same machine with a full-tunnel OpenVPN up. `0/1` + `128.0/1` is a
// default route in disguise: it beats the real default on prefix length
// without replacing it, which is how every full-tunnel VPN takes the traffic.
const FULL_TUNNEL = `Routing tables

Internet:
Destination        Gateway            Flags               Netif Expire
0/1                10.107.0.1         UGScg               utun6
default            10.0.0.1           UGScg                 en0
10.0.0.1/32        link#14            UCS                   en0      !
10.107.0.1         10.107.0.60        UH                  utun6
128.0/1            10.107.0.1         UGSc                utun6
224.0.0/4          link#14            UmCS                  en0      !
`

describe('reading a tunnel out of the routing table', () => {
  it('finds the NetworkExtension tunnel os.networkInterfaces() cannot see', () => {
    expect(defaultRouteTunnels(FULL_TUNNEL)).toEqual(['utun6'])
  })

  it('reports nothing on a machine with no VPN', () => {
    expect(defaultRouteTunnels(NO_VPN)).toEqual([])
  })

  it('does not mistake the ordinary default route for a tunnel', () => {
    // `default -> en0` is on every machine on a network. Reporting it would
    // put "something on this machine has a tunnel up" on every render, which
    // is the exact false positive the address check was already fixed for.
    expect(defaultRouteTunnels(NO_VPN)).not.toContain('en0')
    expect(defaultRouteTunnels(FULL_TUNNEL)).not.toContain('en0')
  })

  it('accepts the unabbreviated spelling of the same two routes', () => {
    // netstat trims trailing zero octets, but not on every macOS version, so
    // matching only `0/1` would see nothing on the ones that print it in full.
    const long = `Routing tables

Internet:
Destination        Gateway            Flags               Netif Expire
0.0.0.0/1          10.107.0.1         UGScg               utun6
128.0.0.0/1        10.107.0.1         UGSc                utun6
`
    expect(defaultRouteTunnels(long)).toEqual(['utun6'])
  })

  it('counts a VPN that replaces the default route outright', () => {
    // WireGuard's `0.0.0.0/0` is not always installed as the 0/1 split, and a
    // tunnel that owns `default` is the strongest form of the same signal.
    const wg = `Routing tables

Internet:
Destination        Gateway            Flags               Netif Expire
default            link#26            UCSI                 utun4
`
    expect(defaultRouteTunnels(wg)).toEqual(['utun4'])
  })

  it('survives output that is not a routing table at all', () => {
    // A truncated read, a localised header, an error on stdout: none of it may
    // throw, because this runs on the path of every engine resolve.
    expect(defaultRouteTunnels('')).toEqual([])
    expect(defaultRouteTunnels('netstat: unknown option\n')).toEqual([])
    expect(defaultRouteTunnels('Routing tables\n\nInternet:\n')).toEqual([])
  })
})

describe('what activeTunnelInterfaces does with the two sources', () => {
  it('merges them rather than replacing one with the other', async () => {
    // Neither source is a superset. A tunnel an app runs as its own process
    // has an address Node can see; a NetworkExtension one only has a route.
    stubPlatform('darwin')
    net.current = { utun3: [v4('10.8.0.2')] }
    route.stdout = FULL_TUNNEL
    expect(await activeTunnelInterfaces()).toEqual(['utun3', 'utun6'])
  })

  it('names an interface once when both sources see it', async () => {
    stubPlatform('darwin')
    net.current = { utun6: [v4('10.107.0.60')] }
    route.stdout = FULL_TUNNEL
    expect(await activeTunnelInterfaces()).toEqual(['utun6'])
  })

  it('reads the route table through an absolute path', async () => {
    // This module's header says the PATH search IS the vulnerability, and
    // elevation/win32.ts sets the precedent. A bare `netstat` would run
    // whatever a writable PATH entry put there first.
    stubPlatform('darwin')
    await activeTunnelInterfaces()
    expect(route.calls[0]).toEqual(['/usr/sbin/netstat', '-rn', '-f', 'inet'])
  })

  it('spawns nothing off macOS', async () => {
    // NetworkExtension is a macOS framework. On Linux and Windows the stdlib
    // already sees the tunnel, so a subprocess would buy nothing.
    for (const p of ['linux', 'win32'] as NodeJS.Platform[]) {
      stubPlatform(p)
      net.current = { tun0: [v4('10.8.0.2')] }
      expect(await activeTunnelInterfaces()).toEqual(['tun0'])
    }
    expect(route.calls).toEqual([])
  })

  it('does not spawn once per poll', async () => {
    // `resolveEngineBinary` calls this on every UI poll. One netstat per call
    // is the thing that makes a cheap advisory expensive.
    stubPlatform('darwin')
    route.stdout = FULL_TUNNEL
    await Promise.all([activeTunnelInterfaces(), activeTunnelInterfaces()])
    await activeTunnelInterfaces()
    expect(route.calls.length).toBe(1)
  })

  it('reads again after resetBinaryCache', async () => {
    // Every other per-run answer in this module is cleared there, and a test
    // that swaps fixtures has to be able to clear this one too.
    stubPlatform('darwin')
    route.stdout = FULL_TUNNEL
    await activeTunnelInterfaces()
    resetBinaryCache()
    await activeTunnelInterfaces()
    expect(route.calls.length).toBe(2)
  })

  it('degrades to the stdlib answer when netstat is missing or slow', async () => {
    // A missing, renamed or hung netstat must cost the advisory, never the
    // resolve: this sits on the path to "which openvpn do we run".
    stubPlatform('darwin')
    route.code = 127
    route.stdout = ''
    net.current = { utun3: [v4('10.8.0.2')] }
    expect(await activeTunnelInterfaces()).toEqual(['utun3'])
  })
})

describe('the sentence the user actually reads', () => {
  it('warns about the tunnel that used to be invisible', async () => {
    // The end of the whole exercise: a Mac with a full-tunnel VPN up and
    // nothing visible to Node used to get silence.
    stubPlatform('darwin')
    net.current = {}
    route.stdout = FULL_TUNNEL
    const said = (await coexistenceAdvisories()).join(' ')
    expect(said).toContain('utun6')
    expect(said).toContain('the last one to start wins')
  })

  it('no longer claims a macOS VPN cannot be seen at all', async () => {
    // That sentence was true and is not any more. A stale caveat is worse than
    // none: it tells the reader to discount a list that is now the better half
    // of the answer.
    stubPlatform('darwin')
    route.stdout = FULL_TUNNEL
    const said = (await coexistenceAdvisories()).join(' ')
    expect(said).not.toContain('a VPN macOS runs for another app')
  })

  it('still refuses to report an all-clear', async () => {
    // A split-tunnel NetworkExtension VPN claims no default route and shows no
    // address, so empty still means "none was visible", not "none is running".
    stubPlatform('darwin')
    net.current = {}
    route.stdout = NO_VPN
    expect(await coexistenceAdvisories()).toEqual([])
  })
})
