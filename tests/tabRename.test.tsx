// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { stubBridge } from './setup/renderer'
import { TabStrip } from '../src/renderer/src/components/panel/TabStrip'
import { useApp } from '../src/renderer/src/store/app'

/**
 * Naming a tab.
 *
 * Tabs are titled from whatever opened them — a server's name, a shell's
 * path — and three sessions on one host are then three tabs reading the same
 * word. The strip is where that name is read, so it is where it is typed:
 * a dialog for one short string puts the thing being renamed behind the box
 * renaming it.
 */

const ITEMS = [
  { id: 't1', title: 'web-01' },
  { id: 't2', title: 'web-01 (2)' }
]

function strip(over: Partial<React.ComponentProps<typeof TabStrip>> = {}): {
  onRename: ReturnType<typeof vi.fn>
} {
  stubBridge({})
  const onRename = vi.fn()
  render(
    <TabStrip
      items={ITEMS}
      activeId="t1"
      label="Session tabs"
      onSelect={vi.fn()}
      onClose={vi.fn()}
      onReorder={vi.fn()}
      onRename={onRename}
      {...over}
    />
  )
  return { onRename }
}

describe('renaming a tab in the strip', () => {
  it('opens an editor on double-click, seeded with the current name', async () => {
    strip()
    await userEvent.dblClick(screen.getByRole('tab', { name: /web-01$/ }))
    expect((screen.getByLabelText('Rename web-01') as HTMLInputElement).value).toBe('web-01')
  })

  it('commits on Enter', async () => {
    const { onRename } = strip()
    await userEvent.dblClick(screen.getByRole('tab', { name: /web-01$/ }))
    const box = screen.getByLabelText('Rename web-01')
    await userEvent.clear(box)
    await userEvent.type(box, 'prod api{Enter}')
    expect(onRename).toHaveBeenCalledWith('t1', 'prod api')
  })

  it('commits on blur, so clicking away keeps the name', async () => {
    const { onRename } = strip()
    await userEvent.dblClick(screen.getByRole('tab', { name: /web-01$/ }))
    const box = screen.getByLabelText('Rename web-01')
    await userEvent.clear(box)
    await userEvent.type(box, 'staging')
    await userEvent.click(screen.getByRole('tab', { name: /web-01 \(2\)/ }))
    expect(onRename).toHaveBeenCalledWith('t1', 'staging')
  })

  it('abandons the edit on Escape without renaming anything', async () => {
    const { onRename } = strip()
    await userEvent.dblClick(screen.getByRole('tab', { name: /web-01$/ }))
    const box = screen.getByLabelText('Rename web-01')
    await userEvent.clear(box)
    await userEvent.type(box, 'discard me{Escape}')
    // Escape must win even though blur fires straight after the unmount.
    expect(onRename).not.toHaveBeenCalled()
    expect(screen.queryByLabelText('Rename web-01')).toBeNull()
  })

  it('offers nothing when the caller cannot rename', async () => {
    // The database strip shares this component and has no notion of a custom
    // title; it must be untouched by all of the above.
    stubBridge({})
    render(
      <TabStrip
        items={ITEMS}
        activeId="t1"
        label="Database tabs"
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onReorder={vi.fn()}
      />
    )
    await userEvent.dblClick(screen.getByRole('tab', { name: /web-01$/ }))
    expect(screen.queryByLabelText('Rename web-01')).toBeNull()
  })

  it('opens from a rename request, and again when asked a second time', () => {
    // The context menu's "Rename…". A second ask for the same tab must not be
    // swallowed for looking like the first.
    const { rerender } = render(
      <TabStrip
        items={ITEMS}
        activeId="t1"
        label="Session tabs"
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onReorder={vi.fn()}
        onRename={vi.fn()}
        renameRequest={{ id: 't2', nonce: 1 }}
      />
    )
    expect(screen.getByLabelText('Rename web-01 (2)')).toBeTruthy()

    const common = {
      items: ITEMS,
      activeId: 't1',
      label: 'Session tabs',
      onSelect: vi.fn(),
      onClose: vi.fn(),
      onReorder: vi.fn(),
      onRename: vi.fn()
    }
    rerender(<TabStrip {...common} renameRequest={{ id: 't2', nonce: 1 }} />)
    rerender(<TabStrip {...common} renameRequest={{ id: 't2', nonce: 2 }} />)
    expect(screen.getByLabelText('Rename web-01 (2)')).toBeTruthy()
  })
})

describe('the store action', () => {
  it('keeps the new name', () => {
    useApp.setState({
      tabs: [{ id: 't1', kind: 'local', workspaceId: 'ws', title: 'zsh', view: 'terminal', shellId: 'sh' }]
    } as never)
    useApp.getState().renameTab('t1', '  build box  ')
    // Trimmed: a name with leading spaces sorts and reads oddly everywhere.
    expect(useApp.getState().tabs[0].title).toBe('build box')
  })

  it('refuses a blank name rather than producing a nameless tab', () => {
    useApp.setState({
      tabs: [{ id: 't1', kind: 'local', workspaceId: 'ws', title: 'zsh', view: 'terminal', shellId: 'sh' }]
    } as never)
    useApp.getState().renameTab('t1', '   ')
    // A tab with a blank label is unreachable in the strip and unidentifiable
    // in the overflow menu, so clearing the box means cancel.
    expect(useApp.getState().tabs[0].title).toBe('zsh')
  })

  it('refuses a name longer than the strip can carry', () => {
    useApp.setState({
      tabs: [{ id: 't1', kind: 'local', workspaceId: 'ws', title: 'zsh', view: 'terminal', shellId: 'sh' }]
    } as never)
    useApp.getState().renameTab('t1', 'x'.repeat(200))
    expect(useApp.getState().tabs[0].title).toBe('zsh')
  })
})
