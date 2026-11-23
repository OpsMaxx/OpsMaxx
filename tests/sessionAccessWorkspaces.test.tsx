// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { stubBridge } from './setup/renderer'
import { SessionAccess } from '../src/renderer/src/components/ai/SessionAccess'
import { useApp } from '../src/renderer/src/store/app'
import { useToasts } from '../src/renderer/src/store/toast'
import type { AccessGroup, McpAgentSession } from '../src/shared/mcp'

// Granting a live session another workspace from its card. Widening access, so
// the panel says what it means, a locked workspace cannot be granted until it
// is opened, and the last workspace cannot be taken away (revoke does that).

const session = {
  id: 'sess-1',
  agentName: 'Claude Code',
  workspaces: [{ id: 'w1', name: 'Prod' }],
  groupId: 'grp-full',
  groupName: 'Full Access',
  mode: 'custom'
} as McpAgentSession

const groups = [{ id: 'grp-full', name: 'Full Access' }] as AccessGroup[]

function setup(setSessionWorkspaces: ReturnType<typeof vi.fn>): void {
  stubBridge({
    aiMcp: { explainAccess: vi.fn(async () => []), setSessionWorkspaces },
    aiPolicy: { listProtected: vi.fn(async () => []), listServers: vi.fn(async () => []), listAssignments: vi.fn(async () => []) }
  })
}

beforeEach(() => {
  useToasts.setState({ toasts: [] } as never)
  useApp.setState({
    workspaces: [
      { id: 'w1', name: 'Prod', color: 'green', hidden: false, locked: false, hasPassword: false },
      { id: 'w2', name: 'Lab', color: 'blue', hidden: false, locked: false, hasPassword: false },
      { id: 'w3', name: 'Vault', color: 'red', hidden: false, locked: false, hasPassword: true }
    ],
    unlockedWorkspaces: []
  } as never)
})

async function openPanel(s: McpAgentSession = session, onChanged = vi.fn()): Promise<void> {
  render(<SessionAccess session={s} groups={groups} onChanged={onChanged} />)
  await userEvent.click(screen.getByRole('button', { name: /Workspaces/ }))
}

describe('a session’s workspaces', () => {
  it('says that ticking one lets the agent see and use it, under this session’s access', async () => {
    setup(vi.fn())
    await openPanel()
    expect(screen.getByTestId('session-workspaces').textContent).toMatch(/Claude Code can see and use everything.*Full Access/)
  })

  it('grants one and reports it once main confirms', async () => {
    const set = vi.fn(async () => ({ ...session, workspaces: [...session.workspaces, { id: 'w2', name: 'Lab' }] }))
    setup(set)
    const onChanged = vi.fn()
    await openPanel(session, onChanged)
    await userEvent.click(screen.getByRole('checkbox', { name: /Lab/ }))

    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(set).toHaveBeenCalledWith('sess-1', ['w1', 'w2'])
    expect(useToasts.getState().toasts.some((t) => t.kind === 'ok' && /can now see and use Lab/.test(t.message))).toBe(true)
  })

  it('says so when main dropped the workspace, rather than claiming it was granted', async () => {
    // e.g. a workspace an agent created a moment ago and the app has not saved.
    setup(vi.fn(async () => session))
    const onChanged = vi.fn()
    await openPanel(session, onChanged)
    await userEvent.click(screen.getByRole('checkbox', { name: /Lab/ }))

    await waitFor(() => expect(useToasts.getState().toasts.some((t) => t.kind === 'error')).toBe(true))
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('will not grant a locked workspace until it is unlocked', async () => {
    setup(vi.fn())
    await openPanel()
    expect((screen.getByRole('checkbox', { name: /Vault/ }) as HTMLInputElement).disabled).toBe(true)
    expect(screen.getByRole('button', { name: 'Unlock' })).toBeTruthy()

    useApp.setState({ unlockedWorkspaces: ['w3'] } as never)
    await waitFor(() => expect((screen.getByRole('checkbox', { name: /Vault/ }) as HTMLInputElement).disabled).toBe(false))
  })

  it('will not take away the last workspace', async () => {
    setup(vi.fn())
    await openPanel()
    expect((screen.getByRole('checkbox', { name: /Prod/ }) as HTMLInputElement).disabled).toBe(true)
  })

  it('takes one away when the session has more', async () => {
    const two = { ...session, workspaces: [...session.workspaces, { id: 'w2', name: 'Lab' }] }
    const set = vi.fn(async () => ({ ...session, workspaces: [{ id: 'w2', name: 'Lab' }] }))
    setup(set)
    const onChanged = vi.fn()
    await openPanel(two, onChanged)
    await userEvent.click(screen.getByRole('checkbox', { name: /Prod/ }))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(set).toHaveBeenCalledWith('sess-1', ['w2'])
  })
})

describe('review round 1', () => {
  it('holds every box while a change is in flight, and builds the next on main’s answer', async () => {
    // Two quick ticks used to both start from the prop, so the second undid
    // the first. Now the second waits, and starts from what main answered.
    const four = [
      ...useApp.getState().workspaces,
      { id: 'w4', name: 'Edge', color: 'cyan', hidden: false, locked: false, hasPassword: false }
    ]
    useApp.setState({ workspaces: four } as never)
    let release: (() => void) | null = null
    const set = vi.fn(
      (_id: string, ids: string[]) =>
        new Promise((resolve) => {
          release = () => resolve({ ...session, workspaces: ids.map((id) => ({ id, name: id })) })
        })
    )
    setup(set)
    await openPanel()
    await userEvent.click(screen.getByRole('checkbox', { name: /Lab/ }))
    expect((screen.getByRole('checkbox', { name: /Edge/ }) as HTMLInputElement).disabled).toBe(true)

    release!()
    await waitFor(() => expect((screen.getByRole('checkbox', { name: /Edge/ }) as HTMLInputElement).disabled).toBe(false))
    await userEvent.click(screen.getByRole('checkbox', { name: /Edge/ }))
    release!()
    await waitFor(() => expect(set).toHaveBeenCalledTimes(2))
    expect(set.mock.calls[1][1]).toEqual(['w1', 'w2', 'w4'])
  })

  it('says why it will not add a workspace with the same name as one the session has', async () => {
    useApp.setState((s) => ({
      workspaces: [...s.workspaces, { id: 'w5', name: 'PROD', color: 'pink', hidden: false, locked: false, hasPassword: false }]
    }) as never)
    const set = vi.fn()
    setup(set)
    await openPanel()
    await userEvent.click(screen.getByRole('checkbox', { name: /PROD/ }))
    expect(set).not.toHaveBeenCalled()
    expect(useToasts.getState().toasts.some((t) => t.kind === 'error' && /already has a workspace with that name/.test(t.message))).toBe(true)
  })
})
