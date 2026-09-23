// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import userEvent from '@testing-library/user-event'
import { stubBridge } from './setup/renderer'
import { ApprovalWatcher } from '../src/renderer/src/components/ai/ApprovalWatcher'
import { ToastSlot, Toasts } from '../src/renderer/src/components/common/Toasts'
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
    expect(rule('.scrim.approval-scrim')).toMatch(/flex-direction:\s*column/)
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

describe('two approvals up at once', () => {
  // The AI dialog re-renders every second for its countdown. With an inline
  // ref it re-registered its slot each time and, chosen as last-registered,
  // pulled the stack under the SSH agent prompt in front of it, re-mounting
  // every role="alert" toast so a screen reader announced it again.
  it('keeps toasts in the front slot, and does not re-mount them', () => {
    let tick: () => void = () => undefined
    function Ticking(): React.JSX.Element {
      const [, set] = useState(0)
      tick = () => set((n) => n + 1)
      return (
        <div data-testid="behind">
          <ToastSlot />
        </div>
      )
    }
    stubBridge({})
    render(
      <>
        <Ticking />
        <div data-testid="front">
          <ToastSlot />
        </div>
        <Toasts />
      </>
    )
    act(() => toast('Something failed', 'error'))
    const node = screen.getByRole('alert')
    expect(screen.getByTestId('front').contains(node)).toBe(true)

    for (let i = 0; i < 5; i++) act(() => tick())

    expect(screen.getByRole('alert')).toBe(node)
    expect(screen.getByTestId('front').contains(node)).toBe(true)
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

describe('the next queued request', () => {
  it('does not inherit the previous one\'s kill switch failure', async () => {
    withApproval(vi.fn(async () => undefined as never))
    render(<ApprovalWatcher />)
    await userEvent.click(await screen.findByRole('button', { name: /Deny and stop all AI access/ }))
    await screen.findByRole('alert')

    act(() => useApprovalQueue.setState({ pending: [{ ...approval, id: 'appr-2' }] }))

    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(screen.getByRole('dialog', { name: 'AI action requires approval' })).toBeTruthy()
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
    // The session grant is present, which is the case that overflowed. Its
    // visible text names the unit and is its accessible name; the server is in
    // the tooltip.
    const grant = screen.getByRole('button', { name: 'Allow “Execute terminal commands” this session' })
    expect(grant.getAttribute('aria-label')).toBeNull()
    expect(grant.getAttribute('title')).toMatch(/on k3s-node-01.production.example.internal for this session$/)

    expect(rule('.approval-footer')).toMatch(/flex-wrap:\s*wrap/)
    expect(rule('.approval-answers')).not.toMatch(/flex-wrap:\s*wrap/)
    expect(rule('.approval-answers')).toMatch(/margin-left:\s*auto/)
    // A long grant label wraps inside its own button, the one answer that
    // shrinks, instead of wrapping the row to a third line.
    expect(rule('.approval-answers .btn')).toMatch(/flex:\s*none/)
    const grantRule = rule('.approval-answers .btn.approval-grant')
    expect(grantRule).toMatch(/white-space:\s*normal/)
    expect(grantRule).toMatch(/min-width:\s*0/)
  })

  it('still puts the focus on Deny', async () => {
    withApproval()
    render(<ApprovalWatcher />)
    const deny = await screen.findByRole('button', { name: 'Deny' })
    expect(document.activeElement).toBe(deny)
  })
})

describe('fitting the window', () => {
  // jsdom cannot lay out, so these pin the rules that make "fits" true; the
  // numbers were measured in the real app (see the commit).
  it('is a column exactly the window high, whose dialog gives way', () => {
    const scrim = rule('.scrim.approval-scrim')
    expect(scrim).toMatch(/flex-direction:\s*column/)
    expect(scrim).toMatch(/justify-content:\s*safe center/)
    expect(scrim).toMatch(/overflow:\s*hidden/)
    const modal = rule('.approval-scrim > .modal')
    expect(modal).toMatch(/min-height:\s*0/)
    expect(modal).toMatch(/max-height:\s*100%/)
  })

  it('keeps the header, notes and footer at full height; only the body scrolls', () => {
    expect(rule('.approval-scrim .modal-header,\n.approval-scrim .modal-footer,\n.approval-scrim .approval-note')).toMatch(
      /flex:\s*none/
    )
    expect(rule('.modal-body')).toMatch(/overflow-y:\s*auto/)
    expect(rule('.modal-body')).toMatch(/min-height:\s*0/)
  })

  // Measured at 1440x900: with no spacing and no ground of its own, the note
  // sat over the scrolling body's last visible line.
  it('gives the later-writes note its own band on the dialog\'s ground', () => {
    const note = rule('.approval-later-writes')
    expect(note).toMatch(/padding:\s*var\(--sp-2\)/)
    expect(note).toMatch(/background:\s*var\(--bg-card\)/)
    expect(note).toMatch(/border-top:/)
  })

  it('caps the toast stack at a quarter of the height, scrolling inside itself', () => {
    const slot = rule('.toasts.in-slot')
    expect(slot).toMatch(/max-height:\s*25vh/)
    expect(slot).toMatch(/overflow-y:\s*auto/)
  })

  it('puts the newest toast first while it is capped', async () => {
    withApproval()
    render(
      <>
        <ApprovalWatcher />
        <Toasts />
      </>
    )
    await screen.findByRole('dialog', { name: 'AI action requires approval' })
    act(() => {
      toast('First')
      toast('Second')
    })
    const texts = [...document.querySelectorAll('.toasts.in-slot .toast')].map((t) => t.textContent)
    expect(texts[0]).toContain('Second')
  })
})

describe('the corner the walkthrough shares', () => {
  it('moves toasts left of a tour or tip card, and no further than the activity bar', () => {
    const r = rule('body:has(.tour-card, .tip-card) .toasts:not(.in-slot)')
    expect(r).toMatch(/right:\s*calc\(400px \+ var\(--sp-3\)\)/)
    expect(r).toMatch(/max-width:\s*calc\(100vw - 400px - var\(--sp-3\) - var\(--activitybar-w\)/)
  })

  it('keeps toasts under the palette scrim while it is open', () => {
    expect(rule('body:has(.palette-scrim) .toasts:not(.in-slot)')).toMatch(/z-index:\s*calc\(var\(--z-palette\) - 1\)/)
  })
})

describe('an agent that disconnected while you were deciding', () => {
  it('is announced as that, not as the clock', async () => {
    let fire: (e: unknown) => void = () => undefined
    stubBridge({
      aiMcp: {
        listApprovals: async () => [approval],
        getConfig: async () => ({ approvalTimeoutSeconds: 120 }),
        listSessions: async () => [],
        listAudit: async () => [],
        onApprovalEvent: (cb: (e: unknown) => void) => {
          fire = cb
          return () => undefined
        }
      }
    })
    render(
      <>
        <ApprovalWatcher />
        <Toasts />
      </>
    )
    await screen.findByRole('dialog', { name: 'AI action requires approval' })

    act(() => fire({ type: 'resolved', request: { ...approval, status: 'disconnected' } }))

    await waitFor(() => expect(document.body.textContent).toContain('The agent disconnected before you answered'))
    expect(document.body.textContent).not.toContain('by the clock')
  })
})

describe('a heading focused for a screen reader', () => {
  it('draws no ring, since nobody tabbed to it', () => {
    expect(rule(":is(h1, h2, h3)[tabindex='-1']:focus-visible")).toMatch(/outline:\s*none/)
  })
})
