// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { stubBridge } from './setup/renderer'
import { AiAuthorizations } from '../src/renderer/src/components/ai/AiAuthorizations'
import type { AccessGroup } from '../src/shared/mcp'

/**
 * The one screen where a person decides what a client may do.
 *
 * Everything else in the OAuth flow is machinery that runs without a human:
 * discovery, registration, PKCE, the code exchange. This is the only point at
 * which somebody looks at who is asking and says yes, so the thing worth
 * pinning is that it cannot say yes on its own.
 */

const group = (id: string, name: string): AccessGroup =>
  ({ id, name, builtIn: true, capabilities: {}, filePolicies: [] }) as unknown as AccessGroup

const GROUPS = [group('grp-read-only', 'Read Only'), group('grp-full', 'Full Access')]
const WORKSPACES = [
  { id: 'ws-prod', name: 'Production' },
  { id: 'ws-dev', name: 'Development' }
]

const REQUEST = {
  id: 'consent-1',
  clientName: 'Claude Code (opsmaxx)',
  redirectUri: 'http://localhost:52346/callback',
  createdAt: Date.now()
}

function mount(over: Record<string, unknown> = {}): {
  approve: ReturnType<typeof vi.fn>
  deny: ReturnType<typeof vi.fn>
} {
  const approve = vi.fn(async () => ({ ok: true }))
  const deny = vi.fn(async () => ({ ok: true }))
  stubBridge({
    aiMcp: {
      listAuthorizations: async () => [REQUEST],
      approveAuthorization: approve,
      denyAuthorization: deny,
      ...over
    },
    aiPolicy: {
      listWorkspaces: async () => WORKSPACES,
      listGroups: async () => GROUPS
    }
  } as never)
  render(<AiAuthorizations />)
  return { approve, deny }
}

const approveButton = (): HTMLButtonElement =>
  screen.getByRole('button', { name: /Approve/ }) as HTMLButtonElement

describe('approving a client', () => {
  it('shows who is asking and where they will be sent back to', async () => {
    mount()
    expect(await screen.findByText('Claude Code (opsmaxx)')).toBeTruthy()
    expect(screen.getByText('http://localhost:52346/callback')).toBeTruthy()
  })

  it('cannot be approved until a group AND a workspace are chosen', async () => {
    // The whole reason this screen exists. A default here would be an access
    // grant nobody picked, handed to a client that asked for it.
    const { approve } = mount()
    await screen.findByText('Claude Code (opsmaxx)')
    expect(approveButton().disabled).toBe(true)

    await userEvent.click(screen.getByText('Production'))
    expect(approveButton().disabled).toBe(true) // still no group

    await userEvent.selectOptions(screen.getByTestId('authorization-group'), 'grp-read-only')
    await waitFor(() => expect(approveButton().disabled).toBe(false))
    expect(approve).not.toHaveBeenCalled()
  })

  it('offers no preselected access group', async () => {
    mount()
    await screen.findByText('Claude Code (opsmaxx)')
    expect((screen.getByTestId('authorization-group') as HTMLSelectElement).value).toBe('')
  })

  it('passes exactly what was chosen, and nothing it was not given', async () => {
    const { approve } = mount()
    await screen.findByText('Claude Code (opsmaxx)')
    await userEvent.click(screen.getByText('Development'))
    await userEvent.selectOptions(screen.getByTestId('authorization-group'), 'grp-full')
    await waitFor(() => expect(approveButton().disabled).toBe(false))
    await userEvent.click(approveButton())

    await waitFor(() => expect(approve).toHaveBeenCalledTimes(1))
    expect(approve).toHaveBeenCalledWith('consent-1', {
      groupId: 'grp-full',
      groupName: 'Full Access',
      // Only the one that was toggled on -- not every workspace on offer.
      workspaces: [{ id: 'ws-dev', name: 'Development' }],
      // An access group picked on the consent card is the Custom profile.
      mode: 'custom'
    })
  })

  it('can be denied without choosing anything', async () => {
    // Refusing is not a decision that needs a grant attached to it.
    const { deny } = mount()
    await screen.findByText('Claude Code (opsmaxx)')
    await userEvent.click(screen.getByRole('button', { name: /Deny/ }))
    await waitFor(() => expect(deny).toHaveBeenCalledWith('consent-1'))
  })

  it('says so when the request expired instead of looking like a dead button', async () => {
    // A consent times out on its own after a few minutes. Main reports that as
    // a refusal rather than throwing, and swallowing it would leave somebody
    // clicking Approve at a request that can never be granted.
    const { approve } = mount({
      approveAuthorization: vi.fn(async () => ({ ok: false, error: 'That authorization request is no longer open.' }))
    })
    await screen.findByText('Claude Code (opsmaxx)')
    await userEvent.click(screen.getByText('Production'))
    await userEvent.selectOptions(screen.getByTestId('authorization-group'), 'grp-read-only')
    await waitFor(() => expect(approveButton().disabled).toBe(false))
    await userEvent.click(approveButton())

    expect(await screen.findByText(/no longer open/)).toBeTruthy()
    expect(approve).not.toHaveBeenCalled()
  })
})

describe('consent offers profiles as well as groups', () => {
  it('grants a predefined profile with no group, and never offers Bypass', async () => {
    const approve = vi.fn(async () => ({ ok: true as const }))
    stubBridge({
      aiMcp: {
        listAuthorizations: vi.fn(async () => [
          { id: 'consent-1', clientName: 'Claude Code', redirectUri: 'http://127.0.0.1:1/cb', createdAt: Date.now() }
        ]),
        approveAuthorization: approve,
        denyAuthorization: vi.fn(async () => ({ ok: true }))
      },
      aiPolicy: {
        listGroups: vi.fn(async () => [{ id: 'grp-full', name: 'Full Access' }]),
        listWorkspaces: vi.fn(async () => [{ id: 'ws-dev', name: 'Development' }])
      }
    })
    render(<AiAuthorizations />)
    const select = (await screen.findByTestId('authorization-group')) as HTMLSelectElement
    expect([...select.options].map((o) => o.value)).not.toContain('profile:bypass')
    await userEvent.selectOptions(select, 'profile:auto')
    await userEvent.click(screen.getByText('Development'))
    await userEvent.click(screen.getByRole('button', { name: /Approve/ }))
    await waitFor(() => expect(approve).toHaveBeenCalledTimes(1))
    expect(approve).toHaveBeenCalledWith('consent-1', {
      groupId: null,
      groupName: 'Auto',
      workspaces: [{ id: 'ws-dev', name: 'Development' }],
      mode: 'auto'
    })
  })
})
