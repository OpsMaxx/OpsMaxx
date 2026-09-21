import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { VpnDriver } from '../src/main/services/vpn/driver'
import type { VpnProfile, VpnStartResult, VpnValidation } from '../src/shared/vpn'

/**
 * A profile deleted on another device leaves a live tunnel on this one.
 *
 * The local delete path stops the tunnel first and CANCELS the delete when the
 * engine will not die, because dropping the profile, its status and its vault
 * key material while the tunnel kept its routes left a live VPN under a
 * "deleted" toast with nothing on screen able to stop it — see the comment on
 * `remove` in components/vpn/useVpnProfiles.tsx.
 *
 * Sync reached that exact state through a door that guard does not cover: the
 * engine wrote the `vpns` collection to disk, the renderer reloaded its list,
 * and nothing told the manager. The tunnel stayed `connected`, the supervisor
 * kept it alive, its routes stayed up, and `vpnList()` stopped returning it
 * because it synthesises from `vpnProfiles()`. The row vanished and the Stop
 * button with it, and the vault entry synced away in the same pass, so it
 * could not even be restarted in order to be stopped.
 *
 * Tested against the fake engine the rest of the manager is, for the same
 * reason: what is under test is the reconcile, not any one protocol.
 */

let profiles: VpnProfile[] = []
vi.mock('../src/main/services/store', () => ({
  loadData: () => ({ vpns: profiles }),
  saveData: vi.fn()
}))

vi.mock('../src/main/services/mcpDataCache', () => ({
  listCachedVpns: () => profiles.map((p) => ({ id: p.id, name: p.name, workspaceId: p.workspaceId })),
  listCachedServers: () => [],
  listCachedDatabases: () => [],
  listCachedTunnels: () => [],
  getCachedVpn: (id: string) => profiles.find((p) => p.id === id) ?? null
}))

class VaultLockedError extends Error {}
vi.mock('../src/main/services/credentialResolver', () => ({
  VaultLockedError,
  isVaultLockedError: (e: unknown) => e instanceof VaultLockedError,
  resolveVpnSecrets: async () => ({ all: [] })
}))

vi.mock('../src/main/services/vpn/runDir', () => ({
  createRunDir: async (id: string) => `/tmp/vpn-run/${id}`,
  disposeRunDir: async () => undefined,
  sweepRunDirs: async () => undefined
}))

vi.mock('../src/main/services/vpn/supervisor', () => ({
  Supervisor: class {
    async reapOrphans(): Promise<void> {}
    async stopAll(): Promise<void> {}
  }
}))

const behaviour = {
  start: async (): Promise<VpnStartResult> => ({ ok: true }),
  stop: async (): Promise<void> => undefined,
  validate: (): VpnValidation => ({ ok: true, issues: [] })
}
const stopped: string[] = []
const aborted: string[] = []

const fakeDriver: VpnDriver = {
  kind: 'wireguard',
  validateConfig: () => behaviour.validate(),
  probe: async () => ({ kind: 'wireguard', available: true, bundled: true }),
  start: async () => behaviour.start(),
  stop: async (id, opts) => {
    stopped.push(`${id}${opts?.force ? ':force' : ''}`)
    return behaviour.stop()
  },
  abortStart: (id: string) => {
    aborted.push(id)
  },
  status: () => null,
  stats: async () => null
} as VpnDriver

vi.mock('../src/main/services/vpn/drivers', () => ({
  driverFor: () => fakeDriver,
  allDrivers: () => [fakeDriver]
}))

const mgr = await import('../src/main/services/vpn/manager')

function wgProfile(over: Partial<VpnProfile> = {}): VpnProfile {
  return {
    id: 'v1',
    workspaceId: 'w1',
    name: 'office',
    autoStart: false,
    spec: {
      kind: 'wireguard',
      mode: 'userspace',
      privateKeyRef: { vaultEntryId: 'e1', field: 'privateKey' },
      addresses: ['10.0.0.2/32'],
      dns: [],
      peers: [],
      listeners: []
    },
    ...over
  }
}

/** The engine has written the pulled collection to disk. */
function arrives(next: VpnProfile[]): void {
  profiles = next
  mgr.vpnProfilesExternalChange()
}

/** The reconcile fires stops without awaiting them, exactly as the applied
 *  hook in main/index.ts calls it. Let the queue settle. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  profiles = [wgProfile()]
  stopped.length = 0
  aborted.length = 0
  behaviour.start = async () => ({ ok: true })
  behaviour.stop = async () => undefined
  behaviour.validate = () => ({ ok: true, issues: [] })
  mgr.resetVpnManagerState()
})

describe('a vpns collection arriving from another device', () => {
  it('stops a tunnel whose profile was deleted there', async () => {
    await mgr.vpnStart('v1')
    expect(mgr.vpnStatus('v1')?.state).toBe('connected')

    arrives([])
    await settle()

    expect(stopped).toEqual(['v1:force'])
  })

  it('leaves the status behind no longer claiming the tunnel is up', async () => {
    // The row is gone from `vpnList()` the moment the profile is, so a status
    // still reading `connected` is a live tunnel nothing can name. Cleared
    // only once the engine actually died.
    await mgr.vpnStart('v1')
    arrives([])
    await settle()

    expect(mgr.vpnStatus('v1')).toBeNull()
    expect(mgr.vpnList()).toEqual([])
  })

  it('does not stop a tunnel whose profile was merely edited', async () => {
    // A rename, a changed peer, a toggled autoStart — the id is the same and
    // this is a change, not a deletion. Stopping somebody's VPN because they
    // renamed it on a laptop is the bug this would be replacing.
    await mgr.vpnStart('v1')

    arrives([wgProfile({ name: 'office (new office)', autoStart: true })])
    await settle()

    expect(stopped).toEqual([])
    expect(mgr.vpnStatus('v1')?.state).toBe('connected')
  })

  it('stops only the deleted one when several are running', async () => {
    profiles = [wgProfile({ id: 'v1' }), wgProfile({ id: 'v2', name: 'lab' })]
    await mgr.vpnStart('v1')
    await mgr.vpnStart('v2')

    arrives([wgProfile({ id: 'v2', name: 'lab' })])
    await settle()

    expect(stopped).toEqual(['v1:force'])
    expect(mgr.vpnStatus('v2')?.state).toBe('connected')
  })

  it('does nothing when nothing is running', async () => {
    arrives([])
    await settle()
    expect(stopped).toEqual([])
  })

  it('interrupts a start that was still in flight', async () => {
    // `force` is what reaches an engine mid-connect. Without it the stop waits
    // behind a start that can take a minute, with the routes going up
    // underneath it.
    let release: () => void = () => undefined
    behaviour.start = () =>
      new Promise<VpnStartResult>((resolve) => {
        release = () => resolve({ ok: true })
      })
    const starting = mgr.vpnStart('v1')
    await settle()

    arrives([])
    await settle()
    expect(aborted).toEqual(['v1'])

    release()
    await starting
    await settle()
    expect(stopped).toEqual(['v1:force'])
  })

  it('keeps the status when the engine refuses to die', async () => {
    // The only record that a tunnel this app can no longer name is still up,
    // and the error it carries is what the user is owed. Forgetting it here
    // would be the original bug with extra steps.
    await mgr.vpnStart('v1')
    behaviour.stop = async () => {
      throw new Error('openvpn would not exit')
    }

    arrives([])
    await settle()

    expect(mgr.vpnStatus('v1')?.state).toBe('error')
    expect(mgr.vpnStatus('v1')?.error).toContain('openvpn would not exit')
  })
})
