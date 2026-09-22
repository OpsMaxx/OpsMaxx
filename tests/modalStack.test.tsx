// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Modal } from '../src/renderer/src/components/common/Modal'

/**
 * Two dialogs open at once, which the app does routinely and nothing handled.
 *
 * Reported from the running app: connecting to a jump server with Google
 * Authenticator on it stopped showing the verification-code popup and showed
 * "Enter Vault password" instead, then failed with
 *
 *   Timed out waiting for the second factor for <user>@<host>.
 *   The challenge was not answered in time.
 *
 * Both dialogs render `.scrim`, and `.scrim` carries ONE z-index for all of
 * them, so which one is in front fell through to DOM order — and App.tsx
 * happens to mount the vault dialog after the SSH prompt. The prompt was still
 * there, still pending, with a 135-second fuse on it, underneath an opaque
 * scrim the user could not see past.
 *
 * The second half is worse and is not about looks. `Modal` arms Escape and
 * outside-click through document-level listeners, one set PER OPEN DIALOG, so
 * one Escape closed every dialog on screen. For the SSH prompt, closing is not
 * closing: it REPLIES to the server with an empty answer, which is a wrong
 * second factor and spends one of that host's MaxAuthTries.
 */

const scrims = (): HTMLElement[] => [...document.querySelectorAll('.scrim')] as HTMLElement[]
const layerOf = (el: HTMLElement): number => Number(el.style.getPropertyValue('--modal-layer'))

describe('two dialogs on screen at once', () => {
  it('paints the one that opened later in front', () => {
    render(
      <>
        <Modal title="First" onClose={() => undefined}>
          <span>first body</span>
        </Modal>
        <Modal title="Second" onClose={() => undefined}>
          <span>second body</span>
        </Modal>
      </>
    )
    const [first, second] = scrims()
    expect(layerOf(second)).toBeGreaterThan(layerOf(first))
  })

  it('gives Escape to the one in front, and to no other', async () => {
    const closeFirst = vi.fn()
    const closeSecond = vi.fn()
    render(
      <>
        <Modal title="First" onClose={closeFirst}>
          <span>first body</span>
        </Modal>
        <Modal title="Second" onClose={closeSecond}>
          <span>second body</span>
        </Modal>
      </>
    )
    await userEvent.keyboard('{Escape}')
    expect(closeSecond).toHaveBeenCalledTimes(1)
    // The one underneath is untouched. This is the assertion the SSH prompt
    // needs: its close is an answer to a server, not a dismissal.
    expect(closeFirst).not.toHaveBeenCalled()
  })

  it('gives an outside click to the one in front, and to no other', async () => {
    const closeFirst = vi.fn()
    const closeSecond = vi.fn()
    render(
      <>
        <Modal title="First" onClose={closeFirst}>
          <span>first body</span>
        </Modal>
        <Modal title="Second" onClose={closeSecond}>
          <span>second body</span>
        </Modal>
      </>
    )
    // Anywhere outside the front dialog's own box. Note that clicking INSIDE
    // the front dialog is still outside the one behind it, which is exactly
    // how answering the vault prompt used to cancel the SSH prompt.
    await userEvent.click(screen.getByText('second body'))
    expect(closeFirst).not.toHaveBeenCalled()
    expect(closeSecond).not.toHaveBeenCalled()

    await userEvent.click(document.body)
    expect(closeSecond).toHaveBeenCalledTimes(1)
    expect(closeFirst).not.toHaveBeenCalled()
  })
})

describe('a dialog something is waiting on', () => {
  /**
   * The fix for the report, stated as the rule rather than as the pair of
   * dialogs that happened to collide. Priority is a property of the dialog;
   * where somebody put it in the tree is not.
   */
  it('outranks an ordinary one that opened after it', () => {
    render(
      <>
        <Modal title="Second factor" priority={10} onClose={() => undefined}>
          <span>code</span>
        </Modal>
        <Modal title="Vault locked" onClose={() => undefined}>
          <span>master password</span>
        </Modal>
      </>
    )
    const [prompt, vault] = scrims()
    expect(layerOf(prompt)).toBeGreaterThan(layerOf(vault))
  })

  it('keeps Escape even though it was mounted first', async () => {
    const closePrompt = vi.fn()
    const closeVault = vi.fn()
    render(
      <>
        <Modal title="Second factor" priority={10} onClose={closePrompt}>
          <span>code</span>
        </Modal>
        <Modal title="Vault locked" onClose={closeVault}>
          <span>master password</span>
        </Modal>
      </>
    )
    await userEvent.keyboard('{Escape}')
    expect(closePrompt).toHaveBeenCalledTimes(1)
    expect(closeVault).not.toHaveBeenCalled()
  })
})

describe('a dialog whose close is an answer, not a dismissal', () => {
  // `dismissible={false}` exists for exactly one case: closing sends something
  // to a remote side. A reflex Escape must not be able to spend an
  // authentication attempt on a host.
  it('ignores Escape and an outside click', async () => {
    const onClose = vi.fn()
    render(
      <Modal title="Second factor" dismissible={false} onClose={onClose}>
        <span>code</span>
      </Modal>
    )
    await userEvent.keyboard('{Escape}')
    await userEvent.click(document.body)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('still closes from its own controls', async () => {
    const onClose = vi.fn()
    render(
      <Modal title="Second factor" dismissible={false} onClose={onClose}>
        <span>code</span>
      </Modal>
    )
    await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
