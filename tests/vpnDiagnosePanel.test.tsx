// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { stubBridge } from './setup/renderer'
import { VpnDiagnose } from '../src/renderer/src/components/vpn/VpnDiagnose'
import type { VpnDiagnoseResult, VpnDiagnoseRefusal } from '../src/shared/vpn'

// Rendered rather than read. The promises this component keeps are about what
// appears on screen -- a skip that shows its reason, a refusal that is a
// sentence rather than an empty list -- and none of them is visible in a source
// regex: a component can hold the right data and render none of it.

const RESULT: VpnDiagnoseResult = {
  id: 'v1',
  checks: [
    { name: 'handshake', status: 'ok', detail: 'the peer completed a handshake recently', elapsed: 4 },
    {
      name: 'dns',
      status: 'skipped',
      detail: 'the target is already an address, so no name was looked up'
    },
    { name: 'tcp', status: 'failed', detail: 'nothing accepted a connection on this port', elapsed: 5001 }
  ],
  sampledAt: 1
}

function mount(
  diagnose: (id: string, t: { host?: string; port?: number }) => Promise<VpnDiagnoseResult | VpnDiagnoseRefusal>
): void {
  stubBridge({ vpn: { diagnose } })
  render(<VpnDiagnose id="v1" />)
}

describe('running a probe', () => {
  it('sends the operator’s target and nothing it invented', async () => {
    const spy = vi.fn(async () => RESULT)
    mount(spy)
    await userEvent.type(screen.getByPlaceholderText(/Host or address/i), '10.7.0.1')
    await userEvent.type(screen.getByPlaceholderText('Port'), '22')
    await userEvent.click(screen.getByRole('button', { name: /run/i }))
    await waitFor(() => expect(spy).toHaveBeenCalledWith('v1', { host: '10.7.0.1', port: 22 }))
  })

  // There is no address this app may pick on somebody's behalf, and the
  // handshake check needs no target at all.
  it('runs with both fields empty rather than demanding a target', async () => {
    const spy = vi.fn(async () => RESULT)
    mount(spy)
    await userEvent.click(screen.getByRole('button', { name: /run/i }))
    await waitFor(() => expect(spy).toHaveBeenCalledWith('v1', { host: undefined, port: undefined }))
  })

  it('does not send a port that is not a number', async () => {
    const spy = vi.fn(async () => RESULT)
    mount(spy)
    await userEvent.type(screen.getByPlaceholderText('Port'), 'ssh')
    await userEvent.click(screen.getByRole('button', { name: /run/i }))
    await waitFor(() => expect(spy).toHaveBeenCalledWith('v1', { host: undefined, port: undefined }))
  })
})

describe('what the checklist shows', () => {
  it('gives every row its own sentence, including the passing one', async () => {
    mount(async () => RESULT)
    await userEvent.click(screen.getByRole('button', { name: /run/i }))
    await screen.findByText(/completed a handshake recently/i)
    expect(screen.getByText(/nothing accepted a connection/i)).toBeTruthy()
  })

  // A skip is a check that did not run. Rendering its reason is the difference
  // between a checklist and a green tick over an unasked question.
  it('shows why a check was skipped', async () => {
    mount(async () => RESULT)
    await userEvent.click(screen.getByRole('button', { name: /run/i }))
    await screen.findByText(/already an address, so no name was looked up/i)
  })

  // Milliseconds for a probe, seconds for the handshake's age: the units are
  // what each check measured.
  it('labels the handshake in seconds and the probes in milliseconds', async () => {
    mount(async () => RESULT)
    await userEvent.click(screen.getByRole('button', { name: /run/i }))
    await screen.findByText('4s ago')
    expect(screen.getByText('5001 ms')).toBeTruthy()
  })

  it('does not claim a latency when no connect succeeded', async () => {
    mount(async () => RESULT)
    await userEvent.click(screen.getByRole('button', { name: /run/i }))
    await screen.findByText(/completed a handshake recently/i)
    expect(screen.queryByText(/TCP connect took/i)).toBeNull()
  })

  it('names the latency for what was measured rather than calling it a round trip', async () => {
    mount(async () => ({ ...RESULT, latencyMs: 41 }))
    await userEvent.click(screen.getByRole('button', { name: /run/i }))
    const t = await screen.findByText(/TCP connect took 41 ms/i)
    expect(t.textContent).toContain('through the tunnel')
  })

  // An empty checklist and "everything passed" render identically, which is why
  // the refusal is a sentence.
  it('renders a refusal as words rather than as no rows', async () => {
    mount(async () => ({ id: 'v1', unsupported: 'This VPN is not running, so nothing was sent.' }))
    await userEvent.click(screen.getByRole('button', { name: /run/i }))
    await screen.findByText(/not running, so nothing was sent/i)
  })

  // A stale checklist beside a SPINNING button reads as this probe's answer.
  // The assertion has to land while the second probe is still in flight, which
  // is why the second call is held open rather than resolved.
  it('clears the previous answer while the next probe is still running', async () => {
    let release: ((r: VpnDiagnoseResult) => void) | null = null
    let n = 0
    mount(async () => {
      n += 1
      if (n === 1) return RESULT
      return new Promise<VpnDiagnoseResult>((r) => {
        release = r
      })
    })
    await userEvent.click(screen.getByRole('button', { name: /run/i }))
    await screen.findByText(/completed a handshake recently/i)

    await userEvent.click(screen.getByRole('button', { name: /run/i }))
    await screen.findByRole('button', { name: /probing/i })
    // The first probe's answer is gone even though the second has none yet.
    expect(screen.queryByText(/completed a handshake recently/i)).toBeNull()
    expect(screen.queryByText(/nothing accepted a connection/i)).toBeNull()

    ;(release as unknown as ((r: VpnDiagnoseResult) => void) | null)?.(RESULT)
    await screen.findByText(/completed a handshake recently/i)
  })

  it('says the lookup goes through the tunnel rather than the host resolver', async () => {
    mount(async () => RESULT)
    expect(screen.getByText(/never the host resolver/i)).toBeTruthy()
  })

  it('reports a probe that threw instead of leaving the button spinning', async () => {
    mount(async () => {
      throw new Error('channel gone')
    })
    await userEvent.click(screen.getByRole('button', { name: /run/i }))
    await screen.findByText(/could not be run/i)
    expect(screen.getByRole('button', { name: /run/i })).toBeTruthy()
  })
})

// A button that cannot do anything is worse than no button.
it('renders nothing when the preload has no such method', () => {
  stubBridge({ vpn: {} })
  const { container } = render(<VpnDiagnose id="v1" />)
  expect(container.textContent).toBe('')
})

// An input the probe ignores is worse than no input: it invites somebody to
// type a host and then quietly does something else.
describe('an engine whose probe may only reach its own remotes', () => {
  it('renders no target fields', async () => {
    const spy = vi.fn(async () => ({ id: 'v1', checks: [], sampledAt: 1 }))
    stubBridge({ vpn: { diagnose: spy } })
    render(<VpnDiagnose id="v1" showTarget={false} />)
    expect(screen.queryByPlaceholderText(/Host or address/i)).toBeNull()
    expect(screen.queryByPlaceholderText('Port')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: /run/i }))
    await waitFor(() => expect(spy).toHaveBeenCalledWith('v1', { host: undefined, port: undefined }))
  })

  it('says it will not connect anywhere the profile does not already name', () => {
    stubBridge({ vpn: { diagnose: async () => ({ id: 'v1', checks: [], sampledAt: 1 }) } })
    render(<VpnDiagnose id="v1" showTarget={false} />)
    expect(screen.getByText(/will not connect anywhere else/i)).toBeTruthy()
  })
})
