// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ContextMenu, placeMenu } from '../src/renderer/src/components/connections/ContextMenu'

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

describe('ContextMenu extensions (HTTP client, §3.8)', () => {
  const open = (entries: Parameters<typeof ContextMenu>[0]['entries'], anchor?: DOMRect): void => {
    render(<ContextMenu x={40} y={40} entries={entries} anchor={anchor} onClose={() => {}} />)
  }

  it('shows shortcut text without making it part of the name', () => {
    open([{ label: 'Duplicate', shortcut: '⌘D' }])
    expect(item('Duplicate').textContent).toContain('⌘D')
  })

  it('renders radio and checkbox items with aria-checked', () => {
    open([
      { label: 'Auto', radio: 'orientation', checked: false },
      { label: 'Stacked', radio: 'orientation', checked: true },
      { label: 'Sidebar', checked: true },
      { label: 'Response', checked: false },
      { label: 'Plain' }
    ])
    expect(screen.getByRole('menuitemradio', { name: 'Stacked' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('menuitemradio', { name: 'Auto' }).getAttribute('aria-checked')).toBe('false')
    expect(screen.getByRole('menuitemcheckbox', { name: 'Sidebar' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('menuitemcheckbox', { name: 'Response' }).getAttribute('aria-checked')).toBe('false')
    expect(item('Plain').getAttribute('aria-checked')).toBeNull()
  })

  it('shows a section header as presentation, not an item', async () => {
    open([{ label: 'A' }, { label: 'Description column', section: 'This tab', checked: true }])
    const header = screen.getByText('This tab')
    expect(header.getAttribute('role')).toBe('presentation')
    await userEvent.keyboard('{End}')
    expect(document.activeElement).toBe(screen.getByRole('menuitemcheckbox', { name: 'Description column' }))
  })

  it('clamps against the measured size of the menu, not an estimate', () => {
    const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 400))
    Object.assign(window, { innerWidth: 1024, innerHeight: 768 })
    render(<ContextMenu x={1000} y={700} entries={[{ label: 'A' }]} onClose={() => {}} />)
    const menu = screen.getByRole('menu')
    expect(spy).toHaveBeenCalled()
    expect(menu.style.left).toBe(`${1024 - 300 - 8}px`)
    expect(menu.style.top).toBe(`${768 - 400 - 8}px`)
    spy.mockRestore()
  })

  it('opens under an anchor, and above it when there is no room below', () => {
    const anchor = new DOMRect(100, 700, 80, 28)
    expect(placeMenu({ x: 0, y: 0, anchor: new DOMRect(100, 50, 80, 28) }, 200, 100, 1024, 768)).toEqual([100, 78])
    expect(placeMenu({ x: 0, y: 0, anchor }, 200, 100, 1024, 768)).toEqual([100, 600])
    expect(placeMenu({ x: 2000, y: -5 }, 200, 100, 1024, 768)).toEqual([816, 8])
  })
})
