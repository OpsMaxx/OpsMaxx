// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { stubBridge } from './setup/renderer'
import { SessionAccess } from '../src/renderer/src/components/ai/SessionAccess'
import { useToasts } from '../src/renderer/src/store/toast'
import type { AccessGroup, CapabilityExplanation, McpAgentSession } from '../src/shared/mcp'

// Changing a live session's mode from its card. A failed change must leave the
// Effective access table showing what is still in force, and say so.

const session = {
  id: 'sess-1',
  agentName: 'Claude Code',
  workspaces: [{ id: 'ws', name: 'Prod' }],
  groupId: 'grp-full',
  groupName: 'Full Access',
  mode: 'auto'
} as McpAgentSession

const groups = [{ id: 'grp-full', name: 'Full Access' }] as AccessGroup[]

const row = {
  capability: 'terminal',
  label: 'Execute terminal commands',
  decision: 'allow',
  reason: 'Allowed by access group.',
  fromScope: 'allow',
  fromSession: 'allow',
  decidedBy: 'both',
  mode: 'auto',
  protectedTarget: false,
  partlyAsks: false
} as CapabilityExplanation

function bridge(setSessionMode: ReturnType<typeof vi.fn>): ReturnType<typeof vi.fn> {
  const explainAccess = vi.fn(async () => [row])
  stubBridge({
    aiMcp: { explainAccess, setSessionMode },
    aiPolicy: { listProtected: vi.fn(async () => []), listServers: vi.fn(async () => []) }
  })
  return explainAccess
}

async function pickAskFirst(): Promise<void> {
  await userEvent.click(screen.getByRole('button', { name: /Effective access/ }))
  await screen.findByText('Execute terminal commands')
  await userEvent.click(screen.getByTestId('mode-picker'))
  await userEvent.keyboard('2')
}

describe('changing a session’s mode', () => {
  it('keeps the table and says so when the IPC rejects', async () => {
    const explainAccess = bridge(vi.fn(async () => Promise.reject(new Error('gone'))))
    const onChanged = vi.fn()
    render(<SessionAccess session={session} groups={groups} onChanged={onChanged} />)
    await pickAskFirst()

    await waitFor(() =>
      expect(useToasts.getState().toasts.some((t) => t.kind === 'error' && /was not changed/.test(t.message))).toBe(
        true
      )
    )
    expect(screen.getByText('Execute terminal commands')).toBeTruthy()
    expect(explainAccess).toHaveBeenCalledTimes(1)
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('re-reads the table after a change that took', async () => {
    const setSessionMode = vi.fn(async () => ({ ...session, mode: 'ask' }))
    const explainAccess = bridge(setSessionMode)
    const onChanged = vi.fn()
    render(<SessionAccess session={session} groups={groups} onChanged={onChanged} />)
    await pickAskFirst()

    await waitFor(() => expect(explainAccess).toHaveBeenCalledTimes(2))
    expect(setSessionMode).toHaveBeenCalledWith('sess-1', 'ask')
    expect(onChanged).toHaveBeenCalled()
  })
})
