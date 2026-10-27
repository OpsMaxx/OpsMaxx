// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

function withConflicts(list: unknown[], devices?: unknown[]): void {
  stubBridge({
    addy: {
      conflicts: vi.fn().mockResolvedValue(list),
      resolveConflict,
      discardConflict,
      // Optional on purpose: every other call here is, and the chooser has to
      // render on a window whose preload predates this one. The tests that do
      // not pass devices are that case.
      ...(devices ? { status: vi.fn().mockResolvedValue({ devices }) } : {})
    }
  })
}

const device = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  label: 'a paired device',
  self: false,
  lastSeen: null,
  addedAt: null,
  ...over
})

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

  it('can be left for later with Escape, which writes nothing either', async () => {
    // `aria-modal` with no dismissal from the keyboard is a trap, and the
    // three buttons that DO dismiss it all destroy a copy.
    withConflicts([conflict()])
    render(<ConflictChooser />)
    await screen.findByRole('dialog')
    // Drain the passive effects before pressing anything. The listener below
    // is attached by a `useEffect`, which React schedules as a separate task
    // AFTER the commit that puts the dialog in the DOM -- and `findByRole`
    // resolves on that commit. Firing in the gap loses the key, which is a
    // race the machine's speed decides: green 14/14 here, red on a loaded CI
    // runner. No user can press a key inside one frame of a dialog opening,
    // so this is the test learning what the component already promises.
    await act(async () => {})

    fireEvent.keyDown(document, { key: 'Escape' })

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

  it('says which of the two the app is already using', async () => {
    // The winner is on disk here before the loser is ever published --
    // `sync.ts` writes it and then keeps the local copy as a conflict -- so
    // "keep this one" changes nothing anywhere and "replace it" changes what
    // the user sees. Neither was said, and the pane was headed "What is on
    // the relay now", which is a place the reader cannot look at.
    withConflicts([conflict()])
    render(<ConflictChooser />)
    // Twice on purpose: the pane it heads, and the sentence above that points
    // at it. The heading is the one asserted here.
    expect(await screen.findByText('In use now', { selector: 'h3 span' })).toBeTruthy()
    expect(screen.getByText(/already using the version marked/)).toBeTruthy()
  })

  it('says that nothing has been written yet', async () => {
    // "You are about to lose something" and "both are kept and one is active"
    // are very different sentences, and until a button is pressed it is the
    // second one.
    withConflicts([conflict()])
    render(<ConflictChooser />)
    expect(await screen.findByText(/Nothing is lost yet/)).toBeTruthy()
  })
})

describe('which machine each version came from', () => {
  it('names this machine rather than blaming another one', async () => {
    // THE COMMONEST CASE, AND IT WAS BACKWARDS. The first sync after pairing
    // takes sync.ts's `!known` branch: this machine adopts the account's copy
    // and the copy set aside is ITS OWN. The dialog called it "The copy from
    // another device".
    const me = 'aa'.repeat(32)
    withConflicts([conflict({ device: me })], [device(me, { self: true })])
    render(<ConflictChooser />)
    expect(await screen.findByText(/made by this machine/)).toBeTruthy()
    expect(screen.queryByText(/from another device/)).toBeNull()
  })

  it('names the other device from the roster, with its key', async () => {
    const other = 'bb'.repeat(32)
    withConflicts(
      [conflict({ device: other })],
      [device('aa'.repeat(32), { self: true }), device(other, { label: 'desktop' })]
    )
    render(<ConflictChooser />)
    expect(await screen.findByText(/made by desktop \(bbbbbbbb\)/)).toBeTruthy()
  })

  it('says a device has left the account rather than inventing a name for it', async () => {
    withConflicts([conflict({ device: 'cc'.repeat(32) })], [device('aa'.repeat(32), { self: true })])
    render(<ConflictChooser />)
    expect(await screen.findByText(/no longer on this account \(cccccccc\)/)).toBeTruthy()
  })

  it('claims nothing when the roster is not available', async () => {
    // No `status` on the bridge. An unnamed key beats a wrong machine.
    withConflicts([conflict({ device: 'dd'.repeat(32) })])
    render(<ConflictChooser />)
    expect(await screen.findByText(/made by the device dddddddd/)).toBeTruthy()
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
    // so a new collection must not reintroduce it silently. The table is
    // shared with the panel's error band now, so it is read where it lives.
    const PANEL = require('node:fs').readFileSync(
      require('node:path').join(__dirname, '..', 'src/renderer/src/components/addy/collectionNames.ts'),
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

  it('says when who-and-when for a vault is only the relay\'s word', async () => {
    // For the vault those two facts are the whole basis of the choice. A copy
    // kept by 0.59.0 carries no sealed record of them, so the relay's fields
    // are shown -- and must not look checked.
    withConflicts([conflict({ collection: 'vault', winning: 'AAAA', losing: 'BBBB', reportedByRelay: true })])
    render(<ConflictChooser />)
    expect(await screen.findByText(/as reported by the relay, not checked/)).toBeTruthy()
    expect(screen.getByText(/only what the relay reports/)).toBeTruthy()
  })

  it('does not hedge who-and-when that came from inside the sealed copy', async () => {
    withConflicts([conflict({ collection: 'vault', winning: 'AAAA', losing: 'BBBB', reportedByRelay: false })])
    render(<ConflictChooser />)
    expect(await screen.findByText(/sealed into this copy by a device on this account/)).toBeTruthy()
    expect(screen.queryByText(/as reported by the relay/)).toBeNull()
  })
})

describe('a vault set aside on the first sync', () => {
  const vaultConflict = conflict({ collection: 'vault', winning: { data: 'aa' }, losing: { data: 'bb' } })

  it('offers to add its entries with the password it was made with', async () => {
    const mergeVaultCopy = vi.fn().mockResolvedValue({ ok: true, added: 3 })
    const conflicts = vi.fn().mockResolvedValueOnce([vaultConflict]).mockResolvedValue([])
    stubBridge({ addy: { conflicts, resolveConflict, discardConflict, mergeVaultCopy } })
    render(<ConflictChooser />)

    const field = await screen.findByLabelText(/master password that copy was made with/)
    const add = screen.getByRole('button', { name: 'Add its entries to this vault' })
    expect((add as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(field, { target: { value: 'old-master' } })
    fireEvent.click(add)

    await waitFor(() => expect(mergeVaultCopy).toHaveBeenCalledWith(1, 'old-master'))
    expect(resolveConflict).not.toHaveBeenCalled()
  })

  it('says why when the password does not open it, and keeps the copy', async () => {
    const mergeVaultCopy = vi
      .fn()
      .mockResolvedValue({ ok: false, error: 'That master password does not open the other copy.' })
    stubBridge({
      addy: { conflicts: vi.fn().mockResolvedValue([vaultConflict]), resolveConflict, discardConflict, mergeVaultCopy }
    })
    render(<ConflictChooser />)

    fireEvent.change(await screen.findByLabelText(/master password that copy was made with/), {
      target: { value: 'wrong' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add its entries to this vault' }))

    expect((await screen.findByText(/does not open the other copy/)).textContent).toMatch(/That did not finish/)
    expect(discardConflict).not.toHaveBeenCalled()
  })

  it('is not offered for anything but the vault', async () => {
    withConflicts([conflict()])
    render(<ConflictChooser />)
    await screen.findByRole('button', { name: /Keep the version in use/ })
    expect(screen.queryByRole('button', { name: 'Add its entries to this vault' })).toBeNull()
  })
})

describe('a copy kept because another device removed most of a list', () => {
  it('says so instead of describing a race', async () => {
    withConflicts([conflict({ reason: 'bulk-removal', reportedByRelay: false })])
    render(<ConflictChooser />)
    expect(await screen.findByText(/removed most of this list/)).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/changed this before they had synced/)
  })
})
