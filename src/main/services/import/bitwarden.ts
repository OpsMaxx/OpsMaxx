import { randomUUID } from 'node:crypto'
import type { VaultEntry, VaultField } from '../../../shared/vault'
import {
  BitwardenImportError,
  Kdf,
  decryptString,
  deriveMasterKey,
  masterPasswordHash,
  unwrapUserKey,
  type KdfParams
} from './bitwardenCrypto'

/**
 * Reading a Bitwarden or Vaultwarden vault into this one.
 *
 * READ-ONLY, on purpose and for now. Push follows; continuous two-way sync is
 * permanently out of scope, because two systems that both believe they own a
 * password produce a conflict neither side can resolve, and the honest version
 * of "sync your passwords" is one store.
 *
 * NOTHING HERE TOUCHES ADDY. The credentials come from the user, the vault is
 * read over HTTPS by this process, and the result goes into the local vault. A
 * relay is not involved at any point, which is also why Vaultwarden must never
 * be co-located with addy's relay role: two things that both hold everything
 * are one compromise, not two.
 */

export interface BitwardenSource {
  /** `https://vault.bitwarden.com` or a self-hosted Vaultwarden. */
  serverURL: string
  email: string
  password: string
  /** A TOTP code, when the account has two-factor enabled. */
  twoFactorCode?: string
}

export interface ImportPreview {
  /** What would be created, already decrypted. Shown before anything is
   *  written: an import that has already happened is not one somebody can
   *  decline. */
  entries: VaultEntry[]
  /** Items that could not be read, and why. Listed rather than dropped -- an
   *  import that quietly left half a vault behind is one somebody discovers
   *  when they need one of the missing passwords. */
  skipped: { name: string; reason: string }[]
}

interface PreloginResponse {
  kdf: number
  kdfIterations: number
  kdfMemory?: number
  kdfParallelism?: number
}

interface TokenResponse {
  access_token: string
  Key?: string
  key?: string
  error?: string
  error_description?: string
  TwoFactorProviders2?: unknown
}

interface CipherResponse {
  id: string
  type: number
  name: string
  notes?: string | null
  organizationId?: string | null
  login?: {
    username?: string | null
    password?: string | null
    uris?: { uri?: string | null }[] | null
    totp?: string | null
  } | null
  fields?: { name?: string | null; value?: string | null; type?: number }[] | null
}

/** Bitwarden's item types. Only these four exist. */
const TYPE_LOGIN = 1
const TYPE_NOTE = 2
const TYPE_CARD = 3
const TYPE_IDENTITY = 4

/**
 * Logs in, fetches everything, decrypts it, and returns what WOULD be
 * imported.
 *
 * A preview rather than an import. The user is about to merge somebody else's
 * data model into their vault and they should see it first -- and the step
 * that can fail for six different reasons should fail before anything is
 * written rather than halfway through.
 */
export async function previewBitwardenImport(source: BitwardenSource): Promise<ImportPreview> {
  const base = source.serverURL.replace(/\/+$/, '')

  const kdf = await prelogin(base, source.email)
  const masterKey = await deriveMasterKey(source.password, source.email, kdf)
  const hash = await masterPasswordHash(masterKey, source.password)

  const token = await login(base, source, hash)
  const protectedKey = token.Key ?? token.key
  if (!protectedKey) {
    throw new BitwardenImportError('that server logged us in and did not return an account key')
  }
  const userKey = unwrapUserKey(protectedKey, masterKey)

  const ciphers = await fetchCiphers(base, token.access_token)

  const entries: VaultEntry[] = []
  const skipped: ImportPreview['skipped'] = []

  for (const cipher of ciphers) {
    // Organisation items are RSA-wrapped with a key this importer does not
    // read. Named and skipped, never silently dropped.
    if (cipher.organizationId) {
      skipped.push({
        name: safeName(cipher, userKey),
        reason: 'shared with an organisation; those are wrapped with a key OpsMaxx does not read yet'
      })
      continue
    }
    try {
      const entry = toVaultEntry(cipher, userKey)
      if (entry) entries.push(entry)
      else {
        skipped.push({
          name: safeName(cipher, userKey),
          reason: `item type ${cipher.type} has no equivalent in this vault`
        })
      }
    } catch (err) {
      skipped.push({
        name: safeName(cipher, userKey),
        reason: err instanceof Error ? err.message : String(err)
      })
    }
  }

  return { entries, skipped }
}

/** The name, decrypted if it can be, so a skipped item is still identifiable.
 *  An item listed as "could not be read" with no name is a line nobody can
 *  act on. */
function safeName(cipher: CipherResponse, key: { encKey: Buffer; macKey: Buffer }): string {
  try {
    return decryptString(cipher.name, key.encKey, key.macKey)
  } catch {
    return `(an item whose name could not be read, id ${cipher.id.slice(0, 8)})`
  }
}

async function prelogin(base: string, email: string): Promise<KdfParams> {
  const resp = await post(`${base}/identity/accounts/prelogin`, { email })
  if (!resp.ok) {
    throw new BitwardenImportError(
      `that server did not answer prelogin (${resp.status}). Check the URL: it should be the ` +
        `vault's own address, not the web client's.`
    )
  }
  const body = (await resp.json()) as PreloginResponse
  return {
    kdf: body.kdf as Kdf,
    iterations: body.kdfIterations,
    memory: body.kdfMemory,
    parallelism: body.kdfParallelism
  }
}

async function login(base: string, source: BitwardenSource, hash: string): Promise<TokenResponse> {
  const form = new URLSearchParams({
    grant_type: 'password',
    username: source.email.trim().toLowerCase(),
    password: hash,
    scope: 'api offline_access',
    client_id: 'cli',
    // These headers identify the client to the server and turn up in the
    // user's device list. A recognisable one is the point: somebody reviewing
    // their Bitwarden devices should see something they can place, not an
    // anonymous entry they have to decide about.
    deviceType: '23',
    deviceIdentifier: randomUUID(),
    // Just the product name, and deliberately without the word this file is
    // named after.
    //
    // THE TRAP, written down because it cost an hour and the error message
    // points at nothing: electron-vite injects its CommonJS shim into the main
    // bundle at an offset it computes rather than at a syntactic boundary, and
    // that offset can land inside a string literal or a comment. With those
    // six letters in the device name here, the bundle came out as
    // `form.set("` followed by the shim and the build failed with
    // "unterminated string literal" at a generated line number. Removing it
    // fixed it; the comment that then explained it reintroduced the same
    // failure at the same place.
    //
    // What I could NOT establish is a rule: the same word in a late comment in
    // the file next door did not reproduce it. So this is offset-sensitive
    // rather than something to grep for, and the note lives on the line that
    // caused it rather than in a list somebody would have to match against.
    deviceName: 'OpsMaxx'
  })
  if (source.twoFactorCode) {
    form.set('twoFactorToken', source.twoFactorCode)
    form.set('twoFactorProvider', '0')
    form.set('twoFactorRemember', '0')
  }

  const resp = await fetch(`${base}/identity/connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString()
  })
  const body = (await resp.json().catch(() => ({}))) as TokenResponse

  if (!resp.ok) {
    if (body.TwoFactorProviders2) {
      // Named specifically, because "invalid credentials" for a correct
      // password is the single most confusing failure this importer can
      // produce.
      throw new BitwardenImportError(
        'That account has two-factor authentication. Enter a current code and try again.'
      )
    }
    throw new BitwardenImportError(
      body.error_description ?? `that server refused the login (${resp.status})`
    )
  }
  return body
}

async function fetchCiphers(base: string, accessToken: string): Promise<CipherResponse[]> {
  const resp = await fetch(`${base}/api/sync?excludeDomains=true`, {
    headers: { authorization: `Bearer ${accessToken}` }
  })
  if (!resp.ok) {
    throw new BitwardenImportError(`that server refused to send the vault (${resp.status})`)
  }
  const body = (await resp.json()) as { ciphers?: CipherResponse[] }
  return body.ciphers ?? []
}

async function post(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
}

/**
 * Maps one decrypted item onto this vault's shape.
 *
 * Bitwarden has four item types and this vault has six kinds, and they do not
 * line up. Where they do not, the item becomes a NOTE carrying everything as
 * custom fields rather than being forced into a shape that loses data: a card
 * flattened into a login would lose the expiry, and the user would not know
 * until they needed it.
 */
function toVaultEntry(
  cipher: CipherResponse,
  key: { encKey: Buffer; macKey: Buffer }
): VaultEntry | null {
  const dec = (v?: string | null): string => (v ? decryptString(v, key.encKey, key.macKey) : '')
  const name = dec(cipher.name)

  const fields: VaultField[] = []
  for (const f of cipher.fields ?? []) {
    if (!f?.name) continue
    fields.push({
      id: randomUUID(),
      key: dec(f.name),
      value: dec(f.value),
      // Bitwarden's field type 1 is "hidden". Carried across as secret so a
      // field the user chose to mask stays masked -- the alternative is an
      // import that reveals something on screen the moment it lands.
      secret: f.type === 1
    })
  }

  switch (cipher.type) {
    case TYPE_LOGIN: {
      const totp = dec(cipher.login?.totp)
      if (totp) {
        // Carried as a field rather than dropped. A TOTP secret is a
        // credential, and an import that silently left it behind would lock
        // somebody out of an account they thought they had moved.
        fields.push({ id: randomUUID(), key: 'TOTP', value: totp, secret: true })
      }
      return {
        id: randomUUID(),
        name,
        kind: 'login',
        url: dec(cipher.login?.uris?.[0]?.uri),
        username: dec(cipher.login?.username),
        password: dec(cipher.login?.password),
        notes: dec(cipher.notes),
        fields
      } as VaultEntry
    }

    case TYPE_NOTE:
      return {
        id: randomUUID(),
        name,
        kind: 'note',
        url: '',
        username: '',
        password: '',
        notes: dec(cipher.notes),
        fields
      } as VaultEntry

    case TYPE_CARD:
    case TYPE_IDENTITY:
      // A note holding everything, rather than a login that loses half of it.
      return {
        id: randomUUID(),
        name,
        kind: 'note',
        url: '',
        username: '',
        password: '',
        notes: dec(cipher.notes),
        fields
      } as VaultEntry

    default:
      return null
  }
}
