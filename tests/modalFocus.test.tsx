// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Modal } from '../src/renderer/src/components/common/Modal'

/**
 * The dialog primitive, from the keyboard: focus goes in when it opens, Tab
 * stays inside while it is in front, and focus goes back to the opener when it
 * closes. Before this, the production confirm opened with focus still in the
 * editor, and the next Enter went to the editor rather than the dialog.
 */

function Harness({
  destructive,
  autoFocusField,
  onOpenerKey
}: {
  destructive?: boolean
  autoFocusField?: boolean
  onOpenerKey?: (key: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [confirmed, setConfirmed] = useState(0)
  return (
    <>
      <button onClick={() => setOpen(true)} onKeyDown={(e) => onOpenerKey?.(e.key)}>
        opener
      </button>
      <button>behind</button>
      <span data-testid="confirmed">{confirmed}</span>
      {open && (
        <Modal
          title="Dialog"
          onClose={() => setOpen(false)}
          confirm={{
            label: 'Confirm',
            destructive,
            onClick: () => {
              setConfirmed((n) => n + 1)
              setOpen(false)
            }
          }}
        >
          <input aria-label="field" autoFocus={autoFocusField} />
        </Modal>
      )}
    </>
  )
}

async function open(): Promise<void> {
  screen.getByText('opener').focus()
  await userEvent.keyboard('{Enter}')
}

describe('Modal focus', () => {
  it('moves focus to the confirm button on open', async () => {
    render(<Harness />)
    await open()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Confirm' }))
  })

  it('keeps focus where an autoFocus put it', async () => {
    render(<Harness autoFocusField />)
    await open()
    expect(document.activeElement).toBe(screen.getByLabelText('field'))
  })

  it('lands on Cancel, not a destructive confirm, so a reflexive Enter cannot confirm', async () => {
    render(<Harness destructive />)
    await open()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }))
    await userEvent.keyboard('{Enter}')
    expect(screen.getByTestId('confirmed').textContent).toBe('0')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('traps Tab and Shift+Tab inside the dialog', async () => {
    render(<Harness />)
    await open()
    const close = screen.getByRole('button', { name: 'Close' })
    const confirm = screen.getByRole('button', { name: 'Confirm' })
    await userEvent.tab()
    expect(document.activeElement).toBe(close)
    await userEvent.tab({ shift: true })
    expect(document.activeElement).toBe(confirm)
    for (let i = 0; i < 6; i++) {
      await userEvent.tab()
      expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true)
    }
  })

  it('returns focus to the opener on close', async () => {
    render(<Harness />)
    await open()
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(screen.getByText('opener'))
  })

  it('an Enter after opening answers the dialog and never reaches the opener', async () => {
    const onOpenerKey = vi.fn()
    render(<Harness onOpenerKey={onOpenerKey} />)
    await open()
    onOpenerKey.mockClear()
    await userEvent.keyboard('{Enter}')
    expect(screen.getByTestId('confirmed').textContent).toBe('1')
    expect(onOpenerKey).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(screen.getByText('opener'))
  })

  it('does not take focus back from whatever the confirm focused', async () => {
    function Elsewhere(): React.JSX.Element {
      const [open, setOpen] = useState(true)
      return (
        <>
          <input aria-label="target" />
          {open && (
            <Modal
              title="x"
              onClose={() => setOpen(false)}
              confirm={{
                label: 'Go',
                onClick: () => {
                  ;(screen.getByLabelText('target') as HTMLInputElement).focus()
                  setOpen(false)
                }
              }}
            >
              {null}
            </Modal>
          )}
        </>
      )
    }
    render(<Elsewhere />)
    await userEvent.click(screen.getByRole('button', { name: 'Go' }))
    expect(document.activeElement).toBe(screen.getByLabelText('target'))
  })
})
