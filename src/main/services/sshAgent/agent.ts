import { createHash } from 'node:crypto'
import { utils as sshUtils } from 'ssh2'
import { AGENT, EXTENSION, SIGN_FLAGS, type AgentIdentity } from '../../../shared/sshAgentHost'
import type { VaultEntry } from '../../../shared/vault'
import {
  EXTENSION_FAILURE,
  FAILURE,
  Reader,
  Writer,
  extensionQueryAnswer,
  frame,
  identitiesAnswer,
  signResponse
} from './protocol'
import type { SigningPolicy } from './policy'

/**
 * The agent itself: one request in, one reply out, no sockets.
 *
 * Deliberately transport-free. The listeners -- a Unix socket, a Windows named
 * pipe -- differ in everything except what they carry, and a core that took a
 * socket would have to be tested through one. This takes a Buffer and returns
 * a Buffer, so every case below is a unit test with no file system in it.
 */

interface LoadedKey {
  identity: AgentIdentity
  /** ssh2's parsed key. `null` when the entry could not be parsed, in which
   *  case `identity.problem` says why and the key is offered but unusable. */
  parsed: ReturnType<typeof sshUtils.parseKey> extends Error ? never : any
}

/** `SHA256:…`, exactly as `ssh-keygen -l` prints it: base64, padding stripped.
 *  The user compares this against what they see elsewhere, so it has to match
 *  character for character or it is worse than no fingerprint. */
export function fingerprintOf(publicKeyBlob: Buffer): string {
  return 'SHA256:' + createHash('sha256').update(publicKeyBlob).digest('base64').replace(/=+$/, '')
}

/**
 * Turns vault entries into keys this agent can offer.
 *
 * A key that will not parse is OFFERED WITH ITS REASON rather than dropped.
 * The commonest cause is an entry whose secret slot is not the key's
 * passphrase, and a key that silently vanishes from `ssh-add -l` is a support
 * ticket; one that appears with "the passphrase does not open this key" is a
 * thing the user fixes in ten seconds.
 */
export function loadKeys(entries: VaultEntry[]): LoadedKey[] {
  const out: LoadedKey[] = []
  for (const entry of entries) {
    if (entry.kind !== 'sshkey' || !entry.privateKey) continue

    const parsed = sshUtils.parseKey(entry.privateKey, entry.password || undefined)
    if (parsed instanceof Error) {
      out.push({
        identity: {
          entryId: entry.id,
          name: entry.name,
          publicKeyBase64: '',
          keyType: 'unknown',
          fingerprint: '',
          problem: parsed.message
        },
        parsed: null
      })
      continue
    }
    const key = Array.isArray(parsed) ? parsed[0] : parsed
    const blob = key.getPublicSSH()
    out.push({
      identity: {
        entryId: entry.id,
        name: entry.name,
        publicKeyBase64: blob.toString('base64'),
        keyType: key.type,
        fingerprint: fingerprintOf(blob)
      },
      parsed: key
    })
  }
  return out
}

/** What a connection remembers between messages. */
export interface SessionState {
  /** Set by `session-bind@openssh.com`. */
  destination?: { hostKeyFingerprint: string; forwarded: boolean }
}

export interface AgentDeps {
  /** The keys to offer, read fresh on every REQUEST_IDENTITIES: the vault can
   *  lock, unlock or gain an entry between one request and the next, and a
   *  list cached at startup would go on offering a key the user just deleted. */
  keys(): LoadedKey[]
  policy(): SigningPolicy
  /** False when the agent must not sign at all -- the vault is locked, or is
   *  `secured` and the user asked for that to be enough. Checked before the
   *  policy, so a locked vault never produces a prompt. */
  canSign(): boolean
  log?(message: string): void
}

/**
 * Handles one request.
 *
 * Returns the bytes to write back. Never throws: a malformed request gets
 * FAILURE, because an agent that closes the connection on bad input is an
 * agent that a probing client can use to distinguish "no such key" from
 * "parse error".
 */
export async function handleMessage(
  body: Buffer,
  session: SessionState,
  deps: AgentDeps
): Promise<Buffer> {
  if (body.length === 0) return FAILURE
  const r = new Reader(body)
  let type: number
  try {
    type = r.byte()
  } catch {
    return FAILURE
  }

  try {
    switch (type) {
      case AGENT.REQUEST_IDENTITIES:
        return identitiesAnswer(
          deps
            .keys()
            // A key that will not parse cannot be signed with, so offering it
            // on the wire would produce a signature failure later instead of a
            // clear absence now. The UI shows it with its reason; the protocol
            // does not.
            .filter((k) => k.parsed && k.identity.publicKeyBase64)
            .map((k) => ({
              blob: Buffer.from(k.identity.publicKeyBase64, 'base64'),
              comment: k.identity.name
            }))
        )

      case AGENT.SIGN_REQUEST:
        return await handleSign(r, session, deps)

      case AGENT.EXTENSION:
        return handleExtension(r, session, deps)

      // Every key-management message. Refused, and this is the one refusal
      // worth being explicit about: an agent that accepts ADD_IDENTITY becomes
      // a second key store beside the vault, holding material the vault never
      // saw, surviving no restart and appearing in no backup. The vault is the
      // store; this is a window onto it.
      case AGENT.ADD_IDENTITY:
      case AGENT.ADD_ID_CONSTRAINED:
      case AGENT.REMOVE_IDENTITY:
      case AGENT.REMOVE_ALL_IDENTITIES:
      case AGENT.ADD_SMARTCARD_KEY:
      case AGENT.ADD_SMARTCARD_KEY_CONSTRAINED:
      case AGENT.REMOVE_SMARTCARD_KEY:
        deps.log?.(`refused agent message ${type}: this agent does not store keys`)
        return FAILURE

      // The agent protocol's own lock. Refused because the vault's lock is the
      // lock: a second one that could disagree with it would be a second thing
      // to explain and a second thing to get wrong.
      case AGENT.LOCK:
      case AGENT.UNLOCK:
        return FAILURE

      default:
        return FAILURE
    }
  } catch {
    return FAILURE
  }
}

async function handleSign(r: Reader, session: SessionState, deps: AgentDeps): Promise<Buffer> {
  const wanted = r.blob()
  const data = r.blob()
  const flags = r.uint32()

  const key = deps.keys().find(
    (k) =>
      k.parsed &&
      k.identity.publicKeyBase64 &&
      Buffer.from(k.identity.publicKeyBase64, 'base64').equals(wanted)
  )
  if (!key) return FAILURE

  // Before the policy, so a locked vault never produces a prompt. A prompt
  // that appears and then cannot succeed teaches people to dismiss prompts.
  if (!deps.canSign()) {
    deps.log?.('refused a signature: the vault is not in a state that permits signing')
    return FAILURE
  }

  const allowed = await deps.policy().allow({
    identity: key.identity,
    destination: session.destination
  })
  if (!allowed) return FAILURE

  // RSA signs SHA-1 by default and no current server accepts that, so a client
  // asks for better with these flags. Honouring them is not optional in
  // practice: an agent that ignores them offers RSA keys that never
  // authenticate anywhere, which looks like a broken key rather than a broken
  // agent.
  let algorithm: string | undefined
  if (key.identity.keyType === 'ssh-rsa') {
    if (flags & SIGN_FLAGS.RSA_SHA2_512) algorithm = 'rsa-sha2-512'
    else if (flags & SIGN_FLAGS.RSA_SHA2_256) algorithm = 'rsa-sha2-256'
  }

  const raw = algorithm ? key.parsed.sign(data, algorithm) : key.parsed.sign(data)
  if (raw instanceof Error) {
    deps.log?.(`signing failed: ${raw.message}`)
    return FAILURE
  }

  // The wire form is `string algorithm || string signature`. ssh2 returns the
  // raw signature, so the algorithm name is prepended here -- and it must be
  // the one actually used, not the key's type, or a server verifying an
  // rsa-sha2-512 signature against ssh-rsa rejects it.
  const name = algorithm ?? key.identity.keyType
  return signResponse(new Writer().blob(name).blob(raw).body())
}

function handleExtension(r: Reader, session: SessionState, deps: AgentDeps): Buffer {
  const name = r.str()

  if (name === EXTENSION.QUERY) {
    // OpenSSH probes before using any extension, so an agent that fails here
    // never gets asked to session-bind -- and then cannot tell where a
    // signature is going, which is the one thing that makes forwarding safe.
    return extensionQueryAnswer([EXTENSION.SESSION_BIND, EXTENSION.QUERY])
  }

  if (name === EXTENSION.SESSION_BIND) {
    // `string hostkey || string session identifier || string signature ||
    //  bool is_forwarding`
    const hostKey = r.blob()
    r.blob() // session identifier: bound to the connection, not used here
    r.blob() // signature over it, verified by the client's own host-key check
    const forwarding = r.bool()

    // Recorded rather than verified. Verifying the signature would prove the
    // client holds the session -- but the client is the party this agent is
    // already trusting to tell the truth about its own connection, and a
    // client that lied would simply omit the bind instead. What this buys is
    // the ability to SHOW the user where a signature is going and to always
    // re-prompt when it is a forwarded hop.
    session.destination = {
      hostKeyFingerprint: fingerprintOf(hostKey),
      forwarded: forwarding
    }
    return frame(Buffer.from([AGENT.SUCCESS]))
  }

  // restrict-destination-v00 and everything else. EXTENSION_FAILURE rather
  // than FAILURE, which is what tells a client the agent is alive and simply
  // does not implement this one.
  deps.log?.(`unimplemented agent extension: ${name}`)
  return EXTENSION_FAILURE
}
