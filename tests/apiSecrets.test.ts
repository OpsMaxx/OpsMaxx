import { describe, it, expect } from 'vitest'
import {
  VAULT_ENTRY_GONE_MESSAGE,
  VAULT_LOCKED_MESSAGE,
  VaultUnavailableError,
  isVaultReference,
  parseVaultReference,
  resolveSecrets,
  resolveUrl,
  resolveValue,
  vaultReference,
  type SecretLookup
} from '../src/shared/apiSecrets'

/**
 * Vault-backed values in the API client.
 *
 * The security-relevant half of this file is the last describe block: a
 * credential must never end up anywhere it can be persisted. The rest is the
 * behaviour that makes that safe to rely on — chiefly that a request which
 * cannot resolve its secret FAILS rather than sending an empty one.
 */

const ENTRY = '8f2c4d1e-0000-4000-8000-abcdefabcdef'

const vault = (over: Partial<SecretLookup> = {}): SecretLookup => ({
  unlocked: true,
  read: ({ field }) => (field === 'username' ? 'alice' : 's3cr3t'),
  ...over
})

describe('the reference format', () => {
  it('round-trips', () => {
    const ref = vaultReference(ENTRY)
    expect(parseVaultReference(ref)).toEqual({ entryId: ENTRY, field: 'password' })
  })

  it('carries which field of the entry is wanted', () => {
    expect(parseVaultReference(vaultReference(ENTRY, 'username'))).toEqual({
      entryId: ENTRY,
      field: 'username'
    })
  })

  it('is not confused by something that merely starts the same way', () => {
    expect(isVaultReference('vault:')).toBe(false)
    expect(isVaultReference('vault:abc')).toBe(false)
    expect(isVaultReference('vault:abc#nonsense')).toBe(false)
    expect(isVaultReference('not-a-vault:abc#password')).toBe(false)
  })

  it('leaves an ordinary value alone', () => {
    expect(parseVaultReference('https://api.example.test')).toBeNull()
    expect(isVaultReference('Bearer hunter2')).toBe(false)
  })
})

describe('resolving a value', () => {
  it('replaces a reference that is the whole value', () => {
    expect(resolveValue(vaultReference(ENTRY), vault())).toBe('s3cr3t')
  })

  it('replaces one embedded in a larger value', () => {
    // How an Authorization header is actually written.
    expect(resolveValue(`Bearer ${vaultReference(ENTRY)}`, vault())).toBe('Bearer s3cr3t')
  })

  it('replaces every reference in one value', () => {
    const both = `${vaultReference(ENTRY, 'username')}:${vaultReference(ENTRY)}`
    expect(resolveValue(both, vault())).toBe('alice:s3cr3t')
  })

  it('does not touch a value with no reference in it', () => {
    const untouched = 'application/json'
    expect(resolveValue(untouched, vault())).toBe(untouched)
  })

  it('resolves references in a URL too', () => {
    const url = `https://api.example.test/?key=${vaultReference(ENTRY)}`
    expect(resolveUrl(url, vault())).toBe('https://api.example.test/?key=s3cr3t')
  })
})

describe('when the secret cannot be had', () => {
  /**
   * The whole point of throwing. Substituting an empty string sends
   * `Authorization: Bearer ` and collects a 401, which reads as a wrong
   * password — and the actual problem, a locked vault, appears nowhere.
   */
  it('refuses to send when the vault is locked', () => {
    expect(() => resolveValue(vaultReference(ENTRY), vault({ unlocked: false }))).toThrowError(
      VaultUnavailableError
    )
    expect(() => resolveValue(vaultReference(ENTRY), vault({ unlocked: false }))).toThrowError(
      VAULT_LOCKED_MESSAGE
    )
  })

  it('refuses to send when the entry has been deleted', () => {
    expect(() => resolveValue(vaultReference(ENTRY), vault({ read: () => null }))).toThrowError(
      VAULT_ENTRY_GONE_MESSAGE
    )
  })

  it('does not consult a locked vault for a value that needs nothing', () => {
    // A locked vault must not block every request, only the ones that
    // actually reference it.
    const locked = vault({
      unlocked: false,
      read: () => {
        throw new Error('must not be read')
      }
    })
    expect(resolveValue('Bearer hunter2', locked)).toBe('Bearer hunter2')
  })
})

describe('resolving a header set', () => {
  it('substitutes values and leaves names alone', () => {
    const resolved = resolveSecrets(
      { Authorization: `Bearer ${vaultReference(ENTRY)}`, Accept: 'application/json' },
      vault()
    )
    expect(resolved).toEqual({ Authorization: 'Bearer s3cr3t', Accept: 'application/json' })
  })

  it('fails the whole set if any one value cannot resolve', () => {
    // Partial resolution would send some credentials and blank others, which
    // is harder to diagnose than not sending at all.
    expect(() =>
      resolveSecrets(
        { Accept: 'application/json', Authorization: vaultReference(ENTRY) },
        vault({ unlocked: false })
      )
    ).toThrowError(VaultUnavailableError)
  })
})

describe('what reaches disk', () => {
  /**
   * This is the reason the reference format exists at all.
   *
   * The alternative design put the real token in the environment variable and
   * stripped it on the way out. That needs the filter to be right every time,
   * forever, against a structure the API client owns and reshapes between
   * versions — and one missed path leaves a bearer token in
   * `opsmaxx-data.json` and in every backup taken since.
   */
  it('keeps the secret out of anything that could be persisted', () => {
    const stored = { name: 'token', value: vaultReference(ENTRY) }
    const serialized = JSON.stringify(stored)

    expect(serialized).not.toContain('s3cr3t')
    expect(serialized).toContain('vault:')
    // What IS stored points at the entry, and is useless without the vault.
    expect(parseVaultReference(stored.value)?.entryId).toBe(ENTRY)
  })

  it('resolves only in memory, leaving the stored value unchanged', () => {
    const stored = { name: 'token', value: vaultReference(ENTRY) }
    const sent = resolveValue(stored.value, vault())

    expect(sent).toBe('s3cr3t')
    // The document still holds the reference. Resolution must not write back.
    expect(stored.value).toBe(vaultReference(ENTRY))
  })
})
