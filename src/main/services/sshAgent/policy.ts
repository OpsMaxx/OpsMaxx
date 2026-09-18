import type {
  AgentDecision,
  AgentIdentity,
  ApprovalScope,
  SshAgentSettings
} from '../../../shared/sshAgentHost'

/**
 * Whether a signature is allowed, and who is asked.
 *
 * TWO INTERFACES, deliberately, and the split is the design. `ApprovalRequester`
 * is how a human is asked; `SigningPolicy` is what decides whether to ask at
 * all and what to remember afterwards. Collapsing them gives you a policy that
 * can only be enforced by showing a dialog, which means no policy in a headless
 * run and no way to test one without a renderer.
 *
 * THE RULE THIS FILE EXISTS TO HOLD: a sign request always reaches the policy,
 * and the policy's default answer is to ask. Every relaxation -- remember this
 * key for fifteen minutes, remember it until the vault locks -- is a decision
 * the user made in the renderer and that this layer then honours. It is never
 * a default, never inferred from how recently they were at the keyboard, and
 * never skipped because a previous request looked similar.
 *
 * The reason is that a signature is not a read. Resolving a credential for a
 * background sweep is the app doing what it was told; signing is something
 * ELSE -- git, a script, a compromised dependency's postinstall, a process on
 * a host the user forwarded their agent to -- asking the app to authenticate
 * as the user, to a destination the app may not even be told.
 */

/** How a human is asked. One method, so a test can be a function. */
export interface ApprovalRequester {
  /**
   * Ask, and resolve with what they chose.
   *
   * Must resolve -- never hang. A request that never settles is a `git push`
   * that never returns, and the user has no way to connect the hung command to
   * a dialog they did not see. Implementations time out and resolve to a
   * refusal.
   */
  ask(request: {
    identity: AgentIdentity
    destination?: { hostKeyFingerprint: string; forwarded: boolean }
  }): Promise<AgentDecision>
}

/** What the policy is asked. */
export interface SignAttempt {
  identity: AgentIdentity
  destination?: { hostKeyFingerprint: string; forwarded: boolean }
}

export interface SigningPolicy {
  /** True when this signature may go ahead. */
  allow(attempt: SignAttempt): Promise<boolean>
  /** Forget every remembered approval. Called when the vault locks. */
  forgetAll(): void
}

interface Remembered {
  scope: ApprovalScope
  /** Epoch ms, or Infinity for a session-scoped approval. */
  until: number
  /** Set when a `window` approval has run out and `onExpiry` is `refuse`:
   *  this key is inert for the rest of the session and is not asked about
   *  again. */
  refusing?: boolean
}

/**
 * The default policy: ask, then remember exactly what the user said.
 *
 * Remembered approvals are keyed on the KEY, not on the destination. Keying on
 * the destination sounds tighter and is worse: the destination is only known
 * when the client sends `session-bind`, so a client that does not bind would
 * get a fresh prompt for every signature while a client that does would be
 * silently narrower -- the user's grant would mean different things depending
 * on a protocol detail they cannot see. One meaning, stated in the prompt.
 */
export class DefaultSigningPolicy implements SigningPolicy {
  private readonly remembered = new Map<string, Remembered>()

  constructor(
    private readonly requester: ApprovalRequester,
    private readonly settings: () => SshAgentSettings,
    private readonly now: () => number = Date.now
  ) {}

  async allow(attempt: SignAttempt): Promise<boolean> {
    const key = attempt.identity.entryId
    const settings = this.settings()
    const held = this.remembered.get(key)

    // A FORWARDED REQUEST IS ASKED ABOUT EVERY TIME, ahead of anything
    // remembered.
    //
    // An approval given for a signature the user started on their own machine
    // is not consent for one started by whatever is running on the host they
    // forwarded their agent to -- which is exactly the case where a signature
    // is least likely to be their doing. `session-bind` is what lets the agent
    // tell the two apart, and spending the extra prompt is the reason to
    // implement it at all.
    //
    // A `refusing` entry still wins: it is a stronger answer than "ask", and
    // re-prompting for a key the user deliberately made inert would be the one
    // way to get it used again by accident.
    if (attempt.destination?.forwarded && !held?.refusing) {
      return (await this.requester.ask(attempt)).allow
    }

    if (held) {
      if (held.refusing) {
        // The user chose "refuse after the window" and the window has passed.
        // Not asked again, which is the whole point of that setting: a key
        // usable for one task and then inert, without anyone having to
        // remember to revoke it.
        return false
      }
      if (this.now() < held.until) return true
      this.remembered.delete(key)
      if (settings.onExpiry === 'refuse') {
        this.remembered.set(key, { scope: held.scope, until: 0, refusing: true })
        return false
      }
    }

    const decision = await this.requester.ask(attempt)
    if (!decision.allow) return false

    switch (decision.scope) {
      case 'once':
        break
      case 'window':
        this.remembered.set(key, {
          scope: 'window',
          until: this.now() + Math.max(1, settings.windowMinutes) * 60_000
        })
        break
      case 'session':
        this.remembered.set(key, { scope: 'session', until: Number.POSITIVE_INFINITY })
        break
    }
    return true
  }

  forgetAll(): void {
    // Including the `refusing` entries. The vault locking is the end of the
    // session in every sense, and carrying a refusal across it would leave a
    // key inert after an unlock for a reason nobody could see.
    this.remembered.clear()
  }
}

/**
 * A policy that refuses everything, for when the agent must not sign at all --
 * the vault is locked, or it is `secured` and the user asked for that to be
 * enough to stop it.
 *
 * A separate object rather than a flag inside the default policy, so the
 * refusal cannot be reached by any code path that thinks it has an approval.
 */
export const REFUSE_ALL: SigningPolicy = {
  async allow() {
    return false
  },
  forgetAll() {}
}
