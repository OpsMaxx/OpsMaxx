// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { stubBridge } from './setup/renderer'
import { ApprovalWatcher } from '../src/renderer/src/components/ai/ApprovalWatcher'
import { StatusBar } from '../src/renderer/src/components/layout/StatusBar'
import { useApprovalQueue } from '../src/renderer/src/store/approvalQueue'
import { useToasts } from '../src/renderer/src/store/toast'
import { useNav } from '../src/renderer/src/store/nav'
import type { ApprovalRequest } from '../src/shared/mcp'

// Finding C6: denial produced no acknowledgement anywhere.
//
// Before this, the only difference between "I denied it", "it timed out while I
// was reading the command" and "I mis-clicked and nothing happened" was three
// levels of navigation into the audit log. All three left the identical screen
// behind: the previous panel, with the modal gone.

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
    action: 'systemctl restart cron',
    risk: 'high',
    createdAt: new Date(T0).toISOString(),
    status: 'pending',
    ...over
  }
}

function harness(opts: { approvals?: ApprovalRequest[]; timeoutSeconds?: number | null } = {}): {
  fire: (e: unknown) => void
} {
  let handler: ((e: unknown) => void) | null = null
  stubBridge({
    aiMcp: {
      listApprovals: async () => opts.approvals ?? [request()],
      getConfig: async () =>
        opts.timeoutSeconds === null ? {} : { approvalTimeoutSeconds: opts.timeoutSeconds ?? 120 },
      listSessions: async () => [],
      listAudit: async () => [],
      respondApproval: async () => true,
      killAllSessions: async () => ({ revoked: 0, denied: 0 }),
      onApprovalEvent: (cb: (e: unknown) => void) => {
        handler = cb
        return () => {
          handler = null
        }
      }
    }
  })
  return { fire: (e) => handler?.(e) }
}

const messages = (): string[] => useToasts.getState().toasts.map((t) => t.message)

beforeEach(() => {
  vi.setSystemTime(T0)
})

describe('acknowledging a decision', () => {
  it('names what was denied, on which host, and that the agent was told', async () => {
    const h = harness()
    render(<ApprovalWatcher />)
    await screen.findByText(/Restarts cron/)

    h.fire({ type: 'resolved', request: request({ status: 'denied' }) })
    await waitFor(() => expect(messages()).toHaveLength(1))
    expect(messages()[0]).toContain('Denied')
    expect(messages()[0]).toContain('systemctl restart cron')
    expect(messages()[0]).toContain('k3s-node-01')
    expect(messages()[0]).toContain('Claude Code was told no.')
  })

  it('acknowledges an approval too — silence after a yes is the same ambiguity as silence after a no', async () => {
    const h = harness()
    render(<ApprovalWatcher />)
    await screen.findByText(/Restarts cron/)

    h.fire({ type: 'resolved', request: request({ status: 'approved' }) })
    await waitFor(() => expect(messages()).toHaveLength(1))
    expect(messages()[0]).toContain('Approved')
    expect(messages()[0]).toContain('was allowed to run it')
  })

  it('never renders a timeout as though the human denied it', async () => {
    const h = harness()
    render(<ApprovalWatcher />)
    await screen.findByText(/Restarts cron/)

    h.fire({ type: 'resolved', request: request({ status: 'timeout' }) })
    await waitFor(() => expect(messages()).toHaveLength(1))
    const [m] = messages()
    expect(m).toContain('No answer in time')
    expect(m).toContain('told no by the clock, not by you')
    // The word "Denied" as an opening claim about the operator is exactly what
    // must not appear: the operator would go looking for a decision they never
    // made.
    expect(m.startsWith('Denied')).toBe(false)
    expect(useToasts.getState().toasts[0].kind).toBe('error')
  })

  it('hands the operator a way into the audit log rather than naming it and leaving', async () => {
    const h = harness()
    render(<ApprovalWatcher />)
    await screen.findByText(/Restarts cron/)

    h.fire({ type: 'resolved', request: request({ status: 'denied' }) })
    await waitFor(() => expect(useToasts.getState().toasts).toHaveLength(1))
    const [t] = useToasts.getState().toasts
    // Sticky, because an acknowledgement that fades in three seconds is one an
    // operator who alt-tabbed never sees.
    expect(t.sticky).toBe(true)
    expect(t.action?.label).toBe('View in audit log')
    t.action?.run()
    expect(useNav.getState().aiSection).toBe('audit')
  })
})

describe('the status-bar chip', () => {
  it('says an agent is blocked on you, with the time it has left', async () => {
    harness()
    render(<StatusBar />)
    expect(await screen.findByText('1 AI action waiting · 2:00')).toBeTruthy()
  })

  it('drops the clock, not the chip, when the timeout could not be read', async () => {
    harness({ timeoutSeconds: null })
    render(<StatusBar />)
    expect(await screen.findByText('1 AI action waiting')).toBeTruthy()
  })

  it('is absent when nothing is waiting, like every other chip in the bar', async () => {
    harness({ approvals: [] })
    render(<StatusBar />)
    await waitFor(() => expect(useApprovalQueue.getState().pending).toHaveLength(0))
    expect(screen.queryByText(/AI action/)).toBeNull()
  })

  it('brings back a decision that was put away — the deferred request is not lost', async () => {
    harness()
    render(
      <>
        <StatusBar />
        <ApprovalWatcher />
      </>
    )
    await userEvent.click(await screen.findByRole('button', { name: /Decide later/ }))
    await waitFor(() => expect(screen.queryByText(/Restarts cron/)).toBeNull())

    // The chip is still up, because the request is still pending and its fuse
    // is still burning.
    await userEvent.click(screen.getByText(/1 AI action waiting/))
    expect(await screen.findByText(/Restarts cron/)).toBeTruthy()
  })
})
