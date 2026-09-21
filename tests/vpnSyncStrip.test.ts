import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A VPN profile crosses devices. The parts that describe one computer must not.
 *
 * `vpns` is a synced collection, so a profile written on a Mac is applied
 * verbatim on a Windows machine. Three fields in it are about the machine that
 * wrote them, and each one broke differently when it travelled:
 *
 *  * `OpenVpnSpec.binaryPath` — the driver passes `confirmed: binaryPath !==
 *    undefined`, so `resolveEngineBinary` short-circuits on it and never
 *    consults the bundled engine. A Windows user was told
 *    `/opt/homebrew/bin/openvpn` "does not exist"; a Mac user was told
 *    `C:\Program Files\...` "is a relative path". Both bypassed an engine
 *    OpsMaxx ships that would have worked.
 *  * `OpenVpnSpec.sourcePath` — the `.ovpn` file a profile was discovered
 *    from, which exists to make a re-scan idempotent. A path on somebody
 *    else's disk names nothing here.
 *  * `autoStart` on frp and ngrok — `vpnStartup` starts every `autoStart`
 *    profile at launch, and for those two kinds starting means publishing THIS
 *    machine's localhost port, with ngrok to the public internet. The consent
 *    gate `start()` refuses without, `acknowledgedExposure`, is a tick about
 *    one machine's ports and rides in the same record. So machine B opened a
 *    port unattended, at login, on a decision made about machine A.
 *
 * Write side only, like `serversSource()` and for the same reason: the engine
 * compares bytes, so a read-side strip would be a conflict copy per pass for as
 * long as any device runs an older build.
 */

const userData = mkdtempSync(join(tmpdir(), 'opsmaxx-vpn-sync-strip-'))
vi.mock('electron', () => ({
  app: { getPath: () => userData, getVersion: () => '0' },
  // Identity "encryption", like tests/mocks/electron.ts and
  // tests/addyServerStatus.test.ts: what is under test is the strip, not the
  // sealing store.ts does on the way past.
  safeStorage: {
    isEncryptionAvailable: (): boolean => true,
    encryptString: (v: string): Buffer => Buffer.from(v, 'utf8'),
    decryptString: (b: Buffer): string => b.toString('utf8')
  }
}))

const { SOURCES } = await import('../src/main/services/addy/collections')

const DATA = join(userData, 'opsmaxx-data.json')

const inbound = (vpns: unknown[]): Buffer => Buffer.from(JSON.stringify(vpns), 'utf8')

const storedVpns = (): Array<Record<string, unknown>> => {
  const parsed = JSON.parse(readFileSync(DATA, 'utf8')) as { enc?: string }
  const blob = (
    typeof parsed.enc === 'string'
      ? JSON.parse(Buffer.from(parsed.enc, 'base64').toString('utf8'))
      : parsed
  ) as { vpns: Array<Record<string, unknown>> }
  return blob.vpns
}

const spec = (i: number): Record<string, unknown> => storedVpns()[i].spec as Record<string, unknown>

const openvpn = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'ov1',
  workspaceId: 'w1',
  name: 'office',
  autoStart: true,
  spec: {
    kind: 'openvpn',
    configRef: { vaultEntryId: 'e1', field: 'config' },
    authMode: 'none',
    redirectGateway: false,
    binaryPath: '/opt/homebrew/bin/openvpn',
    sourcePath: '/Users/someone-else/Downloads/office.ovpn',
    remotes: [{ host: 'vpn.example.com', port: 1194, proto: 'udp' }],
    ...(over.spec as Record<string, unknown>)
  },
  ...over
})

const frp = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'frp1',
  workspaceId: 'w1',
  name: 'demo',
  autoStart: true,
  spec: {
    kind: 'frp',
    serverAddr: 'frp.example.com',
    serverPort: 7000,
    auth: { method: 'token', tokenRef: { vaultEntryId: 'e2', field: 'token' } },
    transport: { protocol: 'tcp', tlsEnable: true },
    proxies: [
      {
        name: 'web',
        type: 'http',
        localIp: '127.0.0.1',
        localPort: 3000,
        acknowledgedExposure: true
      }
    ],
    visitors: []
  },
  ...over
})

beforeEach(() => rmSync(DATA, { force: true }))

describe('an openvpn profile arriving from another device', () => {
  it('drops the engine path, so this machine resolves its own', () => {
    SOURCES.vpns!.write(inbound([openvpn()]))
    expect(spec(0).binaryPath).toBeUndefined()
  })

  it('drops the file it was discovered from', () => {
    SOURCES.vpns!.write(inbound([openvpn()]))
    expect(spec(0).sourcePath).toBeUndefined()
  })

  it('keeps everything else about the profile exactly as it arrived', () => {
    // The point is narrow. The config ref, the auth mode, the remotes and the
    // name are the reason the collection is carried at all, and a fix that
    // quietly normalised any of them would be a worse bug than the one it
    // replaced.
    SOURCES.vpns!.write(inbound([openvpn()]))
    expect(storedVpns()[0]).toMatchObject({
      id: 'ov1',
      workspaceId: 'w1',
      name: 'office',
      // An OpenVPN tunnel publishes nothing, so a deliberate "start this at
      // launch" is a preference and travels.
      autoStart: true
    })
    expect(spec(0)).toMatchObject({
      kind: 'openvpn',
      configRef: { vaultEntryId: 'e1', field: 'config' },
      authMode: 'none',
      redirectGateway: false,
      remotes: [{ host: 'vpn.example.com', port: 1194, proto: 'udp' }]
    })
  })
})

describe('a reverse-proxy profile arriving from another device', () => {
  it('does not auto-start frp, because that would publish this machine port', () => {
    SOURCES.vpns!.write(inbound([frp()]))
    expect(storedVpns()[0].autoStart).toBe(false)
  })

  it('does not auto-start ngrok either', () => {
    SOURCES.vpns!.write(
      inbound([
        {
          id: 'ng1',
          workspaceId: 'w1',
          name: 'share',
          autoStart: true,
          spec: {
            kind: 'ngrok',
            authtokenRef: { vaultEntryId: 'e3', field: 'authtoken' },
            tunnels: [
              { name: 't', proto: 'http', localPort: 8080, acknowledgedExposure: true }
            ]
          }
        }
      ])
    )
    expect(storedVpns()[0].autoStart).toBe(false)
  })

  it('leaves the exposure tick alone', () => {
    // Deliberately NOT stripped, and the reason is about what a strip costs
    // rather than about what the tick means.
    //
    // A stripped field does not travel on its own — `writeBack` in sync.ts
    // records the hash of what landed AFTER the transform, so this device sees
    // no local edit and pushes nothing. But the collection syncs WHOLE, so the
    // first genuine edit to any profile here pushes this device's copy of all
    // of them. A gate `start()` refuses without, erased on the machine where
    // it was ticked, is an frp profile nobody can ever start again — one
    // unrelated rename away, and unrecoverable through the UI, since the tick
    // would be stripped again on arrival.
    //
    // `autoStart` carries the unattended half of the risk and is recoverable
    // by pressing Start, so that is the field that goes.
    SOURCES.vpns!.write(inbound([frp()]))
    const proxies = spec(0).proxies as Array<Record<string, unknown>>
    expect(proxies[0].acknowledgedExposure).toBe(true)
  })
})

describe('what the strip refuses to touch', () => {
  it('leaves a wireguard profile completely alone', () => {
    const wg = {
      id: 'wg1',
      workspaceId: 'w1',
      name: 'home',
      autoStart: true,
      spec: {
        kind: 'wireguard',
        mode: 'userspace',
        privateKeyRef: { vaultEntryId: 'e4', field: 'privateKey' },
        addresses: ['10.0.0.2/32'],
        dns: [],
        peers: [],
        listeners: [{ bindHost: '127.0.0.1', bindPort: 51820 }]
      }
    }
    SOURCES.vpns!.write(inbound([wg]))
    expect(storedVpns()[0]).toEqual(wg)
  })

  it('writes an empty list through unchanged', () => {
    // Deleting your last profile is a real edit that has to travel. Nothing
    // here may turn it into a no-op.
    SOURCES.vpns!.write(inbound([]))
    expect(storedVpns()).toEqual([])
  })

  it('passes a shape that is not a profile through to the file', () => {
    // So it can be found there, rather than reshaped into something plausible
    // by the one function in the path that was not meant to have an opinion.
    SOURCES.vpns!.write(inbound([null, 7, { id: 'no-spec' }]))
    expect(storedVpns()).toEqual([null, 7, { id: 'no-spec' }])
  })
})
