// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { stubBridge } from './setup/renderer'
import { ApprovalWatcher } from '../src/renderer/src/components/ai/ApprovalWatcher'
import { useApprovalQueue } from '../src/renderer/src/store/approvalQueue'
import { NO_CONSEQUENCE_TEXT } from '../src/shared/approvalRisk'
import type { ApprovalRequest, McpAgentSession } from '../src/shared/mcp'

// The modal half of finding C5.
//
// These assert what an operator SEES, because the thing this dialog got wrong
// was not incorrect — it was four true labels and no meaning. A modal that
// prints "Risk HIGH" in the same grey as "Workspace" has told the truth and
// communicated nothing, and no assertion about the data would have caught it.

const T0 = Date.parse('2026-09-07T10:00:00.000Z')

function request(over: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: 'appr-1',
    sessionId: 'sess-claude',
    agentName: 'Claude Code',
    workspaceId: 'ws-1',
    workspaceName: 'Personal',
    serverId: 'srv-1',
    serverName: 'k3s-node-01',
    capability: 'sudo',
    action: 'sudo systemctl restart cron',
    risk: 'high',
    createdAt: new Date(T0).toISOString(),
    status: 'pending',
    ...over
  }
}

function session(over: Partial<McpAgentSession> = {}): McpAgentSession {
  return {
    id: 'sess-claude',
    agentName: 'Claude Code',
    workspaces: [{ id: 'ws-1', name: 'Personal' }],
    groupId: 'grp-1',
    groupName: 'Read only',
    tokenHash: 'x',
    tokenPreview: 'sp_ab…',
    createdAt: new Date(T0 - 41 * 60_000).toISOString(),
    expiresAt: null,
    lastActiveAt: new Date(T0).toISOString(),
    revoked: false,
    ...over
  }
}

interface Harness {
  respondApproval: ReturnType<typeof vi.fn>
  killAllSessions: ReturnType<typeof vi.fn>
  extendApproval: ReturnType<typeof vi.fn>
  fire: (e: unknown) => void
}

function harness(
  opts: {
    approvals?: ApprovalRequest[]
    timeoutSeconds?: number | null
    sessions?: McpAgentSession[] | null
    audit?: { sessionId: string }[] | null
    /** Omitted by default: the modal must cope with a preload that cannot extend. */
    canExtend?: boolean
  } = {}
): Harness {
  let handler: ((e: unknown) => void) | null = null
  const respondApproval = vi.fn(async () => true)
  const killAllSessions = vi.fn(async () => ({ revoked: 2, denied: 1 }))
  const extendApproval = vi.fn(async () => true)
  stubBridge({
    aiMcp: {
      ...(opts.canExtend ? { extendApproval } : {}),
      listApprovals: async () => opts.approvals ?? [request()],
      getConfig: async () =>
        opts.timeoutSeconds === null ? {} : { approvalTimeoutSeconds: opts.timeoutSeconds ?? 120 },
      listSessions: async () => (opts.sessions === null ? [] : (opts.sessions ?? [session()])),
      listAudit: async () => (opts.audit === null ? undefined : (opts.audit ?? [])),
      respondApproval,
      killAllSessions,
      onApprovalEvent: (cb: (e: unknown) => void) => {
        handler = cb
        return () => {
          handler = null
        }
      }
    }
  })
  return { respondApproval, killAllSessions, extendApproval, fire: (e) => handler?.(e) }
}

beforeEach(() => {
  vi.setSystemTime(T0)
})

describe('the approval modal', () => {
  it('leads with what the action does, and demotes the command to evidence beneath it', async () => {
    harness()
    render(<ApprovalWatcher />)

    const consequence = await screen.findByText(/Restarts cron on k3s-node-01/)
    const command = screen.getByText('sudo systemctl restart cron')
    // Order in the document, not merely presence: the old modal had the
    // command as the headline and no consequence at all.
    expect(consequence.compareDocumentPosition(command) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByText(/What Claude Code asked OpsMaxx to run/)).toBeTruthy()
  })

  it('says out loud that it cannot describe a command it does not recognise', async () => {
    harness({ approvals: [request({ capability: 'terminal', action: 'flarb --quux /opt/thing', risk: 'medium' })] })
    render(<ApprovalWatcher />)
    expect(await screen.findByText(NO_CONSEQUENCE_TEXT)).toBeTruthy()
  })

  it('gives the risk word a scale and a reason instead of a fourth grey label', async () => {
    harness()
    render(<ApprovalWatcher />)
    expect(await screen.findByText('HIGH — 3 of 3')).toBeTruthy()
    expect(screen.getByText(/HIGH because: .*root/)).toBeTruthy()
  })

  it('counts down against the configured timeout, not against an assumed two minutes', async () => {
    harness({ timeoutSeconds: 600 })
    render(<ApprovalWatcher />)
    expect(await screen.findByText('Auto-denies in 10:00')).toBeTruthy()
  })

  it('shows no countdown at all when the timeout could not be read', async () => {
    harness({ timeoutSeconds: null })
    render(<ApprovalWatcher />)
    await screen.findByText(/Restarts cron/)
    expect(screen.queryByText(/Auto-denies in/)).toBeNull()
  })

  it('puts the weight on Deny and takes the accent fill off Approve', async () => {
    harness()
    render(<ApprovalWatcher />)
    const deny = await screen.findByRole('button', { name: 'Deny' })
    const approve = screen.getByRole('button', { name: 'Approve once' })
    // The affirmative must not be the filled primary in a dialog where the
    // safe answer is usually no, and the Return key must not approve.
    expect(approve.className).not.toContain('primary')
    expect(document.activeElement).toBe(deny)
  })

  it('says what happens to the agent if you deny, so "no" is not an unknown cost', async () => {
    harness()
    render(<ApprovalWatcher />)
    expect(await screen.findByText(/nothing runs on k3s-node-01/)).toBeTruthy()
  })

  it('reaches the kill switch from here rather than three screens away', async () => {
    const h = harness()
    render(<ApprovalWatcher />)
    await userEvent.click(await screen.findByRole('button', { name: /Deny and stop all AI access/ }))
    expect(h.killAllSessions).toHaveBeenCalled()
  })

  it('offers no "Give me more time" button in a build whose bridge cannot extend the fuse', async () => {
    harness()
    render(<ApprovalWatcher />)
    await screen.findByText('Auto-denies in 2:00')
    expect(screen.queryByRole('button', { name: 'Give me more time' })).toBeNull()
    expect(screen.getByText(/This build cannot extend the fuse/)).toBeTruthy()
  })
})

describe('provenance the request itself does not carry', () => {
  it('names the session, its access group and how long it has been connected', async () => {
    harness()
    render(<ApprovalWatcher />)
    expect(await screen.findByText(/access group Read only/)).toBeTruthy()
    expect(screen.getByText(/connected 41m 0s ago/)).toBeTruthy()
  })

  it('counts the actions this session has already taken', async () => {
    harness({ audit: [{ sessionId: 'sess-claude' }, { sessionId: 'other' }, { sessionId: 'sess-claude' }] })
    render(<ApprovalWatcher />)
    expect(await screen.findByText('2 recorded before this one')).toBeTruthy()
  })

  it('says the audit log could not be read rather than reporting zero actions', async () => {
    harness({ audit: null })
    render(<ApprovalWatcher />)
    expect(await screen.findByText(/could not read the audit log/)).toBeTruthy()
    expect(screen.queryByText('0 recorded before this one')).toBeNull()
  })

  it('says there is no session record rather than leaving the row empty', async () => {
    harness({ sessions: null })
    render(<ApprovalWatcher />)
    expect(await screen.findByText(/no session record for sess-claude/)).toBeTruthy()
  })

  // The bridge now DOES ask -- every gated tool takes an optional `intent` --
  // so the absence moved from being OpsMaxx's gap to being the agent's
  // silence, and the sentence had to move with it. See "what the agent itself
  // claims it is doing" below for both halves.
})

describe('putting the decision away', () => {
  it('labels the dismiss control, so it cannot be mistaken for a deny', async () => {
    harness()
    render(<ApprovalWatcher />)
    expect(await screen.findByRole('button', { name: /Decide later/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull()
  })

  it('leaves the request pending when deferred — deferring is not answering', async () => {
    const h = harness()
    render(<ApprovalWatcher />)
    await userEvent.click(await screen.findByRole('button', { name: /Decide later/ }))
    await waitFor(() => expect(screen.queryByText(/Restarts cron/)).toBeNull())
    expect(h.respondApproval).not.toHaveBeenCalled()
    expect(useApprovalQueue.getState().pending).toHaveLength(1)
  })

  it('does not vanish on a stray click outside it', async () => {
    harness()
    render(<ApprovalWatcher />)
    const consequence = await screen.findByText(/Restarts cron/)
    await userEvent.click(document.querySelector('.scrim') as Element)
    expect(consequence.isConnected).toBe(true)
  })

  it('keeps a request on screen until main confirms the decision, rather than clearing it optimistically', async () => {
    const h = harness()
    render(<ApprovalWatcher />)
    await userEvent.click(await screen.findByRole('button', { name: 'Deny' }))
    expect(h.respondApproval).toHaveBeenCalledWith('appr-1', 'denied')
    // No `resolved` event has arrived, so nothing has been resolved.
    expect(useApprovalQueue.getState().pending).toHaveLength(1)
    h.fire({ type: 'resolved', request: request({ status: 'denied' }) })
    await waitFor(() => expect(useApprovalQueue.getState().pending).toHaveLength(0))
  })
})

describe('the facts main sends rather than the renderer re-deriving them', () => {
  it('prints main’s own reason for the grade instead of its local guess at it', async () => {
    harness({
      approvals: [
        request({
          riskReason: 'OpsMaxx could not classify this statement as a read, so it is treated as one that changes data'
        })
      ]
    })
    render(<ApprovalWatcher />)
    expect(await screen.findByText(/HIGH because: OpsMaxx could not classify this statement as a read/)).toBeTruthy()
    // The local derivation's sentence for this same request. Seeing it would
    // mean the plumbing arrived and the modal ignored it.
    expect(screen.queryByText(/because: the command runs as root/)).toBeNull()
  })

  it('names the tool the agent called, which no amount of reading the command could tell you', async () => {
    harness({ approvals: [request({ toolName: 'execute_command' })] })
    render(<ApprovalWatcher />)
    expect(await screen.findByText(/called execute_command/)).toBeTruthy()
  })

  it('uses the exact action count from the request and drops the "at least" hedge', async () => {
    harness({ approvals: [request({ actionsThisSession: 7 })], audit: null })
    render(<ApprovalWatcher />)
    expect(await screen.findByText('7 recorded before this one')).toBeTruthy()
    expect(screen.queryByText(/at least/)).toBeNull()
    expect(screen.queryByText(/could not read the audit log/)).toBeNull()
  })

  it('shows an exact zero from main, which is a measurement, unlike the zero of an unread log', async () => {
    harness({ approvals: [request({ actionsThisSession: 0 })], audit: null })
    render(<ApprovalWatcher />)
    expect(await screen.findByText('0 recorded before this one')).toBeTruthy()
  })

  it('keeps the tail read’s "at least" for a request main could not count exactly', async () => {
    harness({ audit: Array.from({ length: 500 }, () => ({ sessionId: 'sess-claude' })) })
    render(<ApprovalWatcher />)
    expect(await screen.findByText('at least 500 recorded before this one')).toBeTruthy()
  })

  it('still says the audit log was unreadable rather than reporting zero, when main sent no count', async () => {
    harness({ audit: null })
    render(<ApprovalWatcher />)
    expect(await screen.findByText(/could not read the audit log/)).toBeTruthy()
  })

  it('takes the session’s age and group from the request without a second IPC round trip', async () => {
    harness({
      approvals: [
        request({
          sessionStartedAt: new Date(T0 - 12 * 60_000).toISOString(),
          sessionGroupName: 'Full access',
          actionsThisSession: 3
        })
      ],
      // Both fallback reads fail. Nothing on the row may depend on them.
      sessions: null,
      audit: null
    })
    render(<ApprovalWatcher />)
    expect(await screen.findByText(/connected 12m 0s ago/)).toBeTruthy()
    expect(screen.getByText(/access group Full access/)).toBeTruthy()
    expect(screen.queryByText(/no session record/)).toBeNull()
  })
})

describe('what the agent itself claims it is doing', () => {
  it('shows the agent’s stated intent, attributed to the agent and not to OpsMaxx', async () => {
    harness({ approvals: [request({ intent: 'Restarting cron after the crontab edit you approved earlier' })] })
    render(<ApprovalWatcher />)
    expect(await screen.findByText(/Restarting cron after the crontab edit/)).toBeTruthy()
    expect(screen.getByText(/Claude Code’s own words, not OpsMaxx’s/)).toBeTruthy()
    expect(screen.getByText(/Nothing checked whether they are true/)).toBeTruthy()
  })

  it('renders the intent as text, never as markup, whatever the agent put in it', async () => {
    harness({ approvals: [request({ intent: '<img src=x onerror="alert(1)"> deploy' })] })
    render(<ApprovalWatcher />)
    const el = await screen.findByText(/onerror/)
    expect(el.querySelector('img')).toBeNull()
    expect(document.querySelector('img')).toBeNull()
  })

  it('says the agent sent no reason, rather than leaving the row blank', async () => {
    harness()
    render(<ApprovalWatcher />)
    expect(await screen.findByText(/Claude Code sent no reason/)).toBeTruthy()
  })
})

describe('asking for more time', () => {
  it('offers the button once the bridge can extend, and asks main rather than moving its own clock', async () => {
    const h = harness({ canExtend: true })
    render(<ApprovalWatcher />)
    await userEvent.click(await screen.findByRole('button', { name: 'Give me more time' }))
    expect(h.extendApproval).toHaveBeenCalledWith('appr-1', 300)
    // Nothing moved locally: the countdown is still main's, unchanged, until
    // main says otherwise.
    expect(screen.getByText('Auto-denies in 2:00')).toBeTruthy()
    expect(screen.queryByText(/This build cannot extend the fuse/)).toBeNull()
  })

  it('counts down to main’s new deadline after an extension, not to the one it derived', async () => {
    const h = harness({
      canExtend: true,
      approvals: [request({ deadlineAt: new Date(T0 + 120_000).toISOString() })]
    })
    render(<ApprovalWatcher />)
    expect(await screen.findByText('Auto-denies in 2:00')).toBeTruthy()

    h.fire({
      type: 'extended',
      request: request({ deadlineAt: new Date(T0 + 420_000).toISOString() })
    })
    await waitFor(() => expect(screen.getByText('Auto-denies in 7:00')).toBeTruthy())
    // An extension is one field changing on a question already on screen, not
    // a second question.
    expect(useApprovalQueue.getState().pending).toHaveLength(1)
  })

  it('counts down against main’s deadline even when the configured timeout could not be read', async () => {
    harness({
      timeoutSeconds: null,
      approvals: [request({ deadlineAt: new Date(T0 + 300_000).toISOString() })]
    })
    render(<ApprovalWatcher />)
    expect(await screen.findByText('Auto-denies in 5:00')).toBeTruthy()
  })
})
