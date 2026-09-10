import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * A connection cannot be saved authenticating with nothing.
 *
 * Reported as "the servers have stopped connecting, I think the private key
 * mechanism is not working anymore", with a screenshot of Edit Server showing
 * Private Key selected and the key field EMPTY — placeholder grey, not a
 * value. That connection had no credential stored, so it offered none, and
 * the server refused every method.
 *
 * The form allowed it because validation returned early for ANY edit:
 *
 *     if (f.editing) return null
 *
 * A blank box means "unchanged" while something is stored, and means
 * "there is nothing here" while nothing is — and the two looked identical.
 * Saving then wrote no credential, because `secret` is only built when
 * `keyPath` is non-empty, and nothing downstream objected.
 */

const MODAL = readFileSync(
  resolve(__dirname, '..', 'src/renderer/src/components/connections/AddServerModal.tsx'),
  'utf8'
)

describe('editing a connection with no credential saved', () => {
  it('no longer skips validation for every edit', () => {
    // The unconditional early return is the bug, in one line.
    expect(MODAL).not.toMatch(/if \(f\.editing\) return null/)
    expect(MODAL).toContain('if (f.editing && f.hasStoredCredential) return null')
  })

  /**
   * Unknown must mean "assume it has one". Opening the editor on a perfectly
   * good connection must not flash a demand for a key it already holds while
   * the answer is still being read.
   */
  it('treats an unread answer as a credential being present', () => {
    expect(MODAL).toContain("stored === null || stored.kind !== 'none'")
  })

  // The two empty states have to look different, or the form is back to
  // showing one box that means two opposite things.
  it('says which empty box the user is looking at', () => {
    expect(MODAL).toMatch(/leave blank to keep it/)
    expect(MODAL).toMatch(/No key is saved for this connection/)
  })

  // A vault-backed credential still supplies it, so demanding a key path
  // there would refuse a connection that works.
  it('still exempts a vault-backed credential', () => {
    expect(MODAL).toContain('if (f.usingVault) return null')
  })

  // And an RDP-only machine has no SSH credential to demand at all.
  it('still exempts an RDP-only machine', () => {
    expect(MODAL).toContain('if (f.rdpOnly) return null')
  })
})
