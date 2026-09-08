// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { stubBridge } from './setup/renderer'
import { ServicesPanel } from '../src/renderer/src/components/monitor/ServicesPanel'
import { useVaultPrompt } from '../src/renderer/src/store/vaultPrompt'
import type { Server } from '../src/renderer/src/types'

// A locked vault stops an ON-DEMAND read, and until now it did so by printing
// the resolver's internal marker into a red box:
//
//   Error invoking remote method 'services:collect':
//   OPSMAXX_VAULT_LOCKED: this server authenticates with a vault credential,
//   and the vault is locked.
//
// The apparatus to do better already existed — withVaultUnlock, the vault
// prompt store, UnlockVaultButton — and had reached the connection surfaces
// (SFTP, tunnels, VPN, databases, the terminal) and none of the monitor
// panels. A junior sysadmin testing a locked-vault estate met the raw token.
//
// Two properties, and they are separate: the read RETRIES ITSELF after a
// successful unlock, and if the person declines, what is left on screen is a
// sentence with the unlock attached rather than the marker.

const VAULT_LOCKED_ERROR =
  "Error invoking remote method 'services:collect': OPSMAXX_VAULT_LOCKED: this server " +
  'authenticates with a vault credential, and the vault is locked.'

function server(id: string, name: string): Server {
  return {
    id,
    name,
    host: 'h',
    port: 22,
    username: 'u',
    auth: 'key',
    route: [],
    tags: [],
    workspaceId: 'w'
  } as unknown as Server
}

const SERVERS = [server('a', 'web-01')]

/** A collect that fails on a locked vault until the vault is opened. */
function lockedUntilUnlocked(): {
  collect: ReturnType<typeof vi.fn>
  unlock: () => void
} {
  let locked = true
  const collect = vi.fn(async () => {
    if (locked) throw new Error(VAULT_LOCKED_ERROR)
    return [{ serverId: 'a', serverName: 'web-01', reading: { units: [], detail: null } }]
  })
  return { collect, unlock: () => (locked = false) }
}

beforeEach(() => {
  useVaultPrompt.setState({ request: async () => false })
})

describe('an on-demand read against a locked vault', () => {
  it('asks to unlock rather than reporting the resolver’s marker', async () => {
    const { collect } = lockedUntilUnlocked()
    stubBridge({ services: { collect } })
    const asked: string[] = []
    useVaultPrompt.setState({
      request: async (reason: string) => {
        asked.push(reason)
        return false
      }
    })

    render(<ServicesPanel servers={SERVERS} />)
    await userEvent.click(screen.getByRole('button', { name: /Read services/ }))

    await waitFor(() => expect(asked).toHaveLength(1))
    // The dialog says why THIS screen needs it, not "a credential is required".
    expect(asked[0]).toMatch(/supervis/i)
  })

  it('retries the read once the vault is open, with no second press', async () => {
    const { collect, unlock } = lockedUntilUnlocked()
    stubBridge({ services: { collect } })
    useVaultPrompt.setState({
      request: async () => {
        unlock()
        return true
      }
    })

    render(<ServicesPanel servers={SERVERS} />)
    await userEvent.click(screen.getByRole('button', { name: /Read services/ }))

    // Twice: the failing attempt, then the same read again after the unlock.
    // The person pressed the button once.
    await waitFor(() => expect(collect).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByText('web-01')).toBeTruthy())
  })

  it('does not retry, and does not loop, when the prompt is declined', async () => {
    const { collect } = lockedUntilUnlocked()
    stubBridge({ services: { collect } })
    render(<ServicesPanel servers={SERVERS} />)
    await userEvent.click(screen.getByRole('button', { name: /Read services/ }))

    await waitFor(() => expect(collect).toHaveBeenCalledTimes(1))
  })

  it('leaves a sentence and an unlock, never the marker or the IPC channel', async () => {
    const { collect } = lockedUntilUnlocked()
    stubBridge({ services: { collect } })
    render(<ServicesPanel servers={SERVERS} />)
    await userEvent.click(screen.getByRole('button', { name: /Read services/ }))

    await waitFor(() => expect(screen.getByRole('button', { name: /Unlock vault/ })).toBeTruthy())
    const text = document.body.textContent ?? ''
    expect(text).toMatch(/the vault is locked/i)
    // The two things a person cannot act on.
    expect(text).not.toContain('OPSMAXX_VAULT_LOCKED')
    expect(text).not.toContain('invoking remote method')
  })

  it('re-runs the read from that unlock button, so declining is not a dead end', async () => {
    const { collect, unlock } = lockedUntilUnlocked()
    stubBridge({ services: { collect } })
    render(<ServicesPanel servers={SERVERS} />)
    await userEvent.click(screen.getByRole('button', { name: /Read services/ }))
    await waitFor(() => expect(screen.getByRole('button', { name: /Unlock vault/ })).toBeTruthy())

    useVaultPrompt.setState({
      request: async () => {
        unlock()
        return true
      }
    })
    await userEvent.click(screen.getByRole('button', { name: /Unlock vault/ }))

    await waitFor(() => expect(screen.getByText('web-01')).toBeTruthy())
  })
})

describe('a failure that is not the vault', () => {
  it('is passed through word for word', async () => {
    // The diagnosis this app spends its effort on. A component that started
    // rewording these would be hiding it.
    const collect = vi.fn(async () => {
      throw new Error('sudo: a password is required')
    })
    stubBridge({ services: { collect } })

    render(<ServicesPanel servers={SERVERS} />)
    await userEvent.click(screen.getByRole('button', { name: /Read services/ }))

    await waitFor(() => expect(screen.getByText(/sudo: a password is required/)).toBeTruthy())
    expect(screen.queryByRole('button', { name: /Unlock vault/ })).toBeNull()
    expect(collect).toHaveBeenCalledTimes(1)
  })
})
