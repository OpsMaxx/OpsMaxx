// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { act, configure, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { stubBridge } from './setup/renderer'
import { AiApprovals } from '../src/renderer/src/components/ai/AiApprovals'
import { AgentApprovalWatcher } from '../src/renderer/src/components/sshAgent/AgentApprovalWatcher'
import type { ApprovalRequest } from '../src/shared/mcp'

// The other two places a yes is given: the Approvals page and the SSH agent's
// signing prompt. Both change under the pointer — a withdrawn row closes up the
// list, and answering one signing prompt brings up the next — so both arm.

configure({ asyncUtilTimeout: 5000 })

const row = (id: string, action: string): ApprovalRequest =>
  ({
    id,
    sessionId: 's',
    agentName: 'Claude Code',
    workspaceId: 'ws',
    workspaceName: 'Personal',
    serverId: 'srv',
    serverName: 'web-1',
    capability: 'terminal',
    action,
    risk: 'medium',
    createdAt: new Date().toISOString(),
    status: 'pending'
  }) as ApprovalRequest

const armedAll = (name: string): Promise<void> =>
  waitFor(() =>
    expect(screen.getAllByRole('button', { name }).every((b) => b.getAttribute('aria-disabled') === 'false')).toBe(true)
  )

describe('the Approvals page', () => {
  it('re-arms every yes when a row leaves and the list closes up', async () => {
    let list = [row('a', 'uptime'), row('b', 'rm -rf /srv/app')]
    const respondApproval = vi.fn(async () => true)
    let fire: () => void = () => undefined
    stubBridge({
      aiMcp: {
        listApprovals: async () => list,
        recentApprovals: async () => [],
        respondApproval,
        onApprovalEvent: (cb: () => void) => {
          fire = cb
          return () => undefined
        }
      }
    })
    render(<AiApprovals />)
    await screen.findByText('rm -rf /srv/app')
    await armedAll('Approve once')

    // Row a is withdrawn: row b's Approve once moves up to where a's was.
    list = [row('b', 'rm -rf /srv/app')]
    act(() => fire())
    await waitFor(() => expect(screen.queryByText('uptime')).toBeNull())

    const once = screen.getByRole('button', { name: 'Approve once' })
    expect(once.getAttribute('aria-disabled')).toBe('true')
    await userEvent.click(once)
    expect(respondApproval).not.toHaveBeenCalled()

    await armedAll('Approve once')
    await userEvent.click(once)
    expect(respondApproval).toHaveBeenCalledWith('b', 'approved', 'once')
  })
})

describe('the SSH agent signing prompt', () => {
  it('holds its yeses for a moment, and never its Refuse', async () => {
    const resolve = vi.fn(async () => undefined)
    stubBridge({
      sshAgent: {
        pending: async () => [
          {
            id: 'sig-1',
            identity: { name: 'Production key', fingerprint: 'SHA256:abc' },
            destination: { host: 'github.com', user: 'git' },
            requestedAt: Date.now()
          }
        ],
        onApprovalEvent: () => () => undefined,
        resolve
      }
    })
    render(<AgentApprovalWatcher />)
    const once = await screen.findByRole('button', { name: 'Allow once' })

    expect(once.getAttribute('aria-disabled')).toBe('true')
    await userEvent.click(once)
    expect(resolve).not.toHaveBeenCalled()

    await armedAll('Allow once')
    await userEvent.click(once)
    expect(resolve).toHaveBeenCalledWith('sig-1', { allow: true, scope: 'once' })
  })

  it('refuses at once', async () => {
    const resolve = vi.fn(async () => undefined)
    stubBridge({
      sshAgent: {
        pending: async () => [
          { id: 'sig-2', identity: { name: 'k', fingerprint: 'f' }, destination: null, requestedAt: Date.now() }
        ],
        onApprovalEvent: () => () => undefined,
        resolve
      }
    })
    render(<AgentApprovalWatcher />)
    await userEvent.click(await screen.findByRole('button', { name: 'Refuse' }))
    expect(resolve).toHaveBeenCalledWith('sig-2', { allow: false })
  })
})
