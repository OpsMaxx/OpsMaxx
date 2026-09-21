import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A tailnet hostname names ONE device. The profile that carries it syncs.
 *
 * `TailscaleSpec.hostname` lives in `vpns`, which crosses devices, and the
 * `vpn-state/` directory holding each device's tsnet node key correctly does
 * not. So two paired machines running the same profile are two genuinely
 * distinct nodes registering under one label: Tailscale disambiguates by
 * appending `-1`, `-2`, and the admin console fills with near-copies of one
 * name.
 *
 * The fix is a per-device override stored beside the node key it disambiguates
 * — `vpn-state/tailscale-<id>/hostname` — with the synced `hostname` left
 * alone as the default. These tests pin the two properties that make that
 * right: the override never crosses, and exactly one function decides which
 * name wins.
 *
 * Both halves matter. A resolution rule the driver and the UI implement
 * separately is two rules, and the day they disagree the user is editing a
 * field that does not name the node they are looking at.
 */

const userData = mkdtempSync(join(tmpdir(), 'opsmaxx-vpn-hostname-'))
vi.mock('electron', () => ({
  app: { getPath: () => userData, getVersion: () => '0' },
  // Identity "encryption", like tests/vpnSyncStrip.test.ts: what is under test
  // is what travels, not the sealing store.ts does on the way past.
  safeStorage: {
    isEncryptionAvailable: (): boolean => true,
    encryptString: (v: string): Buffer => Buffer.from(v, 'utf8'),
    decryptString: (b: Buffer): string => b.toString('utf8')
  }
}))

const { tailscaleHostname, isTailscaleHostname } = await import('../src/shared/vpn')
const { readDeviceHostname, writeDeviceHostname } = await import(
  '../src/main/services/vpn/drivers/tailscale'
)
const { SOURCES } = await import('../src/main/services/addy/collections')

const DATA = join(userData, 'opsmaxx-data.json')

/** Two devices, as two `vpn-state` roots. The override is a file under one of
 *  them, so a second root is the whole of what a second machine is here. */
const roots: string[] = []
const deviceRoot = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'opsmaxx-vpn-state-'))
  roots.push(dir)
  return dir
}

const profile = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'ts1',
  workspaceId: 'w1',
  name: 'tailnet',
  spec: { kind: 'tailscale', hostname: 'opsmaxx', ...over }
})

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

beforeEach(() => {
  rmSync(DATA, { force: true })
  rmSync(`${DATA}.bak`, { force: true })
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

describe('which name the node takes', () => {
  it('prefers this machine over the profile', () => {
    // The whole point. The profile's name is the default; the machine that set
    // an override meant it about itself.
    expect(tailscaleHostname({ kind: 'tailscale', hostname: 'opsmaxx' }, 'work-laptop')).toBe(
      'work-laptop'
    )
  })

  it('falls back to the profile, which is a name the user chose', () => {
    expect(tailscaleHostname({ kind: 'tailscale', hostname: 'opsmaxx' }, undefined)).toBe('opsmaxx')
  })

  it('answers undefined when neither is set, so the sidecar picks', () => {
    // NOT the empty string. `ts.up` treats absent as "choose one for me" and
    // an empty hostname as a name, which is how a node ends up registering
    // under nothing at all.
    expect(tailscaleHostname({ kind: 'tailscale' }, undefined)).toBeUndefined()
  })

  it('ignores an override that is only whitespace', () => {
    // A cleared field arrives as spaces often enough that treating it as a
    // name would put one on the tailnet.
    expect(tailscaleHostname({ kind: 'tailscale', hostname: 'opsmaxx' }, '   ')).toBe('opsmaxx')
  })
})

describe('the name rule', () => {
  it('accepts what a tailnet accepts', () => {
    expect(isTailscaleHostname('opsmaxx')).toBe(true)
    expect(isTailscaleHostname('work-laptop-2')).toBe(true)
  })

  it('refuses what it does not', () => {
    // Shared with the driver's own validateConfig, so the form cannot accept a
    // name the engine will later reject.
    expect(isTailscaleHostname('-leading-dash')).toBe(false)
    expect(isTailscaleHostname('has space')).toBe(false)
    expect(isTailscaleHostname('under_score')).toBe(false)
    expect(isTailscaleHostname('')).toBe(false)
    expect(isTailscaleHostname('a'.repeat(64))).toBe(false)
  })
})

describe('the per-device override', () => {
  it('survives being written and read back', async () => {
    const root = deviceRoot()
    await writeDeviceHostname('ts1', 'work-laptop', root)
    expect(await readDeviceHostname('ts1', root)).toBe('work-laptop')
  })

  it('reads as absent on a machine that has never set one', async () => {
    // Absent is not the empty string here either: absent means "this machine
    // has no opinion", which is what makes the profile's name the default.
    expect(await readDeviceHostname('ts1', deviceRoot())).toBeUndefined()
  })

  it('lands beside the node key it disambiguates', async () => {
    // Not decoration. `vpn-state/tailscale-<id>/` is already classified
    // device-local in NOT_SYNCED *because* it holds the tsnet node identity,
    // so putting the name there needs no new guardrail entry — and the two
    // facts about this device stay together.
    const root = deviceRoot()
    await writeDeviceHostname('ts1', 'work-laptop', root)
    expect(existsSync(join(root, 'tailscale-ts1', 'hostname'))).toBe(true)
  })

  it('is cleared rather than blanked', async () => {
    const root = deviceRoot()
    await writeDeviceHostname('ts1', 'work-laptop', root)
    await writeDeviceHostname('ts1', undefined, root)
    expect(await readDeviceHostname('ts1', root)).toBeUndefined()
  })

  it('refuses a name a tailnet would not take', async () => {
    // A trust boundary: this arrives from the renderer and becomes a name sent
    // to the sidecar. Refused here rather than written and failed at start,
    // which would strand the profile with a name nothing will accept.
    const root = deviceRoot()
    await expect(writeDeviceHostname('ts1', 'has space', root)).rejects.toThrow(/letters/i)
    expect(await readDeviceHostname('ts1', root)).toBeUndefined()
  })
})

describe('the override does not cross devices', () => {
  it('is nowhere in what this machine pushes', async () => {
    // The property a strip cannot give you: it is not in the payload at all,
    // so it does not reach the relay even as ciphertext.
    const a = deviceRoot()
    await writeDeviceHostname('ts1', 'a-laptop', a)
    SOURCES.vpns!.write(inbound([profile()]))

    const pushed = SOURCES.vpns!.read()!.toString('utf8')
    expect(pushed).not.toContain('a-laptop')
    // And the name the user chose for the profile is still travelling, which
    // is the half that must not break.
    expect(pushed).toContain('opsmaxx')
  })

  it('survives landing another machine\'s copy of the same profile', async () => {
    // The failure this guards: `vpns` syncs WHOLE, so any edit anywhere pushes
    // every profile. If the override rode in the record it would be overwritten
    // on the next pass by whatever the other machine had.
    const b = deviceRoot()
    await writeDeviceHostname('ts1', 'b-desktop', b)

    // Device A's copy arrives, carrying A's idea of the profile.
    SOURCES.vpns!.write(inbound([profile({ hostname: 'renamed-on-a' })]))

    expect(await readDeviceHostname('ts1', b)).toBe('b-desktop')
    // A's edit to the shared field did land — that one is supposed to travel.
    expect((storedVpns()[0].spec as Record<string, unknown>).hostname).toBe('renamed-on-a')
  })

  it('leaves the two machines naming the same profile differently', async () => {
    const a = deviceRoot()
    const b = deviceRoot()
    await writeDeviceHostname('ts1', 'a-laptop', a)
    await writeDeviceHostname('ts1', 'b-desktop', b)

    const spec = { kind: 'tailscale' as const, hostname: 'opsmaxx' }
    expect(tailscaleHostname(spec, await readDeviceHostname('ts1', a))).toBe('a-laptop')
    expect(tailscaleHostname(spec, await readDeviceHostname('ts1', b))).toBe('b-desktop')
  })
})
