import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { parseOvpn } from '../src/main/services/vpn/parsers/ovpn'
import { parseWgConf } from '../src/main/services/vpn/parsers/wgConf'
import {
  bundleName,
  noteDirs,
  profileDirs,
  readProfile,
  vpnImport
} from '../src/main/services/vpn/import'
import type { OpenVpnSpec, VpnImportResultInternal, WireGuardSpec } from '../src/shared/vpn'

/**
 * The import path as somebody who has actually been handed a `.ovpn` meets it.
 *
 * Every case here is a file that exists in the world in large numbers and that
 * OpsMaxx refused, mis-described or quietly weakened. The sanitizer's own rules
 * are pinned next door in tests/ovpnSanitizer.test.ts — nothing here loosens
 * one; containment (E37) in particular is asserted below to be exactly as tight
 * as it was.
 */

const DIR = fileURLToPath(new URL('./fixtures/ovpn', import.meta.url))
const WG = fileURLToPath(new URL('./fixtures/wgconf', import.meta.url))

const ovpnText = (name: string): string => readFileSync(join(DIR, name), 'utf8')
const wgText = (name: string): string => readFileSync(join(WG, name), 'utf8')

const parse = (name: string): VpnImportResultInternal =>
  parseOvpn(ovpnText(name), DIR, { hostHasIpv6: false })
/** The paste/drag path before it could carry one: no folder at all. */
const parsePasted = (name: string): VpnImportResultInternal =>
  parseOvpn(ovpnText(name), undefined, { hostHasIpv6: false })
const body = (r: VpnImportResultInternal): string => r.secrets?.configBody ?? ''
const reasons = (r: VpnImportResultInternal): string => r.stripped.map((s) => s.reason).join('\n')

describe('an .ovpn that names files beside it, pasted rather than dropped', () => {
  // The commonest shape there is: easy-rsa and the OpenVPN Community bundle
  // both write `ca ca.crt` / `cert client.crt` / `key client.key`.
  it('is refused with what is actually wrong, not with a path escape', () => {
    const r = parsePasted('ok-pathform.ovpn')
    expect(r.ok).toBe(false)
    // The old answer. It said the path "points outside the folder the profile
    // was imported from", which is false — it points inside it — and offered
    // no next step, on a file that imports fine from "Found on this machine".
    expect(r.error).not.toMatch(/points outside/)
    expect(r.stripped.some((s) => s.severity === 'rejected')).toBe(false)
    // What is actually wrong, and what to do about it.
    expect(r.error).toMatch(/pasted text does not carry it/)
    expect(r.error).toMatch(/Choose file|Drop the .ovpn/)
  })

  it('imports once the folder it came from is known', () => {
    const r = parse('ok-pathform.ovpn')
    expect(r.ok).toBe(true)
    expect(body(r)).toContain('<ca>')
  })

  it('still refuses to read a single byte from outside that folder', () => {
    // E37 is not what was wrong and is not what was relaxed. Both of these are
    // rejections, with the path-escape reason, exactly as before.
    for (const file of ['hostile-path-absolute.ovpn', 'hostile-path-nested-traversal.ovpn']) {
      const r = parse(file)
      expect(r.ok, file).toBe(false)
      expect(r.errorCode, file).toBe('config-rejected')
      expect(reasons(r)).toMatch(/points outside the folder/)
    }
  })
})

describe('<connection> blocks', () => {
  it('do not kill the import, and their server is carried over', () => {
    const r = parse('ok-connection.ovpn')
    expect(r.ok).toBe(true)
    const spec = r.spec as OpenVpnSpec
    expect(spec.remotes?.map((x) => `${x.host}:${x.port}/${x.proto}`)).toEqual([
      'vpn.example.com:1194/udp',
      'backup.example.com:443/tcp',
      'third.example.com:9443/udp'
    ])
    expect(body(r)).toContain('remote backup.example.com 443 tcp')
  })

  it('are not a way to smuggle a script directive past the reject list', () => {
    const r = parse('hostile-connection-up.ovpn')
    expect(r.ok).toBe(false)
    expect(r.errorCode).toBe('config-rejected')
    expect(r.error).toContain('up runs a program')
  })
})

describe('the checks that say who the server has to be', () => {
  // ovpn.ts's own comment calls a silently dropped identity check "the one
  // direction a dropped directive must never go". Three of them were going
  // there through the catch-all.
  it('keeps remote-cert-eku, and does not call it a setting we do not carry', () => {
    const r = parse('ok-identity-checks.ovpn')
    expect(r.ok).toBe(true)
    expect(body(r)).toContain('remote-cert-eku "TLS Web Server Authentication"')
  })

  it('carries ns-cert-type over as the spelling OpenVPN still accepts', () => {
    const r = parse('ok-identity-checks.ovpn')
    // Not re-emitted: OpenVPN removed it in 2.5 and would refuse to start.
    expect(body(r)).not.toContain('ns-cert-type')
    // But the check itself survives.
    expect(body(r)).toContain('remote-cert-tls server')
    expect(reasons(r)).toContain('remote-cert-tls server')
  })

  it('says what a dropped tls-remote costs', () => {
    const r = parse('ok-identity-checks.ovpn')
    const entry = r.stripped.find((s) => s.directive === 'tls-remote')
    expect(entry).toBeDefined()
    expect(entry?.reason).not.toBe('Not a setting OpsMaxx carries over.')
    expect(entry?.reason).toMatch(/accepts any server certificate/)
  })

  it('emits remote-cert-tls once when a file carries both spellings', () => {
    const r = parse('ok-identity-checks.ovpn')
    expect(body(r).match(/remote-cert-tls server/g)).toHaveLength(1)
  })
})

describe('a WireGuard peer with no Endpoint', () => {
  it('does not destroy the import of the peers that have one', () => {
    const r = parseWgConf(wgText('ok-mixed-endpoint.conf'), { hostHasIpv6: false })
    expect(r.ok).toBe(true)
    const spec = r.spec as WireGuardSpec
    // Hub-and-spoke and LAN peers routinely omit it; the dialable peer is what
    // the user came for and it used to be thrown away along with the other.
    expect(spec.peers).toHaveLength(1)
    expect(spec.peers[0].endpoint).toBe('vpn.example.com:51820')
    expect(reasons(r)).toMatch(/has no Endpoint/)
  })

  it('still fails when no peer in the file is dialable', () => {
    const r = parseWgConf(wgText('bad-no-endpoint.conf'), { hostHasIpv6: false })
    expect(r.ok).toBe(false)
    expect(r.errorCode).toBe('config-invalid')
  })
})

describe('a config dropped into the dialog for the wrong kind', () => {
  it('is told which dialog it belongs in', () => {
    const r = vpnImport('openvpn', wgText('ok-minimal.conf'))
    expect(r.ok).toBe(false)
    // The old answer was "This profile carries no certificate authority" — true
    // of the bytes, and an answer to a question nobody asked.
    expect(r.error).not.toMatch(/certificate authority/)
    expect(r.error).toMatch(/looks like a WireGuard configuration/)
    expect(r.error).toMatch(/Import WireGuard/)
  })

  it('does not second-guess a file that was rejected on its own merits', () => {
    // A rejected directive is a real finding about the file the user handed
    // over, and it outranks a guess about which button they should have used.
    const r = vpnImport('openvpn', ovpnText('reject-up.ovpn'), DIR)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('up runs a program')
  })
})

describe('where the scan looks, and what it calls what it finds', () => {
  const real = process.platform
  const asPlatform = (value: string): void => {
    Object.defineProperty(process, 'platform', { value, configurable: true })
  }
  afterEach(() => asPlatform(real))

  const dirsFor = async (platform: string, kind: 'openvpn' | 'wireguard'): Promise<string[]> => {
    asPlatform(platform)
    return (await profileDirs([kind])).map((d) => d.dir)
  }

  it('looks where Tunnelblick actually moves configurations to', async () => {
    // Tunnelblick SECURES a configuration by default, which moves it out of
    // ~/Library/.../Configurations into a root-owned tree under /Library. Only
    // the per-user folder was scanned, so most Tunnelblick users found nothing
    // — and the ones whose copy is root-only now get the "needs administrator
    // rights" entry the scan already produces rather than silence.
    const dirs = await dirsFor('darwin', 'openvpn')
    const root = '/Library/Application Support/Tunnelblick'
    expect(dirs).toContain(join(root, 'Users', userInfo().username))
    expect(dirs).toContain(join(root, 'Shared'))
  })

  it('looks where a profile somebody was emailed actually lands', async () => {
    const dirs = await dirsFor('darwin', 'openvpn')
    expect(dirs.some((d) => d.endsWith('/Downloads'))).toBe(true)
    expect(dirs.some((d) => d.endsWith('/.openvpn'))).toBe(true)
  })

  it('looks in /etc/wireguard on macOS as well as on Linux', async () => {
    // `wg-quick up <name>` resolves <name> there on both. It was in the Linux
    // branch and missing from the darwin one, so a tunnel set up by hand on a
    // Mac was invisible.
    expect(await dirsFor('darwin', 'wireguard')).toContain('/etc/wireguard')
    expect(await dirsFor('linux', 'wireguard')).toContain('/etc/wireguard')
  })

  it('explains the two stores it cannot read instead of finding nothing in them', () => {
    // Both hold real profiles and neither can be opened by anything but the app
    // that wrote it, so a scan that simply found nothing in them reads as
    // OpsMaxx having missed what the user can see in another window. Same shape
    // as the Windows DPAPI entry: a reason, and no Import button.
    asPlatform('darwin')
    const notes = noteDirs(['openvpn', 'wireguard'])
    expect(notes.find((n) => n.dir.includes('OpenVPN Connect'))?.note).toMatch(
      /its own database/
    )
    expect(notes.find((n) => n.dir.includes('com.wireguard.macos'))?.note).toMatch(
      /only it can read them/
    )
    asPlatform('win32')
    expect(noteDirs(['openvpn']).some((n) => n.dir.includes('OpenVPN Connect'))).toBe(true)
    // Nothing is claimed about software this machine does not have: the scan
    // only lists these when the directory is there.
    asPlatform('linux')
    expect(noteDirs(['openvpn', 'wireguard'])).toEqual([])
  })

  it('calls a bundled profile what its own client calls it', async () => {
    // Both clients name the file inside a per-profile folder `config`, so every
    // profile from either one was listed as "config" — no name at all once
    // there are two of them.
    const home = mkdtempSync(join(tmpdir(), 'vpn-bundle-'))
    try {
      const tblk = join(home, 'Work.tblk', 'Contents', 'Resources')
      mkdirSync(tblk, { recursive: true })
      writeFileSync(join(tblk, 'config.ovpn'), ovpnText('ok-minimal.ovpn'))
      expect((await readProfile(join(tblk, 'config.ovpn'), 'openvpn'))?.name).toBe('Work')

      // Viscosity numbers its connection folders and keeps the name the user
      // gave the connection in a comment on the first line. The folder alone
      // would list it as "3".
      const visc = join(home, 'OpenVPN', '3')
      mkdirSync(visc, { recursive: true })
      writeFileSync(
        join(visc, 'config.conf'),
        `#viscosity name Berlin Office\n${ovpnText('ok-minimal.ovpn')}`
      )
      expect((await readProfile(join(visc, 'config.conf'), 'openvpn'))?.name).toBe('Berlin Office')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('names a bundled profile after its bundle, not "config"', () => {
    // Tunnelblick and Viscosity both keep a profile in a directory named after
    // it, with the file inside always called `config`. Every profile from
    // either client was listed as "config", which is no name at all once there
    // are two.
    expect(bundleName('/Users/x/Tunnelblick/Work.tblk/Contents/Resources/config.ovpn')).toBe('Work')
    expect(bundleName('/Users/x/Viscosity/OpenVPN/Office.visc/config.conf')).toBe('Office')
    // A loose file in an ordinary directory keeps its own stem; only a file
    // actually called `config` asks for this.
    expect(bundleName('/etc/openvpn/client/work.ovpn')).toBe('client')
  })
})
