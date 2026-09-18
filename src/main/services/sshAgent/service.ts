import { randomUUID } from 'node:crypto'
import { BrowserWindow } from 'electron'
import {
  DEFAULT_SSH_AGENT_SETTINGS,
  type AgentApprovalRequest,
  type AgentDecision,
  type AgentIdentity,
  type AgentStatus,
  type SshAgentSettings
} from '../../../shared/sshAgentHost'
import { vaultEntriesForResolve, vaultStatus } from '../vault'
import { loadKeys } from './agent'
import { DefaultSigningPolicy, type ApprovalRequester, type SigningPolicy } from './policy'
import { listen, type RunningListener } from './listener'

/**
 * The agent as the app runs it.
 *
 * Holds three things the layers below deliberately do not: the vault, the
 * renderer, and the settings. Each of those is a reason the core could not be
 * tested without an Electron app, which is why none of them is down there.
 */

/** How long an approval prompt waits before it refuses on its own.
 *
 *  It MUST refuse rather than hang. A `git push` that never returns is a
 *  failure the user cannot connect to a dialog they did not see -- they are
 *  looking at a terminal, and the prompt is behind something. Two minutes is
 *  long enough to find the window and short enough that a forgotten prompt
 *  does not wedge a script overnight. */
const PROMPT_TIMEOUT_MS = 120_000

interface Pending {
  request: AgentApprovalRequest
  settle(decision: AgentDecision): void
  timer: NodeJS.Timeout
}

class RendererRequester implements ApprovalRequester {
  readonly pending = new Map<string, Pending>()

  ask(attempt: {
    identity: AgentIdentity
    destination?: { hostKeyFingerprint: string; forwarded: boolean }
  }): Promise<AgentDecision> {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (!win || win.isDestroyed()) {
      // No window means nobody can be asked, and an unattended signature is
      // exactly what the policy exists to prevent. Refusing is the only honest
      // answer -- the alternative is a headless app signing silently.
      return Promise.resolve({ allow: false })
    }

    const request: AgentApprovalRequest = {
      id: randomUUID(),
      identity: attempt.identity,
      destination: attempt.destination,
      requestedAt: Date.now()
    }

    return new Promise<AgentDecision>((resolve) => {
      let done = false
      const settle = (decision: AgentDecision): void => {
        if (done) return
        done = true
        const held = this.pending.get(request.id)
        if (held) clearTimeout(held.timer)
        this.pending.delete(request.id)
        win.webContents.send('sshAgent:approval-event', { type: 'resolved', request })
        resolve(decision)
      }
      const timer = setTimeout(() => settle({ allow: false }), PROMPT_TIMEOUT_MS)
      // `unref` so a pending prompt cannot hold the process open at quit.
      timer.unref?.()
      this.pending.set(request.id, { request, settle, timer })
      win.webContents.send('sshAgent:approval-event', { type: 'created', request })
    })
  }
}

export class SshAgentService {
  private listener: RunningListener | null = null
  private policy: SigningPolicy
  private readonly requester = new RendererRequester()
  private settings: SshAgentSettings = DEFAULT_SSH_AGENT_SETTINGS
  private lastError: string | undefined

  constructor() {
    this.policy = new DefaultSigningPolicy(this.requester, () => this.settings)
  }

  /** Keys as the UI sees them, INCLUDING the ones that will not parse.
   *
   *  The wire protocol filters those out -- they cannot be signed with -- but
   *  a key that silently vanishes from a settings panel is a support ticket,
   *  and one shown with "the passphrase does not open this key" is fixed in
   *  ten seconds. */
  identities(): AgentIdentity[] {
    const entries = vaultEntriesForResolve()
    if (!entries) return []
    return loadKeys(entries).map((k) => k.identity)
  }

  /**
   * Whether a signature may happen at all, before any prompt.
   *
   * `locked` is an absolute no: there is no key material to sign with.
   * `secured` is the user's choice -- a background sweep resolving a
   * credential is the app doing what it was told, and a signature is something
   * else asking the app to authenticate as the user, so somebody who wants the
   * agent inert the moment they walk away sets `requireOpenVault`.
   */
  private canSign(): boolean {
    const status = vaultStatus()
    if (!status.unlocked) return false
    return this.settings.requireOpenVault ? status.stage === 'open' : true
  }

  async start(settings: SshAgentSettings): Promise<AgentStatus> {
    this.settings = settings
    if (!settings.enabled) {
      await this.stop()
      return this.status()
    }
    if (this.listener) return this.status()

    try {
      this.listener = await listen({
        deps: {
          keys: () => {
            const entries = vaultEntriesForResolve()
            return entries ? loadKeys(entries) : []
          },
          policy: () => this.policy,
          canSign: () => this.canSign(),
          log: (m) => console.log('[sshAgent]', m)
        },
        log: (m) => console.log('[sshAgent]', m)
      })
      this.lastError = undefined
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err)
    }
    return this.status()
  }

  /** Settings changed while running. Restart only when it matters: `enabled`
   *  is the one that needs a socket opened or closed, and rebinding for a
   *  changed window length would drop every live connection for nothing. */
  async configure(settings: SshAgentSettings): Promise<AgentStatus> {
    const wasEnabled = this.settings.enabled
    this.settings = settings
    if (settings.enabled !== wasEnabled) return this.start(settings)
    return this.status()
  }

  async stop(): Promise<void> {
    const held = this.listener
    this.listener = null
    // Every pending prompt refuses. A prompt whose agent has gone would
    // resolve into nothing and leave the caller hanging.
    for (const p of this.requester.pending.values()) p.settle({ allow: false })
    await held?.close()
  }

  /** The vault locked. Every remembered approval goes with it: carrying one
   *  across a lock would leave a key usable after the user deliberately shut
   *  the thing that holds it. */
  onVaultLocked(): void {
    this.policy.forgetAll()
    for (const p of this.requester.pending.values()) p.settle({ allow: false })
  }

  resolve(id: string, decision: AgentDecision): boolean {
    const held = this.requester.pending.get(id)
    if (!held) return false
    held.settle(decision)
    return true
  }

  pending(): AgentApprovalRequest[] {
    return [...this.requester.pending.values()].map((p) => p.request)
  }

  status(): AgentStatus {
    return {
      running: this.listener !== null,
      path: this.listener?.path,
      identities: this.identities().filter((i) => !i.problem).length,
      error: this.lastError
    }
  }
}

export const sshAgent = new SshAgentService()
