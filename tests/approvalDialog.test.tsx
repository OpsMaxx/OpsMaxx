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
  fire: (e: unknown) => void
}

function harness(
  opts: {
    approvals?: ApprovalRequest[]
    timeoutSeconds?: number | null
    sessions?: McpAgentSession[] | null
    audit?: { sessionId: string }[] | null
  } = {}
): Harness {
  let handler: ((e: unknown) => void) | null = null
  const respondApproval = vi.fn(async () => true)
  const killAllSessions = vi.fn(async () => ({ revoked: 2, denied: 1 }))
  stubBridge({
    aiMcp: {
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
  return { respondApproval, killAllSessions, fire: (e) => handler?.(e) }
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
    expect(screen.getByText(/What Claude Code asked ShellPilot to run/)).toBeTruthy()
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

  it('states that no intent was recorded, because a blank line would blame the agent for ShellPilot’s gap', async () => {
    harness()
    render(<ApprovalWatcher />)
    expect(await screen.findByText(/does not ask an agent what it is trying to achieve/)).toBeTruthy()
  })
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
