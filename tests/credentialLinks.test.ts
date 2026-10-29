import { describe, it, expect, beforeEach, vi } from 'vitest'
import { app } from 'electron'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { VaultEntry } from '../src/shared/vault'

/**
 * A server's or database's link to its vault entry rides on the synced record,
 * so a second device can log in — and only once a person there confirms it.
 *
 * Every arrival goes through `SOURCES[name].write`, the door sync uses. Before
 * this, a second device had the record and no credential at all: the keychain
 * blob it would need lives only on the machine that saved it.
 */

const secrets = new Map<string, string>()
const entry = (id: string, name: string, over: Partial<VaultEntry> = {}): VaultEntry => ({
  id,
  name,
  kind: 'login',
  url: '',
  username: 'root',
  password: `${id}-secret`,
  notes: '',
  tags: [],
  fields: [],
  createdAt: '',
  updatedAt: '',
  ...over
})
let vaultEntries: VaultEntry[] = []
const vaultRead = vi.fn(() => vaultEntries)
const vaultSave = vi.fn((e: VaultEntry[]) => ((vaultEntries = e), { ok: true }))
let stage: 'open' | 'secured' = 'open'
const ask = vi.fn(async (_o: unknown) => ({ response: 1, checkboxChecked: false }))

vi.mock('../src/main/services/secrets', () => ({
  getSecret: (id: string) => secrets.get(id) ?? null,
  setSecret: (id: string, v: string) => (secrets.set(id, v), true)
}))
vi.mock('../src/main/services/vault', () => ({
  vaultStatus: () => ({ exists: true, unlocked: true, stage, entryCount: vaultEntries.length }),
  vaultEntriesForResolve: () => vaultRead(),
  vaultList: () => ({ ok: true, entries: vaultEntries }),
  vaultSave: (e: VaultEntry[]) => vaultSave(e)
}))
vi.mock('../src/main/services/promptWindow', () => ({ askInWindow: (o: unknown) => ask(o) }))

const { SOURCES } = await import('../src/main/services/addy/collections')
const { saveData } = await import('../src/main/services/store')
const trust = await import('../src/main/services/syncTrust')
const { resolveSecrets, resolveDbSecrets, credentialSourceFor } = await import('../src/main/services/credentialResolver')
const { storedCredential, credentialToStore } = await import('../src/main/services/credentialLink')
const { keychainOnly, moveCredentialsToVault } = await import('../src/main/services/credentialMove')

const userData = app.getPath('userData')
const land = (name: keyof typeof SOURCES, value: unknown): void =>
  SOURCES[name]!.write(Buffer.from(JSON.stringify(value), 'utf8'))

const server = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 's1',
  workspaceId: 'w1',
  name: 'Chain305',
  host: 'prod.example',
  port: 22,
  username: 'root',
  ...over
})
const dial = (host = 'prod.example'): { password?: string; privateKey?: string } =>
  resolveSecrets({ host, port: 22, username: 'root', auth: 'password', serverId: 's1' } as never) as never

beforeEach(() => {
  for (const f of ['opsmaxx-data.json', 'opsmaxx-data.json.bak', 'opsmaxx-sync-trust.json']) {
    rmSync(join(userData, f), { force: true })
  }
  secrets.clear()
  vaultEntries = [entry('v-prod', 'Prod root'), entry('v-other', 'Payroll DB')]
  stage = 'open'
  vaultRead.mockClear()
  vaultSave.mockClear()
  ask.mockClear()
})

describe('a server that arrives by sync with a vault link', () => {
  it('logs in with the linked entry once confirmed here, and not before', () => {
    land('servers', [server({ vaultEntryId: 'v-prod' })])
    // 0.59.1: nothing stored here, so nothing offered at all.
    expect(dial().password).toBeUndefined()
    expect(vaultRead).not.toHaveBeenCalled()
    expect(trust.heldRecords().map((r) => r.id)).toEqual(['s1'])
    trust.confirmRecord('server', 's1')
    expect(dial().password).toBe('v-prod-secret')
    expect(credentialSourceFor('s1')).toEqual({ source: 'vault', vaultEntryId: 'v-prod' })
  })

  it('names the entry it would release when it asks', async () => {
    land('servers', [server({ vaultEntryId: 'v-prod' })])
    await trust.askToUse('server', 's1', 'Chain305', trust.serverFieldsNow('s1', 'prod.example'), 'root@prod.example')
    expect(ask).toHaveBeenCalledTimes(1)
    expect((ask.mock.calls[0]![0] as { detail: string }).detail).toContain('vault entry "Prod root"')
  })

  it('holds a synced change of the link alone, on an otherwise confirmed record', () => {
    saveData({ servers: [server({ vaultEntryId: 'v-prod' })] })
    expect(dial().password).toBe('v-prod-secret')
    // Same address, another of the user's secrets: that secret would go to it.
    land('servers', [server({ vaultEntryId: 'v-other' })])
    expect(dial().password).toBeUndefined()
    expect(trust.serverCredentialHeld('s1', 'prod.example')).toBe(true)
  })

  it('a link created on this device is used without asking', () => {
    saveData({ servers: [server({ vaultEntryId: 'v-prod' })] })
    expect(trust.serverCredentialHeld('s1', 'prod.example')).toBe(false)
    expect(dial().password).toBe('v-prod-secret')
  })
})

describe('a device with its own stored credential', () => {
  it('keeps using it, and a synced link change does not hold it', () => {
    secrets.set('s1', JSON.stringify({ password: 'typed-here' }))
    saveData({ servers: [server()] })
    land('servers', [server({ vaultEntryId: 'v-other' })])
    expect(trust.serverCredentialHeld('s1', 'prod.example')).toBe(false)
    expect(dial().password).toBe('typed-here')
  })

  it('a blob holding only a remembered second-factor answer still gains the link', () => {
    secrets.set('s1', JSON.stringify({ kbAnswer: '424242' }))
    land('servers', [server({ vaultEntryId: 'v-prod' })])
    expect(JSON.parse(storedCredential('s1')!)).toEqual({ kbAnswer: '424242', vaultEntryId: 'v-prod' })
    trust.confirmRecord('server', 's1')
    expect(dial().password).toBe('v-prod-secret')
  })
})

describe('a database that arrives by sync with a vault link', () => {
  const db = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'd1',
    workspaceId: 'w1',
    name: 'payroll',
    kind: 'postgres',
    host: 'db.example',
    port: 5432,
    username: 'app',
    ssl: true,
    uri: false,
    sshServerId: null,
    vpnProfileId: null,
    ...over
  })
  const cfg = { id: 'd1', host: 'db.example', port: 5432 }

  it('is refused until confirmed, then reads the linked password', () => {
    land('databases', [db({ vaultEntryId: 'v-other' })])
    expect(() => resolveDbSecrets({ ...cfg } as never)).toThrow(trust.SyncHeldError)
    trust.confirmRecord('database', 'd1')
    expect((resolveDbSecrets({ ...cfg } as never) as { password?: string }).password).toBe('v-other-secret')
  })

  it('a connection-string database reads the entry as its URI', () => {
    vaultEntries.push(entry('v-uri', 'URI', { password: 'postgres://app:pw@db.example/payroll' }))
    land('databases', [db({ uri: true, vaultEntryId: 'v-uri' })])
    trust.confirmRecord('database', 'd1')
    expect((resolveDbSecrets({ ...cfg } as never) as { uri?: string }).uri).toBe('postgres://app:pw@db.example/payroll')
  })
})

describe('moving keychain-only credentials into the vault', () => {
  it('turns a password and a key file into entries, rewrites the blobs, keeps the rest', () => {
    const keyFile = join(userData, 'id_test')
    writeFileSync(keyFile, '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n')
    saveData({
      servers: [server(), server({ id: 's2', name: 'Bastion' }), server({ id: 's3', name: 'Agent box' })],
      databases: [{ id: 'd1', name: 'payroll', username: 'app', uri: true, workspaceId: 'w1' }]
    })
    secrets.set('s1', JSON.stringify({ password: 'hunter2', kbAnswer: '1' }))
    secrets.set('s2', JSON.stringify({ keyPath: keyFile, passphrase: 'pp', certificatePath: '/c-cert.pub' }))
    secrets.set('s3', JSON.stringify({ agentSocket: '/tmp/agent.sock' }))
    secrets.set('d1', JSON.stringify({ uri: 'postgres://x' }))
    expect(keychainOnly(['s1', 's2', 's3', 'd1', 'nope']).sort()).toEqual(['d1', 's1', 's2'])

    const r = moveCredentialsToVault(['s1', 's2', 's3', 'd1'])
    expect(r.ok).toBe(true)
    expect(r.moved.map((m) => m.id).sort()).toEqual(['d1', 's1', 's2'])
    expect(r.skipped.map((s) => s.id)).toEqual(['s3'])
    expect(vaultSave).toHaveBeenCalledTimes(1)

    const id = (k: string): string => r.moved.find((m) => m.id === k)!.vaultEntryId
    const made = (k: string): VaultEntry => vaultEntries.find((e) => e.id === id(k))!
    expect(made('s1')).toMatchObject({ kind: 'login', password: 'hunter2', username: 'root', workspaceId: 'w1' })
    expect(made('s2')).toMatchObject({ kind: 'sshkey', password: 'pp' })
    expect(made('s2').privateKey).toContain('PRIVATE KEY')
    // A `key` entry: the kind the connection-string picker lists.
    expect(made('d1')).toMatchObject({ kind: 'key', password: 'postgres://x' })
    // The values are gone from the keychain; what is not the credential stays.
    expect(JSON.parse(secrets.get('s1')!)).toEqual({ kbAnswer: '1', vaultEntryId: id('s1') })
    expect(JSON.parse(secrets.get('s2')!)).toEqual({ certificatePath: '/c-cert.pub', vaultEntryId: id('s2') })
    expect(JSON.parse(secrets.get('d1')!)).toEqual({ vaultUriEntryId: id('d1') })
    expect(keychainOnly(['s1', 's2', 'd1'])).toEqual([])
  })

  it('does nothing while the vault is not open', () => {
    stage = 'secured'
    saveData({ servers: [server()] })
    secrets.set('s1', JSON.stringify({ password: 'hunter2' }))
    const r = moveCredentialsToVault(['s1'])
    expect(r.ok).toBe(false)
    expect(vaultSave).not.toHaveBeenCalled()
    expect(JSON.parse(secrets.get('s1')!)).toEqual({ password: 'hunter2' })
  })

  it('skips a key path that is not a private key, and leaves its blob alone', () => {
    const notKey = join(userData, 'notes.txt')
    writeFileSync(notKey, 'hello')
    saveData({ servers: [server()] })
    secrets.set('s1', JSON.stringify({ keyPath: notKey }))
    const r = moveCredentialsToVault(['s1'])
    expect(r.moved).toEqual([])
    expect(r.skipped[0]!.reason).toContain('could not be read as a private key')
    expect(vaultSave).not.toHaveBeenCalled()
  })
})

describe('review findings, 2026-10-29', () => {
  it('re-saving the linked entry in the editor stores no link and confirms nothing', () => {
    land('servers', [server({ host: 'evil.example', vaultEntryId: 'v-prod' })])
    // What the editor sends on Save when it showed the synced link.
    expect(credentialToStore('s1', JSON.stringify({ vaultEntryId: 'v-prod' }))).toEqual({ store: null, confirms: false })
    // A certificate path is kept, over what this device stores, still without the link.
    secrets.set('s1', JSON.stringify({ kbAnswer: '9' }))
    const withCert = credentialToStore('s1', JSON.stringify({ vaultEntryId: 'v-prod', certificatePath: '/c' }))
    expect(withCert.confirms).toBe(false)
    expect(JSON.parse(withCert.store!)).toEqual({ kbAnswer: '9', certificatePath: '/c' })
    // Picking a different entry, or typing a password, is a choice made here.
    expect(credentialToStore('s1', JSON.stringify({ vaultEntryId: 'v-other' })).confirms).toBe(true)
    expect(credentialToStore('s1', JSON.stringify({ password: 'x' })).confirms).toBe(true)
  })

  it('a desktop password confirms the address but leaves a held link held', () => {
    land('servers', [server({ vaultEntryId: 'v-prod' })])
    secrets.set('s1:rdp', JSON.stringify({ password: 'desk' }))
    trust.confirmSecretOwner('s1:rdp')
    expect(trust.serverCredentialHeld('s1', 'prod.example')).toBe(true)
    // And the desktop's own password is not held by the SSH link.
    expect(trust.serverCredentialHeld('s1:rdp', 'prod.example')).toBe(false)
  })

  it('links already on disk when this version first runs are held, once', () => {
    // Written by an older build that kept the field and judged nothing.
    saveData({ servers: [server({ vaultEntryId: 'v-other' })], databases: [] })
    expect(trust.serverCredentialHeld('s1', 'prod.example')).toBe(false)
    trust.seedLinkMarks()
    expect(trust.serverCredentialHeld('s1', 'prod.example')).toBe(true)
    trust.confirmRecord('server', 's1')
    trust.seedLinkMarks()
    expect(trust.serverCredentialHeld('s1', 'prod.example')).toBe(false)
  })

  it('a synced flip of a database between password and connection string is held', () => {
    const db = { id: 'd1', workspaceId: 'w1', name: 'payroll', host: 'db.example', port: 5432, ssl: true, uri: false, vaultEntryId: 'v-other' }
    saveData({ databases: [db] })
    land('databases', [{ ...db, uri: true }])
    expect(() => resolveDbSecrets({ id: 'd1', host: 'db.example', port: 5432 } as never)).toThrow(trust.SyncHeldError)
  })

  it('a legacy bare-password blob is this device own credential, not hidden by a link', () => {
    secrets.set('d1', 'plain-old-password')
    land('databases', [{ id: 'd1', name: 'x', host: 'db.example', vaultEntryId: 'v-other' }])
    expect(storedCredential('d1')).toBe('plain-old-password')
  })
})
