import { describe, it, expect } from 'vitest'
import { execSync } from 'node:child_process'
import {
  buildListeningPortsCommand,
  filterByProto,
  parseListeningPorts,
  parseLsof,
  parseNetstat,
  parseSs,
  protoCounts
} from '../src/shared/listeningPorts'

/**
 * "Which ports are being used" — asked for by name.
 *
 * Three tools because no one of them is present-and-sufficient everywhere, and
 * the interesting behaviour is the macOS join: unprivileged `lsof` cannot see
 * other users' sockets, so on its own the LIST is short rather than merely
 * missing an owner column. A short list presented as complete is the failure
 * worth testing for.
 */

const SS_OUT = `===OM_PORTS_SS===
tcp   LISTEN 0      4096         0.0.0.0:22        0.0.0.0:*    users:(("sshd",pid=812,fd=3))
tcp   LISTEN 0      511             [::]:80           [::]:*    users:(("nginx",pid=1140,fd=6))
tcp   ESTAB  0      0        10.0.0.5:22        10.0.0.9:51234
udp   UNCONN 0      0        127.0.0.1:53        0.0.0.0:*    users:(("systemd-resolve",pid=640,fd=12))
===OM_PORTS_NETSTAT===
===OM_PORTS_LSOF===
`

const MAC_OUT = `===OM_PORTS_SS===
===OM_PORTS_NETSTAT===
Active Internet connections (including servers)
Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)
tcp4       0      0  *.22                   *.*                    LISTEN
tcp4       0      0  127.0.0.1.5432         *.*                    LISTEN
tcp4       0      0  192.168.1.10.51000     93.184.216.34.443      ESTABLISHED
udp4       0      0  *.5353                 *.*
===OM_PORTS_LSOF===
COMMAND     PID   USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
sshd        812   root    3u  IPv4 0x1a2b3c4d5e6f7890      0t0  TCP *:22 (LISTEN)
`

describe('buildListeningPortsCommand', () => {
  it('asks all three tools and guards every one', () => {
    const cmd = buildListeningPortsCommand()
    expect(cmd).toContain('ss -tulpn')
    expect(cmd).toContain('netstat')
    expect(cmd).toContain('lsof')
    // A host with none of them must answer empty, not fail the read.
    expect(cmd).toContain('|| true')
  })
})

describe('ss', () => {
  it('reads listeners with their owning process', () => {
    const ports = parseSs(SS_OUT.split('===OM_PORTS_NETSTAT===')[0])
    const ssh = ports.find((p) => p.port === 22)
    expect(ssh).toMatchObject({ proto: 'tcp', address: '0.0.0.0', port: 22, process: 'sshd', pid: 812 })
  })

  // An IPv6 address is full of colons, so splitting on the first would halve it.
  it('keeps an IPv6 address intact', () => {
    const ports = parseSs(SS_OUT.split('===OM_PORTS_NETSTAT===')[0])
    expect(ports.find((p) => p.port === 80)).toMatchObject({ address: '::', process: 'nginx' })
  })

  // A tcp row without LISTEN is an established connection, not a listener.
  it('excludes established connections', () => {
    const ports = parseSs(SS_OUT.split('===OM_PORTS_NETSTAT===')[0])
    expect(ports.some((p) => p.port === 51234)).toBe(false)
  })

  // UDP has no LISTEN state, so being in the output is the whole signal.
  it('includes udp sockets', () => {
    const ports = parseSs(SS_OUT.split('===OM_PORTS_NETSTAT===')[0])
    expect(ports.find((p) => p.proto === 'udp')).toMatchObject({ port: 53 })
  })
})

describe('netstat', () => {
  it('reads the macOS dotted form', () => {
    const ports = parseNetstat(MAC_OUT.split('===OM_PORTS_LSOF===')[0])
    expect(ports.find((p) => p.port === 5432)).toMatchObject({ address: '127.0.0.1', proto: 'tcp' })
    expect(ports.find((p) => p.port === 22)).toMatchObject({ address: '*' })
  })

  it('reads the Linux owner column when it is there', () => {
    const ports = parseNetstat('tcp 0 0 0.0.0.0:22 0.0.0.0:* LISTEN 812/sshd')
    expect(ports[0]).toMatchObject({ port: 22, process: 'sshd', pid: 812 })
  })

  it('excludes established connections and skips headers', () => {
    const ports = parseNetstat(MAC_OUT.split('===OM_PORTS_LSOF===')[0])
    expect(ports.some((p) => p.port === 51000)).toBe(false)
    expect(ports.some((p) => Number.isNaN(p.port))).toBe(false)
  })
})

describe('lsof', () => {
  /**
   * lsof truncates COMMAND to nine characters unless told not to, which turned
   * `JavaApplicationStub` into `JavaAppli` and `codebase-memory-mcp` into
   * `codebase-` — an owner column naming something nobody could recognise or
   * search for. `+c 0` lifts it, with a plain `lsof` fallback because `+c` is
   * not universal and a truncated name beats no name.
   */
  it('asks lsof not to truncate, and still works if it cannot', () => {
    const cmd = buildListeningPortsCommand()
    expect(cmd).toContain('lsof +c 0')
    expect(cmd).toContain('|| lsof -nP')
  })

  /**
   * The trap inside that fix: with `+c 0`, lsof escapes a space as `\x20`. The
   * allowlist rejects a backslash, so decoding has to happen first or the fix
   * turns truncated names into missing ones.
   */
  it('decodes the escapes lsof writes for spaces', () => {
    const ports = parseLsof(
      'Burp\\x20Browser 900 me 5u IPv4 0x1 0t0 TCP 127.0.0.1:8080 (LISTEN)'
    )
    expect(ports[0]?.process).toBe('Burp Browser')
  })

  it('reads the owner and the socket', () => {
    const ports = parseLsof(MAC_OUT.split('===OM_PORTS_LSOF===')[1])
    expect(ports[0]).toMatchObject({ proto: 'tcp', address: '*', port: 22, process: 'sshd', pid: 812 })
  })
})

describe('parseListeningPorts', () => {
  it('prefers ss outright, since it reports sockets and owners in one pass', () => {
    const info = parseListeningPorts(SS_OUT)
    expect(info.source).toBe('ss')
    expect(info.partialOwners).toBe(false)
    expect(info.ports.map((p) => p.port)).toEqual([22, 53, 80])
  })

  /**
   * The macOS case, and the reason the join exists. lsof sees sshd only;
   * netstat sees postgres and mDNS as well. Taking lsof alone would have
   * presented a one-row list as the complete answer.
   */
  it('joins netstat and lsof so the list is complete and the owners partial', () => {
    const info = parseListeningPorts(MAC_OUT)
    expect(info.source).toBe('mixed')
    expect(info.ports.map((p) => p.port)).toEqual([22, 5353, 5432])
    // The owner lsof could see.
    expect(info.ports.find((p) => p.port === 22)?.process).toBe('sshd')
    // The ones it could not — present, and honestly ownerless.
    expect(info.ports.find((p) => p.port === 5432)?.process).toBeUndefined()
    expect(info.partialOwners).toBe(true)
  })

  it('reports nothing rather than an error when no tool exists', () => {
    const info = parseListeningPorts('===OM_PORTS_SS===\n===OM_PORTS_NETSTAT===\n===OM_PORTS_LSOF===\n')
    expect(info).toEqual({ ports: [], partialOwners: false, source: null })
  })

  // A process name is drawn in a panel, so it is shape-checked, not trusted.
  it('drops a process name that is not a plausible name', () => {
    const hostile = `===OM_PORTS_SS===
tcp   LISTEN 0 1 0.0.0.0:22 0.0.0.0:* users:(("<img src=x onerror=alert(1)>",pid=1,fd=3))
===OM_PORTS_NETSTAT===
===OM_PORTS_LSOF===`
    const info = parseListeningPorts(hostile)
    expect(info.ports[0].process).toBeUndefined()
    expect(info.partialOwners).toBe(true)
  })

  it('does not report the same socket twice', () => {
    const both = `===OM_PORTS_SS===
===OM_PORTS_NETSTAT===
tcp4 0 0 *.22 *.* LISTEN
===OM_PORTS_LSOF===
COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME
sshd 812 root 3u IPv4 0x1 0t0 TCP *:22 (LISTEN)`
    const info = parseListeningPorts(both)
    expect(info.ports).toHaveLength(1)
    expect(info.ports[0].process).toBe('sshd')
  })
})

/**
 * The command, executed by a real shell, into the real parser.
 *
 * This is the test that was missing, and its absence hid a total failure: the
 * markers used to begin with `#`, which is a comment in every POSIX shell, so
 * `echo #__om_ss__` printed an empty line, no marker ever reached the output,
 * and the feature returned zero ports on every host. Every test above feeds the
 * markers in by hand, so all of them passed while nothing worked.
 *
 * Anything that only checks the command STRING, or only checks the parser
 * against hand-written input, cannot catch that class of bug. This runs the two
 * halves against each other.
 */
describe('the command and the parser, end to end', () => {
  const posix = process.platform !== 'win32'

  it.runIf(posix)('produces markers that survive the shell', () => {
    const out = execSync(buildListeningPortsCommand(), { shell: '/bin/sh', encoding: 'utf8' })
    for (const marker of ['===OM_PORTS_SS===', '===OM_PORTS_NETSTAT===', '===OM_PORTS_LSOF===']) {
      expect(out, `${marker} did not survive the shell`).toContain(marker)
    }
  })

  it.runIf(posix)('finds at least one listening port on this machine', () => {
    const out = execSync(buildListeningPortsCommand(), { shell: '/bin/sh', encoding: 'utf8' })
    const info = parseListeningPorts(out)
    // A development machine always has something listening. Zero here means the
    // pipeline is broken, not that the machine is quiet.
    expect(info.source).not.toBeNull()
    expect(info.ports.length).toBeGreaterThan(0)
    // And every row has to be a real port, not a NaN from a shifted column.
    for (const p of info.ports) {
      expect(Number.isInteger(p.port), JSON.stringify(p)).toBe(true)
      expect(p.port).toBeGreaterThan(0)
    }
  })
})

/**
 * The protocol filter, and why TCP is the default.
 *
 * The panel listed UDP alongside TCP and showed roughly twice the rows a
 * terminal does — `ss -tlpn` and `lsof -i -P | grep LISTEN` are both TCP. A
 * panel that disagrees with the terminal on the same machine reads as wrong
 * even when its data is right, which this one's was: the TCP ports verified
 * exactly against netstat.
 *
 * UDP is filtered, never dropped. Plenty of real services are UDP — DNS, mDNS,
 * WireGuard, syslog — and hiding them permanently would be its own lie.
 */
describe('protocol filter', () => {
  const ports = parseListeningPorts(SS_OUT).ports

  it('shows only TCP, only UDP, or everything', () => {
    expect(filterByProto(ports, 'tcp').every((p) => p.proto === 'tcp')).toBe(true)
    expect(filterByProto(ports, 'udp').every((p) => p.proto === 'udp')).toBe(true)
    expect(filterByProto(ports, 'all')).toHaveLength(ports.length)
  })

  // Nothing is removed by filtering — the UDP rows are still there.
  it('keeps every port available under one filter or another', () => {
    const tcp = filterByProto(ports, 'tcp').length
    const udp = filterByProto(ports, 'udp').length
    expect(tcp + udp).toBe(ports.length)
    expect(udp).toBeGreaterThan(0)
  })

  /**
   * Every count is on screen at once, so the filter states what it is hiding
   * rather than implying there is nothing there — which is the failure mode of
   * a filter that silently defaults to a subset.
   */
  it('counts each protocol so the filter can say what it hides', () => {
    const c = protoCounts(ports)
    expect(c.tcp + c.udp).toBe(c.all)
    expect(c.all).toBe(ports.length)
  })
})
