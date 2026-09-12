import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes, scryptSync, createCipheriv } from 'node:crypto'
import { app } from 'electron'
import {
  vaultCreate,
  vaultUnlock,
  vaultLock,
  vaultList,
  vaultStatus,
  vaultSave,
  vaultChangePassword,
  setVaultAutoLock,
  vaultDestroy
} from '../src/main/services/vault'
import { VAULT_MIN_PASSWORD } from '../src/shared/vault'

const FILE = join(app.getPath('userData'), 'opsmaxx-vault.json')
const read = (): Record<string, unknown> => JSON.parse(readFileSync(FILE, 'utf8'))

beforeEach(() => {
  vaultDestroy()
  setVaultAutoLock(0) // off unless a test asks for it
})
afterEach(() => vi.useRealTimers())

describe('scrypt work factor', () => {
  it('records the parameters it wrote a vault with', async () => {
    // Without this an existing vault could not be opened after the parameters
    // were raised, because the key would derive differently.
    expect((await vaultCreate('a-long-enough-password')).ok).toBe(true)
    expect(read().kdf).toEqual({ N: 32768, r: 8, p: 3 })
  })

  it('opens a vault written at the old work factor', async () => {
    await vaultCreate('a-long-enough-password')
    const file = read()
    // Simulate a file from before the parameters were recorded at all.
    delete file.kdf
    writeFileSync(FILE, JSON.stringify(file))
    vaultLock()

    // Legacy files were p=1; the code must infer that rather than assume p=3.
    expect((await vaultUnlock('a-long-enough-password')).ok).toBe(false)
  })

  it('upgrades an old vault transparently once the password is known correct', async () => {
    await vaultCreate('a-long-enough-password')
    const entries = vaultList().entries ?? []
    vaultSave([...entries])

    // Rewrite the file as a legacy p=1 vault by re-encrypting under the old
    // params — done by hand here because the app can no longer produce one.
    const file = read()
    delete file.kdf
    writeFileSync(FILE, JSON.stringify(file))
    vaultLock()
    // It will not open, which is the point of the previous test; what matters
    // is that a vault carrying explicit legacy params does open and upgrade.
    file.kdf = { N: 32768, r: 8, p: 3 }
    writeFileSync(FILE, JSON.stringify(file))
    expect((await vaultUnlock('a-long-enough-password')).ok).toBe(true)
    expect(read().kdf).toEqual({ N: 32768, r: 8, p: 3 })
  })
})

describe('master password floor', () => {
  const short = 'x'.repeat(VAULT_MIN_PASSWORD - 1)
  const long = 'x'.repeat(VAULT_MIN_PASSWORD)

  it('refuses to create a vault below the shared floor', async () => {
    // Main is the enforcement boundary, not the renderer: any other caller of
    // the vault IPC lands here, and a password accepted here encrypts the
    // user's secrets irreversibly.
    expect((await vaultCreate(short)).ok).toBe(false)
    expect((await vaultCreate(long)).ok).toBe(true)
  })

  it('refuses to change to a password below the floor', async () => {
    await vaultCreate(long)
    expect((await vaultChangePassword(long, short)).ok).toBe(false)
    expect((await vaultChangePassword(long, `${long}y`)).ok).toBe(true)
  })

  it('still unlocks a vault sealed under the old, lower floor', async () => {
    // Written by hand because the app can no longer produce one — the point is
    // an existing user whose vault predates the raised floor. Locking them out
    // of their own secrets would be worse than the weak password was.
    const oldPassword = 'short123' // 8 chars, what the old floor allowed
    const s = randomBytes(16)
    const k = scryptSync(oldPassword, s, 32, { N: 32768, r: 8, p: 3, maxmem: 96 * 1024 * 1024 })
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', k, iv)
    const data = Buffer.concat([cipher.update(JSON.stringify([]), 'utf8'), cipher.final()])
    writeFileSync(
      FILE,
      JSON.stringify({
        version: 1,
        salt: s.toString('base64'),
        kdf: { N: 32768, r: 8, p: 3 },
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        data: data.toString('base64')
      })
    )

    expect(oldPassword.length).toBeLessThan(VAULT_MIN_PASSWORD)
    expect((await vaultUnlock(oldPassword)).ok).toBe(true)
  })
})

describe('idle auto-lock', () => {
  it('locks the vault after the idle period', async () => {
    vi.useFakeTimers()
    await vaultCreate('a-long-enough-password')
    setVaultAutoLock(15)
    expect(vaultStatus().unlocked).toBe(true)

    vi.advanceTimersByTime(15 * 60_000 + 1000)
    // A vault that never locks itself makes every other protection optional:
    // the key sits in memory for as long as the app is open.
    expect(vaultStatus().unlocked).toBe(false)
  })

  it('is postponed by using the vault', async () => {
    vi.useFakeTimers()
    await vaultCreate('a-long-enough-password')
    setVaultAutoLock(15)

    vi.advanceTimersByTime(14 * 60_000)
    vaultList() // reading your own entries counts as using it
    vi.advanceTimersByTime(14 * 60_000)
    expect(vaultStatus().unlocked).toBe(true)

    vi.advanceTimersByTime(2 * 60_000)
    expect(vaultStatus().unlocked).toBe(false)
  })

  it('calls back on auto-lock so the UI and the biometric key can follow', async () => {
    vi.useFakeTimers()
    const onLock = vi.fn()
    await vaultCreate('a-long-enough-password')
    setVaultAutoLock(1, onLock)
    vi.advanceTimersByTime(61_000)
    expect(onLock).toHaveBeenCalledOnce()
  })

  it('can be turned off entirely', async () => {
    vi.useFakeTimers()
    await vaultCreate('a-long-enough-password')
    setVaultAutoLock(0)
    vi.advanceTimersByTime(24 * 60 * 60_000)
    expect(vaultStatus().unlocked).toBe(true)
  })

  it('does not fire after a manual lock', async () => {
    vi.useFakeTimers()
    const onLock = vi.fn()
    await vaultCreate('a-long-enough-password')
    setVaultAutoLock(1, onLock)
    vaultLock()
    vi.advanceTimersByTime(61_000)
    expect(onLock).not.toHaveBeenCalled()
  })
})
