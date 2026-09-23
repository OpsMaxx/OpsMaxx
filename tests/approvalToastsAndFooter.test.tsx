// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { stubBridge } from './setup/renderer'
import { ApprovalWatcher } from '../src/renderer/src/components/ai/ApprovalWatcher'
import { Toasts } from '../src/renderer/src/components/common/Toasts'
import { KILL_SWITCH_FAILED, useApprovalQueue } from '../src/renderer/src/store/approvalQueue'
import { toast } from '../src/renderer/src/store/toast'
import type { ApprovalRequest } from '../src/shared/mcp'

// Found in the running app at 1440x900. Toasts paint above the approval layer
// (some of them are about the approval), so a sticky error and a "Copied"
// toast floated over the dialog's footer and covered Approve once, the session
// grant and Deny. And with a session grant, the footer's one row was wider than
// the dialog and drew the kill switch past its left edge.

const approval: ApprovalRequest = {
  id: 'appr-1',
  sessionId: 'sess-1',
  agentName: 'Claude Code',
  workspaceId: 'ws-1',
  workspaceName: 'Personal',
  serverId: 'srv-1',
  serverName: 'k3s-node-01.production.example.internal',
  capability: 'terminal',
  toolName: 'execute_command',
  sessionGrant: 'capability',
  action: 'systemctl restart cron',
  risk: 'high',
  createdAt: new Date().toISOString(),
  status: 'pending'
}

function withApproval(killAllSessions = vi.fn(async () => ({ revoked: 1, denied: 1 }))): void {
  stubBridge({
    aiMcp: {
      listApprovals: async () => [approval],
      getConfig: async () => ({ approvalTimeoutSeconds: 120 }),
      listSessions: async () => [],
      listAudit: async () => [],
      respondApproval: vi.fn(async () => true),
      killAllSessions,
      onApprovalEvent: () => () => undefined
    }
  })
}

const CSS = readFileSync(join(__dirname, '../src/renderer/src/styles/global.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  ''
)
const rule = (selector: string): string => {
  const i = CSS.indexOf(`${selector} {`)
  expect(i, `${selector} must exist`).toBeGreaterThan(-1)
  return CSS.slice(i, CSS.indexOf('}', i))
}

describe('toasts while an approval is up', () => {
  it('are laid out above the dialog, inside its scrim, not floated over it', async () => {
    withApproval()
    render(
      <>
        <ApprovalWatcher />
        <Toasts />
      </>
    )
    const dialog = await screen.findByRole('dialog', { name: 'AI action requires approval' })
    act(() => {
      toast('Copied')
      toast('Something failed', 'error')
    })

    const stack = document.querySelector('.toasts') as HTMLElement
    expect(stack.classList.contains('in-slot')).toBe(true)
    expect(dialog.closest('.approval-scrim')?.contains(stack)).toBe(true)
    // Before the dialog in the scrim's flow, so it is drawn above it.
    expect(stack.compareDocumentPosition(dialog) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(stack.textContent).toContain('Something failed')
    // In flow, not positioned: this is the rule that makes "cannot cover" true.
    expect(rule('.toasts.in-slot')).toMatch(/position:\s*static/)
    expect(rule('.scrim.approval-scrim')).toMatch(/align-content:\s*center/)
  })

  it('go back to their corner once it is answered', async () => {
    withApproval()
    render(
      <>
        <ApprovalWatcher />
        <Toasts />
      </>
    )
    await screen.findByRole('dialog', { name: 'AI action requires approval' })
    act(() => useApprovalQueue.setState({ pending: [] }))

    const stack = document.querySelector('.toasts') as HTMLElement
    expect(stack.classList.contains('in-slot')).toBe(false)
    expect(stack.closest('.approval-scrim')).toBeNull()
  })
})

describe('the kill switch failing', () => {
  it('says so in the dialog, not only in a toast', async () => {
    withApproval(vi.fn(async () => undefined as never))
    render(<ApprovalWatcher />)

    await userEvent.click(await screen.findByRole('button', { name: /Deny and stop all AI access/ }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(KILL_SWITCH_FAILED)
    expect(alert.closest('[role="dialog"]')).not.toBeNull()
  })
})

describe('the approval footer', () => {
  it('keeps the kill switch and the answers as two groups that wrap', async () => {
    withApproval()
    render(<ApprovalWatcher />)
    const deny = await screen.findByRole('button', { name: 'Deny' })

    const footer = deny.closest('.approval-footer') as HTMLElement
    const answers = deny.closest('.approval-answers') as HTMLElement
    expect(footer).not.toBeNull()
    expect(answers.parentElement).toBe(footer)
    // The kill switch is outside the answers group, on its own side.
    const kill = screen.getByRole('button', { name: /Deny and stop all AI access/ })
    expect(answers.contains(kill)).toBe(false)
    // The session grant is present, which is the case that overflowed.
    expect(answers.textContent).toMatch(/for this session/)

    expect(rule('.approval-footer')).toMatch(/flex-wrap:\s*wrap/)
    expect(rule('.approval-answers')).toMatch(/flex-wrap:\s*wrap/)
    expect(rule('.approval-answers')).toMatch(/margin-left:\s*auto/)
    // A long grant label wraps inside its button instead of widening the row.
    expect(rule('.approval-answers .btn')).toMatch(/white-space:\s*normal/)
  })

  it('still puts the focus on Deny', async () => {
    withApproval()
    render(<ApprovalWatcher />)
    const deny = await screen.findByRole('button', { name: 'Deny' })
    expect(document.activeElement).toBe(deny)
  })
})

describe('the corner the walkthrough shares', () => {
  it('moves toasts left of a tour or tip card, so they cannot cover its Next button', () => {
    expect(rule('body:has(.tour-card, .tip-card) .toasts:not(.in-slot)')).toMatch(/right:\s*min\(calc\(400px/)
  })
})

describe('a heading focused for a screen reader', () => {
  it('draws no ring, since nobody tabbed to it', () => {
    expect(rule(":is(h1, h2, h3)[tabindex='-1']:focus-visible")).toMatch(/outline:\s*none/)
  })
})
