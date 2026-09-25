// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { stubBridge } from './setup/renderer'
import { ApprovalDialog } from '../src/renderer/src/components/ai/ApprovalDialog'
import { StartsInMode } from '../src/renderer/src/components/ai/ModePicker'
import type { ApprovalRequest } from '../src/shared/mcp'

// The approval's inline mode picker shows the session's LIVE mode, not the one
// it was asked under: picking the value a stale picker shows would be a no-op.

const request = {
  id: 'appr-1',
  sessionId: 'sess-1',
  agentName: 'Claude Code',
  workspaceId: 'ws-1',
  workspaceName: 'Personal',
  serverId: 'srv-1',
  serverName: 'k3s-node-01',
  capability: 'terminal',
  action: 'systemctl restart cron',
  risk: 'high',
  createdAt: new Date().toISOString(),
  status: 'pending',
  sessionMode: 'auto'
} as ApprovalRequest

describe('the approval dialog’s mode picker', () => {
  it('shows the live mode, while the chip keeps the mode it was asked under', async () => {
    let live = 'ask'
    const setSessionMode = vi.fn(async () => ({ id: 'sess-1' }))
    stubBridge({
      aiMcp: {
        getConfig: async () => ({}),
        listAudit: async () => [],
        listSessions: async () => [{ id: 'sess-1', mode: live }],
        setSessionMode
      }
    })
    render(<ApprovalDialog request={request} waiting={1} />)
    expect(screen.getByTestId('approval-mode').textContent).toBe('Asked under: Auto')
    await waitFor(() => expect(screen.getByTestId('mode-picker').textContent).toContain('Ask first'))

    // Changed elsewhere again: opening the picker re-reads it, so Auto is a
    // real change rather than a click on the value already shown.
    live = 'readOnly'
    await userEvent.click(screen.getByTestId('mode-picker'))
    await waitFor(() => expect(screen.getByTestId('mode-picker').textContent).toContain('Read only'))
    await userEvent.keyboard('3')
    expect(setSessionMode).toHaveBeenCalledWith('sess-1', 'auto')
  })
})

describe('the mode a picker-less session starts in', () => {
  it('names a Bypass default in the danger tone', async () => {
    stubBridge({ aiMcp: { getConfig: async () => ({ defaultSessionMode: 'bypass' }) } })
    render(<StartsInMode />)
    const note = await screen.findByTestId('starts-in-mode')
    expect(note.textContent).toContain('Bypass permissions')
    expect(note.querySelector('.chip.danger')).not.toBeNull()
  })

  it('does not claim a mode it could not read', async () => {
    stubBridge({ aiMcp: { getConfig: async () => Promise.reject(new Error('x')) } })
    render(<StartsInMode />)
    expect(await screen.findByText(/could not be read/)).toBeTruthy()
  })
})
