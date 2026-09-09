import { describe, it, expect } from 'vitest'
import { execSync } from 'node:child_process'
import {
  buildPingCommand,
  buildTracerouteCommand,
  isProbeableHost,
  parsePing,
  parseTraceroute
} from '../src/shared/netTools'

/**
 * ping and traceroute.
 *
 * Two things are worth testing hard here. The host is user input going into a
 * shell command, so the refusal has to be airtight — and the three platforms
 * agree on almost nothing about either the flags or the output, so each format
 * is parsed from real output rather than from something convenient.
 */

describe('host validation', () => {
  it('accepts the things that are actually hosts', () => {
    for (const h of ['example.com', 'a.b.c.d.example.org', '10.0.0.1', 'host-1', '::1', 'fe80::1']) {
      expect(isProbeableHost(h), h).toBe(true)
    }
  })

  /**
   * The refusal, and the reason it is an allowlist. Every one of these would
   * otherwise be interpolated into a command line — an allowlist of what a
   * hostname may contain is knowable, and an escaping scheme that holds for
   * every shell is not.
   */
  it('refuses anything that could be more than a host', () => {
    for (const h of [
      '',
      '   ',
      'example.com; rm -rf /',
      'example.com && curl evil',
      '$(whoami)',
      '`id`',
      'a|b',
      'host name',
      "host'quote",
      'host"quote',
      '-oProxyCommand=x',
      'a'.repeat(300)
    ]) {
      expect(isProbeableHost(h), JSON.stringify(h)).toBe(false)
    }
  })

  it('builds no command at all for a refused host', () => {
    expect(buildPingCommand('a; rm -rf /', 'linux')).toBeNull()
    expect(buildTracerouteCommand('a; rm -rf /', 'linux')).toBeNull()
  })
})

describe('command shape per platform', () => {
  // Windows counts with -n and takes milliseconds; the Unixes count with -c.
  it('uses the count flag each platform actually has', () => {
    expect(buildPingCommand('example.com', 'win32', { count: 3 })).toContain('-n 3')
    expect(buildPingCommand('example.com', 'linux', { count: 3 })).toContain('-c 3')
    expect(buildPingCommand('example.com', 'darwin', { count: 3 })).toContain('-c 3')
  })

  it('gives Windows its timeout in milliseconds', () => {
    expect(buildPingCommand('example.com', 'win32', { timeoutSec: 2 })).toContain('-w 2000')
  })

  // Without an overall deadline a black-holed host holds the connection for
  // count × timeout, which on a shared SSH connection is the wrong thing to do.
  it('bounds the whole run on Linux, not just each probe', () => {
    expect(buildPingCommand('example.com', 'linux', { count: 4, timeoutSec: 2 })).toContain('-w 8')
  })

  it('clamps a count nobody should be sending to a server', () => {
    expect(buildPingCommand('example.com', 'linux', { count: 10000 })).toContain('-c 20')
    expect(buildPingCommand('example.com', 'linux', { count: -5 })).toContain('-c 1')
  })

  it('uses tracert on Windows and traceroute elsewhere', () => {
    expect(buildTracerouteCommand('example.com', 'win32')).toMatch(/^tracert /)
    expect(buildTracerouteCommand('example.com', 'linux')).toMatch(/^traceroute /)
  })

  // Reverse DNS for every hop is most of the wall clock and none of the answer.
  it('never resolves hop names', () => {
    expect(buildTracerouteCommand('example.com', 'linux')).toContain('-n')
    expect(buildTracerouteCommand('example.com', 'win32')).toContain('-d')
  })
})

describe('parsePing', () => {
  const LINUX = `PING example.com (93.184.216.34) 56(84) bytes of data.
64 bytes from 93.184.216.34: icmp_seq=1 ttl=56 time=11.2 ms
64 bytes from 93.184.216.34: icmp_seq=2 ttl=56 time=10.9 ms

--- example.com ping statistics ---
2 packets transmitted, 2 received, 0% packet loss, time 1002ms
rtt min/avg/max/mdev = 10.912/11.056/11.201/0.144 ms`

  const MACOS = `PING example.com (93.184.216.34): 56 data bytes
64 bytes from 93.184.216.34: icmp_seq=0 ttl=56 time=11.234 ms

--- example.com ping statistics ---
2 packets transmitted, 1 packets received, 50.0% packet loss
round-trip min/avg/max/stddev = 11.234/11.234/11.234/0.000 ms`

  const WINDOWS = `\r\nPinging example.com [93.184.216.34] with 32 bytes of data:\r
Reply from 93.184.216.34: bytes=32 time=11ms TTL=56\r
\r
Ping statistics for 93.184.216.34:\r
    Packets: Sent = 4, Received = 3, Lost = 1 (25% loss),\r
Approximate round trip times in milli-seconds:\r
    Minimum = 10ms, Maximum = 13ms, Average = 11ms\r`

  it('reads the Linux form', () => {
    const r = parsePing(LINUX)
    expect(r).toMatchObject({ reachable: true, transmitted: 2, received: 2, loss: 0 })
    expect(r.avgMs).toBeCloseTo(11.056)
    expect(r.resolvedIp).toBe('93.184.216.34')
  })

  // macOS says "packets received" where Linux says "received", and labels its
  // timing line round-trip rather than rtt.
  it('reads the macOS form', () => {
    const r = parsePing(MACOS)
    expect(r).toMatchObject({ reachable: true, transmitted: 2, received: 1, loss: 50 })
    expect(r.maxMs).toBeCloseTo(11.234)
  })

  // A different shape entirely: a Sent/Received/Lost table and a separate
  // Minimum/Maximum/Average line, with the average LAST rather than middle.
  it('reads the Windows form, including the reordered timings', () => {
    const r = parsePing(WINDOWS)
    expect(r).toMatchObject({ reachable: true, transmitted: 4, received: 3, loss: 25 })
    expect(r.minMs).toBe(10)
    expect(r.avgMs).toBe(11)
    expect(r.maxMs).toBe(13)
    expect(r.resolvedIp).toBe('93.184.216.34')
  })

  /**
   * "0 received" alone sends someone to look at the network when the reason is
   * usually sitting in the output.
   */
  it('surfaces the reason when nothing came back', () => {
    const r = parsePing(`ping: cannot resolve nope.invalid: Unknown host`)
    expect(r.reachable).toBe(false)
    expect(r.loss).toBe(100)
    expect(r.error).toMatch(/cannot resolve/i)
  })

  it('reports a container without raw-socket permission as itself', () => {
    const r = parsePing('ping: socket: Operation not permitted')
    expect(r.error).toMatch(/not permitted/i)
  })
})

describe('parseTraceroute', () => {
  const UNIX = `traceroute to example.com (93.184.216.34), 20 hops max, 60 byte packets
 1  192.168.1.1  1.234 ms
 2  *
 3  10.0.0.1  8.900 ms
 4  93.184.216.34  11.201 ms`

  const WINDOWS = `\r
Tracing route to example.com [93.184.216.34]\r
over a maximum of 20 hops:\r
\r
  1     1 ms     1 ms     1 ms  192.168.1.1\r
  2     *        *        *     Request timed out.\r
  3    11 ms    10 ms    12 ms  93.184.216.34\r`

  it('reads the Unix layout, where the address comes first', () => {
    const hops = parseTraceroute(UNIX)
    expect(hops).toHaveLength(4)
    expect(hops[0]).toMatchObject({ hop: 1, host: '192.168.1.1', timedOut: false })
    expect(hops[0].timesMs).toEqual([1.234])
  })

  // Windows puts the address LAST, after three timing columns — so a parser
  // that took "the first token after the hop number" would read `1` as a host.
  it('reads the Windows layout, where the address comes last', () => {
    const hops = parseTraceroute(WINDOWS)
    expect(hops[0]).toMatchObject({ hop: 1, host: '192.168.1.1' })
    expect(hops[0].timesMs).toEqual([1, 1, 1])
    expect(hops[2]).toMatchObject({ hop: 3, host: '93.184.216.34' })
  })

  it('marks a hop that never answered', () => {
    expect(parseTraceroute(UNIX)[1]).toMatchObject({ hop: 2, timedOut: true, host: undefined })
  })

  it('skips the header lines rather than reading them as hops', () => {
    for (const hops of [parseTraceroute(UNIX), parseTraceroute(WINDOWS)]) {
      expect(hops.every((h) => Number.isInteger(h.hop) && h.hop > 0)).toBe(true)
    }
  })
})

/**
 * The command, run by a real shell against loopback, into the real parser.
 *
 * The class of bug this catches is the one that cost the listening-ports
 * feature everything: a command that looks right as a string and produces
 * nothing when a shell actually runs it. Loopback so it needs no network.
 */
describe('end to end against loopback', () => {
  const posix = process.platform !== 'win32'

  it.runIf(posix)('pings loopback and parses what comes back', () => {
    const platform = process.platform === 'darwin' ? 'darwin' : 'linux'
    const cmd = buildPingCommand('127.0.0.1', platform, { count: 1, timeoutSec: 2 })
    expect(cmd).not.toBeNull()
    const out = execSync(`${cmd as string} 2>&1 || true`, { shell: '/bin/sh', encoding: 'utf8' })
    const r = parsePing(out)
    expect(r.transmitted, out).toBe(1)
    expect(r.received, out).toBe(1)
    expect(r.reachable).toBe(true)
    expect(r.loss).toBe(0)
  })
})
