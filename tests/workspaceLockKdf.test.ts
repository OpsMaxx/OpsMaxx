import { describe, it, expect } from 'vitest'
import { app } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { scryptSync, randomBytes } from 'node:crypto'
import { wsLockSet, wsLockVerify, wsLockRemove } from '../src/main/services/wslock'

// The workspace verifier was the last scrypt in the app still at p=1.
//
// vault.ts and backup.ts were raised to p=3 on OWASP's guidance — N=2^15 is
// adequate only at p=3 — and this one was left behind with no note saying why,
// which is the state where nobody can tell a decision from an oversight.
//
// It matters less than the vault's and it matters. The file gates the UI and
// encrypts nothing, so an attacker holding it can read the workspace's servers
// out of opsmaxx-data.json without cracking anything. What a cheap verifier
// leaks is the PASSWORD, and people reuse those — the one on a workspace may
// be the one on the vault next door.
//
// Raising the number alone would have been a lockout rather than a hardening,
// because this file recorded no parameters: every stored verifier would have
// stopped matching, indistinguishably from a wrong password. So the lock now
// carries the parameters it was written with, the way the vault file does.

const FILE = (): string => join(app.getPath('userData'), 'opsmaxx-wslocks.json')
const readLocks = (): Record<string, { salt: string; hash: string; kdf?: { N: number; r: number; p: number } }> =>
  JSON.parse(readFileSync(FILE(), 'utf8'))

const PASSWORD = 'correct horse battery'

describe('the workspace lock work factor', () => {
  it('writes new locks at the same parameters as the vault', async () => {
    expect((await wsLockSet('ws-new', PASSWORD)).ok).toBe(true)
    expect(readLocks()['ws-new'].kdf).toEqual({ N: 32768, r: 8, p: 3 })

    // Pinned against vault.ts rather than against a literal here, so the two
    // cannot drift apart again without this failing.
    const vault = readFileSync('src/main/services/vault.ts', 'utf8')
    const ws = readFileSync('src/main/services/wslock.ts', 'utf8')
    const kdfLine = (src: string): string => src.match(/^const KDF = .*$/m)?.[0] ?? ''
    expect(kdfLine(ws)).toBe(kdfLine(vault))
    await wsLockRemove('ws-new', PASSWORD)
  })

  it('still verifies a lock written before parameters were recorded', async () => {
    // Exactly the on-disk shape of the old file: salt and hash, no kdf key.
    const salt = randomBytes(16)
    const legacy = scryptSync(PASSWORD, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 })
    const map = { 'ws-legacy': { salt: salt.toString('base64'), hash: legacy.toString('base64') } }
    writeFileSync(FILE(), JSON.stringify(map))

    expect(await wsLockVerify('ws-legacy', PASSWORD)).toBe(true)
    expect(await wsLockVerify('ws-legacy', 'wrong password entirely')).toBe(false)
  })

  it('upgrades that lock in place, once the password is known correct', async () => {
    const salt = randomBytes(16)
    const legacy = scryptSync(PASSWORD, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 })
    const map = { 'ws-up': { salt: salt.toString('base64'), hash: legacy.toString('base64') } }
    writeFileSync(FILE(), JSON.stringify(map))

    expect(await wsLockVerify('ws-up', PASSWORD)).toBe(true)

    const after = readLocks()['ws-up']
    expect(after.kdf).toEqual({ N: 32768, r: 8, p: 3 })
    // Same salt, new hash: this is a re-derivation, not a new password.
    expect(after.salt).toBe(salt.toString('base64'))
    expect(after.hash).not.toBe(legacy.toString('base64'))
    // And the password still works through the upgraded verifier.
    expect(await wsLockVerify('ws-up', PASSWORD)).toBe(true)
    expect(await wsLockVerify('ws-up', 'wrong password entirely')).toBe(false)
  })

  it('does not upgrade on a wrong password', async () => {
    // The re-derivation needs the plaintext, so it can only happen on the
    // success path. Writing on a failure would mean a wrong guess could
    // replace a verifier it never matched.
    const salt = randomBytes(16)
    const legacy = scryptSync(PASSWORD, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 })
    const map = { 'ws-bad': { salt: salt.toString('base64'), hash: legacy.toString('base64') } }
    writeFileSync(FILE(), JSON.stringify(map))

    expect(await wsLockVerify('ws-bad', 'not it')).toBe(false)
    expect(readLocks()['ws-bad']).toEqual(map['ws-bad'])
  })

  it('leaves a workspace with no lock open', async () => {
    writeFileSync(FILE(), JSON.stringify({}))
    expect(await wsLockVerify('ws-absent', '')).toBe(true)
  })
})
