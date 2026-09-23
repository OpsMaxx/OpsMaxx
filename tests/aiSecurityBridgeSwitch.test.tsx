// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { stubBridge } from './setup/renderer'
import { AiSecurity } from '../src/renderer/src/components/ai/AiSecurity'
import { useToasts } from '../src/renderer/src/store/toast'
import type { McpGlobalConfig } from '../src/shared/mcp'

// Found in the running app with 127.0.0.1:5177 already taken. The switch read
// the SETTING, so it was drawn on beside text reading "Off"; pressing it turned
// the setting off instead of trying again; the error toast appeared twice and
// was still there after a later attempt succeeded.

const CONFIG = { enabled: true, port: 5177, approvalTimeoutSeconds: 120 } as McpGlobalConfig

function bridge(opts: { running: boolean; results: { error?: string }[] }): {
  setConfig: ReturnType<typeof vi.fn>
  status: { running: boolean }
} {
  const status = { running: opts.running }
  const results = [...opts.results]
  const setConfig = vi.fn(async (patch: Partial<McpGlobalConfig>) => {
    const r = results.shift() ?? {}
    status.running = !r.error && patch.enabled !== false
    return { config: { ...CONFIG, ...patch }, ...r }
  })
  stubBridge({
    aiMcp: {
      getConfig: async () => CONFIG,
      status: async () => ({ running: status.running, port: status.running ? 5177 : null }),
      setConfig,
      listSessions: async () => [],
      listApprovals: async () => []
    }
  })
  return { setConfig, status }
}

const toggle = (): HTMLElement => screen.getByRole('switch', { name: 'Enable AI & MCP access' })
const bindToasts = (): number =>
  useToasts.getState().toasts.filter((t) => t.message.includes('could not listen')).length

describe('the AI & MCP switch', () => {
  it('shows off, and says why, when it is enabled but not listening', async () => {
    bridge({ running: false, results: [] })
    render(<AiSecurity />)

    await screen.findByText(/Not listening: OpsMaxx could not open 127.0.0.1:5177/)
    expect(toggle().getAttribute('aria-checked')).toBe('false')
    expect(toggle().classList.contains('on')).toBe(false)
  })

  it('tries again when pressed from off, rather than turning the setting off', async () => {
    const { setConfig } = bridge({ running: false, results: [{ error: 'listen EADDRINUSE' }] })
    render(<AiSecurity />)
    await screen.findByText(/Not listening/)

    await userEvent.click(toggle())

    expect(setConfig).toHaveBeenCalledWith({ enabled: true })
  })

  it('shows one failure toast however many times it fails, and clears it on success', async () => {
    bridge({
      running: false,
      // Two different messages: identical ones were already collapsed, and it
      // was the ones that differ that stacked.
      results: [{ error: 'listen EADDRINUSE 127.0.0.1:5177' }, { error: 'listen EACCES' }, {}]
    })
    render(<AiSecurity />)
    await screen.findByText(/Not listening/)

    await userEvent.click(toggle())
    await userEvent.click(toggle())
    await waitFor(() => expect(bindToasts()).toBe(1))

    await userEvent.click(toggle())
    await waitFor(() => expect(bindToasts()).toBe(0))
    await waitFor(() => expect(toggle().getAttribute('aria-checked')).toBe('true'))
  })
})
