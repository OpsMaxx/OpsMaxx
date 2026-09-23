// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SplitButton } from '../src/renderer/src/components/common/SplitButton'
import { Popover } from '../src/renderer/src/components/common/Popover'

describe('SplitButton', () => {
  it('runs the primary action, and opens and closes its menu from ▾', async () => {
    const send = vi.fn()
    const curl = vi.fn()
    render(
      <SplitButton label="Send" ariaLabel="Send (⌘↵)" variant="primary" onClick={send} entries={[{ label: 'Copy as cURL', onClick: curl }]} />
    )
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(send).toHaveBeenCalledOnce()
    const more = screen.getByRole('button', { name: 'More Send options' })
    await userEvent.click(more)
    expect(more.getAttribute('aria-expanded')).toBe('true')
    await userEvent.click(more)
    expect(screen.queryByRole('menu')).toBeNull()
    await userEvent.click(more)
    await userEvent.click(screen.getByRole('menuitem', { name: 'Copy as cURL' }))
    expect(curl).toHaveBeenCalledOnce()
  })

  it('is icon-only with a label, and busy without being disabled', () => {
    render(<SplitButton label="Send" ariaLabel="Send (⌘↵)" variant="primary" onClick={() => {}} entries={[]} iconOnly busy />)
    const b = screen.getByRole('button', { name: 'Send (⌘↵)' })
    expect(b.getAttribute('aria-busy')).toBe('true')
    expect((b as HTMLButtonElement).disabled).toBe(false)
    expect(screen.queryByRole('button', { name: /More/ })).toBeNull()
  })
})

describe('Popover', () => {
  function Harness(): React.JSX.Element {
    const [at, setAt] = useState<DOMRect | null>(null)
    return (
      <>
        <button onClick={(e) => setAt(e.currentTarget.getBoundingClientRect())}>open</button>
        <Popover anchor={at} open={at !== null} onClose={() => setAt(null)} ariaLabel="Card">
          <input aria-label="inside" />
        </Popover>
      </>
    )
  }

  it('closes on Escape and returns focus to its opener', async () => {
    render(<Harness />)
    await userEvent.click(screen.getByText('open'))
    expect(screen.getByRole('dialog', { name: 'Card' })).toBeTruthy()
    await userEvent.click(screen.getByLabelText('inside'))
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(screen.getByText('open'))
  })
})
