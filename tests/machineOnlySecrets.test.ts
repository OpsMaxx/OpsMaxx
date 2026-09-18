import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * The passphrase a scheduled backup encrypts WITH must never be inside a
 * backup.
 *
 * This is the whole argument the vault requirement was built on: the settings
 * blob travels inside every bundle, so a passphrase kept there would ship
 * inside the file it protects, which is the same as shipping no passphrase at
 * all. The obvious workaround — "put it in the OS keychain like every server
 * credential" — fails for exactly the same reason, and that is the part worth
 * a test rather than a comment: `buildBundle` includes `exportSecrets()`, which
 * walks EVERY keychain entry.
 *
 * So there is one reserved prefix that `exportSecrets` refuses to emit. That
 * carve-out has to be honoured forever by anything that ever walks the
 * keychain, and "forever" is what this file is for.
 */

const store: Record<string, string> = {}

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/opsmaxx-test' },
  safeStorage: {
    encryptString: (v: string) => Buffer.from(v, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8')
  }
}))

vi.mock('../src/main/services/secretsBackend', () => ({ secretsAvailable: () => true }))

vi.mock('node:fs', async (orig) => {
  const real = await orig<typeof import('node:fs')>()
  return {
    ...real,
    existsSync: () => true,
    readFileSync: (p: string, enc?: unknown) =>
      String(p).endsWith('opsmaxx-secrets.json')
        ? JSON.stringify(store)
        : real.readFileSync(p as never, enc as never),
    writeFileSync: (p: string, data: string) => {
      if (!String(p).endsWith('opsmaxx-secrets.json')) return
      for (const k of Object.keys(store)) delete store[k]
      Object.assign(store, JSON.parse(data))
    }
  }
})

const secrets = await import('../src/main/services/secrets')
const { MACHINE_ONLY_SECRET_PREFIX, exportSecrets, importSecrets, setSecret, getSecret } = secrets
// Imported after the mocks, like `secrets` itself: it reaches the keychain
// through that module and would otherwise bind the real one.
const { ADDY_SECRET_KINDS, addySecretId, addyAccountSecretId, storeAddySecret, loadAddySecret } =
  await import('../src/main/services/addy/keys')

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k]
})

describe('what a bundle is allowed to carry', () => {
  it('carries an ordinary credential', () => {
    setSecret('s-prod-1', 'a server credential')
    expect(exportSecrets()['s-prod-1']).toBe('a server credential')
  })

  // The one that matters. A bundle containing the passphrase it is encrypted
  // under is a bundle with no passphrase.
  it('never carries a machine-only secret', () => {
    setSecret(`${MACHINE_ONLY_SECRET_PREFIX}backup-passphrase:bd-1`, 'correct horse battery')
    const out = exportSecrets()
    expect(Object.keys(out)).not.toContain(`${MACHINE_ONLY_SECRET_PREFIX}backup-passphrase:bd-1`)
    expect(JSON.stringify(out)).not.toContain('correct horse battery')
  })

  it('leaves it readable on the machine that holds it', () => {
    const id = `${MACHINE_ONLY_SECRET_PREFIX}backup-passphrase:bd-1`
    setSecret(id, 'correct horse battery')
    // Excluded from the bundle, not from the app: the scheduler has to be able
    // to read it, which is the entire point of storing it.
    expect(getSecret(id)).toBe('correct horse battery')
  })

  it('carries the others even when one is reserved', () => {
    setSecret('s-prod-1', 'a server credential')
    setSecret(`${MACHINE_ONLY_SECRET_PREFIX}backup-passphrase:bd-1`, 'secret')
    expect(Object.keys(exportSecrets())).toEqual(['s-prod-1'])
  })
})

describe('what a restore is allowed to write', () => {
  /**
   * Belt as well as braces. Nothing should be able to get one of these into a
   * bundle, and a bundle that somehow carries one — hand-edited, or written by
   * a future version that forgot — must not overwrite this machine's own
   * passphrase with another machine's.
   */
  it('refuses to import one', () => {
    const id = `${MACHINE_ONLY_SECRET_PREFIX}backup-passphrase:bd-1`
    setSecret(id, 'this machine')
    importSecrets({ [id]: 'some other machine', 's-prod-1': 'fine' })
    expect(getSecret(id)).toBe('this machine')
    expect(getSecret('s-prod-1')).toBe('fine')
  })
})

describe("addy's keys are not in a bundle either", () => {
  /**
   * addy's premise is that the server holds no key. That premise survives a
   * compromised relay and dies to a bundle, which collects every credential
   * the app holds, seals it under one passphrase, and is then designed to be
   * copied somewhere else -- a bucket, an SFTP host, a second laptop.
   *
   * Per kind, against the real `exportSecrets`, rather than reading the prefix
   * off the id and calling it proved. The prefix is how it works; this is
   * whether it works.
   */
  it.each(ADDY_SECRET_KINDS)('keeps the %s key out of the bundle', (kind) => {
    storeAddySecret(kind, 'acct-1', `the ${kind} key`)
    // Still readable here -- excluded from the bundle, not from the app.
    expect(loadAddySecret(kind, 'acct-1')).toBe(`the ${kind} key`)
    expect(Object.keys(exportSecrets())).not.toContain(addySecretId(kind, 'acct-1'))
  })

  it('refuses one that arrives in a bundle anyway', () => {
    // Belt as well as braces, and the direction that matters most for the
    // device key: a bundle that carried one must not be able to install
    // another machine's identity here. Two machines answering to one roster
    // entry is the state revocation cannot express.
    const id = addySecretId('device', 'acct-1')
    importSecrets({ [id]: "another machine's device key" })
    expect(getSecret(id)).toBeNull()
  })

  it('gives each epoch its own account key rather than overwriting', () => {
    // Both are held at once during a transition: objects re-sealed under n+1
    // land before the signed transition entry does, so a client still reading
    // n needs n. An id that ignored the epoch would drop one of them.
    storeAddySecret('account', 'acct-1:7', 'AK_7')
    storeAddySecret('account', 'acct-1:8', 'AK_8')
    expect(getSecret(addyAccountSecretId('acct-1', 7))).toBe('AK_7')
    expect(getSecret(addyAccountSecretId('acct-1', 8))).toBe('AK_8')
  })

  it('builds every addy id from the prefix, with no second path', () => {
    // The file-level half: a future key stored with a hand-written id would
    // pass every test above by simply not being in ADDY_SECRET_KINDS.
    const src = readFileSync(resolve(__dirname, '..', 'src/main/services/addy/keys.ts'), 'utf8')
    expect(src).toContain('`${MACHINE_ONLY_SECRET_PREFIX}addy-${kind}:${scope}`')
    // One builder. Every other id in the module goes through `addySecretId`,
    // so there is a single place the prefix can be dropped from -- and a
    // second interpolation of it is a second path that has to be argued for in
    // a diff rather than added quietly.
    expect(src.match(/\$\{MACHINE_ONLY_SECRET_PREFIX\}/g)?.length).toBe(1)
  })
})

describe('the prefix cannot collide with a real id', () => {
  /**
   * The exclusion is the only thing standing between a scheduled passphrase and
   * the bundle it protects, and it is a string comparison. If a server or
   * database id could ever start with this prefix, that server's credential
   * would silently stop being backed up — the failure would be a restore, months
   * later, missing one credential and saying nothing about it.
   *
   * Two underscores, because ids in this app are generated from a timestamp and
   * random suffix and none of them can begin that way.
   */
  it('starts with a sequence no generated id produces', () => {
    expect(MACHINE_ONLY_SECRET_PREFIX.startsWith('__')).toBe(true)
  })

  it('does not swallow an id that merely mentions backup', () => {
    // The guard is a PREFIX test, not a substring one: a destination called
    // "backup-passphrase" must still have its own credential exported.
    setSecret('bd-backup-passphrase', 'an ordinary database credential')
    expect(exportSecrets()['bd-backup-passphrase']).toBe('an ordinary database credential')
  })

  it('is what the scheduled passphrase id is actually built from', () => {
    const backup = readFileSync(resolve(__dirname, '..', 'src/main/services/backup.ts'), 'utf8')
    expect(backup).toContain('`${MACHINE_ONLY_SECRET_PREFIX}backup-passphrase:${destinationId}`')
  })
})

describe('the exclusion is where it has to be', () => {
  const SRC = readFileSync(resolve(__dirname, '..', 'src/main/services/secrets.ts'), 'utf8')

  it('sits inside exportSecrets, not at some call site', () => {
    // A caller-side filter would be one every future caller had to remember.
    const i = SRC.indexOf('export function exportSecrets')
    expect(SRC.slice(i, i + 400)).toContain('if (isMachineOnlySecret(id)) continue')
  })

  it('is the only thing a bundle gets its secrets from', () => {
    const backup = readFileSync(resolve(__dirname, '..', 'src/main/services/backup.ts'), 'utf8')
    const i = backup.indexOf('const payload: BackupPayload')
    expect(backup.slice(i, i + 400)).toContain('secrets: exportSecrets()')
  })
})
