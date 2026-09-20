// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { stubBridge } from './setup/renderer'
import { MachineGrants } from '../src/renderer/src/components/settings/MachineGrants'
import type { MachineGrant } from '../src/shared/machineGrants'

/**
 * Rendered rather than grepped.
 *
 * The promise this panel makes is not visible in a source regex: it can hold
 * the right list and still put the consequence of revoking AFTER the button,
 * or describe an orphaned grant as though the thing it authorises still
 * exists, without any one line looking wrong. The failure mode the whole item
 * is written against is somebody pressing Revoke in the afternoon and finding
 * out at 03:00, so what is checked here is what is on screen BEFORE the press.
 */

const BACKUP: MachineGrant = {
  id: '__machine__backup-passphrase:bd-1',
  subject: { kind: 'backup-passphrase', destinationId: 'bd-1' },
  grantedAt: '2026-01-04T09:00:00.000Z'
}

const ADDY_DEVICE: MachineGrant = {
  id: '__machine__addy-device:acct-9',
  subject: { kind: 'addy', secretKind: 'device', accountId: 'acct-9' }
}

const DESTINATION = {
  id: 'bd-1',
  name: 'wasabi-nightly',
  kind: 'local' as const,
  directory: '/tmp/b',
  keep: 3,
  everyHours: 24,
  restoreTest: true,
  passphraseSource: 'machine' as const
}

function bridge(
  grants: MachineGrant[],
  destinations: unknown[] = [DESTINATION],
  over: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    secrets: {
      machineGrants: vi.fn(async () => grants),
      delete: vi.fn(async () => undefined),
      ...over
    },
    backup: {
      destinations: vi.fn(async () => ({
        version: 1,
        destinations,
        lastRunAt: {},
        lastReport: {}
      }))
    }
  }
}

afterEach(() => vi.restoreAllMocks())

describe('what the list says', () => {
  it('names the destination a backup passphrase belongs to', async () => {
    stubBridge(bridge([BACKUP]))
    render(<MachineGrants />)
    expect(await screen.findByText(/Backup passphrase for “wasabi-nightly”/)).toBeTruthy()
  })

  it('says what the grant means before any of the rows', async () => {
    stubBridge(bridge([BACKUP]))
    render(<MachineGrants />)
    expect(
      await screen.findByText(/readable by anything running as you on this machine/)
    ).toBeTruthy()
  })

  it('shows when it was granted', async () => {
    stubBridge(bridge([BACKUP]))
    render(<MachineGrants />)
    expect(await screen.findByText(/^Granted \S+/)).toBeTruthy()
  })

  /** Every grant already on a user's machine has no date. A blank cell reads
   *  as "just now", so the absence is stated. */
  it('says so when no date was recorded, rather than showing nothing', async () => {
    stubBridge(bridge([ADDY_DEVICE], []))
    render(<MachineGrants />)
    expect(await screen.findByText(/before OpsMaxx recorded grant dates/)).toBeTruthy()
  })

  it('does not invent a friendly name for an id it cannot resolve', async () => {
    const odd: MachineGrant = {
      id: '__machine__something-nobody-wrote-yet',
      subject: { kind: 'other' }
    }
    stubBridge(bridge([odd], []))
    render(<MachineGrants />)
    expect(await screen.findByText('__machine__something-nobody-wrote-yet')).toBeTruthy()
    expect(screen.queryByText(/Backup passphrase/)).toBeNull()
  })

  it('says nothing is granted when nothing is', async () => {
    stubBridge(bridge([], []))
    render(<MachineGrants />)
    expect(await screen.findByText(/Nothing runs without your master password/)).toBeTruthy()
  })
})

describe('a grant for something that is gone', () => {
  it('is marked orphaned and names the id it cannot resolve', async () => {
    stubBridge(bridge([BACKUP], []))
    render(<MachineGrants />)
    expect(await screen.findByText(/Orphaned/)).toBeTruthy()
    expect(screen.getByText(/no longer exists \(bd-1\)/)).toBeTruthy()
  })

  it('is not marked orphaned while its destination is still configured', async () => {
    stubBridge(bridge([BACKUP]))
    render(<MachineGrants />)
    await screen.findByText(/Backup passphrase for “wasabi-nightly”/)
    expect(screen.queryByText(/Orphaned/)).toBeNull()
  })

  /** Live destination, idle grant: the passphrase is still readable without a
   *  master password while nothing reads it. Still an authorisation. */
  it('says a grant is unused when its destination went back to the vault', async () => {
    stubBridge(bridge([BACKUP], [{ ...DESTINATION, passphraseSource: 'vault' }]))
    render(<MachineGrants />)
    expect(await screen.findByText(/not being used by anything/)).toBeTruthy()
  })
})

describe('revoking', () => {
  it('states what stops working before the button is pressed', async () => {
    stubBridge(bridge([BACKUP]))
    render(<MachineGrants />)
    const said = await screen.findByText(/the next scheduled run of “wasabi-nightly” stops/)
    expect(said).toBeTruthy()
    // And it is not merely somewhere on the page: it is in the same row as the
    // button, above it in the DOM.
    const row = said.closest('.setting-row')
    expect(row).not.toBeNull()
    expect(row!.querySelector('button')?.textContent).toContain('Revoke')
  })

  it('deletes the secret behind the grant', async () => {
    const api = bridge([BACKUP])
    stubBridge(api)
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<MachineGrants />)
    await screen.findByText(/Backup passphrase for “wasabi-nightly”/)

    await userEvent.click(screen.getByRole('button', { name: /Revoke/ }))

    const secrets = api.secrets as { delete: ReturnType<typeof vi.fn> }
    await waitFor(() => expect(secrets.delete).toHaveBeenCalledWith(BACKUP.id))
  })

  it('revokes nothing when the confirmation is declined', async () => {
    const api = bridge([BACKUP])
    stubBridge(api)
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<MachineGrants />)
    await screen.findByText(/Backup passphrase for “wasabi-nightly”/)

    await userEvent.click(screen.getByRole('button', { name: /Revoke/ }))

    const secrets = api.secrets as { delete: ReturnType<typeof vi.fn> }
    expect(secrets.delete).not.toHaveBeenCalled()
  })

  it('warns that a revoked addy device key does not come back', async () => {
    stubBridge(bridge([ADDY_DEVICE], []))
    render(<MachineGrants />)
    expect(await screen.findByText(/deliberately cannot be restored/)).toBeTruthy()
  })
})

describe('when the bridge cannot answer', () => {
  /** A panel that silently renders "nothing is granted" because the method is
   *  missing tells the user the opposite of the truth. */
  it('says it cannot list them rather than showing an empty list', async () => {
    stubBridge({ secrets: { delete: vi.fn() } })
    render(<MachineGrants />)
    expect(await screen.findByText(/Grants cannot be listed right now/)).toBeTruthy()
    expect(screen.queryByText(/Nothing runs without your master password/)).toBeNull()
  })
})
