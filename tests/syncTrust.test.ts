import { describe, it, expect, beforeEach, vi } from 'vitest'
import { app } from 'electron'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { VaultEntry } from '../src/shared/vault'
import type { CicdConnection } from '../src/shared/cicd'
import type { HttpResult } from '../src/shared/httpClient'
import type { VpnProfile } from '../src/shared/vpn'

/**
 * Synced records cannot steer credentials or policy on a device that has not
 * confirmed them (the 2026-10-28 sync review, findings 1, 2, 12, 13, 15, 16).
 *
 * Every test here lands a copy the way sync does — through `SOURCES[name]
 * .write`, the only door an inbound collection comes in by — and then asks the
 * code that would act on it. Each one fails against 0.59.0, where the synced
 * record was used exactly as it arrived.
 */

const secrets = new Map<string, string>()
const vaultEntries: VaultEntry[] = [
  {
    id: 'v-ci',
    name: 'GitHub token',
    kind: 'login',
    url: '',
    username: '',
    password: 'ghp_real_token',
    notes: '',
    tags: [],
    fields: [],
    createdAt: '',
    updatedAt: ''
  }
]
const vaultRead = vi.fn(() => vaultEntries)
const ask = vi.fn(async (_o: unknown) => ({ response: 1, checkboxChecked: false }))

vi.mock('../src/main/services/secrets', () => ({
  getSecret: (id: string) => secrets.get(id) ?? null,
  setSecret: (id: string, v: string) => void secrets.set(id, v)
}))
vi.mock('../src/main/services/vault', () => ({
  vaultStatus: () => ({ exists: true, unlocked: true, stage: 'open', entryCount: vaultEntries.length }),
  vaultEntriesForResolve: () => vaultRead(),
  vaultList: () => ({ ok: true, entries: vaultEntries })
}))
vi.mock('../src/main/services/promptWindow', () => ({ askInWindow: (o: unknown) => ask(o) }))

const { SOURCES } = await import('../src/main/services/addy/collections')
const { saveData } = await import('../src/main/services/store')
const trust = await import('../src/main/services/syncTrust')
const { resolveSecret } = await import('../src/main/services/cicd/service')
const { pollOnce } = await import('../src/main/services/cicd/wiring')
const { resolveSecrets, resolveDbSecrets, resolveVpnSecrets } = await import(
  '../src/main/services/credentialResolver'
)
const { verifyHostKey, fingerprint } = await import('../src/main/services/knownhosts')
const { resolveRestriction } = await import('../src/main/services/policyEngine')

const userData = app.getPath('userData')
const land = (name: keyof typeof SOURCES, value: unknown): void =>
  SOURCES[name]!.write(Buffer.from(JSON.stringify(value), 'utf8'))

beforeEach(() => {
  for (const f of ['opsmaxx-data.json', 'opsmaxx-data.json.bak', 'opsmaxx-sync-trust.json', 'opsmaxx-known-hosts.json', 'opsmaxx-env-secrets.json']) {
    rmSync(join(userData, f), { force: true })
  }
  secrets.clear()
  vaultRead.mockClear()
  ask.mockClear()
})

// ---------------------------------------------------------------- finding 1

const ci = (over: Partial<CicdConnection> = {}): CicdConnection => ({
  id: 'c1',
  workspaceId: 'w1',
  name: 'Platform GitHub',
  provider: 'github',
  baseUrl: 'https://github.com',
  vaultEntryId: 'v-ci',
  route: { kind: 'direct' },
  enabled: true,
  ...over
})

describe('a CI connection changed by sync', () => {
  it('is not handed its token, and the vault is not even read', () => {
    saveData({ cicdConnections: [ci()] })
    land('cicdConnections', [ci({ baseUrl: 'https://collector.attacker.example' })])
    const moved = ci({ baseUrl: 'https://collector.attacker.example' })
    expect(() => resolveSecret(moved)).toThrow(trust.SyncHeldError)
    expect(vaultRead).not.toHaveBeenCalled()
  })

  it('is skipped by discovery: no request leaves for the new URL', async () => {
    saveData({ cicdConnections: [ci()] })
    const moved = ci({ baseUrl: 'https://collector.attacker.example' })
    land('cicdConnections', [moved])
    const request = vi.fn(async (): Promise<HttpResult> => {
      throw new Error('must not be called')
    })
    const out = await pollOnce(
      { target: { id: 't', connectionId: 'c1', pipelineRef: 'a/b', kind: 'runs' }, connection: moved, cacheKey: 'k' },
      { request }
    )
    expect(request).not.toHaveBeenCalled()
    expect(vaultRead).not.toHaveBeenCalled()
    expect(out.status).toBe(0)
  })

  it('holds a new vault pointer on an unchanged URL just the same', () => {
    saveData({ cicdConnections: [ci()] })
    land('cicdConnections', [ci({ vaultEntryId: 'v-someone-elses-ssh-password' })])
    expect(() => resolveSecret(ci({ vaultEntryId: 'v-someone-elses-ssh-password' }))).toThrow(trust.SyncHeldError)
  })

  it('holds one that arrived new, and releases it once confirmed here', () => {
    saveData({ cicdConnections: [] })
    land('cicdConnections', [ci()])
    expect(() => resolveSecret(ci())).toThrow(trust.SyncHeldError)
    trust.confirmRecord('cicd', 'c1')
    expect(resolveSecret(ci())).toBe('ghp_real_token')
  })

  it('leaves alone one that sync carried unchanged, or that was never synced', () => {
    saveData({ cicdConnections: [ci()] })
    expect(resolveSecret(ci())).toBe('ghp_real_token')
    land('cicdConnections', [ci({ name: 'renamed elsewhere' })])
    expect(resolveSecret(ci({ name: 'renamed elsewhere' }))).toBe('ghp_real_token')
  })

  it('is listed for the panel with what changed', () => {
    saveData({ cicdConnections: [ci()] })
    land('cicdConnections', [ci({ baseUrl: 'https://collector.attacker.example' })])
    const held = trust.heldRecords()
    expect(held).toEqual([
      expect.objectContaining({ kind: 'cicd', id: 'c1', changed: ['address'], destination: 'https://collector.attacker.example' })
    ])
  })

  it('fails closed when the trust file is damaged', () => {
    saveData({ cicdConnections: [ci()] })
    writeFileSync(join(userData, 'opsmaxx-sync-trust.json'), '{not json')
    expect(() => resolveSecret(ci())).toThrow(trust.SyncHeldError)
  })
})

// ------------------------------------------------- finding 2, servers half

const server = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 's1',
  workspaceId: 'w-locked',
  name: 'prod-db',
  host: 'prod.internal',
  port: 22,
  username: 'root',
  ...over
})

describe('a server redirected by sync', () => {
  it('dials without its stored password, and keeps it for the address this device knew', () => {
    secrets.set('s1', JSON.stringify({ password: 'hunter2' }))
    saveData({ servers: [server()] })
    land('servers', [server({ host: 'evil.example' })])
    const redirected = resolveSecrets({ host: 'evil.example', port: 22, username: 'root', auth: 'password', serverId: 's1' } as never) as { password?: string }
    expect(redirected.password).toBeUndefined()
    const original = resolveSecrets({ host: 'prod.internal', port: 22, username: 'root', auth: 'password', serverId: 's1' } as never) as { password?: string }
    expect(original.password).toBe('hunter2')
  })

  it('asks before a person-driven connect, and a yes releases it', async () => {
    secrets.set('s1', JSON.stringify({ password: 'hunter2' }))
    saveData({ servers: [server()] })
    land('servers', [server({ host: 'evil.example' })])
    ask.mockResolvedValueOnce({ response: 0, checkboxChecked: false })
    expect(await trust.askToUse('server', 's1', 'prod-db', trust.serverFieldsNow('evil.example'), 'root@evil.example')).toBe(true)
    expect(String((ask.mock.calls[0][0] as { detail: string }).detail)).toMatch(/address was changed on another of your devices/)
    expect(trust.serverCredentialHeld('s1', 'evil.example')).toBe(false)
  })

  it('refuses a database whose host moved, before any password is read', () => {
    secrets.set('d1', JSON.stringify({ password: 'pg-secret' }))
    const db = { id: 'd1', name: 'orders', host: 'db.internal', port: 5432, sshServerId: null }
    saveData({ databases: [db] })
    land('databases', [{ ...db, host: 'evil.example' }])
    expect(() => resolveDbSecrets({ id: 'd1', host: 'evil.example', port: 5432 } as never)).toThrow(trust.SyncHeldError)
    expect((resolveDbSecrets({ id: 'd1', host: 'db.internal', port: 5432 } as never) as { password?: string }).password).toBe('pg-secret')
  })
})

// ---------------------------------------------------------------- finding 2

const key = Buffer.from('a host key the attacker controls')
const realKey = Buffer.from('the real host key')

describe('known hosts that arrived by sync', () => {
  it('do not vouch for a host this device never trusted: background refuses, a person is asked', async () => {
    land('knownHosts', {
      'evil.example:22': { id: 'evil.example:22', fingerprint: fingerprint(key), addedAt: '' }
    })
    expect(await verifyHostKey('evil.example', 22, key, false)).toBe(false)
    expect(ask).not.toHaveBeenCalled()

    expect(await verifyHostKey('evil.example', 22, key, true)).toBe(false)
    expect(ask).toHaveBeenCalledTimes(1)
    expect(String((ask.mock.calls[0][0] as { detail: string }).detail)).toMatch(/shared it through Sync/)
  })

  it('cannot swap the key of a host this device already trusts', async () => {
    writeFileSync(
      join(userData, 'opsmaxx-known-hosts.json'),
      JSON.stringify({ 'prod.internal:22': { id: 'prod.internal:22', fingerprint: fingerprint(realKey), addedAt: '' } })
    )
    land('knownHosts', {
      'prod.internal:22': { id: 'prod.internal:22', fingerprint: fingerprint(key), addedAt: '' }
    })
    // The planted key is refused as a changed key...
    ask.mockResolvedValueOnce({ response: 0, checkboxChecked: false })
    expect(await verifyHostKey('prod.internal', 22, key, true)).toBe(false)
    expect((ask.mock.calls[0][0] as { title: string }).title).toBe('Host key changed')
    // ...and the real one still works without a prompt.
    expect(await verifyHostKey('prod.internal', 22, realKey, false)).toBe(true)
  })

  it('cost nothing for a host whose key this device already agrees with', async () => {
    const entry = { 'prod.internal:22': { id: 'prod.internal:22', fingerprint: fingerprint(realKey), addedAt: '' } }
    writeFileSync(join(userData, 'opsmaxx-known-hosts.json'), JSON.stringify(entry))
    land('knownHosts', entry)
    expect(await verifyHostKey('prod.internal', 22, realKey, false)).toBe(true)
  })
})

// --------------------------------------------------------------- finding 12

describe('a server moved to another workspace by sync', () => {
  it('keeps the old workspace restriction until confirmed here', () => {
    saveData({ servers: [server()] })
    land('servers', [server({ workspaceId: 'w-open' })])
    const former = trust.pendingWorkspace('s1', 'w-open')
    expect(former).toBe('w-locked')
    const assignments = [{ scope: { level: 'workspace' as const, workspaceId: 'w-locked' }, groupId: null }]
    // 0.59.0 read only the new workspace, which has no assignment: lifted.
    expect(resolveRestriction(assignments as never, 's1', 'w-open').kind).toBe('none')
    expect(resolveRestriction(assignments as never, 's1', 'w-open', former).kind).toBe('no-ai-access')
    trust.confirmRecord('server', 's1')
    expect(trust.pendingWorkspace('s1', 'w-open')).toBeNull()
  })

  it('applies a stricter new workspace at once, and refuses when two groups disagree', () => {
    const a = [
      { scope: { level: 'workspace' as const, workspaceId: 'w-old' }, groupId: 'g-read' },
      { scope: { level: 'workspace' as const, workspaceId: 'w-new' }, groupId: 'g-write' }
    ]
    expect(resolveRestriction(a as never, 's1', 'w-new', 'w-old').kind).toBe('no-ai-access')
    expect(resolveRestriction(a as never, 's1', 'w-new', null)).toEqual({ kind: 'group', groupId: 'g-write' })
  })
})

// --------------------------------------------------------------- finding 13

const wg = (endpoint: string, autoStart = true): VpnProfile => ({
  id: 'wg1',
  workspaceId: 'w1',
  name: 'office',
  autoStart,
  spec: {
    kind: 'wireguard',
    mode: 'userspace',
    privateKeyRef: { vaultEntryId: 'v-wg', field: 'privateKey' },
    addresses: ['10.0.0.2/32'],
    dns: [],
    peers: [{ publicKey: 'x'.repeat(43) + '=', endpoint, allowedIps: ['0.0.0.0/0'] }],
    listeners: []
  }
})

describe('a WireGuard profile rewritten by sync', () => {
  const stored = async (): Promise<VpnProfile> => {
    const { loadData } = await import('../src/main/services/store')
    return (loadData() as { vpns: VpnProfile[] }).vpns[0]
  }

  it('loses autoStart when its peers change, and is not started until confirmed', async () => {
    saveData({ vpns: [wg('vpn.example.com:51820')] })
    land('vpns', [wg('evil.example:51820')])
    const p = await stored()
    expect(p.autoStart).toBe(false)
    await expect(resolveVpnSecrets(p)).rejects.toThrow(/changed on another of your devices/)
  })

  it('keeps autoStart when only the name changed', async () => {
    saveData({ vpns: [wg('vpn.example.com:51820')] })
    land('vpns', [{ ...wg('vpn.example.com:51820'), name: 'office (renamed)' }])
    expect((await stored()).autoStart).toBe(true)
  })
})

// --------------------------------------------------------------- finding 15

describe('env pointers arriving by sync', () => {
  it('are added to, never removed: redaction survives a synced empty list', () => {
    const mine = { serverId: 's1', vaultEntryId: 'v-db', slot: 'password' }
    const theirs = { serverId: 's2', vaultEntryId: 'v-api', slot: 'password' }
    writeFileSync(join(userData, 'opsmaxx-env-secrets.json'), JSON.stringify([mine]))
    land('env', [])
    land('env', [theirs])
    expect(JSON.parse(SOURCES.env!.read()!.toString('utf8'))).toEqual(
      expect.arrayContaining([mine, theirs])
    )
  })
})

// --------------------------------------------------------------- finding 16

describe('HTTP checks arriving by sync', () => {
  const check = (over: Record<string, unknown>): Record<string, unknown> => ({
    id: 'h1',
    workspaceId: 'w1',
    name: 'site',
    url: 'https://example.com',
    method: 'HEAD',
    intervalSec: 60,
    timeoutMs: 10000,
    expectStatus: [200],
    enabled: true,
    ...over
  })
  const landed = (): Array<Record<string, unknown>> =>
    JSON.parse(SOURCES.httpChecks!.read()!.toString('utf8')) as Array<Record<string, unknown>>

  it('cannot run more often than the default', () => {
    saveData({ httpChecks: [] })
    land('httpChecks', [check({ intervalSec: 1 })])
    expect(landed()[0].intervalSec).toBe(60)
  })

  it('never carry insecureTls in, and keep this device\'s own answer', () => {
    saveData({ httpChecks: [] })
    land('httpChecks', [check({ insecureTls: true })])
    expect(landed()[0].insecureTls).toBeUndefined()

    saveData({ httpChecks: [check({ insecureTls: true })] })
    land('httpChecks', [check({ name: 'renamed' })])
    expect(landed()[0].insecureTls).toBe(true)
  })
})

describe('the trust file', () => {
  it('is device-local and goes with "delete everything"', async () => {
    const { NOT_SYNCED } = await import('../src/shared/addy')
    const { ALL_DATA_FILES } = await import('../src/main/services/backup')
    expect(NOT_SYNCED).toHaveProperty('syncTrust')
    expect(ALL_DATA_FILES).toContain('opsmaxx-sync-trust.json')
    saveData({ cicdConnections: [] })
    land('cicdConnections', [ci()])
    expect(existsSync(join(userData, 'opsmaxx-sync-trust.json'))).toBe(true)
  })
})
