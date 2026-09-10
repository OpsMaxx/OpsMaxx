import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The ngrok dialog, which asked for a credential and gave nobody a way to
 * supply one.
 *
 * The Authtoken field rendered a picker only when the vault already held a
 * usable entry. With an empty vault it rendered a SENTENCE — "add your ngrok
 * authtoken to the vault first, then pick it here" — beside a Save button that
 * could never enable, and no control anywhere to act on it. The user had to
 * leave, find the vault, work out which entry shape a token wants, come back
 * and reopen the dialog.
 *
 * It also drew two Cancel buttons: `Modal` renders its own, and `footer` is
 * for EXTRA controls beside it, so a hand-rolled Cancel/Save pair in there
 * duplicates one and puts the commit in the wrong place.
 */

const SRC = readFileSync(
  join(__dirname, '..', 'src/renderer/src/components/vpn/NgrokSetup.tsx'),
  'utf8'
)

describe('the footer', () => {
  it('uses the modal’s own commit and cancel', () => {
    expect(SRC).toMatch(/confirm=\{\{\s*label: 'Save'/)
  })

  it('does not hand-roll a second Cancel', () => {
    // One Cancel remains — the inline add's own — and it is inside the token
    // form rather than the footer, so this counts footers, not the word.
    expect(SRC).not.toMatch(/footer=\{[\s\S]*?Cancel[\s\S]*?\}\s*\n\s*>/)
  })
})

describe('the authtoken field', () => {
  it('offers to add one rather than describing the task', () => {
    expect(SRC).toContain('Add an authtoken')
    expect(SRC).toMatch(/createEntry\('login'/)
  })

  it('selects what it just wrote, so Save can enable', () => {
    // Writing the entry and leaving the picker empty would swap one dead end
    // for another.
    expect(SRC).toMatch(/setEntryId\(id\)/)
  })

  it('reports a vault that refused the write', () => {
    // `createEntry` answers null on failure. Silence there leaves a Save
    // button disabled for no visible cause.
    expect(SRC).toMatch(/if \(!id\)/)
  })

  it('says where an ngrok token comes from', () => {
    expect(SRC).toContain('https://dashboard.ngrok.com/get-started/your-authtoken')
  })

  it('offers to unlock rather than stating the vault is locked', () => {
    // The same rule the rest of the app follows: never say "the vault is
    // locked" without offering to unlock it.
    expect(SRC).toContain('UnlockVaultButton')
  })

  it('still keeps the token out of the profile', () => {
    // What has NOT changed, and must not: a token typed into a profile would
    // have to live somewhere, and the only place it belongs is the vault.
    expect(SRC).toMatch(/authtokenRef: \{ vaultEntryId/)
  })
})
