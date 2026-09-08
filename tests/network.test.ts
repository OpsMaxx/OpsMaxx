import { describe, it, expect } from 'vitest'
import { buildNetworkCommand, isStubResolver, parseNetwork } from '../src/shared/network'

/**
 * `ip -o addr show` output in the shape a host running k3s and docker gives.
 *
 * Addresses are the documentation ranges — RFC 5737 for v4, RFC 3849 for v6 —
 * because this repository is public and a fixture is not a place to publish a
 * real host's addressing.
 */
const IP_OUT = [
  '1: lo    inet 127.0.0.1/8 scope host lo\\       valid_lft forever',
  '1: lo    inet6 ::1/128 scope host noprefixroute \\       valid_lft forever',
  '2: eth0    inet 198.51.100.23/17 brd 198.51.127.255 scope global eth0\\       valid_lft forever',
  '2: eth0    inet6 2001:db8:2352:9687::1/64 scope global \\       valid_lft forever',
  '2: eth0    inet6 fe80::250:56ff:fe00:0001/64 scope link \\       valid_lft forever',
  '3: docker0    inet 172.17.0.1/16 brd 172.17.255.255 scope global docker0\\       valid_lft forever',
  '5: veth09c4f82    inet6 fe80::3c4f:9dff:fe70:1c30/64 scope link \\       valid_lft forever'
].join('\n')

const out = (ifaces: string, dns: string): string =>
  `__SP_IFACES__\n${ifaces}\n__SP_DNS__\n${dns}\n`

describe('interfaces', () => {
  it('reads each interface with its addresses', () => {
    const info = parseNetwork(out(IP_OUT, ''))
    const eth0 = info.interfaces.find((i) => i.name === 'eth0')
    expect(eth0?.addresses).toEqual([
      { family: 'ipv4', address: '198.51.100.23', prefix: 17 },
      { family: 'ipv6', address: '2001:db8:2352:9687::1', prefix: 64 }
    ])
  })

  /**
   * Loopback and link-local are true and useless: they are identical on every
   * host in the estate. A list whose first row is `lo 127.0.0.1` is a list
   * people stop reading.
   */
  it('leaves out loopback and IPv6 link-local', () => {
    const info = parseNetwork(out(IP_OUT, ''))
    expect(info.interfaces.map((i) => i.name)).not.toContain('lo')
    const addrs = info.interfaces.flatMap((i) => i.addresses.map((a) => a.address))
    expect(addrs.some((a) => a.startsWith('fe80:'))).toBe(false)
    // A veth with nothing but a link-local address has nothing left to show.
    expect(info.interfaces.map((i) => i.name)).not.toContain('veth09c4f82')
  })

  it('keeps the interfaces that do have a routable address', () => {
    const info = parseNetwork(out(IP_OUT, ''))
    expect(info.interfaces.map((i) => i.name)).toEqual(['docker0', 'eth0'])
  })

  // These names and addresses are drawn in a panel, and a remote host chooses
  // them. Anything that is not shaped like an address does not get rendered.
  it('refuses text that is not an address', () => {
    const junk = '2: eth0    inet not-an-address/24 scope global eth0'
    expect(parseNetwork(out(junk, '')).interfaces).toEqual([])
  })

  it('survives a host with neither ip nor ifconfig', () => {
    const info = parseNetwork(out('', ''))
    expect(info.interfaces).toEqual([])
    expect(info.dns).toEqual([])
    expect(info.dnsSource).toBeNull()
  })
})

describe('resolvers', () => {
  it('reads what resolvectl reports, per link', () => {
    const info = parseNetwork(
      out(IP_OUT, 'Global:\nLink 2 (eth0): 203.0.113.53 203.0.113.54\nLink 3 (docker0):')
    )
    expect(info.dns).toEqual(['203.0.113.53', '203.0.113.54'])
    expect(info.dnsSource).toBe('resolvectl')
    expect(isStubResolver(info)).toBe(false)
  })

  it('reads resolv.conf when resolvectl is absent', () => {
    const info = parseNetwork(out(IP_OUT, '# generated\nnameserver 1.1.1.1\nnameserver 8.8.8.8\nsearch lan'))
    expect(info.dns).toEqual(['1.1.1.1', '8.8.8.8'])
    expect(info.dnsSource).toBe('resolv.conf')
  })

  /**
   * On a systemd-resolved host, /etc/resolv.conf names the stub. Reporting
   * "your DNS server is 127.0.0.53" is technically true and sends people
   * looking for a problem that is not there, so the panel says which it is.
   */
  it('recognises the systemd-resolved stub', () => {
    const info = parseNetwork(out(IP_OUT, 'nameserver 127.0.0.53\noptions edns0'))
    expect(info.dns).toEqual(['127.0.0.53'])
    expect(isStubResolver(info)).toBe(true)
  })

  it('does not call real resolvers a stub', () => {
    const info = parseNetwork(out(IP_OUT, 'nameserver 127.0.0.53\nnameserver 1.1.1.1'))
    expect(isStubResolver(info)).toBe(false)
  })
})

describe('the command', () => {
  it('falls back and never fails the whole read', () => {
    const cmd = buildNetworkCommand()
    expect(cmd).toContain('ip -o addr show')
    // A minimal image has no `ip`; a host with neither tool must still answer.
    expect(cmd).toContain('ifconfig -a')
    expect(cmd).toContain('|| true')
    // resolvectl before resolv.conf: on systemd-resolved the file names only
    // the stub.
    expect(cmd.indexOf('resolvectl')).toBeLessThan(cmd.indexOf('/etc/resolv.conf'))
  })
})
