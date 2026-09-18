/**
 * The SSH agent protocol, as this app SERVES it.
 *
 * Not to be confused with `sshAgent.ts` next door, which is the other
 * direction: that one resolves which agent OpsMaxx should TALK TO for a given
 * host. This one is the agent OpsMaxx IS. The two never meet, and the name is
 * the only thing keeping them apart -- so if you are looking for
 * `IdentityAgent` handling, it is the other file.
 *
 * Implemented from the published specification -- `draft-miller-ssh-agent`,
 * plus OpenSSH's `session-bind@openssh.com` and
 * `restrict-destination-v00@openssh.com` extensions -- and from nobody's
 * source. OpenSSH's own agent is BSD-licensed and would be usable; the
 * implementations people usually reach for when reading "how does this work"
 * are not, and this repository is MIT with a CI test that fails on a GPL
 * dependency. Reading a wire format out of an RFC is also simply the right way
 * to get a wire format.
 *
 * WHAT THIS IS FOR. OpsMaxx already holds SSH private keys, encrypted, in its
 * own vault. Every other tool on the machine -- git, rsync, ansible, a
 * terminal the user opened themselves -- reaches keys through an agent socket.
 * Without one, a key in the vault is a key only OpsMaxx can use, so people keep
 * a second copy in `~/.ssh` and the vault protects nothing. With one, the vault
 * becomes the place the key actually lives.
 *
 * It works with no addy at all, which is why the plan calls it the biggest
 * single win in the harvest and why it is not in `src/shared/addy.ts`.
 */

/** Message numbers. From the draft's IANA-style registry; the ones this agent
 *  implements and the ones it deliberately refuses are both listed, because a
 *  reader's first question is which is which. */
export const AGENT = {
  // Generic replies.
  FAILURE: 5,
  SUCCESS: 6,

  // What a client sends, and what this agent answers.
  REQUEST_IDENTITIES: 11,
  IDENTITIES_ANSWER: 12,
  SIGN_REQUEST: 13,
  SIGN_RESPONSE: 14,

  // Key management. REFUSED, every one of them, and not because they are hard.
  // An agent that accepts ADD_IDENTITY is a second key store beside the vault,
  // holding material the vault never saw, surviving no restart and appearing in
  // no backup. The vault is the store; this is a window onto it.
  ADD_IDENTITY: 17,
  REMOVE_IDENTITY: 18,
  REMOVE_ALL_IDENTITIES: 19,
  ADD_ID_CONSTRAINED: 25,
  ADD_SMARTCARD_KEY: 20,
  REMOVE_SMARTCARD_KEY: 21,
  ADD_SMARTCARD_KEY_CONSTRAINED: 26,

  // Locking. Also refused: the vault's own lock is the lock, and a second one
  // that disagreed with it would be a second thing to explain and a second
  // thing to get wrong.
  LOCK: 22,
  UNLOCK: 23,

  EXTENSION: 27,
  EXTENSION_FAILURE: 28
} as const

/** Signature request flags. RSA keys sign SHA-1 by default, which no modern
 *  server accepts; a client asks for better with these. */
export const SIGN_FLAGS = {
  RSA_SHA2_256: 0x02,
  RSA_SHA2_512: 0x04
} as const

/**
 * Extensions this agent understands.
 *
 * `session-bind@openssh.com` is the one that matters and the reason agent
 * forwarding stopped being reckless: the client tells the agent the session
 * identifier and host key of the connection it is about to authenticate, so
 * the agent can refuse to sign for a hop it was not asked about. Without it,
 * forwarding an agent to a host means anyone root on that host can use every
 * key in it, for anything, silently.
 */
export const EXTENSION = {
  SESSION_BIND: 'session-bind@openssh.com',
  RESTRICT_DESTINATION: 'restrict-destination-v00@openssh.com',
  /** OpenSSH's own probe for which extensions exist. */
  QUERY: 'query'
} as const

/** How long an approval lasts. */
export type ApprovalScope =
  /** One signature, then ask again. */
  | 'once'
  /** Every signature with this key until the window passes. */
  | 'window'
  /** Every signature with this key until the vault locks or the app exits. */
  | 'session'

/**
 * What the user is asked, and what they answered.
 *
 * TWO SETTINGS, NOT ONE, which is the prerequisite the plan flags. "How long
 * does an approval last" and "what happens when it runs out" are different
 * questions with different right answers: an approval that expires might
 * reasonably re-ask, or might reasonably start refusing outright for the rest
 * of the session, and a single "timeout" field forces one of those on someone
 * who wanted the other.
 */
export interface SshAgentSettings {
  /** Whether the agent listens at all. Off until the user turns it on: a
   *  socket that signs is not something to start by default. */
  enabled: boolean
  /** Default scope offered in the prompt. The user can always choose another. */
  defaultScope: ApprovalScope
  /** Minutes a `window` approval lasts. */
  windowMinutes: number
  /** When an approval expires: ask again, or refuse for the rest of the
   *  session. The second is for somebody who wants a key usable for one task
   *  and then inert without having to remember to revoke it. */
  onExpiry: 'ask-again' | 'refuse'
  /** Refuse to sign when the vault is `secured` rather than `open`.
   *
   *  The capability axis the plan calls for, and the honest framing of it: a
   *  background sweep resolving a credential is the app doing what it was
   *  told, while a signature is something ELSE asking the app to authenticate
   *  as the user. Somebody who wants the agent inert the moment they walk away
   *  from the keyboard sets this; somebody running long unattended jobs does
   *  not. */
  requireOpenVault: boolean
}

export const DEFAULT_SSH_AGENT_SETTINGS: SshAgentSettings = {
  enabled: false,
  // `once` by default and deliberately the most annoying option. Somebody who
  // finds it annoying will turn it down having understood what they traded;
  // somebody who never notices it was permissive has not.
  defaultScope: 'once',
  windowMinutes: 15,
  onExpiry: 'ask-again',
  requireOpenVault: false
}

/** One key the agent can offer, as the UI and the prompt see it. */
export interface AgentIdentity {
  /** The vault entry this key came from. */
  entryId: string
  /** The entry's name, which is what the approval prompt shows. A prompt that
   *  said only "an SSH key" would be a prompt nobody could answer. */
  name: string
  /** OpenSSH public-key blob, base64. This is the identity on the wire. */
  publicKeyBase64: string
  /** `ssh-ed25519`, `ssh-rsa`, ... */
  keyType: string
  /** SHA256:… as `ssh-keygen -l` prints it, so a user can compare it against
   *  what they see elsewhere rather than taking our word for which key it is. */
  fingerprint: string
  /** Present when the key could not be loaded, e.g. a passphrase the entry's
   *  secret slot does not match. Offered in the list with the reason rather
   *  than silently dropped: a key that vanishes without explanation is a
   *  support ticket. */
  problem?: string
}

/** A pending approval, as the renderer sees it. */
export interface AgentApprovalRequest {
  id: string
  identity: AgentIdentity
  /** What the client said it is authenticating to, from `session-bind`. Absent
   *  when the client did not bind -- which is itself worth showing, because it
   *  means the agent cannot tell where the signature is going. */
  destination?: {
    hostKeyFingerprint: string
    /** True when this is a forwarded agent connection rather than the first
     *  hop, which is the case where a signature is most likely not to be the
     *  user's own doing. */
    forwarded: boolean
  }
  requestedAt: number
}

export type AgentDecision =
  | { allow: true; scope: ApprovalScope }
  | { allow: false }

/** Where the agent is listening, for the UI to show and for the user to copy
 *  into their shell. */
export interface AgentStatus {
  running: boolean
  /** The value for `SSH_AUTH_SOCK`, or the pipe name on Windows. */
  path?: string
  identities: number
  error?: string
}
