// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { useState } from 'react'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ContextMenu } from '../src/renderer/src/components/connections/ContextMenu'

/**
 * The shared context menu, from the keyboard.
 *
 * Every right-click menu in the app is this component, so its focus handling is
 * everybody's: a menu that focus never entered could only be dismissed, and one
 * that yanked focus back on close would undo whatever an item had just focused.
 */

function Harness({ steal }: { steal?: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button onClick={() => setOpen(true)}>opener</button>
      <input aria-label="elsewhere" />
      {open && (
        <ContextMenu
          x={0}
          y={0}
          entries={[
            { label: 'Disabled', disabled: true },
            {
              label: 'First',
              onClick: () => {
                if (steal) (screen.getByLabelText('elsewhere') as HTMLInputElement).focus()
              }
            },
            { separator: true, label: '' },
            { label: 'Second' },
            { label: 'Last' }
          ]}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

const item = (name: string): HTMLElement => screen.getByRole('menuitem', { name })

async function openMenu(steal?: boolean): Promise<void> {
  render(<Harness steal={steal} />)
  const opener = screen.getByText('opener')
  opener.focus()
  await userEvent.keyboard('{Enter}')
}

describe('ContextMenu keyboard', () => {
  it('puts focus on the first enabled item', async () => {
    await openMenu()
    expect(document.activeElement).toBe(item('First'))
  })

  it('wraps: Up from the first goes to the last, Down from the last to the first', async () => {
    await openMenu()
    await userEvent.keyboard('{ArrowUp}')
    expect(document.activeElement).toBe(item('Last'))
    await userEvent.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(item('First'))
    await userEvent.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(item('Second'))
  })

  it('goes to the first and last item on Home and End, and marks separators', async () => {
    await openMenu()
    await userEvent.keyboard('{End}')
    expect(document.activeElement).toBe(item('Last'))
    await userEvent.keyboard('{Home}')
    expect(document.activeElement).toBe(item('First'))
    expect(screen.getByRole('separator')).toBeTruthy()
  })

  it('closes on Tab rather than leaving the menu open behind the focus', async () => {
    await openMenu()
    await userEvent.keyboard('{Tab}')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(screen.getByText('opener'))
  })

  it('returns focus to the opener on Escape', async () => {
    await openMenu()
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(screen.getByText('opener'))
  })

  it('does not steal focus back from whatever an item focused', async () => {
    await openMenu(true)
    await act(async () => {
      item('First').click()
    })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(screen.getByLabelText('elsewhere'))
  })
})
