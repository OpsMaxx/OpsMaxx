import { EventEmitter } from 'node:events'
import { randomBytes } from 'node:crypto'
import type { ApprovalRequest } from '../../shared/mcp'
import { sanitizeAgentIntent } from '../../shared/approvalRisk'
import { getMcpConfig } from './mcpAuth'

// Human-in-the-loop gate for ASK-tier actions. The only way to resolve a
// pending request is respond(), called from the IPC handler the renderer's
// approval dialog uses — the MCP/HTTP surface never reaches this function,
// so an AI agent has no path to approve its own request.
//
// THE MAP IS THE TRUTH ABOUT WHAT IS STILL ANSWERABLE. finish() deletes an
// entry before anything else can observe the decision, so "is this id in
// `pending`?" is not a hint that a request is live — it is the definition. Every
// mutation below leans on that instead of re-checking `status`, which is why an
// extension cannot resurrect a request the clock already denied.
const emitter = new EventEmitter()
const pending = new Map<
  string,
  {
    request: ApprovalRequest
    resolve: (v: 'approved' | 'denied' | 'timeout') => void
    timer: ReturnType<typeof setTimeout>
    /** Seconds granted by extendApproval so far, against EXTENSION_CEILING_SECONDS. */
    extendedSeconds: number
  }
>()

export type ApprovalEvent =
  | { type: 'created'; request: ApprovalRequest }
  | { type: 'resolved'; request: ApprovalRequest }
  // Not a resolution, and deliberately its own type rather than a second
  // `created`. The renderer holds this request already; what changed is one
  // field on it, and a `created` would have appended a duplicate to the queue.
  | { type: 'extended'; request: ApprovalRequest }

export function onApprovalEvent(cb: (e: ApprovalEvent) => void): () => void {
  emitter.on('event', cb)
  return () => emitter.off('event', cb)
}

export interface CreateApprovalInput {
  sessionId: string
  agentName: string
  workspaceId: string
  workspaceName: string
  serverId: string
  serverName: string
  capability: ApprovalRequest['capability']
  action: string
  risk: ApprovalRequest['risk']
  /**
   * The rule that produced `risk`, in the operator's language.
   *
   * REQUIRED, and required on purpose. The renderer can derive a plausible
   * reason from the capability and the command, and did — accurately, right up
   * until the grading in mcpServer.ts changes and the copy of its rules living
   * in the renderer quietly starts describing the old ones. Making this
   * mandatory means a new gate() call site cannot be added without saying why
   * it grades what it grades: the compiler asks, at the site that knows.
   */
  riskReason: string
  /** The MCP tool the agent called. */
  toolName?: string
  /**
   * The agent's stated reason, RAW and untrusted — sanitised here, once.
   *
   * Sanitising at this choke point rather than at the call sites is the whole
   * point: there are eleven gate() call sites and there will be more, and a
   * single one that passed the agent's string straight through would put
   * attacker-authored text on the screen the operator decides from. Nothing
   * else in this module may write `request.intent`.
   */
  intent?: string
  sessionStartedAt?: string
  sessionGroupName?: string
  /** Exact, or omitted. Never a partial count — see ApprovalRequest. */
  actionsThisSession?: number
}

export function requestApproval(input: CreateApprovalInput): Promise<'approved' | 'denied' | 'timeout'> {
  const timeoutMs = getMcpConfig().approvalTimeoutSeconds * 1000
  const request: ApprovalRequest = {
    id: `appr-${randomBytes(6).toString('hex')}`,
    createdAt: new Date().toISOString(),
    status: 'pending',
    ...input,
    // The intent NEVER reaches the request unsanitised, whatever the call site
    // passed. `?? undefined` because an intent that sanitised down to nothing is
    // the same fact as one that was never sent, and the dialog has one sentence
    // for that fact.
    intent: sanitizeAgentIntent(input.intent) ?? undefined,
    // Sent, rather than left for the renderer to reconstruct from createdAt plus
    // the configured timeout: that reconstruction is right only while the fuse
    // cannot move, and extendApproval moves it.
    deadlineAt: new Date(Date.now() + timeoutMs).toISOString()
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      finish(request.id, 'timeout')
    }, timeoutMs)

    pending.set(request.id, { request, resolve, timer, extendedSeconds: 0 })
    emitter.emit('event', { type: 'created', request } satisfies ApprovalEvent)
  })
}

function finish(id: string, decision: 'approved' | 'denied' | 'timeout'): void {
  const entry = pending.get(id)
  if (!entry) return
  clearTimeout(entry.timer)
  pending.delete(id)
  entry.request.status = decision
  entry.request.resolvedAt = new Date().toISOString()
  entry.resolve(decision)
  emitter.emit('event', { type: 'resolved', request: entry.request } satisfies ApprovalEvent)
}

// Called only from the renderer's approval dialog via IPC — never from the
// MCP tool-call path.
export function respondToApproval(id: string, decision: 'approved' | 'denied'): boolean {
  if (!pending.has(id)) return false
  finish(id, decision)
  return true
}

/**
 * The most one call may add, and the most a single request may ever gain.
 *
 * WHY THERE IS A CEILING AT ALL. The fuse is the only part of this design that
 * is fail-closed without a human: an operator who walks away from their desk
 * mid-request has the request denied for them, and the agent is told no. An
 * unbounded "Give me more time" turns that guarantee into a preference — press
 * it twice on the way out of the office and the request is still open tomorrow
 * morning, still blocking the agent, with a countdown nobody is reading. The
 * point of a fail-closed timer is that it fires; a timer that can be pushed
 * back forever is a timer that never fires, which is the same as not having one.
 *
 * So an extension buys the operator time to go and LOOK at something — read the
 * command, check what the host is doing, ask a colleague — and not time to
 * forget. Fifteen minutes total is generous for looking and short of a working
 * day. Past the ceiling the answer is no, and the honest move is to deny the
 * request and let the agent ask again when the operator is ready to decide.
 *
 * A single grant is capped separately so one fat-fingered `seconds` cannot
 * spend the whole allowance in one press.
 */
export const EXTENSION_CEILING_SECONDS = 15 * 60
export const EXTENSION_MAX_PER_CALL_SECONDS = 10 * 60

/**
 * Push a pending request's deadline back, and say whether it moved.
 *
 * FAILS CLOSED IN EVERY DIRECTION. False — and no change to any timer — when:
 *
 *   - the id is not in `pending`. That covers "never existed", "already
 *     approved or denied", and, importantly, "already timed out": finish()
 *     removed the entry before the timeout was announced, so there is no state
 *     here an extension could bring back to life. Resurrection is not
 *     prevented by a check that could be forgotten; it is unrepresentable.
 *   - `seconds` is not a positive finite number. A NaN would otherwise become
 *     a setTimeout of NaN ms, which fires immediately — a request "extended"
 *     into instant denial.
 *   - the ceiling is already spent.
 *
 * A grant may be SMALLER than asked for, when only part of the allowance is
 * left, and that still returns true: the caller is not told a number, it is
 * told that the deadline moved, and the new deadline is broadcast as an
 * `extended` event so the countdown shows what main actually holds rather than
 * what the renderer hoped for.
 */
export function extendApproval(id: string, seconds: number): boolean {
  const entry = pending.get(id)
  if (!entry) return false
  if (!Number.isFinite(seconds) || seconds <= 0) return false

  const grant = Math.min(
    Math.floor(seconds),
    EXTENSION_MAX_PER_CALL_SECONDS,
    EXTENSION_CEILING_SECONDS - entry.extendedSeconds
  )
  if (grant <= 0) return false

  // Extend from the deadline that is standing, not from now: pressing the
  // button with 90 seconds left should add to those 90, not throw them away.
  // `Math.max(…, now)` keeps the arithmetic sane if the standing deadline has
  // somehow slipped into the past (a suspended laptop, a clock change) — the
  // new timer is then simply `grant` seconds from this moment.
  const standing = Date.parse(entry.request.deadlineAt ?? '')
  const now = Date.now()
  const from = Number.isNaN(standing) ? now : Math.max(standing, now)
  const deadline = from + grant * 1000

  clearTimeout(entry.timer)
  entry.extendedSeconds += grant
  entry.request.deadlineAt = new Date(deadline).toISOString()
  entry.timer = setTimeout(() => {
    finish(id, 'timeout')
  }, deadline - now)

  emitter.emit('event', { type: 'extended', request: entry.request } satisfies ApprovalEvent)
  return true
}

export function listPendingApprovals(): ApprovalRequest[] {
  return [...pending.values()].map((e) => e.request)
}

// Used by the global "STOP ALL AI ACCESS" kill switch: every outstanding
// question is answered "denied" immediately rather than left to time out.
export function denyAllPending(): number {
  const ids = [...pending.keys()]
  for (const id of ids) finish(id, 'denied')
  return ids.length
}
