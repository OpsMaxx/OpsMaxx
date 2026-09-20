// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { stubBridge } from './setup/renderer'
import { AddySetup } from '../src/renderer/src/components/addy/AddySetup'
import { useApp } from '../src/renderer/src/store/app'

/**
 * Where an invite comes from.
 *
 * The field said "the person running the relay mints one with `addy invite`"
 * — a command, with no mention of where to run it. For a product whose whole
 * premise is that you run the relay yourself, that means everybody hit an
 * instruction they had to already know the answer to. The relay now serves an
 * operator console; this is the pointer to it.
 */

beforeEach(() => {
  useApp.getState().setSettings({ addyRelayURL: '' })
  stubBridge({
    addy: {
      status: vi.fn().mockResolvedValue({
        enrolled: false,
        sync: { running: false, connected: false, lastSyncAt: null, conflicts: 0 }
      })
    }
  })
})

/**
 * The invite field is on the first-device path, and that path is a choice now
 * rather than the default.
 *
 * It used to be the screen: relay address, invite, device name, on every
 * machine with no account. An invite is right for exactly one machine in an
 * account and wrong for every one after it, and having it there by default is
 * how somebody who owns this product went looking for an invite to mint for
 * his second laptop. So each of these opens the path first — which is also
 * the only honest way to test the field, since that is now what a person does.
 */
async function firstDevicePath(): Promise<HTMLElement> {
  render(<AddySetup />)
  fireEvent.click(await screen.findByRole('button', { name: /first device/i }))
  return screen.getByPlaceholderText('https://relay.example')
}

describe('the invite field', () => {
  it('is not on screen until this machine says it is the first one', async () => {
    // The fork's whole purpose. A second machine must never be handed an
    // invite: spending one does not add a device, it starts a separate sync
    // group with its own key that cannot see the first.
    render(<AddySetup />)
    await screen.findByRole('button', { name: /first device/i })
    expect(screen.queryByPlaceholderText('https://relay.example')).toBeNull()
  })

  it('points at the console for the relay the user typed', async () => {
    const relay = await firstDevicePath()
    fireEvent.change(relay, { target: { value: 'https://addy.example.com' } })

    const link = screen.getByText('addy.example.com/admin')
    expect(link.getAttribute('href')).toBe('https://addy.example.com/admin')
  })

  it('opens it in the browser rather than in a window carrying the preload', async () => {
    // `window.open` goes through main's window-open handler, which vets the
    // scheme and hands it to the OS. Rendering a plain navigation would put
    // an arbitrary page inside an Electron window that has this preload on it.
    const opened = vi.fn()
    vi.stubGlobal('open', opened)
    fireEvent.change(await firstDevicePath(), {
      target: { value: 'https://addy.example.com' }
    })

    fireEvent.click(screen.getByText('addy.example.com/admin'))

    expect(opened).toHaveBeenCalledWith('https://addy.example.com/admin', '_blank', 'noopener')
  })

  it('says nothing specific until the address is a real https one', async () => {
    // Built from what was typed rather than probed, because a relay started
    // without the provider flags serves no console — and asking would be an
    // unauthenticated request on every keystroke.
    fireEvent.change(await firstDevicePath(), { target: { value: 'not-a-url' } })
    expect(screen.queryByText(/\/admin$/)).toBeNull()
    expect(screen.getByText(/Ask whoever runs the relay/)).toBeTruthy()
  })

  it('does not tell anybody to run a command', async () => {
    await firstDevicePath()
    expect(screen.queryByText(/addy invite/)).toBeNull()
  })
})
