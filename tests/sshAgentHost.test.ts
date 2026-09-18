import { describe, it, expect, vi } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { utils as sshUtils } from 'ssh2'
import { AGENT, EXTENSION, SIGN_FLAGS, DEFAULT_SSH_AGENT_SETTINGS } from '../src/shared/sshAgentHost'
import { MessageStream, ProtocolError, Reader, Writer, frame } from '../src/main/services/sshAgent/protocol'
import { fingerprintOf, handleMessage, loadKeys } from '../src/main/services/sshAgent/agent'
import { DefaultSigningPolicy, REFUSE_ALL } from '../src/main/services/sshAgent/policy'
import type { VaultEntry } from '../src/shared/vault'

/**
 * The agent OpsMaxx serves.
 *
 * A key in the vault that no other tool can reach is a key people keep a
 * second copy of in ~/.ssh, and then the vault protects nothing. These tests
 * are about the two halves that make the agent safe to run: it never signs
 * without the policy saying so, and it never becomes a second key store.
 */

/**
 * RSA in PKCS#1 PEM, which is what ssh2 actually parses.
 *
 * NOT ed25519 in PKCS#8: `generateKeyPairSync('ed25519')` emits that and ssh2
 * answers "Unsupported key format", because the OpenSSH world writes ed25519
 * in its own container and only `ssh-keygen` produces it. A first draft of
 * these tests used it and the failure looked like a broken agent rather than a
 * broken fixture.
 *
 * RSA is also the more interesting case here: it is the one with a hash
 * negotiation to get wrong.
 */
const KEYS = new Map<string, string>()
function rsaKey(name: string): string {
  const held = KEYS.get(name)
  if (held) return held
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' }
  })
  KEYS.set(name, privateKey)
  return privateKey
}

function keyEntry(name = 'Production key'): VaultEntry {
  return {
    id: 'v-' + name.replace(/\W/g, ''),
    name,
    kind: 'sshkey',
    url: '',
    username: 'root',
    password: '',
    privateKey: rsaKey(name)
  } as VaultEntry
}

function entries(): VaultEntry[] {
  return [
    keyEntry('Production key'),
    { id: 'v-login', name: 'A login', kind: 'login', url: '', username: 'u', password: 'p' } as VaultEntry
  ]
}

function deps(over: Partial<Parameters<typeof handleMessage>[2]> = {}): Parameters<typeof handleMessage>[2] {
  const keys = loadKeys(entries())
  return {
    keys: () => keys,
    policy: () => ({ allow: async () => true, forgetAll: () => {} }),
    canSign: () => true,
    ...over
  }
}

const request = (type: number, body?: Buffer): Buffer =>
  body ? Buffer.concat([Buffer.from([type]), body]) : Buffer.from([type])

/** Strips the outer length prefix a reply carries. */
const replyBody = (reply: Buffer): Buffer => reply.subarray(4)

describe('what the agent offers', () => {
  it('lists SSH keys and nothing else from the vault', async () => {
    const reply = await handleMessage(request(AGENT.REQUEST_IDENTITIES), {}, deps())
    const r = new Reader(replyBody(reply))
    expect(r.byte()).toBe(AGENT.IDENTITIES_ANSWER)
    // The login entry is in the vault and is not an SSH key.
    expect(r.uint32()).toBe(1)
    r.blob() // key blob
    expect(r.str()).toBe('Production key')
  })

  it('offers an unparseable key to the UI with its reason, but not on the wire', async () => {
    const broken = { ...keyEntry('Broken key'), privateKey: 'not a key at all' } as VaultEntry
    const loaded = loadKeys([broken])
    // A key that silently vanishes from `ssh-add -l` is a support ticket; one
    // that appears with "the passphrase does not open this key" is fixed in
    // ten seconds.
    expect(loaded).toHaveLength(1)
    expect(loaded[0].identity.problem).toBeTruthy()

    // But it cannot be signed with, so putting it on the wire would turn a
    // clear absence now into a signature failure later.
    const reply = await handleMessage(
      request(AGENT.REQUEST_IDENTITIES),
      {},
      deps({ keys: () => loaded })
    )
    const r = new Reader(replyBody(reply))
    r.byte()
    expect(r.uint32()).toBe(0)
  })

  it('reads the key list fresh on every request', async () => {
    const keys = vi.fn(() => loadKeys(entries()))
    const d = deps({ keys })
    await handleMessage(request(AGENT.REQUEST_IDENTITIES), {}, d)
    await handleMessage(request(AGENT.REQUEST_IDENTITIES), {}, d)
    // A list cached at startup goes on offering a key the user just deleted.
    expect(keys.mock.calls.length).toBeGreaterThanOrEqual(2)
  })
})

describe('signing', () => {
  function signRequest(blob: Buffer, data: Buffer, flags = 0): Buffer {
    return request(AGENT.SIGN_REQUEST, new Writer().blob(blob).blob(data).uint32(flags).body())
  }

  it('produces a signature a verifier accepts', async () => {
    const loaded = loadKeys([keyEntry()])
    const blob = Buffer.from(loaded[0].identity.publicKeyBase64, 'base64')
    const data = Buffer.from('the session identifier and everything after it')

    const reply = await handleMessage(signRequest(blob, data), {}, deps({ keys: () => loaded }))
    const r = new Reader(replyBody(reply))
    expect(r.byte()).toBe(AGENT.SIGN_RESPONSE)

    const sig = new Reader(r.blob())
    expect(sig.str()).toBe('ssh-rsa')
    const raw = sig.blob()

    // Verified with the public half, through the same library a server would
    // use. A test that only checked the bytes came back non-empty would pass
    // against an agent that signed the wrong thing.
    const pub = sshUtils.parseKey(blob)
    if (pub instanceof Error) throw pub
    // No algorithm argument: ssh2's third parameter is a DIGEST name, not a
    // key type, and the default for an ssh-rsa key is the sha1 this signature
    // used. Passing 'ssh-rsa' there gets "Invalid digest".
    expect((Array.isArray(pub) ? pub[0] : pub).verify(data, raw)).toBe(true)
  })

  it('refuses a key it was never given', async () => {
    const stranger = loadKeys([keyEntry('Somebody else')])[0]
    const blob = Buffer.from(stranger.identity.publicKeyBase64, 'base64')
    const reply = await handleMessage(signRequest(blob, Buffer.from('x')), {}, deps())
    expect(replyBody(reply)[0]).toBe(AGENT.FAILURE)
  })

  it('refuses before prompting when the vault cannot sign', async () => {
    const loaded = loadKeys([keyEntry()])
    const blob = Buffer.from(loaded[0].identity.publicKeyBase64, 'base64')
    const allow = vi.fn(async () => true)

    const reply = await handleMessage(
      signRequest(blob, Buffer.from('x')),
      {},
      deps({ keys: () => loaded, canSign: () => false, policy: () => ({ allow, forgetAll: () => {} }) })
    )
    expect(replyBody(reply)[0]).toBe(AGENT.FAILURE)
    // A prompt that appears and then cannot succeed teaches people to dismiss
    // prompts, which is the one habit this feature cannot afford.
    expect(allow).not.toHaveBeenCalled()
  })

  it('refuses when the policy says no', async () => {
    const loaded = loadKeys([keyEntry()])
    const blob = Buffer.from(loaded[0].identity.publicKeyBase64, 'base64')
    const reply = await handleMessage(
      signRequest(blob, Buffer.from('x')),
      {},
      deps({ keys: () => loaded, policy: () => REFUSE_ALL })
    )
    expect(replyBody(reply)[0]).toBe(AGENT.FAILURE)
  })
})

describe('what the agent refuses to become', () => {
  it('will not store a key', async () => {
    // An agent that accepts ADD_IDENTITY is a second key store beside the
    // vault, holding material the vault never saw, surviving no restart and
    // appearing in no backup.
    for (const type of [
      AGENT.ADD_IDENTITY,
      AGENT.ADD_ID_CONSTRAINED,
      AGENT.REMOVE_IDENTITY,
      AGENT.REMOVE_ALL_IDENTITIES,
      AGENT.ADD_SMARTCARD_KEY,
      AGENT.REMOVE_SMARTCARD_KEY
    ]) {
      const reply = await handleMessage(request(type), {}, deps())
      expect(replyBody(reply)[0], `message ${type} was not refused`).toBe(AGENT.FAILURE)
    }
  })

  it('will not hold a second lock', async () => {
    // The vault's lock is the lock. A second one that could disagree with it
    // is a second thing to explain and a second thing to get wrong.
    for (const type of [AGENT.LOCK, AGENT.UNLOCK]) {
      const reply = await handleMessage(request(type), {}, deps())
      expect(replyBody(reply)[0]).toBe(AGENT.FAILURE)
    }
  })

  it('answers FAILURE rather than closing on a malformed request', async () => {
    // Closing the connection on bad input would let a probing client
    // distinguish "no such key" from "parse error".
    for (const body of [Buffer.alloc(0), Buffer.from([AGENT.SIGN_REQUEST]), Buffer.from([0xff])]) {
      const reply = await handleMessage(body, {}, deps())
      expect(replyBody(reply)[0]).toBe(AGENT.FAILURE)
    }
  })
})

describe('session-bind', () => {
  it('is announced, so OpenSSH will use it', async () => {
    // OpenSSH probes before using any extension. An agent that fails the query
    // never gets asked to bind, and then cannot tell where a signature is
    // going -- which is the one thing that makes forwarding safe.
    const reply = await handleMessage(
      request(AGENT.EXTENSION, new Writer().blob(EXTENSION.QUERY).body()),
      {},
      deps()
    )
    const r = new Reader(replyBody(reply))
    expect(r.byte()).toBe(AGENT.SUCCESS)
    const names: string[] = []
    while (!r.atEnd) names.push(r.str())
    expect(names).toContain(EXTENSION.SESSION_BIND)
  })

  it('records where the signature is going', async () => {
    const hostKey = Buffer.from('a host key blob')
    const session = {}
    const body = new Writer()
      .blob(EXTENSION.SESSION_BIND)
      .blob(hostKey)
      .blob(Buffer.from('session id'))
      .blob(Buffer.from('signature'))
      .byte(1)
      .body()

    const reply = await handleMessage(request(AGENT.EXTENSION, body), session, deps())
    expect(replyBody(reply)[0]).toBe(AGENT.SUCCESS)
    expect(session).toEqual({
      destination: { hostKeyFingerprint: fingerprintOf(hostKey), forwarded: true }
    })
  })

  it('says EXTENSION_FAILURE for one it does not implement', async () => {
    // Not FAILURE, which is what tells a client the agent is alive and simply
    // does not have this one.
    const reply = await handleMessage(
      request(AGENT.EXTENSION, new Writer().blob(EXTENSION.RESTRICT_DESTINATION).body()),
      {},
      deps()
    )
    expect(replyBody(reply)[0]).toBe(AGENT.EXTENSION_FAILURE)
  })
})

describe('the policy', () => {
  const identity = { entryId: 'v-1', name: 'Production key', publicKeyBase64: '', keyType: 'ssh-rsa', fingerprint: '' }

  it('asks every time by default', async () => {
    const ask = vi.fn(async () => ({ allow: true as const, scope: 'once' as const }))
    const p = new DefaultSigningPolicy({ ask }, () => DEFAULT_SSH_AGENT_SETTINGS)
    await p.allow({ identity })
    await p.allow({ identity })
    expect(ask).toHaveBeenCalledTimes(2)
  })

  it('remembers a window, and asks again once it passes', async () => {
    let now = 1_000_000
    const ask = vi.fn(async () => ({ allow: true as const, scope: 'window' as const }))
    const p = new DefaultSigningPolicy({ ask }, () => ({ ...DEFAULT_SSH_AGENT_SETTINGS, windowMinutes: 15 }), () => now)

    expect(await p.allow({ identity })).toBe(true)
    now += 60_000
    expect(await p.allow({ identity })).toBe(true)
    expect(ask).toHaveBeenCalledTimes(1)

    now += 15 * 60_000
    expect(await p.allow({ identity })).toBe(true)
    expect(ask).toHaveBeenCalledTimes(2)
  })

  it('can refuse for the rest of the session once a window runs out', async () => {
    // The second of the two settings, and the reason they are two: "how long
    // does this last" and "what happens when it runs out" have different right
    // answers, and one field forces one of them on somebody who wanted the
    // other.
    let now = 1_000_000
    const ask = vi.fn(async () => ({ allow: true as const, scope: 'window' as const }))
    const p = new DefaultSigningPolicy(
      { ask },
      () => ({ ...DEFAULT_SSH_AGENT_SETTINGS, windowMinutes: 1, onExpiry: 'refuse' }),
      () => now
    )

    expect(await p.allow({ identity })).toBe(true)
    now += 2 * 60_000
    expect(await p.allow({ identity })).toBe(false)
    // Inert, without anyone having to remember to revoke it, and not asked
    // about again.
    expect(await p.allow({ identity })).toBe(false)
    expect(ask).toHaveBeenCalledTimes(1)
  })

  it('asks every time for a forwarded connection, whatever is remembered', async () => {
    const ask = vi.fn(async () => ({ allow: true as const, scope: 'session' as const }))
    const p = new DefaultSigningPolicy({ ask }, () => DEFAULT_SSH_AGENT_SETTINGS)

    // Approved for the session, locally.
    expect(await p.allow({ identity })).toBe(true)
    expect(await p.allow({ identity })).toBe(true)
    expect(ask).toHaveBeenCalledTimes(1)

    // An approval for a signature the user started on their own machine is not
    // consent for one started by whatever is running on the host they
    // forwarded to.
    const forwarded = { identity, destination: { hostKeyFingerprint: 'SHA256:x', forwarded: true } }
    expect(await p.allow(forwarded)).toBe(true)
    expect(ask).toHaveBeenCalledTimes(2)
  })

  it('forgets everything when the vault locks', async () => {
    const ask = vi.fn(async () => ({ allow: true as const, scope: 'session' as const }))
    const p = new DefaultSigningPolicy({ ask }, () => DEFAULT_SSH_AGENT_SETTINGS)
    await p.allow({ identity })
    p.forgetAll()
    await p.allow({ identity })
    expect(ask).toHaveBeenCalledTimes(2)
  })

  it('defaults to the most annoying option', () => {
    // Somebody who finds it annoying turns it down having understood what they
    // traded. Somebody who never notices it was permissive has not.
    expect(DEFAULT_SSH_AGENT_SETTINGS.defaultScope).toBe('once')
    expect(DEFAULT_SSH_AGENT_SETTINGS.enabled).toBe(false)
  })
})

describe('framing', () => {
  it('reassembles a message split across chunks', () => {
    const s = new MessageStream()
    const msg = frame(Buffer.from([AGENT.REQUEST_IDENTITIES]))
    expect(s.push(msg.subarray(0, 2))).toEqual([])
    expect(s.push(msg.subarray(2, 4))).toEqual([])
    expect(s.push(msg.subarray(4))).toEqual([Buffer.from([AGENT.REQUEST_IDENTITIES])])
  })

  it('splits several messages delivered in one chunk', () => {
    // A client that sends two requests without waiting desynchronises any
    // implementation that assumes a chunk is a message -- for the life of the
    // connection.
    const s = new MessageStream()
    const one = frame(Buffer.from([AGENT.REQUEST_IDENTITIES]))
    const two = frame(Buffer.from([AGENT.EXTENSION]))
    expect(s.push(Buffer.concat([one, two]))).toHaveLength(2)
  })

  it('refuses a length nobody could mean', () => {
    // The length prefix is the first thing off the socket and is entirely
    // attacker-controlled. Without a cap, 0xffffffff is an instruction to
    // allocate four gigabytes, from any local process that can reach us.
    const s = new MessageStream()
    const huge = Buffer.alloc(4)
    huge.writeUInt32BE(0xffffffff)
    expect(() => s.push(huge)).toThrow(ProtocolError)
  })

  it('refuses a field that claims more than the message holds', () => {
    const b = Buffer.alloc(8)
    b.writeUInt32BE(1000, 0)
    expect(() => new Reader(b).blob()).toThrow(ProtocolError)
  })
})

describe('fingerprints', () => {
  it('match what ssh-keygen prints', () => {
    // The user compares this against what they see elsewhere, so it has to
    // match character for character or it is worse than no fingerprint:
    // base64, padding stripped, SHA256: prefix.
    const fp = fingerprintOf(Buffer.from('some public key blob'))
    expect(fp).toMatch(/^SHA256:[A-Za-z0-9+/]+$/)
    expect(fp.endsWith('=')).toBe(false)
  })
})

describe('RSA hash negotiation', () => {
  function signRequest(blob: Buffer, data: Buffer, flags: number): Buffer {
    return request(AGENT.SIGN_REQUEST, new Writer().blob(blob).blob(data).uint32(flags).body())
  }

  // RSA signs SHA-1 by default and no current server accepts that. An agent
  // that ignores these flags offers RSA keys that never authenticate anywhere,
  // which looks like a broken key rather than a broken agent -- so the user
  // deletes the key and the bug survives.
  it.each([
    [SIGN_FLAGS.RSA_SHA2_512, 'rsa-sha2-512'],
    [SIGN_FLAGS.RSA_SHA2_256, 'rsa-sha2-256'],
    [0, 'ssh-rsa']
  ])('signs as %s when asked', async (flags, expected) => {
    const loaded = loadKeys([keyEntry()])
    const blob = Buffer.from(loaded[0].identity.publicKeyBase64, 'base64')
    const data = Buffer.from('what a server asked us to sign')

    const reply = await handleMessage(signRequest(blob, data, flags), {}, deps({ keys: () => loaded }))
    const r = new Reader(replyBody(reply))
    expect(r.byte()).toBe(AGENT.SIGN_RESPONSE)
    const sig = new Reader(r.blob())

    // The name on the wire must be the algorithm ACTUALLY USED, not the key's
    // type: a server verifying an rsa-sha2-512 signature against `ssh-rsa`
    // rejects it, and the failure surfaces as a rejected login with no clue.
    expect(sig.str()).toBe(expected)

    const raw = sig.blob()
    const pub = sshUtils.parseKey(blob)
    if (pub instanceof Error) throw pub
    const digest = expected === 'rsa-sha2-512' ? 'sha512' : expected === 'rsa-sha2-256' ? 'sha256' : undefined
    expect((Array.isArray(pub) ? pub[0] : pub).verify(data, raw, digest)).toBe(true)
  })

  it('512 wins when a client sets both flags', async () => {
    const loaded = loadKeys([keyEntry()])
    const blob = Buffer.from(loaded[0].identity.publicKeyBase64, 'base64')
    const reply = await handleMessage(
      signRequest(blob, Buffer.from('x'), SIGN_FLAGS.RSA_SHA2_256 | SIGN_FLAGS.RSA_SHA2_512),
      {},
      deps({ keys: () => loaded })
    )
    const r = new Reader(replyBody(reply))
    r.byte()
    expect(new Reader(r.blob()).str()).toBe('rsa-sha2-512')
  })
})
