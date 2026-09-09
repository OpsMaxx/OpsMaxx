// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { stubBridge } from './setup/renderer'
import { VaultView } from '../src/renderer/src/components/vault/VaultView'
import { VAULT_MIN_PASSWORD } from '../src/shared/vault'

/**
 * Why the Create vault button is disabled.
 *
 * Reported from a screenshot: six characters typed, the button greyed out,
 * and nothing on screen saying why. The minimum was stated in ONE place — the
 * field's placeholder — and a placeholder disappears the moment there is a
 * character in the field. So the rule was visible exactly while it was
 * impossible to have broken it, and invisible from the first keystroke
 * onwards.
 */

function creatingVault(): void {
  stubBridge({
    vault: {
      status: async () => ({ exists: false, unlocked: false }),
      list: async () => ({ ok: true, entries: [] }),
      bioSupport: async () => ({ available: false, kind: 'none' }),
      bioEnabled: async () => false,
      bioScope: async () => null
    }
  } as never)
}

// Anchored: "Confirm master password" also contains "Master password", and an
// unanchored match finds both fields.
const passwordBox = (): HTMLElement => screen.getByPlaceholderText(/^Master password \(min/i)
const confirmBox = (): HTMLElement => screen.getByPlaceholderText(/Confirm master password/i)

describe('the create-vault requirements', () => {
  it('states the minimum before anything is typed', async () => {
    creatingVault()
    render(<VaultView />)
    await waitFor(() => expect(screen.getByText(/Create vault/i)).toBeTruthy())
    expect(screen.getByText(new RegExp(`At least ${VAULT_MIN_PASSWORD} characters`))).toBeTruthy()
  })

  /**
   * The bug, as a test. A placeholder is gone by now; this line is not.
   */
  it('still states it, and how far short, once typing has begun', async () => {
    creatingVault()
    render(<VaultView />)
    await waitFor(() => expect(screen.getByText(/Create vault/i)).toBeTruthy())

    fireEvent.change(passwordBox(), { target: { value: 'abcdef' } })

    const short = VAULT_MIN_PASSWORD - 6
    expect(screen.getByText(new RegExp(`${short} to go`))).toBeTruthy()
  })

  it('stops counting down once the minimum is met', async () => {
    creatingVault()
    render(<VaultView />)
    await waitFor(() => expect(screen.getByText(/Create vault/i)).toBeTruthy())

    fireEvent.change(passwordBox(), { target: { value: 'x'.repeat(VAULT_MIN_PASSWORD) } })
    expect(screen.queryByText(/to go/)).toBeNull()
  })

  /**
   * Shown only once there is something to compare, so a user who has not
   * reached the second field is not looking at an unmet requirement about it.
   */
  it('says nothing about matching until the confirmation has content', async () => {
    creatingVault()
    render(<VaultView />)
    await waitFor(() => expect(screen.getByText(/Create vault/i)).toBeTruthy())

    fireEvent.change(passwordBox(), { target: { value: 'x'.repeat(VAULT_MIN_PASSWORD) } })
    expect(screen.queryByText(/Both entries match/)).toBeNull()

    fireEvent.change(confirmBox(), { target: { value: 'x'.repeat(VAULT_MIN_PASSWORD) } })
    expect(screen.getByText(/Both entries match/)).toBeTruthy()
  })

  // The field is marked invalid while it is short, so the requirement reaches
  // a screen reader rather than only the sighted reader watching a line change.
  it('marks the field invalid while it is too short, and valid once it is not', async () => {
    creatingVault()
    render(<VaultView />)
    await waitFor(() => expect(screen.getByText(/Create vault/i)).toBeTruthy())

    fireEvent.change(passwordBox(), { target: { value: 'abc' } })
    expect(passwordBox().getAttribute('aria-invalid')).toBe('true')

    fireEvent.change(passwordBox(), { target: { value: 'x'.repeat(VAULT_MIN_PASSWORD) } })
    expect(passwordBox().getAttribute('aria-invalid')).toBe('false')
  })

  it('points the field at the requirements it has to satisfy', async () => {
    creatingVault()
    render(<VaultView />)
    await waitFor(() => expect(screen.getByText(/Create vault/i)).toBeTruthy())
    expect(passwordBox().getAttribute('aria-describedby')).toBe('vault-password-rules')
  })
})

/**
 * The same bug, one step further along.
 *
 * The first fix showed the matching rule only once the confirmation had
 * content. So with twelve characters typed and the second box untouched, the
 * button was disabled and every rule on screen was met — no explanation
 * again, for exactly the reason the screen was changed in the first place.
 * Confirming is a requirement, so it belongs on the list.
 */
describe('when the password is long enough but unconfirmed', () => {
  it('asks for the confirmation rather than showing all rules met', async () => {
    creatingVault()
    render(<VaultView />)
    await waitFor(() => expect(screen.getByText(/Create vault/i)).toBeTruthy())

    fireEvent.change(passwordBox(), { target: { value: 'x'.repeat(VAULT_MIN_PASSWORD) } })

    expect(screen.getByText(/Type it again to confirm/)).toBeTruthy()
    expect(screen.queryByText(/to go/)).toBeNull()
  })

  it('turns into the match rule once the confirmation is started', async () => {
    creatingVault()
    render(<VaultView />)
    await waitFor(() => expect(screen.getByText(/Create vault/i)).toBeTruthy())

    fireEvent.change(passwordBox(), { target: { value: 'x'.repeat(VAULT_MIN_PASSWORD) } })
    fireEvent.change(confirmBox(), { target: { value: 'x' } })

    expect(screen.getByText(/Both entries match/)).toBeTruthy()
    expect(screen.queryByText(/Type it again/)).toBeNull()
  })

  // And nothing about confirming while the password is still too short: one
  // unmet rule at a time, in the order they have to be satisfied.
  it('says nothing about confirming while the password is still short', async () => {
    creatingVault()
    render(<VaultView />)
    await waitFor(() => expect(screen.getByText(/Create vault/i)).toBeTruthy())

    fireEvent.change(passwordBox(), { target: { value: 'abc' } })
    expect(screen.queryByText(/Type it again to confirm/)).toBeNull()
  })
})
