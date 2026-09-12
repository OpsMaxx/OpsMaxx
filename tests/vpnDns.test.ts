import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const h = vi.hoisted(() => ({
  replies: new Map<string, { code?: number; stdout?: string; stderr?: string }>(),
  reads: [] as { cmd: string; args: string[] }[]
}))

vi.mock('node:child_process', () => ({
  execFile: (
    cmd: string,
    args: string[],
    _opts: unknown,
    cb: (e: unknown, stdout: string, stderr: string) => void
  ) => {
    h.reads.push({ cmd, args })
    const reply = h.replies.get(`${cmd} ${args.join(' ')}`) ?? {
      code: 1,
      stderr: `no fixture for ${cmd} ${args.join(' ')}`
    }
    const code = reply.code ?? 0
    setImmediate(() =>
      code === 0
        ? cb(null, reply.stdout ?? '', reply.stderr ?? '')
        : cb(Object.assign(new Error(`exit ${code}`), { code }), reply.stdout ?? '', reply.stderr ?? '')
    )
    return undefined
  },
  spawn: () => {
    throw new Error('spawn is not used by the DNS managers')
  }
}))

import { VpnError } from '../src/main/services/vpn/errors'
import type { NetApplyContext, PrivilegedResult } from '../src/main/services/vpn/netstate'
import {
  assertDnsSpec,
  dnsManagerFor,
  isDnsServer,
  runTag,
  verificationFor
} from '../src/main/services/vpn/dns/index'
import type { DnsSpec, DnsVerification } from '../src/main/services/vpn/dns/index'
import {
  buildApplyScript,
  buildRevertScript,
  parseScutilDns,
  parseServiceOrder,
  DarwinDnsManager
} from '../src/main/services/vpn/dns/darwin'
import {
  domainArgs,
  parseResolvConf,
  parseResolvectlStatus,
  renderResolvConf,
  LinuxDnsManager
} from '../src/main/services/vpn/dns/linux'
import {
  buildAddScript,
  buildQueryScript,
  buildRemoveScript,
  parseNrptJson,
  psQuote,
  Win32DnsManager
} from '../src/main/services/vpn/dns/win32'

function reply(key: string, stdout: string, code = 0): void {
  h.replies.set(key, { code, stdout })
}

interface Recorder {
  ctx: NetApplyContext
  calls: { cmd: string; args: string[]; stdin?: string }[]
  result: PrivilegedResult
}

function recorder(over: Partial<NetApplyContext> = {}): Recorder {
  const rec: Recorder = {
    calls: [],
    result: { code: 0, stdout: '', stderr: '' },
    ctx: {
      runId: 'run-1',
      runDir: tmpdir(),
      supportsStdin: true,
      runPrivileged: async (cmd, args, opts) => {
        rec.calls.push({ cmd, args, stdin: opts?.stdin })
        return rec.result
      },
      ...over
    }
  }
  return rec
}

const full: DnsSpec = { servers: ['10.8.0.1', '10.8.0.2'], searchDomains: ['corp.example'], interfaceName: 'utun4' }
const split: DnsSpec = {
  servers: ['10.8.0.1'],
  searchDomains: [],
  interfaceName: 'utun4',
  splitDomains: ['corp.example']
}

beforeEach(() => {
  h.replies.clear()
  h.reads.length = 0
})

// -------------------------------------------------------------------- shared

describe('DNS validation', () => {
  it('accepts real addresses and rejects anything that could become a command', () => {
    expect(isDnsServer('10.8.0.1')).toBe(true)
    expect(isDnsServer('fd00::1')).toBe(true)
    expect(isDnsServer('10.8.0.999')).toBe(false)
    expect(isDnsServer("10.8.0.1'; Remove-Item C:\\ -Recurse")).toBe(false)
    expect(() =>
      assertDnsSpec({ servers: ['$(rm -rf /)'], searchDomains: [], interfaceName: 'utun4' })
    ).toThrow(VpnError)
    expect(() =>
      assertDnsSpec({ servers: ['10.8.0.1'], searchDomains: ['a b'], interfaceName: 'utun4' })
    ).toThrow(VpnError)
    expect(() => assertDnsSpec(full)).not.toThrow()
  })

  it('tags every change with the run id so a sweep can be exact (E10)', () => {
    expect(runTag('run-1')).toBe('OpsMaxx-run-1')
    expect(runTag('../evil')).toBe('OpsMaxx-.._evil')
  })

  it('refuses a platform it has no implementation for', () => {
    expect(() => dnsManagerFor('freebsd')).toThrow(VpnError)
  })

  it('compares IPv6 servers by address and not by spelling', () => {
    // Every pair here is one server written two ways. A textual compare calls
    // the requested one missing, which is `failed`, which rolls back a tunnel
    // whose resolver is doing exactly what was asked of it.
    const same: [string, string][] = [
      ['2001:0db8:0000:0000:0000:0000:0000:0001', '2001:db8::1'],
      ['fe80::1', 'fe80::1%5'],
      ['FD00:0:0:0:0:0:0:1', 'fd00::1']
    ]
    for (const [wanted, reported] of same) {
      const spec: DnsSpec = { servers: [wanted], searchDomains: [], interfaceName: 'wg0' }
      expect(verificationFor(spec, [reported])).toMatchObject({ status: 'ok' })
      // And the other way round: the profile may hold the compressed form while
      // the resolver prints the long one.
      expect(
        verificationFor({ ...spec, servers: [reported] }, [wanted])
      ).toMatchObject({ status: 'ok' })
    }
  })

  it('leaves an IPv4 address and a non-address alone, and never throws on junk', () => {
    const v4: DnsSpec = { servers: ['10.8.0.1'], searchDomains: [], interfaceName: 'wg0' }
    expect(verificationFor(v4, ['10.8.0.2']).status).toBe('failed')
    expect(verificationFor(v4, ['10.8.0.1']).status).toBe('ok')
    // A reading that is not an address at all is still a reading; comparing it
    // must report a finding rather than throw out of verify() and reach the
    // user as an unexplained internal error.
    const junk: DnsSpec = { servers: ['not:an:address'], searchDomains: [], interfaceName: 'wg0' }
    expect(() => verificationFor(junk, ['10.8.0.1'])).not.toThrow()
    expect(verificationFor(junk, ['not:an:address'])).toMatchObject({ status: 'ok' })
    expect(verificationFor(junk, ['10.8.0.1']).status).toBe('failed')
  })

  it('will not let a `skipped` verification exist without a reason', () => {
    // @ts-expect-error — `reason` is required on the `skipped` variant. A
    // read-back we could not take, kept and then never mentioned, is the silent
    // success verify() was added to kill, one level up in applyNetState.
    const unsayable: DnsVerification = { status: 'skipped', actual: [] }
    expect(unsayable.status).toBe('skipped')
  })
})

// -------------------------------------------------------------------- darwin

const SCUTIL_DNS = `DNS configuration

resolver #1
  search domain[0] : lan
  nameserver[0] : 192.168.1.1
  nameserver[1] : 192.168.1.2
  if_index : 12 (en0)
  flags    : Request A records, Request AAAA records
  reach    : 0x00020002 (Reachable,Directly Reachable Address)

resolver #2
  domain   : corp.example
  nameserver[0] : 10.8.0.1
  if_index : 18 (utun4)
  flags    : Supplemental, Request A records
  reach    : 0x00000002 (Reachable)
  order    : 100
`

const SERVICE_ORDER = `An asterisk (*) denotes that a network service is disabled.
(1) Wi-Fi
(Hardware Port: Wi-Fi, Device: en0)

(2) Thunderbolt Ethernet
(Hardware Port: Thunderbolt Ethernet, Device: en4)
`

describe('darwin DNS', () => {
  const mgr = (): DarwinDnsManager => new DarwinDnsManager()

  it('parses scutil --dns into resolvers', () => {
    const resolvers = parseScutilDns(SCUTIL_DNS)
    expect(resolvers).toHaveLength(2)
    expect(resolvers[0]).toMatchObject({
      nameservers: ['192.168.1.1', '192.168.1.2'],
      searchDomains: ['lan'],
      interfaceIndex: 12,
      interfaceName: 'en0'
    })
    expect(resolvers[1]).toMatchObject({ domain: 'corp.example', nameservers: ['10.8.0.1'] })
  })

  it('pairs a network service with its BSD device', () => {
    expect(parseServiceOrder(SERVICE_ORDER)).toEqual({ en0: 'Wi-Fi', en4: 'Thunderbolt Ethernet' })
  })

  it('snapshots the unscoped resolver, which is the one a plain lookup uses', async () => {
    reply('scutil --dns', SCUTIL_DNS)
    reply('networksetup -listnetworkserviceorder', SERVICE_ORDER)
    const snap = await mgr().snapshot()
    expect(snap.platform).toBe('darwin')
    expect(snap.previous).toEqual(['192.168.1.1', '192.168.1.2'])
  })

  it('builds the exact scutil script for a full-tunnel resolver', () => {
    expect(buildApplyScript(full, 'OpsMaxx-run-1')).toBe(
      [
        'd.init',
        'd.add ServerAddresses * 10.8.0.1 10.8.0.2',
        'd.add SearchDomains * corp.example',
        'd.add InterfaceName utun4',
        'set State:/Network/Service/OpsMaxx-run-1/DNS',
        'd.init',
        'd.add InterfaceName utun4',
        'set State:/Network/Service/OpsMaxx-run-1/IPv4',
        'quit',
        ''
      ].join('\n')
    )
  })

  it('uses SupplementalMatchDomains for split DNS (E12)', () => {
    const script = buildApplyScript(split, 'OpsMaxx-run-1')
    expect(script).toContain('d.add SupplementalMatchDomains * corp.example')
    expect(script).toContain('d.add SupplementalMatchOrders * 100')
    expect(script).not.toContain('SearchDomains')
  })

  it('removes exactly the keys it created and nothing else', () => {
    expect(buildRevertScript('OpsMaxx-run-1')).toBe(
      [
        'remove State:/Network/Service/OpsMaxx-run-1/DNS',
        'remove State:/Network/Service/OpsMaxx-run-1/IPv4',
        'quit',
        ''
      ].join('\n')
    )
  })

  it('sends the script on stdin, not on a command line', async () => {
    const rec = recorder()
    await mgr().apply(full, rec.ctx)
    expect(rec.calls).toHaveLength(1)
    expect(rec.calls[0].cmd).toBe('scutil')
    expect(rec.calls[0].args).toEqual([])
    expect(rec.calls[0].stdin).toBe(buildApplyScript(full, 'OpsMaxx-run-1'))
  })

  it('refuses rather than pretending when the channel cannot carry stdin', async () => {
    const rec = recorder({ supportsStdin: false })
    await expect(mgr().apply(full, rec.ctx)).rejects.toMatchObject({ code: 'unsupported' })
    expect(rec.calls).toEqual([])
  })

  it('names scutil and its exit code when no output came back', async () => {
    const rec = recorder()
    // A privileged channel cannot always see what the command printed, and
    // reporting that as an empty string left this sentence ending at its colon.
    rec.result = { code: 1 }
    await expect(mgr().apply(full, rec.ctx)).rejects.toMatchObject({
      code: 'internal',
      detail: 'Could not set DNS for utun4: scutil exited 1'
    })
  })

  it('reverts idempotently even when the key has already gone', async () => {
    const rec = recorder()
    rec.result = { code: 1, stdout: '', stderr: 'No such key' }
    const snapshot = {
      platform: 'darwin' as const,
      capturedAt: 0,
      runId: 'run-1',
      interfaceName: 'utun4',
      previous: []
    }
    await expect(mgr().revert(snapshot, rec.ctx)).resolves.toBeUndefined()
    await expect(mgr().revert(snapshot, rec.ctx)).resolves.toBeUndefined()
    expect(rec.calls.map((c) => c.stdin)).toEqual([
      buildRevertScript('OpsMaxx-run-1'),
      buildRevertScript('OpsMaxx-run-1')
    ])
  })

  it('verify() confirms a change that took effect', async () => {
    reply('scutil --dns', SCUTIL_DNS)
    expect(await mgr().verify(split)).toMatchObject({ status: 'ok', actual: ['10.8.0.1'] })
  })

  it('verify() catches a change that silently did not apply', async () => {
    // The command exited 0 but mDNSResponder never picked the resolver up, so
    // every query is still going to the old server.
    reply('scutil --dns', SCUTIL_DNS)
    const result = await mgr().verify({ ...full, servers: ['10.9.9.9'] })
    expect(result.status).toBe('failed')
    expect(result.reason).toContain('did not take effect')
  })

  it('verify() reports a split rule that is not scoped to anything', async () => {
    reply('scutil --dns', SCUTIL_DNS)
    const result = await mgr().verify({ ...split, splitDomains: ['other.example'] })
    expect(result.status).toBe('failed')
    expect(result.reason).toContain('other.example')
  })

  it('verify() says it could not look rather than reporting a failure', async () => {
    // No fixture is registered, so scutil "exits non-zero" — and an unreadable
    // resolver is not the same answer as a resolver using the old servers. Only
    // one of the two is a reason to tear a working tunnel down.
    const result = await mgr().verify(full)
    expect(result.status).toBe('skipped')
    expect(result.reason).toContain('could not be read')
    expect(result.actual).toEqual([])
  })

  it('verify() treats output it cannot parse as unread, not as unapplied', async () => {
    reply('scutil --dns', 'DNS configuration\n\n(nothing this parser recognises)\n')
    expect(await mgr().verify(full)).toMatchObject({ status: 'skipped', actual: [] })
  })
})

// --------------------------------------------------------------------- linux

const RESOLVECTL_LINK = `Link 5 (wg0)
    Current Scopes: DNS
         Protocols: +DefaultRoute -LLMNR -mDNS -DNSOverTLS DNSSEC=no/unsupported
Current DNS Server: 10.8.0.1
       DNS Servers: 10.8.0.1 10.8.0.2
        DNS Domain: ~corp.example
`

const RESOLVECTL_GLOBAL = `Global
       Protocols: -LLMNR -mDNS -DNSOverTLS DNSSEC=no/unsupported
resolv.conf mode: stub

Link 2 (eth0)
    Current Scopes: DNS
Current DNS Server: 192.168.1.1
       DNS Servers: 192.168.1.1
                    192.168.1.2
        DNS Domain: lan
`

// A server list long enough that resolvectl wraps it, and every hextet on the
// wrapped lines spelled with a-f letters only — which is what `dead::beef`,
// `cafe::1` and friends really look like. Each of those matches the labelled-
// line pattern (key `dead`, value `:beef`), so a parser that tests a
// continuation as a key drops the server AND closes the list, losing everything
// after it too.
const RESOLVECTL_WRAPPED = `Link 7 (wg0)
    Current Scopes: DNS
         Protocols: +DefaultRoute -LLMNR -mDNS -DNSOverTLS DNSSEC=no/unsupported
Current DNS Server: dead::beef
       DNS Servers: dead::beef beef::cafe
                    cafe::face abcd::1
                    10.8.0.1
        DNS Domain: ~corp.example
`

describe('linux DNS', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'opsmaxx-dns-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const at = (name = 'resolv.conf'): string => join(dir, name)

  it('parses resolvectl status, wrapped server lists included', () => {
    expect(parseResolvectlStatus(RESOLVECTL_LINK)).toEqual({
      servers: ['10.8.0.1', '10.8.0.2'],
      domains: ['~corp.example']
    })
    expect(parseResolvectlStatus(RESOLVECTL_GLOBAL).servers).toEqual([
      '192.168.1.1',
      '192.168.1.2'
    ])
  })

  it('keeps a wrapped IPv6 list whose hextets are all letters', () => {
    expect(parseResolvectlStatus(RESOLVECTL_WRAPPED)).toEqual({
      servers: ['dead::beef', 'beef::cafe', 'cafe::face', 'abcd::1', '10.8.0.1'],
      domains: ['~corp.example']
    })
  })

  it('verify() does not roll back over a wrapped server list it mis-parsed', async () => {
    writeFileSync(at(), 'nameserver 127.0.0.53\n')
    reply('resolvectl status', RESOLVECTL_GLOBAL)
    reply('resolvectl status wg0', RESOLVECTL_WRAPPED)
    const result = await new LinuxDnsManager({ resolvConfPath: at() }).verify({
      // The last server on the wrapped block, which is the one a parser that
      // stops at `dead::beef` never sees. Reported missing it would throw
      // dns-not-applied and tear down a tunnel whose resolver is correct.
      servers: ['dead::beef', 'abcd::1', '10.8.0.1'],
      searchDomains: [],
      interfaceName: 'wg0'
    })
    expect(result).toMatchObject({ status: 'ok' })
  })

  it('parses a resolv.conf, comments and all', () => {
    expect(
      parseResolvConf('# generated\nsearch lan corp.example\nnameserver 192.168.1.1 # router\nnameserver 1.1.1.1\n')
    ).toEqual({ servers: ['192.168.1.1', '1.1.1.1'], searchDomains: ['lan', 'corp.example'] })
  })

  it('detects systemd-resolved by the symlink into /run/systemd/ (E11)', async () => {
    writeFileSync(at('stub'), 'nameserver 127.0.0.53\n')
    symlinkSync('/run/systemd/resolve/stub-resolv.conf', at())
    expect(await new LinuxDnsManager({ resolvConfPath: at() }).detectBackend()).toBe('resolv.conf')
    reply('resolvectl status', RESOLVECTL_GLOBAL)
    expect(await new LinuxDnsManager({ resolvConfPath: at() }).detectBackend()).toBe('resolvectl')
  })

  it('detects systemd-resolved behind a static stub resolv.conf too', async () => {
    writeFileSync(at(), 'nameserver 127.0.0.53\noptions edns0\n')
    reply('resolvectl status', RESOLVECTL_GLOBAL)
    expect(await new LinuxDnsManager({ resolvConfPath: at() }).detectBackend()).toBe('resolvectl')
  })

  it('falls back to the file when resolvectl does not answer', async () => {
    writeFileSync(at(), 'nameserver 192.168.1.1\n')
    expect(await new LinuxDnsManager({ resolvConfPath: at() }).detectBackend()).toBe('resolv.conf')
  })

  it('turns a split-DNS spec into routing-only domains and a full one into ~. (E12)', () => {
    expect(domainArgs(split)).toEqual(['~corp.example'])
    expect(domainArgs(full)).toEqual(['corp.example', '~.'])
    expect(domainArgs({ ...split, splitDomains: ['.corp.example'] })).toEqual(['~corp.example'])
  })

  it('produces the exact resolvectl argv', async () => {
    writeFileSync(at(), 'nameserver 127.0.0.53\n')
    reply('resolvectl status', RESOLVECTL_GLOBAL)
    const rec = recorder()
    await new LinuxDnsManager({ resolvConfPath: at() }).apply({ ...full, interfaceName: 'wg0' }, rec.ctx)
    expect(rec.calls.map((c) => [c.cmd, ...c.args])).toEqual([
      ['resolvectl', 'dns', 'wg0', '10.8.0.1', '10.8.0.2'],
      ['resolvectl', 'domain', 'wg0', 'corp.example', '~.']
    ])
  })

  it('names the command and its exit code when no output came back', async () => {
    writeFileSync(at(), 'nameserver 127.0.0.53\n')
    reply('resolvectl status', RESOLVECTL_GLOBAL)
    const rec = recorder()
    rec.result = { code: 1 }
    await expect(
      new LinuxDnsManager({ resolvConfPath: at() }).apply({ ...full, interfaceName: 'wg0' }, rec.ctx)
    ).rejects.toMatchObject({
      code: 'internal',
      detail: 'Could not set DNS for wg0: resolvectl exited 1'
    })
  })

  it('reverts a resolvectl link with one idempotent command', async () => {
    const rec = recorder()
    const snapshot = {
      platform: 'linux' as const,
      capturedAt: 0,
      runId: 'run-1',
      interfaceName: 'wg0',
      previous: [],
      backend: 'resolvectl' as const
    }
    rec.result = { code: 1, stdout: '', stderr: "Failed to revert link: Link 'wg0' not known" }
    await expect(new LinuxDnsManager().revert(snapshot, rec.ctx)).resolves.toBeUndefined()
    await expect(new LinuxDnsManager().revert(snapshot, rec.ctx)).resolves.toBeUndefined()
    expect(rec.calls.map((c) => [c.cmd, ...c.args])).toEqual([
      ['resolvectl', 'revert', 'wg0'],
      ['resolvectl', 'revert', 'wg0']
    ])
  })

  it('stages the new resolv.conf in the run directory and installs it by path', async () => {
    writeFileSync(at(), 'nameserver 192.168.1.1\n')
    const rec = recorder({ runDir: dir })
    await new LinuxDnsManager({ resolvConfPath: at() }).apply({ ...full, interfaceName: 'wg0' }, rec.ctx)
    const staged = join(dir, 'resolv.conf')
    expect(rec.calls.map((c) => [c.cmd, ...c.args])).toEqual([
      ['install', '-m', '0644', staged, at()]
    ])
    // No shell, no stdin: only paths cross the privileged boundary.
    expect(rec.calls[0].stdin).toBeUndefined()
    const body = readFileSync(staged, 'utf8')
    expect(body).toContain('search corp.example')
    expect(body).toContain('nameserver 10.8.0.1')
    expect(body).toContain('nameserver 10.8.0.2')
  })

  it('renders a resolv.conf that says where the original went', () => {
    expect(renderResolvConf(full)).toContain('netstate.json')
  })

  it('puts a symlinked resolv.conf back as a symlink', async () => {
    const rec = recorder({ runDir: dir })
    await new LinuxDnsManager({ resolvConfPath: at() }).revert(
      {
        platform: 'linux',
        capturedAt: 0,
        runId: 'run-1',
        interfaceName: 'wg0',
        previous: [],
        backend: 'resolv.conf',
        resolvConf: { content: '', symlinkTarget: '/run/NetworkManager/resolv.conf' }
      },
      rec.ctx
    )
    expect(rec.calls.map((c) => [c.cmd, ...c.args])).toEqual([
      ['ln', '-sfn', '/run/NetworkManager/resolv.conf', at()]
    ])
  })

  it('puts a plain resolv.conf back byte for byte', async () => {
    const original = '# original\nnameserver 192.168.1.1\n'
    const rec = recorder({ runDir: dir })
    await new LinuxDnsManager({ resolvConfPath: at() }).revert(
      {
        platform: 'linux',
        capturedAt: 0,
        runId: 'run-1',
        interfaceName: 'wg0',
        previous: ['192.168.1.1'],
        backend: 'resolv.conf',
        resolvConf: { content: original, symlinkTarget: null }
      },
      rec.ctx
    )
    const staged = join(dir, 'resolv.conf.orig')
    expect(rec.calls.map((c) => [c.cmd, ...c.args])).toEqual([['install', '-m', '0644', staged, at()]])
    expect(readFileSync(staged, 'utf8')).toBe(original)
  })

  it('verify() catches a resolvectl change that did not apply', async () => {
    writeFileSync(at(), 'nameserver 127.0.0.53\n')
    reply('resolvectl status', RESOLVECTL_GLOBAL)
    reply('resolvectl status wg0', RESOLVECTL_LINK)
    const mgr = new LinuxDnsManager({ resolvConfPath: at() })
    expect(await mgr.verify({ ...full, interfaceName: 'wg0' })).toMatchObject({ status: 'ok' })
    const bad = await mgr.verify({ ...full, servers: ['10.9.9.9'], interfaceName: 'wg0' })
    expect(bad.status).toBe('failed')
    expect(bad.reason).toContain('did not take effect')
  })

  it('verify() separates resolvectl not answering from a link with no servers', async () => {
    writeFileSync(at(), 'nameserver 127.0.0.53\n')
    reply('resolvectl status', RESOLVECTL_GLOBAL)
    const mgr = new LinuxDnsManager({ resolvConfPath: at() })

    // The per-link query itself failed. That is a read we did not get, not a
    // resolver we read and found wanting — and `applyNetState` must not roll a
    // working tunnel back over it.
    reply('resolvectl status wg0', '', 1)
    const unread = await mgr.verify({ ...full, interfaceName: 'wg0' })
    expect(unread.status).toBe('skipped')
    expect(unread.reason).toContain('could not be asked')

    // Same command, exit 0, and a link that simply has no DNS on it. That one
    // IS a finding, and it is the one worth rolling back.
    reply('resolvectl status wg0', 'Link 5 (wg0)\n    Current Scopes: none\n')
    const unapplied = await mgr.verify({ ...full, interfaceName: 'wg0' })
    expect(unapplied.status).toBe('failed')
    expect(unapplied.reason).toContain('did not take effect')
  })

  it('verify() catches a split rule whose domain never got scoped', async () => {
    writeFileSync(at(), 'nameserver 127.0.0.53\n')
    reply('resolvectl status', RESOLVECTL_GLOBAL)
    reply('resolvectl status wg0', RESOLVECTL_LINK)
    const result = await new LinuxDnsManager({ resolvConfPath: at() }).verify({
      servers: ['10.8.0.1'],
      searchDomains: [],
      interfaceName: 'wg0',
      splitDomains: ['other.example']
    })
    expect(result.status).toBe('failed')
    expect(result.reason).toContain('~other.example')
  })

  it('verify() reads the file back on the resolv.conf branch', async () => {
    writeFileSync(at(), 'nameserver 10.8.0.1\nnameserver 10.8.0.2\n')
    const result = await new LinuxDnsManager({ resolvConfPath: at() }).verify({
      ...full,
      interfaceName: 'wg0'
    })
    expect(result).toMatchObject({ status: 'ok', actual: ['10.8.0.1', '10.8.0.2'] })
  })

  it('verify() separates an empty resolv.conf from one it could not open', async () => {
    // On this branch the file IS the configuration, so the two look identical in
    // the content alone — both are ''. A file that exists and lists nothing is a
    // resolver really using nothing; a file that is not there is no reading.
    writeFileSync(at(), '# nothing but a comment\n')
    const empty = await new LinuxDnsManager({ resolvConfPath: at() }).verify({
      ...full,
      interfaceName: 'wg0'
    })
    expect(empty.status).toBe('failed')

    const missing = await new LinuxDnsManager({
      resolvConfPath: join(dir, 'nowhere', 'resolv.conf')
    }).verify({ ...full, interfaceName: 'wg0' })
    expect(missing.status).toBe('skipped')
    expect(missing.reason).toContain('could not be read')
  })
})

// --------------------------------------------------------------------- win32

describe('win32 DNS', () => {
  const mgr = (): Win32DnsManager => new Win32DnsManager()
  const PS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command']

  it('quotes a PowerShell string by doubling the only metacharacter it has', () => {
    expect(psQuote("it's")).toBe("'it''s'")
  })

  it('tags every rule with the run id (E10)', () => {
    const script = buildAddScript(split, 'OpsMaxx-run-1')
    expect(script).toBe(
      "$ErrorActionPreference='Stop'; Add-DnsClientNrptRule -Namespace '.corp.example' -NameServers @('10.8.0.1') -Comment 'OpsMaxx-run-1' -DisplayName 'OpsMaxx-run-1'"
    )
  })

  it('uses the whole tree for a full-tunnel profile and one rule per split domain', () => {
    expect(buildAddScript(full, 'OpsMaxx-run-1')).toContain("-Namespace '.'")
    const many = buildAddScript(
      { ...split, splitDomains: ['corp.example', 'internal.example'] },
      'OpsMaxx-run-1'
    )
    expect(many).toContain("-Namespace '.corp.example'")
    expect(many).toContain("-Namespace '.internal.example'")
  })

  it('sweeps by exact tag so a run id cannot match another by prefix', () => {
    const script = buildRemoveScript('OpsMaxx-run-1')
    expect(script).toContain("$_.Comment -eq 'OpsMaxx-run-1'")
    expect(script).not.toContain('-like')
    expect(script).toContain('Remove-DnsClientNrptRule -Name $_.Name -Force')
  })

  it('produces the exact argv for apply', async () => {
    const rec = recorder()
    await mgr().apply(split, rec.ctx)
    expect(rec.calls).toEqual([
      { cmd: 'powershell.exe', args: [...PS, buildAddScript(split, 'OpsMaxx-run-1')], stdin: undefined }
    ])
  })

  it('names powershell and its exit code when no output came back', async () => {
    const rec = recorder()
    rec.result = { code: 1 }
    await expect(mgr().apply(split, rec.ctx)).rejects.toMatchObject({
      code: 'internal',
      detail: 'Could not add the DNS rule for utun4: powershell exited 1'
    })
  })

  it('produces the exact argv for revert and repeats harmlessly', async () => {
    const rec = recorder()
    const snapshot = {
      platform: 'win32' as const,
      capturedAt: 0,
      runId: 'run-1',
      interfaceName: 'OpsMaxx Tunnel',
      previous: []
    }
    await mgr().revert(snapshot, rec.ctx)
    await mgr().revert(snapshot, rec.ctx)
    expect(rec.calls.map((c) => c.args)).toEqual([
      [...PS, buildRemoveScript('OpsMaxx-run-1')],
      [...PS, buildRemoveScript('OpsMaxx-run-1')]
    ])
  })

  it('parses every shape ConvertTo-Json produces', () => {
    expect(parseNrptJson('')).toEqual([])
    expect(parseNrptJson('{"Namespace":".corp.example","NameServers":["10.8.0.1"]}')).toEqual([
      { namespace: '.corp.example', nameServers: ['10.8.0.1'] }
    ])
    expect(
      parseNrptJson('[{"Namespace":[".a"],"NameServers":"10.8.0.1"},{"Namespace":".b","NameServers":null}]')
    ).toEqual([
      { namespace: '.a', nameServers: ['10.8.0.1'] },
      { namespace: '.b', nameServers: [] }
    ])
  })

  it('verify() confirms our own tagged rules rather than the machine resolvers', async () => {
    const rec = recorder()
    const m = mgr()
    await m.apply(split, rec.ctx)
    reply(
      `powershell.exe ${[...PS, buildQueryScript('OpsMaxx-run-1')].join(' ')}`,
      '{"Namespace":".corp.example","NameServers":["10.8.0.1"]}'
    )
    expect(await m.verify(split)).toMatchObject({ status: 'ok', actual: ['10.8.0.1'] })
  })

  it('verify() catches a rule that was never created', async () => {
    const rec = recorder()
    const m = mgr()
    await m.apply(split, rec.ctx)
    // Exit 0 and nothing on either stream: a pipeline that matched no rule
    // prints nothing at all. This is the real negative, and it is the reason the
    // query script has to fail loudly — see the ErrorActionPreference test
    // above. Under SilentlyContinue a denied read arrives here identically.
    reply(`powershell.exe ${[...PS, buildQueryScript('OpsMaxx-run-1')].join(' ')}`, '')
    const result = await m.verify(split)
    expect(result.status).toBe('failed')
    expect(result.reason).toContain('OpsMaxx-run-1')
  })

  it('verify() reports an NRPT table it could not enumerate as unread', async () => {
    const rec = recorder()
    const m = mgr()
    await m.apply(split, rec.ctx)
    // Group policy can deny this read and a blocked execution policy can stop
    // PowerShell from running at all. Neither says the rule we just added is
    // absent — and `rules.length === 0` would have claimed exactly that.
    h.replies.set(`powershell.exe ${[...PS, buildQueryScript('OpsMaxx-run-1')].join(' ')}`, {
      code: 1,
      stderr: 'Access is denied.'
    })
    const result = await m.verify(split)
    expect(result.status).toBe('skipped')
    expect(result.reason).toContain('Access is denied.')
  })

  it('reads the table back with Stop so a denied read cannot look like an empty one', () => {
    // The one line that decides whether an unreadable NRPT table is `skipped` or
    // `failed`. Under SilentlyContinue a Get-DnsClientNrptRule that fails
    // outright — group policy, a broken CIM repository, no DnsClient module —
    // has its error record swallowed and powershell exits 0 with empty output,
    // which is exactly what a table holding no matching rule looks like. The
    // verification then says `failed` and applyNetState rolls back a tunnel
    // whose DNS is fine.
    expect(buildQueryScript('OpsMaxx-run-1')).toContain("$ErrorActionPreference='Stop'")
    expect(buildQueryScript('OpsMaxx-run-1')).not.toContain('SilentlyContinue')
    // The remove script keeps SilentlyContinue on purpose: removing rules that
    // are already gone is the expected outcome of a second revert.
    expect(buildRemoveScript('OpsMaxx-run-1')).toContain("$ErrorActionPreference='SilentlyContinue'")
  })

  it('verify() treats a failed read as unread, not as a missing rule', async () => {
    const rec = recorder()
    const m = mgr()
    await m.apply(split, rec.ctx)
    // PowerShell writes error records to stderr, not to stdout, and with
    // ErrorActionPreference=Stop a failing cmdlet is terminating — so this is
    // what the denied read actually looks like from here. The rule we added
    // exited 0 and is probably in force; all that failed is our attempt to look.
    h.replies.set(`powershell.exe ${[...PS, buildQueryScript('OpsMaxx-run-1')].join(' ')}`, {
      code: 1,
      stdout: '',
      stderr: "Get-DnsClientNrptRule : The term 'Get-DnsClientNrptRule' is not recognized."
    })
    const result = await m.verify(split)
    expect(result).toMatchObject({ status: 'skipped', actual: [] })
    expect(result.reason).toContain('could not be read')
  })

  it('verify() treats unparseable output as unread, not as a missing rule', async () => {
    const rec = recorder()
    const m = mgr()
    await m.apply(split, rec.ctx)
    // An empty pipeline through ConvertTo-Json prints nothing, so output that is
    // there on stdout but is not JSON is the parser failing rather than the table
    // being empty. `parseNrptJson` answers `[]` to both.
    reply(
      `powershell.exe ${[...PS, buildQueryScript('OpsMaxx-run-1')].join(' ')}`,
      '<#< CLIXML not JSON >#>'
    )
    expect(await m.verify(split)).toMatchObject({ status: 'skipped', actual: [] })
  })

  it('verify() catches a rule that covers the wrong namespace', async () => {
    const rec = recorder()
    const m = mgr()
    await m.apply(split, rec.ctx)
    reply(
      `powershell.exe ${[...PS, buildQueryScript('OpsMaxx-run-1')].join(' ')}`,
      '{"Namespace":".other.example","NameServers":["10.8.0.1"]}'
    )
    const result = await m.verify(split)
    expect(result.status).toBe('failed')
    expect(result.reason).toContain('.corp.example')
  })
})
