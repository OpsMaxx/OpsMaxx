// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { stubBridge } from './setup/renderer'
import { resolveDefaultSessionGroup } from '../src/shared/mcp'
import type { AccessGroup } from '../src/shared/mcp'
import { AiAgents } from '../src/renderer/src/components/ai/AiAgents'
import { ConnectAgent } from '../src/renderer/src/components/ai/ConnectAgent'

/**
 * Which access group a new agent session starts on.
 *
 * Three paths mint sessions and each of them used to decide this for itself:
 * `listGroups()[0]` at CLI pairing, `groups[0]` in the New session form, a
 * hardcoded `grp-read-write` falling through to `list[0]` in the Connect
 * buttons. The session's group is the GRANT, so every one of those handed out an
 * access level nobody chose — on a fresh install, whichever group happened to
 * sit first in the policy file.
 *
 * The resolver's unit tests are here with the two renderer call sites because
 * they are one decision; cliPairing's own integration test covers the third
 * against a real MCP server, and connectAgent.integration.test.ts asserts what
 * the resolved group actually permits.
 */

// Capabilities are deliberately empty: nothing in a group picker reads them, and
// a full 28-capability fixture per group would be 100 lines asserting nothing.
const group = (id: string, name: string): AccessGroup =>
  ({ id, name, builtIn: true, capabilities: {}, filePolicies: [] }) as unknown as AccessGroup

const GROUPS = [
  group('grp-observer', 'Observer'),
  group('grp-read-only', 'Commands, no writes'),
  group('grp-read-write', 'Read & Write'),
  group('grp-full', 'Full Access')
]

describe('resolveDefaultSessionGroup', () => {
  it('returns the configured group when it exists', () => {
    expect(resolveDefaultSessionGroup({ defaultSessionGroupId: 'grp-full' }, GROUPS)).toEqual({
      id: 'grp-full',
      name: 'Full Access'
    })
  })

  it('gives no group when the configured one has since been deleted', () => {
    // The id is a dangling reference, and the one thing it must not become is
    // "some other group". A user who deleted the group they had chosen has not
    // thereby consented to whatever is left.
    expect(resolveDefaultSessionGroup({ defaultSessionGroupId: 'grp-gone' }, GROUPS)).toEqual({
      id: null,
      name: 'No AI Access'
    })
  })

  it('gives no group when nothing is configured, however many groups exist', () => {
    expect(GROUPS.length).toBeGreaterThan(1)
    const resolved = resolveDefaultSessionGroup({}, GROUPS)
    expect(resolved.id).toBeNull()
    // The specific wrong answer this function exists to stop.
    expect(resolved.id).not.toBe(GROUPS[0].id)
  })

  it('treats an empty or whitespace-only configured id as nothing configured', () => {
    // `??` let '' through as a configured choice, which then matched no group —
    // so the answer was null AND the per-flow fallback was never consulted. A
    // config naming nothing at all behaved like a default the user had chosen
    // and since deleted, which is the one case that deliberately refuses a
    // stand-in.
    expect(resolveDefaultSessionGroup({ defaultSessionGroupId: '' }, GROUPS, 'grp-read-write').id).toBe('grp-read-write')
    expect(resolveDefaultSessionGroup({ defaultSessionGroupId: '   ' }, GROUPS, 'grp-read-write').id).toBe(
      'grp-read-write'
    )
    // And with no fallback offered it is the ordinary unconfigured answer.
    expect(resolveDefaultSessionGroup({ defaultSessionGroupId: '' }, GROUPS)).toEqual({
      id: null,
      name: 'No AI Access'
    })
  })

  it('trims a configured id rather than failing to match it', () => {
    // A hand-edited config is the only thing that writes this field, so the id
    // can arrive padded. Untrimmed it resolved to No AI Access, which reads as
    // "the group you named is gone".
    expect(resolveDefaultSessionGroup({ defaultSessionGroupId: '  grp-full  ' }, GROUPS).id).toBe('grp-full')
  })

  it('resolves a duplicated id to one group rather than ambiguity', () => {
    const dupes = [...GROUPS, group('grp-full', 'Full Access (copy)')]
    expect(resolveDefaultSessionGroup({ defaultSessionGroupId: 'grp-full' }, dupes)).toEqual({
      id: 'grp-full',
      name: 'Full Access'
    })
  })

  it('gives no group when there are no groups at all', () => {
    expect(resolveDefaultSessionGroup({ defaultSessionGroupId: 'grp-full' }, [])).toEqual({
      id: null,
      name: 'No AI Access'
    })
    expect(resolveDefaultSessionGroup(undefined, [])).toEqual({ id: null, name: 'No AI Access' })
  })

  describe('the optional per-flow fallback', () => {
    it('applies only when nothing is configured', () => {
      expect(resolveDefaultSessionGroup({}, GROUPS, 'grp-read-write').id).toBe('grp-read-write')
    })

    it('never overrides a configured default', () => {
      expect(resolveDefaultSessionGroup({ defaultSessionGroupId: 'grp-observer' }, GROUPS, 'grp-read-write').id).toBe(
        'grp-observer'
      )
    })

    it('does not stand in for a configured default that was deleted', () => {
      // The difference between "nobody has chosen" and "the choice is gone".
      // Only the first is a gap a flow's own default may fill.
      expect(resolveDefaultSessionGroup({ defaultSessionGroupId: 'grp-gone' }, GROUPS, 'grp-read-write').id).toBeNull()
    })

    it('gives no group when the fallback itself does not exist', () => {
      expect(resolveDefaultSessionGroup({}, GROUPS, 'grp-invented').id).toBeNull()
    })
  })
})

const WORKSPACES = [{ id: 'ws-prod', name: 'Production' }]

function agentsBridge(
  config: { defaultSessionGroupId?: string },
  createSession = vi.fn(async () => ({ token: 'tok' }))
): ReturnType<typeof vi.fn> {
  stubBridge({
    aiMcp: {
      listSessions: vi.fn(async () => []),
      getConfig: vi.fn(async () => config),
      status: vi.fn(async () => ({ running: false, port: null })),
      createSession
    },
    aiPolicy: {
      listWorkspaces: vi.fn(async () => WORKSPACES),
      listGroups: vi.fn(async () => GROUPS)
    }
  })
  return createSession
}

describe('the New AI agent session form preselects the configured default', () => {
  it('preselects the configured group', async () => {
    agentsBridge({ defaultSessionGroupId: 'grp-read-only' })
    render(<AiAgents />)
    const picker = (await screen.findByTestId('new-session-group')) as HTMLSelectElement
    await waitFor(() => expect(picker.value).toBe('grp-read-only'))
  })

  it('preselects No AI Access when nothing is configured, not the first group', async () => {
    const createSession = agentsBridge({})
    render(<AiAgents />)
    const picker = (await screen.findByTestId('new-session-group')) as HTMLSelectElement

    // Visibly No AI Access rather than blank: a <select> whose value matches no
    // option renders empty, which reads as "the first group is selected".
    await waitFor(() => expect(picker.selectedOptions[0]?.textContent).toBe('No AI Access'))
    expect(picker.value).not.toBe(GROUPS[0].id)

    // The effective outcome, not the label on the control: the session this form
    // would actually ask main to mint carries no group, and a null groupId is
    // denied by every gate in mcpServer.ts.
    await userEvent.click(screen.getByRole('button', { name: /create session/i }))
    await waitFor(() => expect(createSession).toHaveBeenCalled())
    expect(createSession.mock.calls[0][0]).toMatchObject({ groupId: null, groupName: 'No AI Access' })
  })

  it('mints the group the user picks, when they pick one', async () => {
    const createSession = agentsBridge({})
    render(<AiAgents />)
    const picker = (await screen.findByTestId('new-session-group')) as HTMLSelectElement
    await waitFor(() => expect(picker.selectedOptions[0]?.textContent).toBe('No AI Access'))

    await userEvent.selectOptions(picker, 'grp-full')
    await userEvent.click(screen.getByRole('button', { name: /create session/i }))
    await waitFor(() => expect(createSession).toHaveBeenCalled())
    expect(createSession.mock.calls[0][0]).toMatchObject({ groupId: 'grp-full', groupName: 'Full Access' })
  })

  it('keeps the group the user picks while getConfig is still in flight', async () => {
    // `groups` is refetched every 5 seconds into a new array, so the effect that
    // preselects the default re-runs until it settles. With a bare setter, a
    // resolve that landed after the user had already chosen in the picker
    // overwrote their choice with the configured default — or with No AI Access —
    // and Create then minted the session on a grant nobody picked.
    let release: (cfg: { defaultSessionGroupId?: string }) => void = () => {}
    const createSession = vi.fn(async (_payload: unknown) => ({ token: 'tok' }))
    stubBridge({
      aiMcp: {
        listSessions: vi.fn(async () => []),
        getConfig: vi.fn(() => new Promise<{ defaultSessionGroupId?: string }>((resolve) => (release = resolve))),
        status: vi.fn(async () => ({ running: false, port: null })),
        createSession
      },
      aiPolicy: {
        listWorkspaces: vi.fn(async () => WORKSPACES),
        listGroups: vi.fn(async () => GROUPS)
      }
    })
    render(<AiAgents />)
    const picker = (await screen.findByTestId('new-session-group')) as HTMLSelectElement
    await waitFor(() => expect(picker.options.length).toBe(GROUPS.length + 1))

    await userEvent.selectOptions(picker, 'grp-full')
    await act(async () => release({ defaultSessionGroupId: 'grp-observer' }))

    expect(picker.value).toBe('grp-full')
    await userEvent.click(screen.getByRole('button', { name: /create session/i }))
    await waitFor(() => expect(createSession).toHaveBeenCalled())
    expect(createSession.mock.calls[0][0]).toMatchObject({ groupId: 'grp-full', groupName: 'Full Access' })
  })

  it('shows No AI Access, not an unrelated group, when the picked group is deleted', async () => {
    // `groups` is refetched every 5 seconds. An admin deleting the group the user
    // has picked leaves `groupId` naming something that is no longer an <option>,
    // and a <select> whose value matches no option renders the FIRST one — React
    // sets `selected` per option, so matching none hands the choice to the
    // browser's selectedness reset, which takes index zero.
    //
    // The form survives that only because `<option value="">No AI Access</option>`
    // IS index zero, so the fallback is the same answer `create()` submits. That
    // position is the whole mechanism and nothing else states it, which is what
    // this test is for: move the No AI Access option down the list and this goes
    // red with the control reading "Observer" while a null grant is minted.
    const createSession = vi.fn(async (_payload: unknown) => ({ token: 'tok' }))
    const surviving = GROUPS.filter((g) => g.id !== 'grp-full')
    let deleted = false
    stubBridge({
      aiMcp: {
        listSessions: vi.fn(async () => []),
        getConfig: vi.fn(async () => ({})),
        status: vi.fn(async () => ({ running: false, port: null })),
        createSession
      },
      aiPolicy: {
        listWorkspaces: vi.fn(async () => WORKSPACES),
        listGroups: vi.fn(async () => (deleted ? surviving : GROUPS))
      }
    })

    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
      render(<AiAgents />)
      const picker = (await screen.findByTestId('new-session-group')) as HTMLSelectElement
      await waitFor(() => expect(picker.options.length).toBe(GROUPS.length + 1))
      await user.selectOptions(picker, 'grp-full')
      expect(picker.value).toBe('grp-full')

      // The group goes while the form is still open, and the poll notices.
      deleted = true
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000)
      })
      await waitFor(() => expect(picker.options.length).toBe(surviving.length + 1))

      // What is RENDERED: the explicit No AI Access option, not GROUPS[0].
      expect(picker.selectedOptions[0]?.textContent).toBe('No AI Access')
      expect(picker.value).toBe('')
      expect(picker.value).not.toBe(surviving[0].id)

      // And what is SUBMITTED agrees with it.
      await user.click(screen.getByRole('button', { name: /create session/i }))
      await waitFor(() => expect(createSession).toHaveBeenCalled())
      expect(createSession.mock.calls[0][0]).toMatchObject({ groupId: null, groupName: 'No AI Access' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('settles on No AI Access when the config cannot be read, instead of asking forever', async () => {
    // A rejected getConfig left groupId null, so the guard never tripped and
    // every 5-second poll fired another IPC call and another unhandled
    // rejection for the life of the page.
    const getConfig = vi.fn(async () => {
      throw new Error('no config')
    })
    stubBridge({
      aiMcp: {
        listSessions: vi.fn(async () => []),
        getConfig,
        status: vi.fn(async () => ({ running: false, port: null })),
        createSession: vi.fn(async () => ({ token: 'tok' }))
      },
      aiPolicy: {
        listWorkspaces: vi.fn(async () => WORKSPACES),
        listGroups: vi.fn(async () => GROUPS)
      }
    })
    render(<AiAgents />)
    const picker = (await screen.findByTestId('new-session-group')) as HTMLSelectElement
    await waitFor(() => expect(picker.selectedOptions[0]?.textContent).toBe('No AI Access'))
    // Settled: the 5-second poll hands the effect a new array, and the resolved
    // state stops it asking again.
    await waitFor(() => expect(getConfig).toHaveBeenCalledTimes(1))
  })
})

describe('the Connect-an-agent picker', () => {
  const connectBridge = (config: { defaultSessionGroupId?: string }, groups = GROUPS): void =>
    stubBridge({
      aiMcp: { getConfig: vi.fn(async () => config) },
      aiPolicy: { listGroups: vi.fn(async () => groups) }
    })

  it('preselects the configured default ahead of its own Read & Write choice', async () => {
    connectBridge({ defaultSessionGroupId: 'grp-observer' })
    render(<ConnectAgent />)
    const picker = (await screen.findByTestId('connect-group')) as HTMLSelectElement
    await waitFor(() => expect(picker.value).toBe('grp-observer'))
  })

  it('keeps Read & Write as its own default when nothing is configured', async () => {
    // Deliberate for this flow — it is the narrowest built-in group that can
    // still add a server, and every mutating capability in it is ASK.
    connectBridge({})
    render(<ConnectAgent />)
    const picker = (await screen.findByTestId('connect-group')) as HTMLSelectElement
    await waitFor(() => expect(picker.value).toBe('grp-read-write'))
  })

  it('does not fall back to the first group when Read & Write is missing', async () => {
    const without = GROUPS.filter((g) => g.id !== 'grp-read-write')
    connectBridge({}, without)
    render(<ConnectAgent />)
    const picker = (await screen.findByTestId('connect-group')) as HTMLSelectElement
    await waitFor(() => expect(picker.selectedOptions[0]?.textContent).toBe('No AI Access'))
    expect(picker.value).not.toBe(without[0].id)
  })

  it('gives no access when the configured default has been deleted', async () => {
    connectBridge({ defaultSessionGroupId: 'grp-gone' })
    render(<ConnectAgent />)
    const picker = (await screen.findByTestId('connect-group')) as HTMLSelectElement
    await waitFor(() => expect(picker.selectedOptions[0]?.textContent).toBe('No AI Access'))
  })
})
