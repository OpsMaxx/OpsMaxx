// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { stubBridge } from './setup/renderer'
import { ConflictChooser } from '../src/renderer/src/components/addy/ConflictChooser'
import { SYNCED_COLLECTIONS } from '../src/shared/addy'

/**
 * The one screen that asks a person to destroy something.
 *
 * ===========================================================================
 * WHAT IT DID BEFORE
 * ===========================================================================
 *
 * A full-screen modal over the whole app with no close, no Escape, and three
 * buttons that all wrote irreversibly. Somebody who wanted to look at the
 * other machine first, or who did not understand two blobs of JSON, had to
 * destroy one copy to get back to the app.
 *
 * It also said "Neither version was thrown away", which was true right up
 * until any button was pressed — every one of them deletes the other copy from
 * the relay permanently — and it asked about `knownHosts` and `apiWorkspace`
 * by their protocol ids. For the vault it printed two walls of base64 and
 * asked which the user preferred, which is not a question anybody can answer:
 * the vault travels as ciphertext by design and nothing in the sync path
 * opens it.
 */

const conflict = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 1,
  collection: 'servers',
  device: 'bb'.repeat(32),
  createdAt: new Date('2026-09-20T09:00:00Z').toISOString(),
  winning: [{ id: 's1' }],
  losing: [{ id: 's2' }],
  ...over
})

const resolveConflict = vi.fn().mockResolvedValue(undefined)
const discardConflict = vi.fn().mockResolvedValue(undefined)

function withConflicts(list: unknown[]): void {
  stubBridge({
    addy: {
      conflicts: vi.fn().mockResolvedValue(list),
      resolveConflict,
      discardConflict
    }
  })
}

beforeEach(() => {
  resolveConflict.mockClear()
  discardConflict.mockClear()
})

describe('the way out', () => {
  it('can be left for later without writing anything', async () => {
    withConflicts([conflict()])
    render(<ConflictChooser />)

    fireEvent.click(await screen.findByRole('button', { name: /Decide later/ }))

    // Gone from the screen, and nothing was written: the copy stays on the
    // relay and the panel's attention tile keeps counting it.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(resolveConflict).not.toHaveBeenCalled()
    expect(discardConflict).not.toHaveBeenCalled()
  })

  it('moves to the next one rather than hiding them all', async () => {
    withConflicts([conflict(), conflict({ id: 2, collection: 'databases' })])
    render(<ConflictChooser />)

    fireEvent.click(await screen.findByRole('button', { name: /Decide later/ }))

    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy())
    expect(screen.getByText(/your saved databases/)).toBeTruthy()
  })
})

describe('what it says before you press anything', () => {
  it('states that the other copy is deleted', async () => {
    // It used to say "Neither version was thrown away", which stopped being
    // true the moment any button was pressed.
    withConflicts([conflict()])
    render(<ConflictChooser />)
    expect(await screen.findByText(/deleted from the.*relay and cannot be brought back/s)).toBeTruthy()
  })

  it('labels the buttons by what they do', async () => {
    withConflicts([conflict()])
    render(<ConflictChooser />)
    expect(await screen.findByRole('button', { name: /delete the other copy/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Replace it with the other copy/ })).toBeTruthy()
  })
})

describe('the words it uses', () => {
  it('names the collection rather than printing its protocol id', async () => {
    withConflicts([conflict({ collection: 'knownHosts' })])
    render(<ConflictChooser />)
    expect(await screen.findByText(/your trusted SSH host keys/)).toBeTruthy()
    expect(screen.queryByText(/knownHosts/)).toBeNull()
  })

  it('has a name for every collection the protocol carries', () => {
    // A missing one falls back to the raw id, which is the state this fixes —
    // so a new collection must not reintroduce it silently.
    const PANEL = require('node:fs').readFileSync(
      require('node:path').join(__dirname, '..', 'src/renderer/src/components/addy/ConflictChooser.tsx'),
      'utf8'
    )
    for (const name of SYNCED_COLLECTIONS) {
      expect(PANEL, `${name} has no display name`).toMatch(new RegExp(`\\b${name}:`))
    }
  })

  it('does not offer two walls of base64 as a comparison', async () => {
    // The vault travels as ciphertext by design; nothing in the sync path
    // opens it. Asking which encrypted blob the user prefers is not a question
    // anybody can answer.
    withConflicts([conflict({ collection: 'vault', winning: 'AAAA', losing: 'BBBB' })])
    render(<ConflictChooser />)
    // Both panes say it — the winner and the loser are both ciphertext.
    expect((await screen.findAllByText(/cannot be shown here/)).length).toBe(2)
    expect(screen.queryByText(/AAAA/)).toBeNull()
  })
})
