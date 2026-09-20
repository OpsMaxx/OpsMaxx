import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from 'electron'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { VpnProfile } from '../src/shared/vpn'

/**
 * What the launch prompt is allowed to say.
 *
 * The design (docs/plans/vault-ux.md §5.1) turns on the counts being real: a
 * number the user can check against what they know they configured is the
 * whole reason the prompt is worth answering, and one that is merely plausible
 * is worse than saying nothing. So these assert the phrases against
 * configuration that is genuinely waiting, and — more importantly — assert
 * silence for the configuration that is not.
 */

let profiles: VpnProfile[] = []
vi.mock('../src/main/services/store', () => ({
  loadData: () => ({ vpns: profiles }),
  saveData: vi.fn()
}))

const { vaultWaiting } = await import('../src/main/services/vaultWaiting')
const { reload } = await import('../src/main/services/cicd/wiring')

const TARGETS = join(app.getPath('userData'), 'opsmaxx-backup-targets.json')

interface Dest {
  id: string
  name: string
  kind: 'local'
  directory: string
  keep: number
  everyHours: number
  restoreTest: boolean
  passphraseVaultEntryId?: string
  passphraseSource?: 'vault' | 'machine'
}

function destinations(...list: Dest[]): void {
  writeFileSync(TARGETS, JSON.stringify({ version: 1, destinations: list, lastRunAt: {}, lastReport: {} }))
}

function ci(...ids: string[]): void {
  reload({
    cicdConnections: ids.map((id) => ({
      id,
      workspaceId: 'w1',
      name: id,
      provider: 'jenkins',
      baseUrl: 'https://ci.example',
      vaultEntryId: `v-${id}`
    }))
  })
}

const wireguard = (name: string, autoStart: boolean, vaultEntryId?: string): VpnProfile =>
  ({
    id: name,
    workspaceId: 'w1',
    name,
    autoStart,
    spec: {
      kind: 'wireguard',
      address: ['10.0.0.2/32'],
      peers: [
        {
          publicKey: 'pk',
          endpoint: 'vpn.example:51820',
          allowedIPs: ['0.0.0.0/0'],
          ...(vaultEntryId ? { presharedKeyRef: { vaultEntryId, field: 'presharedKey' } } : {})
        }
      ],
      privateKeyRef: { vaultEntryId: vaultEntryId ?? '', field: 'privateKey' }
    }
  }) as unknown as VpnProfile

beforeEach(() => {
  profiles = []
  ci()
  destinations()
})

afterEach(() => {
  rmSync(TARGETS, { force: true })
})

describe('vaultWaiting', () => {
  it('says nothing at all when nothing is configured', () => {
    expect(vaultWaiting()).toEqual([])
  })

  it('names a single auto-starting VPN whose key is in the vault', () => {
    profiles = [wireguard('office', true, 'entry-1')]
    expect(vaultWaiting()).toEqual(['VPN “office”'])
  })

  it('leaves out a VPN that does not auto-start, and one that needs no vault entry', () => {
    profiles = [
      // Configured to start itself, but its key is not in the vault — nothing
      // about a shut vault stops it.
      wireguard('no-vault', true),
      // In the vault, but nobody asked for it at launch.
      wireguard('manual', false, 'entry-2')
    ]
    expect(vaultWaiting()).toEqual([])
  })

  it('counts several auto-starting VPNs rather than listing them', () => {
    profiles = [wireguard('office', true, 'e1'), wireguard('lab', true, 'e2')]
    expect(vaultWaiting()).toEqual(['2 auto-starting VPNs'])
  })

  it('finds a reference nested as deep as an frp plugin password', () => {
    profiles = [
      {
        id: 'frp',
        workspaceId: 'w1',
        name: 'frp',
        autoStart: true,
        spec: {
          kind: 'frp',
          serverAddr: 'frp.example',
          serverPort: 7000,
          auth: { method: 'token' },
          visitors: [],
          proxies: [
            {
              name: 'web',
              type: 'tcp',
              localPort: 80,
              remotePort: 8080,
              plugin: { name: 'http_proxy', username: 'u', passwordRef: { vaultEntryId: 'deep', field: 'password' } }
            }
          ]
        }
      } as unknown as VpnProfile
    ]
    expect(vaultWaiting()).toEqual(['VPN “frp”'])
  })

  it('counts CI accounts, singular and plural', () => {
    ci('one')
    expect(vaultWaiting()).toEqual(['1 CI account'])
    ci('one', 'two')
    expect(vaultWaiting()).toEqual(['2 CI accounts'])
  })

  it('names a scheduled backup destination by the name the user gave it', () => {
    destinations({
      id: 'd1',
      name: 'wasabi-nightly',
      kind: 'local',
      directory: '/tmp/b',
      keep: 0,
      everyHours: 24,
      restoreTest: true,
      passphraseVaultEntryId: 'v1'
    })
    expect(vaultWaiting()).toEqual(['a backup to “wasabi-nightly”'])
  })

  it('leaves out a manual destination and one whose passphrase is a machine grant', () => {
    destinations(
      // Manual only: there is a person present to type a passphrase, so it is
      // not waiting on anything.
      {
        id: 'd1',
        name: 'by-hand',
        kind: 'local',
        directory: '/tmp/b',
        keep: 0,
        everyHours: 0,
        restoreTest: true,
        passphraseVaultEntryId: 'v1'
      },
      // The whole point of a machine grant is that the run survives a restart
      // with nobody there. It never needed the vault open.
      {
        id: 'd2',
        name: 'standing-grant',
        kind: 'local',
        directory: '/tmp/b',
        keep: 0,
        everyHours: 6,
        restoreTest: true,
        passphraseVaultEntryId: 'v2',
        passphraseSource: 'machine'
      },
      // Scheduled, but no passphrase entry has ever been chosen — the backup
      // panel's own complaint, not the vault's.
      {
        id: 'd3',
        name: 'unfinished',
        kind: 'local',
        directory: '/tmp/b',
        keep: 0,
        everyHours: 6,
        restoreTest: true
      }
    )
    expect(vaultWaiting()).toEqual([])
  })

  it('reports every surface at once, each in its own words', () => {
    profiles = [wireguard('office', true, 'e1')]
    ci('a', 'b')
    destinations({
      id: 'd1',
      name: 'wasabi-nightly',
      kind: 'local',
      directory: '/tmp/b',
      keep: 0,
      everyHours: 24,
      restoreTest: true,
      passphraseVaultEntryId: 'v1'
    })
    expect(vaultWaiting()).toEqual(['VPN “office”', '2 CI accounts', 'a backup to “wasabi-nightly”'])
  })

  it('counts nothing from a destinations file it could not parse', () => {
    writeFileSync(TARGETS, 'not json at all')
    expect(vaultWaiting()).toEqual([])
  })
})
