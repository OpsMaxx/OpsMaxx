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

describe('the Effective access panel', () => {
  const rows = [
    { ...row },
    {
      ...row,
      capability: 'writeFiles',
      label: 'Write files',
      decision: 'allow',
      beforeMode: 'ask',
      bypassed: true,
      decidedBy: 'scope',
      scopeGroupId: 'grp-rw',
      scopeGroupName: 'Read & Write',
      scopeWorkspaceId: 'ws',
      scopeWorkspaceName: 'Prod',
      mode: 'bypass'
    },
    { ...row, capability: 'sudo', label: 'Sudo / privilege escalation', decision: 'ask', beforeMode: 'ask' },
    { ...row, capability: 'hostFacts', label: 'Host inventory', decision: 'deny', beforeMode: 'deny' }
  ] as CapabilityExplanation[]

  function withRestriction(removeAssignment = vi.fn(async () => undefined)): ReturnType<typeof vi.fn> {
    stubBridge({
      aiMcp: { explainAccess: vi.fn(async () => rows), setSessionMode: vi.fn() },
      aiPolicy: {
        listProtected: vi.fn(async () => []),
        listServers: vi.fn(async () => []),
        listAssignments: vi.fn(async () => [
          { id: 'asn-1', scope: { level: 'workspace', workspaceId: 'ws' }, groupId: 'grp-rw' }
        ]),
        removeAssignment
      }
    })
    return removeAssignment
  }

  const withRw = [...groups, { id: 'grp-rw', name: 'Read & Write' }] as AccessGroup[]

  it('groups capabilities by outcome instead of one row per verdict', async () => {
    withRestriction()
    render(<SessionAccess session={session} groups={withRw} onChanged={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: /Effective access/ }))
    expect((await screen.findByTestId('bucket-allow')).textContent).toContain('Write files')
    expect(screen.getByTestId('bucket-ask').textContent).toContain('Sudo')
    expect(screen.getByTestId('bucket-deny').textContent).toContain('Host inventory')
    // The engine's paragraph is not the table's text any more.
    expect(screen.queryByText(/held below what this AI session/)).toBeNull()
  })

  it('names a restriction on its own, says it is holding the agent, and removes it in one click', async () => {
    const removeAssignment = withRestriction()
    const onChanged = vi.fn()
    render(<SessionAccess session={session} groups={withRw} onChanged={onChanged} />)
    expect((await screen.findByTestId('restriction-note')).textContent).toMatch(
      /Prod workspace is restricted to Read & Write/
    )
    await userEvent.click(screen.getByRole('button', { name: /Effective access/ }))
    await userEvent.click(await screen.findByRole('button', { name: /Remove restriction/ }))
    await waitFor(() => expect(removeAssignment).toHaveBeenCalledWith('asn-1'))
    expect(onChanged).toHaveBeenCalled()
  })

  it('in Bypass, a restriction is listed as lifted and does not warn', async () => {
    withRestriction()
    render(<SessionAccess session={{ ...session, mode: 'bypass' }} groups={withRw} onChanged={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: /Effective access/ }))
    expect((await screen.findByTestId('restrictions')).textContent).toMatch(/lifted while this agent is in Bypass/)
    expect(screen.queryByTestId('restriction-note')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: /why, per capability/ }))
    expect(screen.getByText(/Prod’s restriction says Ask — Bypass lifts it/)).toBeTruthy()
  })
})
