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

describe('the invite field', () => {
  it('points at the console for the relay the user typed', async () => {
    render(<AddySetup />)
    const relay = await screen.findByPlaceholderText('https://relay.example')
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
    render(<AddySetup />)
    fireEvent.change(await screen.findByPlaceholderText('https://relay.example'), {
      target: { value: 'https://addy.example.com' }
    })

    fireEvent.click(screen.getByText('addy.example.com/admin'))

    expect(opened).toHaveBeenCalledWith('https://addy.example.com/admin', '_blank', 'noopener')
  })

  it('says nothing specific until the address is a real https one', async () => {
    // Built from what was typed rather than probed, because a relay started
    // without the provider flags serves no console — and asking would be an
    // unauthenticated request on every keystroke.
    render(<AddySetup />)
    fireEvent.change(await screen.findByPlaceholderText('https://relay.example'), {
      target: { value: 'not-a-url' }
    })
    expect(screen.queryByText(/\/admin$/)).toBeNull()
    expect(screen.getByText(/Ask whoever runs the relay/)).toBeTruthy()
  })

  it('does not tell anybody to run a command', async () => {
    render(<AddySetup />)
    await screen.findByPlaceholderText('https://relay.example')
    expect(screen.queryByText(/addy invite/)).toBeNull()
  })
})
