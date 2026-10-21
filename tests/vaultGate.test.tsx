// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { stubBridge } from './setup/renderer'
import { VaultView } from '../src/renderer/src/components/vault/VaultView'
import { useVault } from '../src/renderer/src/store/vault'
import { useApp } from '../src/renderer/src/store/app'

// The vault gate, and the two things it got wrong in front of a real user.
//
// Both are about the same mistake in opposite directions: deciding something
// before the answer has arrived, and refusing to act after the user has plainly
// asked. Neither is visible to a test that only checks the unlocked browser.

/** A bridge whose `vault.status()` never settles, which is what a keychain
 *  prompt actually does to it: safeStorage blocks for as long as the person
 *  takes to answer, and on this machine that was long enough to screenshot. */
function pendingStatusBridge(): void {
  stubBridge({
    vault: {
      status: () => new Promise(() => {}),
      list: async () => ({ ok: true, entries: [] }),
      bioSupport: async () => ({ available: false, kind: 'none' }),
      bioEnabled: async () => false,
      bioScope: async () => null
    }
  } as never)
}

describe('before the main process has answered', () => {
  it('does not tell someone with a vault that they have none', async () => {
    // The reported bug, exactly. `exists` began as `false`, so for the whole
    // time the keychain prompt was up the screen offered to CREATE a vault --
    // two empty password fields, to a user whose vault was full of credentials.
    // "Nobody has said yet" is not "there isn't one".
    pendingStatusBridge()
    render(<VaultView />)

    await waitFor(() => expect(screen.getByText(/Opening the vault/i)).toBeTruthy())
    expect(screen.queryByText(/Create vault/i)).toBeNull()
    expect(screen.queryByPlaceholderText(/Confirm master password/i)).toBeNull()
  })

  it('offers to create one once main says there is none', async () => {
    // The other half: the unknown state must not be a permanent hiding place.
    stubBridge({
      vault: {
        status: async () => ({ exists: false, unlocked: false }),
        list: async () => ({ ok: true, entries: [] }),
        bioSupport: async () => ({ available: false, kind: 'none' }),
        bioEnabled: async () => false,
        bioScope: async () => null
      }
    } as never)
    render(<VaultView />)
    await waitFor(() => expect(screen.getByText(/Create vault/i)).toBeTruthy())
  })
})

describe('asking for Touch ID when the vault screen opens locked', () => {
  function lockedWithBiometrics(unlockSpy: () => Promise<void>): void {
    stubBridge({
      vault: {
        status: async () => ({ exists: true, unlocked: false }),
        list: async () => ({ ok: true, entries: [] }),
        bioSupport: async () => ({ available: true, kind: 'touch-id' }),
        bioEnabled: async () => true,
        bioScope: async () => 'persistent'
      }
    } as never)
    useVault.setState({ unlockWithBiometrics: unlockSpy as never })
  }

  it('raises the prompt without waiting for a click', async () => {
    const spy = vi.fn(async () => {})
    lockedWithBiometrics(spy)
    useApp.setState((s) => ({ settings: { ...s.settings, vaultAutoBiometricPrompt: true } }))

    render(<VaultView />)
    await waitFor(() => expect(spy).toHaveBeenCalled())
  })

  it('asks once and not again, so cancelling does not reopen the sheet', async () => {
    // promptTouchID rejects on cancel and the store turns that into a failed
    // result rather than a throw, leaving the vault locked. Without the guard
    // the effect sees the same still-locked state and prompts again: a sheet
    // the user cannot get out of by cancelling it.
    //
    // Re-rendering alone does NOT test this, and the first version of this test
    // did exactly that and passed with the guard deleted. The effect's deps do
    // not change on a plain re-render, so React never re-runs it and the guard
    // is never reached. What re-runs it in life is `busy` going true and back
    // to false around the attempt, so the spy does that here.
    // The flip happens on the FIRST attempt only. Without that bound, removing
    // the guard does not fail this test -- it hangs it: every prompt re-runs the
    // effect, which prompts again, forever. A test that hangs on a regression is
    // barely better than one that passes on it, so the second call is allowed to
    // happen and then counted.
    let flips = 0
    const spy = vi.fn(async () => {
      if (flips > 0) return
      flips += 1
      useVault.setState({ busy: true })
      await Promise.resolve()
      useVault.setState({ busy: false })
    })
    lockedWithBiometrics(spy)
    useApp.setState((s) => ({ settings: { ...s.settings, vaultAutoBiometricPrompt: true } }))

    render(<VaultView />)
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1))
    // Let every effect the busy flip scheduled actually run.
    await waitFor(() => expect(useVault.getState().busy).toBe(false))
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('stays quiet when the setting is off', async () => {
    const spy = vi.fn(async () => {})
    lockedWithBiometrics(spy)
    useApp.setState((s) => ({ settings: { ...s.settings, vaultAutoBiometricPrompt: false } }))

    render(<VaultView />)
    await waitFor(() => expect(screen.getByText(/Vault locked/i)).toBeTruthy())
    expect(spy).not.toHaveBeenCalled()
  })

  it('stays quiet when biometrics are not set up, however the setting reads', async () => {
    // The setting defaults on, so this is the common case: it must be inert
    // rather than raising a prompt for a key that does not exist.
    const spy = vi.fn(async () => {})
    stubBridge({
      vault: {
        status: async () => ({ exists: true, unlocked: false }),
        list: async () => ({ ok: true, entries: [] }),
        bioSupport: async () => ({ available: true, kind: 'touch-id' }),
        bioEnabled: async () => false,
        bioScope: async () => null
      }
    } as never)
    useVault.setState({ unlockWithBiometrics: spy as never })
    useApp.setState((s) => ({ settings: { ...s.settings, vaultAutoBiometricPrompt: true } }))

    render(<VaultView />)
    await waitFor(() => expect(screen.getByText(/Vault locked/i)).toBeTruthy())
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('biometrics set up but not usable right now', () => {
  it('says why instead of removing the button and explaining nothing', async () => {
    // The reported symptom: "unlock stopped asking for Touch ID, with no way to
    // tell what happened". `canUseBio` needs enabled AND available, so an
    // un-enrolled fingerprint hid the button while the vault was still set up
    // for it -- leaving the user waiting for a prompt that was never coming.
    // biometricSupport() has always returned this sentence for exactly this.
    stubBridge({
      vault: {
        status: async () => ({ exists: true, unlocked: false }),
        list: async () => ({ ok: true, entries: [] }),
        bioSupport: async () => ({
          available: false,
          kind: 'none',
          reason: 'No enrolled Touch ID fingerprint on this Mac.'
        }),
        bioEnabled: async () => true,
        bioScope: async () => 'persistent'
      }
    } as never)

    render(<VaultView />)

    await waitFor(() =>
      expect(screen.getByText(/No enrolled Touch ID fingerprint on this Mac/i)).toBeTruthy()
    )
    // The button must be gone -- it cannot work -- and the password field must
    // not be, because that is now the only way in.
    expect(screen.queryByText(/Unlock with Touch ID/i)).toBeNull()
    expect(screen.getByPlaceholderText(/Master password/i)).toBeTruthy()
  })
})

describe('the way out when the master password is gone', () => {
  function lockedVault(destroy: () => Promise<{ ok: boolean }>): void {
    stubBridge({
      vault: {
        status: async () => ({ exists: true, unlocked: false }),
        list: async () => ({ ok: true, entries: [] }),
        bioSupport: async () => ({ available: false, kind: 'none' }),
        bioEnabled: async () => false,
        bioScope: async () => null,
        destroy
      }
    } as never)
  }

  it('will not destroy the vault until DELETE is typed', async () => {
    // The assertion that matters. `vaultDestroy` is irreversible and there is
    // no escrow anywhere, so the confirmation is the only thing between a
    // mistyped password and every credential being gone.
    const destroy = vi.fn(async () => ({ ok: true }))
    lockedVault(destroy)
    render(<VaultView />)

    await waitFor(() => expect(screen.getByText(/Lost your master password/i)).toBeTruthy())
    fireEvent.click(screen.getByText(/Lost your master password/i))

    const button = await waitFor(() => screen.getByText(/Delete vault/i).closest('button')!)
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(destroy).not.toHaveBeenCalled()

    // Near-misses stay inert too.
    fireEvent.change(screen.getByPlaceholderText('DELETE'), { target: { value: 'delete' } })
    expect(button.disabled).toBe(true)

    fireEvent.change(screen.getByPlaceholderText('DELETE'), { target: { value: 'DELETE' } })
    expect(button.disabled).toBe(false)
  })

  it('is offered on the secured screen once an unlock has failed, not before', async () => {
    // The secured screen said "start over below" after a wrong password and
    // there was nothing below it: quitting was the only way to reach this.
    stubBridge({
      vault: {
        status: async () => ({ exists: true, unlocked: true, stage: 'secured' }),
        list: async () => ({ ok: true, entries: [] }),
        bioSupport: async () => ({ available: false, kind: 'none' }),
        bioEnabled: async () => false,
        bioScope: async () => null,
        unlock: async () => ({ ok: false, error: 'Wrong master password.' })
      }
    } as never)
    render(<VaultView />)

    await waitFor(() => expect(screen.getByText('Vault secured')).toBeTruthy())
    expect(screen.queryByText(/Lost your master password/i)).toBeNull()

    fireEvent.change(screen.getByPlaceholderText(/Master password/i), { target: { value: 'nope' } })
    fireEvent.click(screen.getByText('Unlock').closest('button')!)

    await waitFor(() => expect(screen.getByText(/Lost your master password/i)).toBeTruthy())
  })

  it('deletes it and offers a fresh one, with nothing carried over', async () => {
    const destroy = vi.fn(async () => ({ ok: true }))
    lockedVault(destroy)
    render(<VaultView />)

    await waitFor(() => expect(screen.getByText(/Lost your master password/i)).toBeTruthy())
    fireEvent.click(screen.getByText(/Lost your master password/i))

    // Type a password into the unlock field first: this is the whole reason
    // VaultReset takes `onDone`. The create screen that follows is the SAME
    // component instance in the same position, so React keeps its state, and
    // without the reset the forgotten password arrives pre-filled one click
    // from becoming the new master password.
    fireEvent.change(screen.getByPlaceholderText(/Master password/i), {
      target: { value: 'the-forgotten-one' }
    })
    fireEvent.change(screen.getByPlaceholderText('DELETE'), { target: { value: 'DELETE' } })
    fireEvent.click(screen.getByText(/Delete vault/i).closest('button')!)

    await waitFor(() => expect(destroy).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByText(/Create vault/i)).toBeTruthy())
    // The create screen has two password fields, so name this one exactly.
    for (const field of [/min 12 characters/i, /Confirm master password/i]) {
      expect((screen.getByPlaceholderText(field) as HTMLInputElement).value).toBe('')
    }
  })
})
