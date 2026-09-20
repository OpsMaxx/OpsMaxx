import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * A standing authorisation has to be enumerable, or it cannot be withdrawn.
 *
 * `MACHINE_ONLY_SECRET_PREFIX` buys something real — a backup that runs at
 * 03:00 after an unattended reboot — by letting one class of secret live in
 * the OS keychain rather than the vault. Two of those shipped and no screen
 * listed either.
 *
 * What is pinned here is the half that makes the list safe to show: it
 * enumerates IDS, never values. A list that leaked what it was listing would
 * undo the reason the secret is in the keychain instead of the window.
 */

const files: Record<string, string> = {}

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/opsmaxx-test' },
  safeStorage: {
    encryptString: (v: string) => Buffer.from(v, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8')
  }
}))

vi.mock('../src/main/services/secretsBackend', () => ({ secretsAvailable: () => true }))

// Both files this module writes, kept in memory and keyed by basename. The
// grants sidecar is a second file, so a mock that only knew about the first
// would have reported "no date recorded" for everything and passed.
vi.mock('node:fs', async (orig) => {
  const real = await orig<typeof import('node:fs')>()
  const key = (p: unknown): string | null => {
    const s = String(p)
    if (s.endsWith('opsmaxx-secrets.json')) return 'secrets'
    if (s.endsWith('opsmaxx-secret-grants.json')) return 'grants'
    return null
  }
  return {
    ...real,
    existsSync: (p: string) => (key(p) ? files[key(p)!] !== undefined : real.existsSync(p)),
    readFileSync: (p: string, enc?: unknown) => {
      const k = key(p)
      return k ? files[k] : real.readFileSync(p as never, enc as never)
    },
    writeFileSync: (p: string, data: string) => {
      const k = key(p)
      if (k) files[k] = data
    }
  }
})

const { MACHINE_ONLY_SECRET_PREFIX, setSecret, getSecret, deleteSecret, listMachineGrants } =
  await import('../src/main/services/secrets')
const { addySecretId } = await import('../src/main/services/addy/keys')

const BACKUP = `${MACHINE_ONLY_SECRET_PREFIX}backup-passphrase:bd-1`

beforeEach(() => {
  for (const k of Object.keys(files)) delete files[k]
})

describe('what the list shows', () => {
  it('names every machine grant and no ordinary credential', () => {
    setSecret('s-prod-1', 'an ordinary server credential')
    setSecret(BACKUP, 'correct horse battery staple')
    setSecret(addySecretId('device', 'acct-9'), 'device key material')

    expect(listMachineGrants().map((g) => g.id)).toEqual([
      `${MACHINE_ONLY_SECRET_PREFIX}addy-device:acct-9`,
      BACKUP
    ])
  })

  // The rule the whole feature rests on. Enumerating grants must not become a
  // channel that reads them.
  it('never returns a secret value', () => {
    setSecret(BACKUP, 'correct horse battery staple')
    setSecret(addySecretId('account', 'acct-9:3'), 'account key material')
    const json = JSON.stringify(listMachineGrants())
    expect(json).not.toContain('correct horse battery staple')
    expect(json).not.toContain('account key material')
    for (const g of listMachineGrants()) {
      expect(Object.keys(g).sort()).toEqual(['grantedAt', 'id', 'subject'])
    }
  })

  it('says what each id is for', () => {
    setSecret(BACKUP, 'x'.repeat(20))
    setSecret(addySecretId('account', 'acct-9:3'), 'y')
    setSecret(`${MACHINE_ONLY_SECRET_PREFIX}something-nobody-wrote-yet`, 'z')
    const by = Object.fromEntries(listMachineGrants().map((g) => [g.id, g.subject]))

    expect(by[BACKUP]).toEqual({ kind: 'backup-passphrase', destinationId: 'bd-1' })
    expect(by[`${MACHINE_ONLY_SECRET_PREFIX}addy-account:acct-9:3`]).toEqual({
      kind: 'addy',
      secretKind: 'account',
      accountId: 'acct-9'
    })
    // Unrecognised rather than guessed. The screen shows the raw id.
    expect(by[`${MACHINE_ONLY_SECRET_PREFIX}something-nobody-wrote-yet`]).toEqual({ kind: 'other' })
  })
})

describe('when it was granted', () => {
  it('records the date the grant was made', () => {
    setSecret(BACKUP, 'correct horse battery staple')
    const at = listMachineGrants()[0].grantedAt
    expect(at).toBeTypeOf('string')
    expect(Date.now() - new Date(at!).getTime()).toBeLessThan(60_000)
  })

  it('does not record one for an ordinary credential', () => {
    setSecret('s-prod-1', 'an ordinary server credential')
    expect(files.grants).toBeUndefined()
  })

  /**
   * Rotating the secret is the same standing grant with a new value in it. If
   * the date moved, a year-old authorisation would read as this morning's,
   * which is the direction that hides the thing the list exists to show.
   */
  it('keeps the first date when the secret is replaced', async () => {
    setSecret(BACKUP, 'first value')
    const first = listMachineGrants()[0].grantedAt
    await new Promise((r) => setTimeout(r, 5))
    setSecret(BACKUP, 'a rotated value')
    expect(listMachineGrants()[0].grantedAt).toBe(first)
  })

  /**
   * Every grant already on a user's machine predates this file. The list has
   * to be able to say "no date" rather than omit the row or invent one.
   */
  it('lists a grant made before dates were recorded, without a date', () => {
    setSecret(BACKUP, 'granted by an older version')
    delete files.grants
    const [g] = listMachineGrants()
    expect(g.id).toBe(BACKUP)
    expect(g.grantedAt).toBeUndefined()
  })
})

describe('revoking', () => {
  it('removes the grant and the secret behind it', () => {
    setSecret(BACKUP, 'correct horse battery staple')
    expect(listMachineGrants()).toHaveLength(1)

    deleteSecret(BACKUP)

    expect(listMachineGrants()).toEqual([])
    // Not just absent from the list: gone. A row that disappears while the
    // keychain still answers would be a revoke that revoked nothing.
    expect(getSecret(BACKUP)).toBeNull()
    expect(files.grants).not.toContain(BACKUP)
  })

  it('leaves every other grant alone', () => {
    const addy = addySecretId('device', 'acct-9')
    setSecret(BACKUP, 'one')
    setSecret(addy, 'two')
    deleteSecret(BACKUP)
    expect(listMachineGrants().map((g) => g.id)).toEqual([addy])
    expect(getSecret(addy)).toBe('two')
  })

  /**
   * The date outlives the secret otherwise, and the next grant under that id
   * would inherit a date from an authorisation the user had already withdrawn.
   */
  it('drops a date left behind by a secret that is already gone', () => {
    setSecret(BACKUP, 'one')
    files.secrets = '{}'
    deleteSecret(BACKUP)
    setSecret(BACKUP, 'granted again, today')
    const at = listMachineGrants()[0].grantedAt
    expect(Date.now() - new Date(at!).getTime()).toBeLessThan(60_000)
  })
})
