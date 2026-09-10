/**
 * What credential a server has, without any of its value.
 *
 * Added because of a report nobody could act on: a connection failing with
 * "All configured authentication methods failed", which is the SSH SERVER's
 * sentence about a credential it did not like. The app knows something the
 * server cannot — whether it sent one at all — and was not saying it, so
 * "no key is configured for this connection" and "the key is configured and
 * the account does not accept it" looked identical. The reporter's reading
 * was that "the private key mechanism is not working anymore", which is what
 * that ambiguity leads a person to conclude.
 *
 * Deliberately a SHAPE and never a value. A key PATH is already visible in the
 * connection editor, so repeating it is not a disclosure; a password, a
 * passphrase or a key's contents would be, and none of them are here.
 */
export type CredentialKind =
  /** Nothing stored. The app would dial with no credential of its own. */
  | 'none'
  /** A private key file on this machine. */
  | 'key'
  /** A password, kept in the OS keychain. */
  | 'password'
  /** An agent socket; the agent holds the key. */
  | 'agent'
  /** A vault entry, which supplies whichever of the above it holds. */
  | 'vault'

export interface CredentialShape {
  kind: CredentialKind
  /** Present for `key` only. Already shown in the editor, so not a secret. */
  keyPath?: string
  /** True when the vault holds it and the vault is currently locked. */
  vaultLocked?: boolean
  /**
   * Which vault entry, for `vault` only.
   *
   * An id, not a value — the same id the editor's credential list already
   * shows and the same one it writes back, so it discloses nothing the form
   * does not already have. It is here because without it the editor could not
   * SELECT the credential a connection already uses: the dropdown opened on
   * "Enter a new one…" for a server with a perfectly good saved credential,
   * which reads as a form that has forgotten its own state.
   */
  vaultEntryId?: string
}

/**
 * The sentence to put under an authentication failure.
 *
 * Null when there is nothing useful to add — a configured credential that the
 * server rejected is exactly what the generic message already says, and
 * repeating it in different words would be noise.
 */
export function credentialNote(shape: CredentialShape | null): string | null {
  if (!shape) return null
  switch (shape.kind) {
    case 'none':
      // The case worth the whole file. Every method failed because none was
      // offered, which no amount of checking the username will reveal.
      return 'OpsMaxx has no credential saved for this connection, so it offered none. Add a key, a password or an agent in Edit connection.'
    case 'vault':
      return shape.vaultLocked === true
        ? 'This connection authenticates from the vault, and the vault is locked, so nothing could be offered. Unlock it and try again.'
        : null
    case 'key':
      return shape.keyPath
        ? `OpsMaxx offered the private key at ${shape.keyPath}. If that key is not in this account's authorized_keys, the server refuses it whatever the username.`
        : null
    case 'agent':
      return 'OpsMaxx offered whatever keys your SSH agent holds. If the agent has none loaded, the server sees no credential at all — check with ssh-add -l.'
    default:
      return null
  }
}
