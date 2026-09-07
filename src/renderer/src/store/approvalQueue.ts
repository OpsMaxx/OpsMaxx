import { create } from 'zustand'
import { useEffect, useState } from 'react'
import type { ApprovalRequest } from '../../../shared/mcp'
import { fuseDeadline, formatFuse } from '../../../shared/approvalRisk'
import { bridgeOn, bridgeHas } from '../lib/bridge'
import { toast } from './toast'
import { openAi } from './nav'

// The pending-approval queue, held here rather than inside ApprovalWatcher.
//
// It moved out of that component for the reason nav.ts describes for tabs: a
// request an agent is blocked on was visible in exactly one place, the modal,
// and the modal is dismissable. Close it and the request became invisible while
// its fuse kept burning — the operator could not see that anything was waiting,
// could not tell whether their click had landed, and had no way back. A status
// bar chip is the way back, and a chip cannot read a component's useState.
//
// The second thing this file owns is ACKNOWLEDGEMENT. Every resolution — the
// operator's, the clock's, or the kill switch's — arrives here as one
// `resolved` event, and each gets its own sentence. Routing all three through
// one subscription is what makes it structurally impossible for a timeout to be
// announced as though a human had denied it: the copy is chosen from
// `request.status`, which main set, rather than from what this renderer thinks
// it just did.

interface ApprovalQueueState {
  pending: ApprovalRequest[]
  /**
   * Requests the operator pressed "Decide later" on. Deferring hides the modal
   * and nothing else — the fuse is main's timer and keeps running — so this is
   * a display concern only, and the chip stays up for exactly these.
   */
  deferred: string[]
  /**
   * The configured fuse in seconds, or null when it has not been read yet or
   * could not be. Null means NO COUNTDOWN ANYWHERE rather than an assumed two
   * minutes; see formatFuse in shared/approvalRisk.ts for why a wrong clock is
   * worse than no clock.
   */
  timeoutSeconds: number | null
  /** Guards against a second subscription if the watcher ever remounts. */
  started: boolean
}

export const useApprovalQueue = create<ApprovalQueueState>(() => ({
  pending: [],
  deferred: [],
  timeoutSeconds: null,
  started: false
}))

function announce(request: ApprovalRequest): void {
  const where = `${request.action} on ${request.serverName}`
  const audit = { label: 'View in audit log', run: () => openAi('audit') }

  if (request.status === 'approved') {
    toast(`Approved “${where}”. ${request.agentName} was allowed to run it.`, 'info', audit)
    return
  }
  if (request.status === 'timeout') {
    // Deliberately not the same sentence as a denial, and deliberately the
    // loud kind. Fail-closed on timeout is the right default, but an operator
    // who reads "denied" here will believe they denied it — and the next thing
    // they do is wonder why they do not remember doing so. The clock denied it;
    // the sentence says the clock did.
    toast(
      `No answer in time: “${where}” was auto-denied. ${request.agentName} was told no by the clock, not by you.`,
      'error',
      audit
    )
    return
  }
  toast(`Denied “${where}”. ${request.agentName} was told no.`, 'info', audit)
}

/**
 * Subscribe to the bridge. Called once, from the watcher mounted at the app
 * root, so the chip and the modal are two views of one subscription.
 */
export function startApprovalQueue(): () => void {
  if (useApprovalQueue.getState().started) return () => {}
  useApprovalQueue.setState({ started: true })

  void window.shellpilot?.aiMcp
    ?.listApprovals?.()
    .then((a) => useApprovalQueue.setState({ pending: a ?? [] }))
    .catch(() => {})

  // Read the real configured timeout. It stays null on failure, which is what
  // switches the countdown off rather than making one up.
  void window.shellpilot?.aiMcp
    ?.getConfig?.()
    .then((c) => {
      const s = c?.approvalTimeoutSeconds
      useApprovalQueue.setState({ timeoutSeconds: typeof s === 'number' && s > 0 ? s : null })
    })
    .catch(() => useApprovalQueue.setState({ timeoutSeconds: null }))

  const off = bridgeOn('aiMcp.onApprovalEvent', window.shellpilot?.aiMcp?.onApprovalEvent, (e) => {
    if (e.type === 'created') {
      useApprovalQueue.setState((s) => ({ pending: [...s.pending, e.request] }))
      return
    }
    useApprovalQueue.setState((s) => ({
      pending: s.pending.filter((r) => r.id !== e.request.id),
      deferred: s.deferred.filter((id) => id !== e.request.id)
    }))
    announce(e.request)
  })

  return () => {
    off?.()
    useApprovalQueue.setState({ started: false })
  }
}

/**
 * The request the modal should be showing, or undefined.
 *
 * The head of the queue that has not been deferred — not simply the head. A
 * deferred request stays pending (its fuse is main's, and nothing here can stop
 * it); it is only this view of it that is put away.
 */
export function nextUndeferred(pending: ApprovalRequest[], deferred: string[]): ApprovalRequest | undefined {
  return pending.find((r) => !deferred.includes(r.id))
}

/** Put the current request away without answering it. See the modal's comment. */
export function deferApproval(id: string): void {
  useApprovalQueue.setState((s) => ({ deferred: [...new Set([...s.deferred, id])] }))
}

/** The status-bar chip's click: bring everything back. */
export function resumeApprovals(): void {
  useApprovalQueue.setState({ deferred: [] })
}

/**
 * Answer a request.
 *
 * Deliberately does NOT remove the request from `pending` or raise the toast
 * itself. Main emits `resolved` for its own decision, and that event is the
 * only thing this store treats as a resolution. Optimistically clearing here
 * would mean a respondApproval that main rejected — an id that had already
 * timed out a moment earlier — vanished from the UI as though it had been
 * answered, which is the precise confusion this whole feature exists to remove.
 */
export async function respondToApproval(id: string, decision: 'approved' | 'denied'): Promise<void> {
  await window.shellpilot?.aiMcp?.respondApproval?.(id, decision)
}

/**
 * The kill switch, reached from the modal rather than only from AI & MCP >
 * Security three screens away. Same IPC the Security page calls — the copy
 * there ("revokes every active session and denies every pending approval
 * request") is the contract, and reimplementing any part of it here would be a
 * second thing to keep in step with it.
 */
export async function denyAndStopAllAi(): Promise<void> {
  const result = await window.shellpilot?.aiMcp?.killAllSessions?.()
  if (!result) {
    toast('AI access was not stopped — every session is still live.', 'error', {
      label: 'Open AI security',
      run: () => openAi('security')
    })
    return
  }
  toast(
    `Stopped every agent: ${result.revoked} session(s) revoked, ${result.denied} waiting request(s) denied.`,
    'ok',
    { label: 'View in audit log', run: () => openAi('audit') }
  )
}

/** Whether this build's preload can extend a running fuse. See useApprovalFuse. */
export function canExtendFuse(): boolean {
  return bridgeHas(window.shellpilot?.aiMcp as Record<string, unknown> | undefined, 'extendApproval')
}

/**
 * Ask main for more time on a request.
 *
 * Only ever called when canExtendFuse() is true. The timer lives in main's
 * `pending` map (src/main/services/approvals.ts) and nothing in the renderer
 * can reach it, so when the method is absent the modal says so instead of
 * offering a button that would appear to work and would not.
 */
export async function extendApprovalFuse(id: string, seconds: number): Promise<void> {
  const fn = (window.shellpilot?.aiMcp as unknown as Record<string, unknown> | undefined)?.extendApproval
  if (typeof fn !== 'function') return
  await (fn as (id: string, seconds: number) => Promise<unknown>)(id, seconds)
}

export interface Fuse {
  /** Milliseconds until auto-denial, or null when there is no trustworthy clock. */
  msLeft: number | null
  /** "1:43", or null. Null means: render no countdown at all. */
  text: string | null
  /** True once the deadline has passed but main has not yet said so. */
  expired: boolean
}

/**
 * A once-a-second countdown for one request.
 *
 * Ticks only while there is something to count. The interval is torn down when
 * the request goes away or the timeout is unknown, so an app sitting idle with
 * no pending approval is not waking up every second to recompute nothing.
 */
export function useApprovalFuse(request: ApprovalRequest | undefined): Fuse {
  const timeoutSeconds = useApprovalQueue((s) => s.timeoutSeconds)
  const deadline = request ? fuseDeadline(request.createdAt, timeoutSeconds) : null
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (deadline === null) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [deadline])

  if (deadline === null) return { msLeft: null, text: null, expired: false }
  const msLeft = deadline - now
  return { msLeft, text: formatFuse(msLeft), expired: msLeft <= 0 }
}
