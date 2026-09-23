// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { stubBridge } from './setup/renderer'
import { AiAgents } from '../src/renderer/src/components/ai/AiAgents'
import { useToasts } from '../src/renderer/src/store/toast'

// "Turn on AI access" on the Session created card only opened the Security
// page, leaving the switch to be found there. It now turns the bridge on and
// says whether it is listening.

function bridge(start: { error?: string }): ReturnType<typeof vi.fn> {
  let running = false
  const setConfig = vi.fn(async () => {
    running = !start.error
    return { config: { enabled: true, port: 5177 }, ...start }
  })
  stubBridge({
    aiMcp: {
      listSessions: vi.fn(async () => []),
      getConfig: vi.fn(async () => ({})),
      status: vi.fn(async () => ({ running, port: running ? 5177 : null })),
      createSession: vi.fn(async () => ({ token: 'tok' })),
      setConfig
    },
    aiPolicy: {
      listWorkspaces: vi.fn(async () => [{ id: 'ws-prod', name: 'Production' }]),
      listGroups: vi.fn(async () => [])
    }
  })
  return setConfig
}

async function createSession(): Promise<void> {
  render(<AiAgents />)
  await userEvent.click(await screen.findByRole('button', { name: /create session/i }))
  await screen.findByText(/Nothing can connect yet/)
}

describe('Turn on AI access, on the session card', () => {
  it('turns the bridge on and says where it is listening', async () => {
    const setConfig = bridge({})
    await createSession()

    await userEvent.click(screen.getByRole('button', { name: 'Turn on AI access' }))

    expect(setConfig).toHaveBeenCalledWith({ enabled: true })
    await waitFor(() => expect(screen.queryByText(/Nothing can connect yet/)).toBeNull())
    expect(useToasts.getState().toasts.map((t) => t.message).join()).toContain('listening on 127.0.0.1:5177')
  })

  it('says it did not start, and why, when the port is taken', async () => {
    bridge({ error: 'listen EADDRINUSE' })
    await createSession()

    await userEvent.click(screen.getByRole('button', { name: 'Turn on AI access' }))

    await waitFor(() =>
      expect(useToasts.getState().toasts.map((t) => t.message).join()).toContain('did not start: listen EADDRINUSE')
    )
    expect(screen.getByText(/Nothing can connect yet/)).toBeTruthy()
  })
})
