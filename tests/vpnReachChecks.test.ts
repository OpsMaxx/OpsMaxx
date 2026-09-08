import { describe, it, expect, afterEach } from 'vitest'
import { createServer as createTcpServer, type Server as TcpServer } from 'node:net'
import { createServer as createTlsServer, type Server as TlsServer } from 'node:tls'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ipv6LeakCheck, probableRemotes, serverReachCheck } from '../src/shared/vpnChecks'
import { reachRemote } from '../src/main/services/vpn/openvpnReach'

// The two checks that are NOT the sidecar's: whether IPv6 is going round the
// tunnel, and whether this machine can reach an OpenVPN server at all.
//
// `reachRemote` is measured against REAL servers on loopback -- a plain TCP
// listener, a TLS listener with a self-signed certificate made by openssl, and
// a closed port -- because the thing under test is what node's socket layer
// actually does, and a mocked socket would only assert that I remember what it
// does.

const servers: (TcpServer | TlsServer)[] = []
afterEach(() => {
  for (const s of servers.splice(0)) s.close()
})

async function listen(s: TcpServer | TlsServer): Promise<number> {
  servers.push(s)
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
  return (s.address() as { port: number }).port
}

/** A self-signed pair from openssl, the way `vpnCertExpiry` does it: bytes
 *  written to satisfy a parser are not a certificate. */
function selfSigned(): { key: string; cert: string } {
  const dir = mkdtempSync(join(tmpdir(), 'sp-tls-'))
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'),
      '-days', '1', '-subj', '/CN=vpn.test'
    ])
    return {
      key: readFileSync(join(dir, 'k.pem'), 'utf8'),
      cert: readFileSync(join(dir, 'c.pem'), 'utf8')
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('reaching a server, measured against real sockets', () => {
  it('reports a plain TCP listener as reached, with no TLS', async () => {
    const port = await listen(createTcpServer(() => {}))
    const r = await reachRemote({ host: '127.0.0.1', port })
    expect(r.reached).toBe(true)
    expect(r.reached && r.tls).toBe(false)
  })

  // The certificate is from a private CA and is NOT validated: every correctly
  // configured OpenVPN server would fail validation against the system store.
  it('completes a handshake against a self-signed certificate', async () => {
    const { key, cert } = selfSigned()
    const port = await listen(createTlsServer({ key, cert }, () => {}))
    const r = await reachRemote({ host: '127.0.0.1', port })
    expect(r).toMatchObject({ reached: true, tls: true })
  })

  it('names a refused port as refused rather than as a timeout', async () => {
    const s = createTcpServer(() => {})
    const port = await listen(s)
    s.close()
    await new Promise((r) => setTimeout(r, 20))
    const r = await reachRemote({ host: '127.0.0.1', port })
    expect(r.reached).toBe(false)
    expect(r.reached === false && r.why).toContain('refused')
  })

  it('names a host that does not resolve as such', async () => {
    const r = await reachRemote({ host: 'nothing.invalid', port: 1194 })
    expect(r.reached).toBe(false)
    expect(r.reached === false && r.why).toContain('resolved')
  })
})

describe('which remotes are tried', () => {
  // Sending an OpenVPN control packet at somebody's server is speaking the
  // protocol, which is a different act from seeing whether a port answers.
  it('does not try a UDP remote', () => {
    const { probe, skippedUdp } = probableRemotes([
      { host: 'a', port: 1194, proto: 'udp' },
      { host: 'b', port: 443, proto: 'tcp' },
      { host: 'c', port: 1194, proto: 'udp4' }
    ])
    expect(probe).toEqual([{ host: 'b', port: 443 }])
    expect(skippedUdp).toBe(2)
  })
})

describe('what the server check says', () => {
  const ok = { host: 'a', port: 443, reached: true as const, tls: true }

  it('reports reach, and says the certificate was not validated', () => {
    const c = serverReachCheck([ok], 0, 1)
    expect(c.status).toBe('ok')
    expect(c.detail).toContain('NOT validated')
    expect(c.detail).toContain('measured reach, not trust')
  })

  // Most well-configured servers drop an unkeyed ClientHello. Calling that a
  // failure would send somebody to debug the one thing that was right.
  it('does not treat a dropped handshake as a fault', () => {
    const c = serverReachCheck([{ ...ok, tls: false }], 0, 1)
    expect(c.status).toBe('ok')
    expect(c.detail).toContain('tls-auth or tls-crypt')
    expect(c.detail).toContain('not evidence of a problem')
  })

  it('says an unreachable server is a network problem, not a certificate one', () => {
    const c = serverReachCheck([{ host: 'a', port: 443, reached: false, why: 'refused the connection' }], 0, 1)
    expect(c.status).toBe('failed')
    expect(c.detail).toContain('rather than a certificate one')
    expect(c.detail).toContain('refused the connection')
  })

  // A UDP-only profile produced no probe. Rendering that as a pass would be a
  // tick over a question nobody asked.
  it('skips a UDP-only profile rather than passing it', () => {
    const c = serverReachCheck([], 3, 3)
    expect(c.status).toBe('skipped')
    expect(c.detail).toContain('UDP')
  })

  it('skips a profile with no remote at all', () => {
    expect(serverReachCheck([], 0, 0).status).toBe('skipped')
  })

  it('says how many UDP remotes went untried alongside a pass', () => {
    expect(serverReachCheck([ok], 2, 3).detail).toContain('2 UDP remote(s) were not tried')
  })
})

describe('IPv6 outside the tunnel', () => {
  const base = {
    mode: 'system' as const,
    claimsIpv6: false as boolean | null,
    hostHasIpv6Default: false as boolean | null
  }

  // Userspace installs no routes: an application reaches the tunnel by
  // connecting to a listener on purpose, so there is nothing to bypass.
  it('does not ask the question of a userspace profile', () => {
    const c = ipv6LeakCheck({ ...base, mode: 'userspace', hostHasIpv6Default: true })
    expect(c.status).toBe('skipped')
    expect(c.detail).toContain('captures no traffic')
  })

  it('passes a profile that carries ::/0', () => {
    expect(ipv6LeakCheck({ ...base, claimsIpv6: true, hostHasIpv6Default: true }).status).toBe('ok')
  })

  it('passes a machine with no IPv6 default route', () => {
    expect(ipv6LeakCheck(base).status).toBe('ok')
  })

  it('fails, and names where the traffic is going instead', () => {
    const c = ipv6LeakCheck({ ...base, hostHasIpv6Default: true, where: 'via fe80::1 on en0' })
    expect(c.status).toBe('failed')
    expect(c.detail).toContain('via fe80::1 on en0')
    expect(c.detail).toContain('bypass the tunnel')
  })

  // OpenVPN's routes are pushed by the server and are not in the stored
  // profile. Guessing `false` would warn about a leak on every working IPv6
  // OpenVPN profile; guessing `true` would hide a real one.
  it('says an engine whose routes are pushed cannot be read here', () => {
    const c = ipv6LeakCheck({ ...base, claimsIpv6: null, hostHasIpv6Default: true })
    expect(c.status).toBe('skipped')
    expect(c.detail).toContain('from the server at connect time')
  })

  // THE case this check exists to get right. A routing table nobody could read
  // is not a routing table with no IPv6 in it.
  it('says unknown rather than fine when the routing table could not be read', () => {
    const c = ipv6LeakCheck({ ...base, hostHasIpv6Default: null })
    expect(c.status).toBe('skipped')
    expect(c.detail).toContain('unknown rather than fine')
  })
})

describe('what the OpenVPN probe may be pointed at', () => {
  const src = readFileSync(
    new URL('../src/main/services/vpn/drivers/openvpn.ts', import.meta.url),
    'utf8'
  )

  // Accepting a typed host here would make this a port scanner wearing a
  // diagnose label. The WireGuard probe takes a target because it goes through
  // the tunnel; this one leaves the machine.
  it('takes no target, only the profile’s own remotes', () => {
    expect(src).toContain('async diagnose(profile: VpnProfile & { spec: OpenVpnSpec }): Promise<VpnDiagnoseResult>')
    expect(src).toContain('profile.spec.remotes')
    expect(src).toContain('port scanner')
  })

  // One reachable remote answers the question; the rest would be connections
  // opened to somebody's servers for no further information.
  it('stops at the first remote that answers', () => {
    expect(src).toContain('if (one.reached) break')
  })
})
