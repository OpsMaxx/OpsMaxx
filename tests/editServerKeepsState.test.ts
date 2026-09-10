import { describe, it, expect } from 'vitest'
import type { CredentialShape } from '../src/shared/credentialShape'

/**
 * Opening Edit on a connection shows what that connection has.
 *
 * Reported as the editor showing default fields instead of the configured
 * ones. Most of the form did restore — name, host, port, username, the auth
 * method, the VPN transport — but the credential block did not: the dropdown
 * opened on "Enter a new one…" and the private-key box showed the same empty
 * placeholder a brand new connection shows.
 *
 * Nothing was ever lost. A blank box on save means "keep what is stored", and
 * the save path only writes a secret when something was typed. It LOOKED like
 * loss, which for a credential is bad enough: it invites retyping something
 * that was never gone, and it makes "nothing is configured" and "something is,
 * elsewhere" the same sentence — which is the one distinction this part of the
 * form exists to draw.
 */

/** The rule the effect applies when the shape comes back. */
function selectionFor(shape: CredentialShape | null, current: string): string {
  // Only when the answer names an entry AND the box is still untouched. The
  // read is async and somebody can pick before it lands; overwriting then is
  // the form fighting the person using it.
  if (shape?.kind === 'vault' && shape.vaultEntryId && current === '') return shape.vaultEntryId
  return current
}

/** The rule the private-key placeholder applies. */
function credentialPlaceholder(editId: string | null, stored: CredentialShape | null): string {
  const fresh = '~/.ssh/id_ed25519 — leave empty to use your default key'
  if (!editId || !stored) return fresh
  switch (stored.kind) {
    case 'key':
      return stored.keyPath ? `Using ${stored.keyPath} — leave blank to keep it` : fresh
    case 'vault':
      return 'Using the saved credential above — leave blank to keep it'
    case 'password':
      return 'A password is saved for this connection — leave blank to keep it'
    case 'agent':
      return 'Your SSH agent holds the key — leave blank to keep using it'
    default:
      return fresh
  }
}

describe('the credential dropdown', () => {
  it('selects the vault entry the connection already uses', () => {
    expect(selectionFor({ kind: 'vault', vaultEntryId: 'ent-7' }, '')).toBe('ent-7')
  })

  it('leaves a choice made while the read was in flight alone', () => {
    // The read is async and the user can pick before it lands. Overwriting
    // then would be the form fighting the person using it.
    expect(selectionFor({ kind: 'vault', vaultEntryId: 'ent-7' }, 'ent-9')).toBe('ent-9')
  })

  it('does not invent a selection for a credential that is not a vault entry', () => {
    expect(selectionFor({ kind: 'key', keyPath: '/home/o/.ssh/id_ed25519' }, '')).toBe('')
    expect(selectionFor({ kind: 'none' }, '')).toBe('')
    expect(selectionFor(null, '')).toBe('')
  })

  it('says nothing about a locked vault it cannot read past', () => {
    // The entry id is known even while the vault is locked — it is an id, not
    // a value — so the selection still restores and the form does not demand a
    // credential it already has.
    expect(selectionFor({ kind: 'vault', vaultEntryId: 'ent-3', vaultLocked: true }, '')).toBe('ent-3')
  })
})

describe('the private-key placeholder', () => {
  it('names the key when there is one', () => {
    expect(credentialPlaceholder('s1', { kind: 'key', keyPath: '/k/id_ed25519' })).toMatch(
      /Using \/k\/id_ed25519/
    )
  })

  it('says a credential exists for every other kind that has one', () => {
    // The gap: only `key` was covered, so a vault-backed connection looked
    // identical to one with nothing saved at all.
    for (const kind of ['vault', 'password', 'agent'] as const) {
      const text = credentialPlaceholder('s1', { kind })
      expect(text, kind).toMatch(/leave blank to keep|keep using it/)
      expect(text, kind).not.toContain('leave empty to use your default key')
    }
  })

  it('offers the fresh prompt when there really is nothing', () => {
    expect(credentialPlaceholder('s1', { kind: 'none' })).toContain('leave empty to use your default key')
  })

  it('offers the fresh prompt for a brand new connection', () => {
    expect(credentialPlaceholder(null, null)).toContain('leave empty to use your default key')
  })
})

describe('what the shape is allowed to carry', () => {
  it('carries an id and never a value', () => {
    // The whole file's rule. An entry id is what the editor's own list already
    // shows and what it writes back; a password, a passphrase or a key's
    // contents would be a disclosure.
    const shape: CredentialShape = { kind: 'vault', vaultEntryId: 'ent-1' }
    expect(Object.keys(shape).sort()).toEqual(['kind', 'vaultEntryId'])
    expect(JSON.stringify(shape)).not.toMatch(/password|passphrase|PRIVATE KEY/i)
  })
})
