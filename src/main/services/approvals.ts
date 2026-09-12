import { EventEmitter } from 'node:events'
import { randomBytes } from 'node:crypto'
import type { ApprovalRequest } from '../../shared/mcp'
import { sanitizeAgentIntent } from '../../shared/approvalRisk'
import { remoteText } from '../../shared/remoteText'
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
    /** subjectKey(input), kept so a deny can start this subject's cooldown. */
    subject: string
    /** See CreateApprovalInput.containment: which volume budget this one spends. */
    containment: boolean
  }
>()

// ---------------------------------------------------------------------------
// Volume
// ---------------------------------------------------------------------------
//
// `pending` used to be unbounded, with no dedupe and no cooldown. MCP
// `tools/call` is concurrent and gate() awaits per call, so N concurrent calls
// produced N simultaneous modals -- and the capability an operator is most
// likely to see prompted twenty times in a row is the one that starts
// production deploys, because that one is per-call approval by design.
//
// docs/AI-SECURITY.md already concedes the dependency: "If you reflexively
// click Approve without reading what an ASK request is actually asking to do,
// the approval gate provides no protection." Engineering the conditions for
// reflexive clicking is not a fix, so the queue is bounded.
//
// FAIL CLOSED. Over the cap the request is refused outright rather than queued
// behind the others: a queue that drains is still twenty modals, just later,
// and an agent holding a promise that resolves in ten minutes has learned
// nothing. `refused` is its own answer for exactly that reason -- it is not a
// human saying no, and the agent is told so.
const MAX_PENDING_PER_SESSION = 3

// Long enough that a denied agent cannot spin, short enough that an operator
// who denied by mistake is not locked out of their own retry.
const DENY_COOLDOWN_MS = 30_000

/** subject -> epoch ms the cooldown expires. Pruned lazily; see requestApproval. */
const recentDenials = new Map<string, number>()

// Session, capability and the thing acted on. The same triple gate() keys its
// elevation cache on, because it is the same notion of "one of these again"
// -- plus one bit, below.
//
// A CONTAINMENT ACTION MUST NOT BE RATIONED BY THE THING IT CONTAINS.
//
// The reasoning above is about ciTrigger and about failing closed, and it
// missed that ciTrigger covers both trigger_run and cancel_run. On the triple
// alone those two are ONE subject, so:
//
//   - three pending trigger_run approvals fill MAX_PENDING_PER_SESSION and
//     every later request is `refused` -- cancel_run included, for up to the
//     whole approval timeout;
//   - an operator who DENIES a suspicious trigger_run starts a 30s cooldown on
//     that subject, and the same cooldown then refuses cancel_run on that
//     connection. Saying "no" to a start disables the stop button.
//
// Both fail closed on the wrong thing. The cap and the cooldown exist to stop
// an agent doing MORE; applied to a cancel they stop it doing LESS, which is
// the one direction neither was written for. So a containment request gets its
// own cooldown subject and its own volume budget -- and nothing else. Same
// capability, same per-call approval, same modal, same audit: only the
// rationing is separate, and a flood of cancels is still capped, just not by
// the fuse that trigger_run spends.
const subjectKey = (i: {
  sessionId: string
  capability: string
  serverId: string
  containment?: boolean
}): string =>
  `${i.sessionId}\u0000${i.capability}\u0000${i.serverId}\u0000${i.containment ? 'stop' : 'start'}`

/** Only for tests and for a fresh process: the guard holds no secrets. */
export function resetApprovalVolumeForTests(): void {
  recentDenials.clear()
}

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
  /**
   * The RULE that required approval, as the policy engine phrased it.
   *
   * Required for the same reason `riskReason` is: the gate knows it, and every
   * other place that could show it would be re-deriving main's rules by hand.
   * `riskReason` says what the ACTION is; this says which layer said ask --
   * "Ask Before Commands: terminal = ask" -- which is the question an operator
   * actually has when they have set a session's ceiling to Full Access and are
   * still being prompted on every command.
   */
  policyReason: string
  /** The MCP tool the agent called. */
  toolName?: string
  /**
   * This request STOPS something rather than starting it.
   *
   * Set by the gate() call site, not inferred from the tool name here: the
   * decision "is this the emergency brake" belongs where the tool is known.
   * It changes the rationing only -- see subjectKey.
   */
  containment?: boolean
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

/**
 * `refused` is OpsMaxx declining to ask, not a human declining the action.
 *
 * Kept out of AuditApproval deliberately: the audit log records it as `denied`,
 * which is what happened to the action, while gate() tells the agent the
 * separate thing that is true of it -- nobody was asked, and retrying now will
 * be refused again.
 */
export type ApprovalDecision = 'approved' | 'denied' | 'timeout' | 'refused'

// Generous on purpose. The point of passing these through remoteText is the
// character filtering and the newline flattening, not the truncation: an
// operator who approves a command must see the whole command, so the cap is set
// where no honest action reaches it.
const ACTION_MAX_CHARS = 4000
const NAME_MAX_CHARS = 200

export function requestApproval(input: CreateApprovalInput): Promise<ApprovalDecision> {
  const subject = subjectKey(input)
  const now = Date.now()

  // Prune first, so the map cannot grow with one entry per subject a long
  // session ever touched. It is small enough that a full pass is cheaper than
  // any bookkeeping that would avoid one.
  for (const [k, expires] of recentDenials) if (expires <= now) recentDenials.delete(k)

  if ((recentDenials.get(subject) ?? 0) > now) return Promise.resolve('refused')

  // Counted within this request's own class, for the reason at subjectKey: a
  // session's three open trigger prompts must not be what refuses its cancel.
  // Destructured off the request itself: it is a rationing input, not something
  // the operator's dialog shows.
  const { containment: asked, ...forRequest } = input
  const containment = asked === true
  let live = 0
  for (const e of pending.values())
    if (e.request.sessionId === input.sessionId && e.containment === containment) live++
  if (live >= MAX_PENDING_PER_SESSION) return Promise.resolve('refused')

  const timeoutMs = getMcpConfig().approvalTimeoutSeconds * 1000
  const request: ApprovalRequest = {
    id: `appr-${randomBytes(6).toString('hex')}`,
    createdAt: new Date().toISOString(),
    status: 'pending',
    ...forRequest,
    // The intent NEVER reaches the request unsanitised, whatever the call site
    // passed. `?? undefined` because an intent that sanitised down to nothing is
    // the same fact as one that was never sent, and the dialog has one sentence
    // for that fact.
    intent: sanitizeAgentIntent(input.intent) ?? undefined,
    // The other three strings the operator reads, sanitised at the same choke
    // point and for the same reason. `...input` above copied them verbatim,
    // and they are not all ours: a CI run's `action` and `riskReason` carry a
    // name the remote side chose -- a Jenkins pipeline sets its own
    // displayName, GitHub's run.display_title is a PR title, GitLab's takes
    // `workflow:name:` off the contributor's own branch. A title that closes
    // this dialog's quoting rewrites the blast radius the operator reads, and
    // a \u202E in one reverses the rest of the sentence.
    //
    // remoteText, not remoteName: remoteName deletes spaces, which is right for
    // an identifier and destroys a sentence. These are sentences. The call site
    // is still the place to put the remote NAME through remoteName before
    // interpolating it; this is the floor under that, not a replacement for it.
    action: remoteText(input.action, ACTION_MAX_CHARS),
    riskReason: remoteText(input.riskReason, ACTION_MAX_CHARS),
    serverName: remoteText(input.serverName, NAME_MAX_CHARS) || '(unnamed)',
    // Sent, rather than left for the renderer to reconstruct from createdAt plus
    // the configured timeout: that reconstruction is right only while the fuse
    // cannot move, and extendApproval moves it.
    deadlineAt: new Date(Date.now() + timeoutMs).toISOString()
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      finish(request.id, 'timeout')
    }, timeoutMs)

    pending.set(request.id, { request, resolve, timer, extendedSeconds: 0, subject, containment })
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
  // A denial answers this subject for a while. Without it the agent's very next
  // call re-opens the same modal, and "deny" becomes a button the operator
  // presses repeatedly rather than a decision. A timeout is not a decision, so
  // it starts no cooldown -- nobody was there.
  if (decision === 'denied') recentDenials.set(entry.subject, Date.now() + DENY_COOLDOWN_MS)
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
