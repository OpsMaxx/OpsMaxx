import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The estate was the one thing left in the clear on disk.
//
// opsmaxx-data.json holds every hostname, port, username, label and folder.
// The same bytes are sealed under the epoch key when addy carries them to a
// relay, and under AES-256-GCM inside a backup bundle. Only on the local
// disk — where they spend all of their time — were they readable by anything
// running as the user.
//
// It is sealed with the OS secure store and NOT with the vault's master
// password, and that is a workflow decision as much as a crypto one: the
// server list has to render while the vault is locked, because seeing your
// servers is how you decide to unlock.

const userData = mkdtempSync(join(tmpdir(), 'opsmaxx-atrest-'))
const DATA = join(userData, 'opsmaxx-data.json')
const BAK = `${DATA}.bak`

// Flipped per test. `available: false` is a Linux box with no keyring;
// `throws: true` is safeStorage raising instead of answering, which it can do
// before app.ready and while a Linux backend is still being resolved.
const keychain = { available: true, throws: false }
// Electron's `app.isReady()`. Before it, safeStorage refuses to decrypt.
const app = { ready: true }

vi.mock('electron', () => ({
  app: {
    getPath: (): string => userData,
    getVersion: (): string => '0.0.0-test',
    isReady: (): boolean => app.ready
  },
  safeStorage: {
    isEncryptionAvailable: (): boolean => {
      if (keychain.throws) throw new Error('keychain is not ready')
      return keychain.available
    },
    // A reversible stand-in, not encryption: what these tests check is that the
    // estate goes through the sealing path at all, and comes back.
    encryptString: (v: string): Buffer => Buffer.from(`SEALED:${v}`, 'utf8'),
    decryptString: (b: Buffer): string => {
      if (!app.ready) throw new Error('safeStorage cannot be used before app is ready')
      const s = b.toString('utf8')
      if (!s.startsWith('SEALED:')) throw new Error('not sealed by this machine')
      return s.slice('SEALED:'.length)
    }
  }
}))

const { loadData, saveData, dataFileExists, dataAtRest, resetStoreMigrationForTests } =
  await import('../src/main/services/store')

const ESTATE = { servers: [{ id: 's1', host: 'k3s-node-01.internal', user: 'deploy', port: 22 }] }

beforeEach(() => {
  rmSync(DATA, { force: true })
  rmSync(BAK, { force: true })
  keychain.available = true
  keychain.throws = false
  app.ready = true
  resetStoreMigrationForTests()
})

describe('a read before the app is ready', () => {
  // Found on every launch with an existing profile: main read the data file at
  // module scope, before `ready`. safeStorage threw, the store filed that as a
  // corrupt primary, went to the backup, failed there too, and answered null —
  // "this machine has nothing". Four modules came up off, and anything that
  // saved on that answer would have written an empty estate over a real one.
  it('is refused, without calling the primary unreadable or touching the backup', () => {
    saveData(ESTATE)
    saveData(ESTATE) // a second save, so the backup exists too
    const primary = readFileSync(DATA, 'utf8')
    const backup = readFileSync(BAK, 'utf8')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      app.ready = false
      expect(() => loadData()).toThrow(/before app is ready/)
      expect(error).not.toHaveBeenCalled()
      expect(readFileSync(DATA, 'utf8')).toBe(primary)
      expect(readFileSync(BAK, 'utf8')).toBe(backup)
    } finally {
      error.mockRestore()
    }
    // And the same file opens normally once the app is up.
    app.ready = true
    expect(loadData()).toEqual(ESTATE)
  })
})

describe('the estate on disk', () => {
  it('is not readable as text once saved', () => {
    saveData(ESTATE)
    const raw = readFileSync(DATA, 'utf8')
    // The point of the whole change: a copied folder, a Time Machine snapshot
    // or a support bundle no longer hands over the infrastructure map.
    expect(raw).not.toContain('k3s-node-01.internal')
    expect(raw).not.toContain('deploy')
    // Still JSON, so anything that parses this file without understanding it
    // gets an object rather than a syntax error — and an object that is
    // obviously not a server list, rather than half of one.
    expect(() => JSON.parse(raw)).not.toThrow()
    expect(JSON.parse(raw)).toMatchObject({ v: 1 })
  })

  it('comes back exactly as it went in', () => {
    saveData(ESTATE)
    expect(loadData()).toEqual(ESTATE)
  })
})

describe('a file written before any of this existed', () => {
  it('still opens', () => {
    writeFileSync(DATA, JSON.stringify(ESTATE))
    expect(loadData()).toEqual(ESTATE)
  })

  it('is sealed on the first read, not on the next edit', () => {
    // A user who opens OpsMaxx to look at a server and closes it again has
    // changed nothing, and "your estate is encrypted, as soon as you edit
    // something" is not a property anyone can rely on.
    writeFileSync(DATA, JSON.stringify(ESTATE))
    loadData()
    expect(readFileSync(DATA, 'utf8')).not.toContain('k3s-node-01.internal')
    expect(loadData()).toEqual(ESTATE)
  })

  it('takes its backup with it', () => {
    // saveData copies the live file to .bak before each write, so sealing only
    // the primary would leave the last plaintext copy of the whole estate
    // beside it indefinitely, under a name that says it is a backup. Sealing a
    // file and leaving its shadow readable is not sealing it.
    writeFileSync(DATA, JSON.stringify(ESTATE))
    writeFileSync(BAK, JSON.stringify(ESTATE))
    loadData()
    expect(readFileSync(BAK, 'utf8')).not.toContain('k3s-node-01.internal')
    // Sealed, not deleted: the backup exists so one bad write cannot lose the
    // estate, and that has to stay true through the migration itself.
    expect(existsSync(BAK)).toBe(true)
    writeFileSync(DATA, 'not json at all')
    expect(loadData()).toEqual(ESTATE)
  })

  it('is left alone when there is no keychain to seal it with', () => {
    keychain.available = false
    writeFileSync(DATA, JSON.stringify(ESTATE))
    expect(loadData()).toEqual(ESTATE)
    expect(readFileSync(DATA, 'utf8')).toContain('k3s-node-01.internal')
  })
})

describe('a file this machine cannot open', () => {
  // A restored copy of somebody else's folder, or this folder after a keychain
  // reset. THE STATE THAT MATTERS: it must land on the same side as corrupt,
  // never on the side of "this machine has nothing" — because that answer is
  // what sync uses to decide whether to write. A corrupt file once read as
  // empty, so every collection was adopted from the relay and the blob rebuilt
  // from {}, destroying settings, tabs and every key with no relay copy.
  beforeEach(() => writeFileSync(DATA, JSON.stringify({ v: 1, enc: Buffer.from('someone else').toString('base64') })))

  it('reads as nothing, so no panel renders half an estate', () => {
    expect(loadData()).toBeNull()
  })

  it('is still reported as PRESENT, which is what stops sync overwriting it', () => {
    expect(dataFileExists()).toBe(true)
  })

  it('falls back to the backup when there is a good one', () => {
    // Built the way the app builds it: a good save, then its copy, then the
    // primary goes bad underneath. (Note what saveData does NOT protect
    // against — it copies the live file to .bak before each write, so a save
    // made while the primary is already corrupt puts the corruption in the
    // backup too. That is why blobKey refuses to write at all when loadData
    // returns null and the file exists.)
    saveData(ESTATE)
    writeFileSync(BAK, readFileSync(DATA, 'utf8'))
    writeFileSync(DATA, JSON.stringify({ v: 1, enc: Buffer.from('still not ours').toString('base64') }))
    expect(loadData()).toEqual(ESTATE)
  })
})

describe('a machine with no OS secure store', () => {
  it('still saves, because the alternative is an app that cannot be used', () => {
    // secrets.ts REFUSES to persist when the keychain is unavailable, and that
    // is right for a credential: not saving one costs a retype. This file is
    // the whole application state, so the same rule would brick a keyring-less
    // Linux box in the name of protecting it.
    keychain.available = false
    saveData(ESTATE)
    expect(loadData()).toEqual(ESTATE)
  })

  it('says so, rather than letting anyone believe otherwise', () => {
    keychain.available = false
    saveData(ESTATE)
    expect(dataAtRest().reason).toMatch(/unavailable/i)
  })

  it('treats a keychain that throws the same as one that says no', () => {
    // safeStorage can raise rather than answer. Letting that escape would send
    // the exception to saveData's catch, which logs to a console nobody reads
    // and returns — and the user's edit would be gone with the app still
    // showing it on screen.
    keychain.throws = true
    saveData(ESTATE)
    expect(loadData()).toEqual(ESTATE)
    expect(dataAtRest().reason).toMatch(/could not be reached/i)
  })

  it('clears the warning once sealing works again', () => {
    keychain.available = false
    saveData(ESTATE)
    expect(dataAtRest().reason).not.toBeNull()
    keychain.available = true
    saveData(ESTATE)
    expect(dataAtRest().reason).toBeNull()
    expect(readFileSync(DATA, 'utf8')).not.toContain('k3s-node-01.internal')
  })
})

describe('a machine that has never saved', () => {
  it('is not mistaken for a broken one', () => {
    expect(existsSync(DATA)).toBe(false)
    expect(loadData()).toBeNull()
    expect(dataFileExists()).toBe(false)
  })
})
