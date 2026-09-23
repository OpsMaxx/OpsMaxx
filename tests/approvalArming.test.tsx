// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { stubBridge } from './setup/renderer'
import { ARM_MS, useArming } from '../src/renderer/src/hooks/useArming'
import { AiApprovals } from '../src/renderer/src/components/ai/AiApprovals'
import { AgentApprovalWatcher } from '../src/renderer/src/components/sshAgent/AgentApprovalWatcher'
import type { ApprovalRequest } from '../src/shared/mcp'

// The other two places a yes is given: the Approvals page and the SSH agent's
// signing prompt. Both change under the pointer — a withdrawn row closes up the
// list, and answering one signing prompt brings up the next — so both arm.
//
// On fake timers, `performance` included, and fireEvent rather than userEvent,
// so every step is exactly where the test says it is. The first version waited
// on real time and failed two runs in three: the hook reset its clock in an
// effect, after paint, and the test caught the frame in between.

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] })
})
afterEach(() => {
  vi.useRealTimers()
})

/** Let pending promises (the bridge reads) settle and React commit. */
const flush = (): Promise<void> => act(async () => {})
const advance = (ms: number): void =>
  act(() => {
    vi.advanceTimersByTime(ms)
  })
const disabled = (el: HTMLElement): string | null => el.getAttribute('aria-disabled')

describe('useArming', () => {
  function Probe({ id }: { id: string }): React.JSX.Element {
    const { armed } = useArming(id)
    return <button aria-disabled={!armed}>yes</button>
  }

  // The hole the effect left. act() flushes effects before it returns, so the
  // DOM afterwards cannot show it; what does is every render the hook
  // produced. With the clock reset in an effect, the render that brought in
  // key b said armed — and that render is what the browser painted.
  it('is inert in the same render that changes the key', () => {
    const renders: [string, boolean][] = []
    function Logged({ id }: { id: string }): React.JSX.Element {
      const { armed } = useArming(id)
      renders.push([id, armed])
      return <button aria-disabled={!armed}>yes</button>
    }
    const { rerender } = render(<Logged id="a" />)
    advance(ARM_MS)
    expect(disabled(screen.getByRole('button'))).toBe('false')

    rerender(<Logged id="b" />)
    expect(renders.filter(([id]) => id === 'b').length).toBeGreaterThan(0)
    expect(renders.filter(([id, armed]) => id === 'b' && armed)).toEqual([])
    expect(disabled(screen.getByRole('button'))).toBe('true')
  })

  it('arms at exactly ARM_MS, not before', () => {
    render(<Probe id="a" />)
    advance(ARM_MS - 1)
    expect(disabled(screen.getByRole('button'))).toBe('true')
    advance(1)
    expect(disabled(screen.getByRole('button'))).toBe('false')
  })
})

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
    await flush()
    advance(ARM_MS)
    expect(screen.getAllByRole('button', { name: 'Approve once' }).map(disabled)).toEqual(['false', 'false'])

    // Row a is withdrawn: row b's Approve once moves up to where a's was.
    list = [row('b', 'rm -rf /srv/app')]
    act(() => fire())
    await flush()
    expect(screen.queryByText('uptime')).toBeNull()

    // Immediately inert, in the render that moved it — the one-frame hole.
    const once = screen.getByRole('button', { name: 'Approve once' })
    expect(disabled(once)).toBe('true')
    fireEvent.click(once)
    advance(ARM_MS - 1)
    fireEvent.click(once)
    expect(respondApproval).not.toHaveBeenCalled()

    advance(1)
    expect(disabled(once)).toBe('false')
    fireEvent.click(once)
    expect(respondApproval).toHaveBeenCalledWith('b', 'approved', 'once')
  })
})

describe('the SSH agent signing prompt', () => {
  const prompt = (id: string): object => ({
    id,
    identity: { name: 'Production key', fingerprint: 'SHA256:abc' },
    destination: { host: 'github.com', user: 'git' },
    requestedAt: 0
  })

  it('holds its yeses for a moment, and never its Refuse', async () => {
    const resolve = vi.fn(async () => undefined)
    stubBridge({
      sshAgent: { pending: async () => [prompt('sig-1')], onApprovalEvent: () => () => undefined, resolve }
    })
    render(<AgentApprovalWatcher />)
    await flush()
    const once = screen.getByRole('button', { name: 'Allow once' })

    expect(disabled(once)).toBe('true')
    fireEvent.click(once)
    expect(resolve).not.toHaveBeenCalled()

    advance(ARM_MS)
    fireEvent.click(once)
    expect(resolve).toHaveBeenCalledWith('sig-1', { allow: true, scope: 'once' })
  })

  it('re-arms for the next prompt, which comes up under the same pointer', async () => {
    const resolve = vi.fn(async () => undefined)
    stubBridge({
      sshAgent: {
        pending: async () => [prompt('sig-1'), prompt('sig-2')],
        onApprovalEvent: () => () => undefined,
        resolve
      }
    })
    render(<AgentApprovalWatcher />)
    await flush()
    advance(ARM_MS)
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))
    expect(resolve).toHaveBeenLastCalledWith('sig-1', { allow: true, scope: 'once' })

    // sig-2 is now at the front, in the same place.
    const next = screen.getByRole('button', { name: 'Allow once' })
    expect(disabled(next)).toBe('true')
    fireEvent.click(next)
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it('refuses at once', async () => {
    const resolve = vi.fn(async () => undefined)
    stubBridge({
      sshAgent: { pending: async () => [prompt('sig-3')], onApprovalEvent: () => () => undefined, resolve }
    })
    render(<AgentApprovalWatcher />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: 'Refuse' }))
    expect(resolve).toHaveBeenCalledWith('sig-3', { allow: false })
  })
})
