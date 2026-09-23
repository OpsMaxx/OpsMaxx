/**
 * Environment variables that hold a credential.
 *
 * ── The shape, and why it is a string ──────────────────────────────────────
 *
 * The API client's environment variable is `{ name, value }`, where value is a
 * string (or an object carrying a `default` string). There is no "secret"
 * flag, and adding one would mean extending a schema the library validates and
 * re-validates on every import and export.
 *
 * So a secret variable stores a REFERENCE as its value:
 *
 *     vault:8f2c…#password
 *
 * It is an ordinary string, so it survives the client's own validation, its
 * import and its export untouched. It is resolved from the vault at the moment
 * a request is sent, and never before.
 *
 * ── Why a reference rather than the value ──────────────────────────────────
 *
 * The alternative — put the real token in the variable and strip it on the way
 * out — needs the filter to be correct every time, forever, on a structure the
 * library owns and reshapes between versions. One missed path and a bearer
 * token is sitting in `opsmaxx-data.json` and in every backup taken since.
 *
 * A reference cannot leak that way, because the secret is never in the
 * document to begin with. It is the same trade `Server` and the CI/CD
 * connections already make: the record names the vault entry, and only the
 * process that can open the vault ever sees the credential.
 */

/**
 * `vault:<entryId>#<field>`.
 *
 * The id is a UUID as the vault writes them; the field says which slot of the
 * entry to read, because one entry can carry both a username and a password
 * and a request usually wants one of them.
 */
const REFERENCE = /^vault:([A-Za-z0-9_-]{1,64})#(password|username)$/

export type VaultField = 'password' | 'username'

export interface VaultReference {
  entryId: string
  field: VaultField
}

export function vaultReference(entryId: string, field: VaultField = 'password'): string {
  return `vault:${entryId}#${field}`
}

/** The reference a value carries, or null when it is an ordinary value. */
export function parseVaultReference(value: string): VaultReference | null {
  const match = REFERENCE.exec(value.trim())
  return match ? { entryId: match[1], field: match[2] as VaultField } : null
}

export function isVaultReference(value: string): boolean {
  return parseVaultReference(value) !== null
}

/** Raised when a request needs a secret and the vault cannot supply it. */
export class VaultUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VaultUnavailableError'
  }
}

export const VAULT_LOCKED_MESSAGE =
  'This request uses a value from the vault, and the vault is locked — unlock it to send.'

export const VAULT_ENTRY_GONE_MESSAGE =
  'This request uses a vault entry that no longer exists. Point the variable at another entry, or remove it.'

/** What `resolveSecrets` needs from the vault: one lookup, no more. */
export interface SecretLookup {
  /** The vault's state. A locked vault cannot be read and must not be guessed at. */
  unlocked: boolean
  /** The value of one field of one entry, or null when the entry is gone. */
  read: (reference: VaultReference) => string | null
}

/**
 * Replace every `vault:` reference in a set of header values.
 *
 * **Where references resolve.** Headers, URLs, auth fields and STRUCTURED body
 * rows (urlencoded and multipart text values), each of which is a slot the
 * user filled deliberately. Never free-text bodies (JSON, XML, text, GraphQL
 * variables): substituting into those would mean scanning user content for a
 * pattern and rewriting it, and a response that echoed the body would then
 * round-trip a real token back into view. `shared/apiRequestBuild.ts` applies
 * this rule; this module only substitutes what it is handed.
 *
 * Throws rather than substituting an empty string. A request that silently
 * sends `Authorization: Bearer ` gets a 401 that looks like a wrong password,
 * and the actual problem — a locked vault — is nowhere on screen.
 */
export function resolveSecrets(
  headers: Record<string, string>,
  vault: SecretLookup
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    out[name] = resolveValue(value, vault)
  }
  return out
}

/**
 * One value, with any embedded references replaced.
 *
 * A reference can be the whole value (`vault:…#password`) or sit inside one
 * (`Bearer vault:…#password`), because that is how somebody writes an
 * Authorization header.
 */
export function resolveValue(value: string, vault: SecretLookup): string {
  if (!value.includes('vault:')) return value

  return value.replace(/vault:[A-Za-z0-9_-]{1,64}#(?:password|username)/g, (token) => {
    const reference = parseVaultReference(token)
    if (!reference) return token
    if (!vault.unlocked) throw new VaultUnavailableError(VAULT_LOCKED_MESSAGE)
    const secret = vault.read(reference)
    if (secret === null) throw new VaultUnavailableError(VAULT_ENTRY_GONE_MESSAGE)
    return secret
  })
}

/**
 * Whether a URL carries a reference, so the caller can resolve it too.
 *
 * Separate from the substitution because a URL has to be resolved before it is
 * parsed, and the caller owns that order.
 */
export function resolveUrl(url: string, vault: SecretLookup): string {
  return resolveValue(url, vault)
}
