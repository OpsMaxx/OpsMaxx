// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  KeyValueTable,
  bulkToRows,
  rowsToBulk,
  type KeyValueTableProps
} from '../src/renderer/src/components/common/KeyValueTable'
import type { Row } from '../src/shared/apiModel'
import { stubBridge } from './setup/renderer'
import { useToasts } from '../src/renderer/src/store/toast'

const row = (key: string, value: string, enabled = true): Row => ({ id: `row_${key}`, key, value, enabled })

function Harness(props: Partial<KeyValueTableProps> & { initial?: Row[]; spy?: (rows: Row[]) => void }): React.JSX.Element {
  const [rows, setRows] = useState<Row[]>(props.initial ?? [row('limit', '10'), row('page', '2', false)])
  const [desc, setDesc] = useState(false)
  return (
    <KeyValueTable
      kind="params"
      showDescription={desc}
      onShowDescription={setDesc}
      {...props}
      rows={rows}
      onChange={(r) => {
        props.spy?.(r)
        setRows(r)
      }}
    />
  )
}

const menuItem = (name: string): HTMLElement => screen.getByRole('menuitem', { name })

describe('bulk edit format', () => {
  it('round-trips rows, with # for a disabled row, keeping ids', () => {
    const rows = [row('limit', '10'), row('page', '2', false), row('url', 'http://x:1/a')]
    const text = rowsToBulk(rows)
    expect(text).toBe('limit: 10\n#page: 2\nurl: http://x:1/a')
    expect(bulkToRows(text, rows)).toEqual(rows)
  })

  it('reads lines without a colon, blank lines, and spaces after #', () => {
    const out = bulkToRows('\n# a: 1\nflag\n')
    expect(out.map((r) => [r.enabled, r.key, r.value])).toEqual([
      [false, 'a', '1'],
      [true, 'flag', '']
    ])
  })
})

describe('KeyValueTable', () => {
  it('grows by a trailing blank row, keeping focus in it', async () => {
    const spy = vi.fn()
    render(<Harness spy={spy} />)
    const input = screen.getByLabelText('New key')
    await userEvent.click(input)
    await userEvent.keyboard('sort')
    expect(spy.mock.lastCall![0].map((r: Row) => r.key)).toEqual(['limit', 'page', 'sort'])
    expect(document.activeElement).toBe(screen.getByLabelText('Key, sort'))
    expect(screen.getByLabelText('New key')).toBeTruthy()
  })

  it('toggles a row with its checkbox', async () => {
    render(<Harness />)
    const box = screen.getByLabelText('Enable page') as HTMLInputElement
    expect(box.checked).toBe(false)
    await userEvent.click(box)
    expect(box.checked).toBe(true)
  })

  it('bulk edits through the table menu and back', async () => {
    const spy = vi.fn()
    const onBulkEditToggle = vi.fn()
    render(<Harness spy={spy} onBulkEditToggle={onBulkEditToggle} />)
    await userEvent.click(screen.getByLabelText('Table options'))
    await userEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Bulk edit' }))
    const area = screen.getByLabelText('Bulk edit') as HTMLTextAreaElement
    expect(area.value).toBe('limit: 10\n#page: 2')
    fireEvent.change(area, { target: { value: 'limit: 10\n#page: 2\nq: x' } })
    await userEvent.click(screen.getByText('Key-value edit'))
    expect(spy.mock.lastCall![0].map((r: Row) => [r.key, r.enabled])).toEqual([
      ['limit', true],
      ['page', false],
      ['q', true]
    ])
    expect(onBulkEditToggle.mock.calls).toEqual([[true], [false]])
  })

  it('offers the row menu from the ⋯ button, right-click and Shift+F10', async () => {
    render(<Harness />)
    fireEvent.contextMenu(screen.getByLabelText('Key, limit'))
    const names = screen.getAllByRole('menuitem').map((m) => m.textContent)
    expect(names).toEqual([
      'Disable rowSpace',
      'Duplicate row',
      'Insert row below',
      'Move upAlt+↑',
      'Move downAlt+↓',
      'Copy key',
      'Copy value',
      'Copy as "key: value"',
      'Read value from vault…',
      expect.stringMatching(/^Delete row/)
    ])
    await userEvent.keyboard('{Escape}')
    screen.getByLabelText('Key, limit').focus()
    await userEvent.keyboard('{Shift>}{F10}{/Shift}')
    expect(screen.getByRole('menu')).toBeTruthy()
    await userEvent.keyboard('{Escape}')
    fireEvent.click(screen.getByLabelText('Actions for limit'))
    expect(screen.getByRole('menu')).toBeTruthy()
  })

  it('duplicates, copies, disables and deletes from the row menu', async () => {
    const write = vi.fn()
    stubBridge({ clipboard: { write } })
    const spy = vi.fn()
    render(<Harness spy={spy} />)
    fireEvent.contextMenu(screen.getByLabelText('Key, limit'))
    await userEvent.click(menuItem('Copy value'))
    expect(write).toHaveBeenCalledWith('10')
    fireEvent.contextMenu(screen.getByLabelText('Key, limit'))
    await userEvent.click(menuItem('Duplicate row'))
    expect(spy.mock.lastCall![0].map((r: Row) => r.key)).toEqual(['limit', 'limit', 'page'])
    fireEvent.contextMenu(screen.getByLabelText('Key, page'))
    await userEvent.click(menuItem('Enable row'))
    expect((screen.getByLabelText('Enable page') as HTMLInputElement).checked).toBe(true)
    fireEvent.contextMenu(screen.getByLabelText('Key, page'))
    await userEvent.click(screen.getByRole('menuitem', { name: /Delete row/ }))
    expect(spy.mock.lastCall![0].map((r: Row) => r.key)).toEqual(['limit', 'limit'])
  })

  it('deletes a row with Mod+Backspace, never plain Backspace', async () => {
    const spy = vi.fn()
    render(<Harness spy={spy} />)
    const key = screen.getByLabelText('Key, page')
    fireEvent.keyDown(key, { key: 'Backspace' })
    expect(spy).not.toHaveBeenCalled()
    fireEvent.keyDown(key, { key: 'Backspace', ctrlKey: true })
    expect(spy.mock.lastCall![0].map((r: Row) => r.key)).toEqual(['limit'])
    expect(document.activeElement).toBe(screen.getByLabelText('Key, limit'))
  })

  it('inserts below, moves with Alt+arrows keeping focus in the cell, and copies as key: value', async () => {
    const write = vi.fn()
    stubBridge({ clipboard: { write } })
    const spy = vi.fn()
    render(<Harness spy={spy} />)
    const value = screen.getByLabelText('Value, page')
    value.focus()
    fireEvent.keyDown(value, { key: 'ArrowUp', altKey: true })
    expect(spy.mock.lastCall![0].map((r: Row) => r.key)).toEqual(['page', 'limit'])
    expect(document.activeElement).toBe(screen.getByLabelText('Value, page'))
    fireEvent.contextMenu(screen.getByLabelText('Key, page'))
    expect(screen.getByRole('menuitem', { name: 'Move up' }).hasAttribute('disabled')).toBe(true)
    await userEvent.click(screen.getByRole('menuitem', { name: 'Insert row below' }))
    expect(spy.mock.lastCall![0].map((r: Row) => r.key)).toEqual(['page', '', 'limit'])
    expect(document.activeElement).toBe(screen.getByLabelText('Key, row 2'))
    fireEvent.contextMenu(screen.getByLabelText('Key, limit'))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Copy as "key: value"' }))
    expect(write).toHaveBeenCalledWith('limit: 10')
  })

  it('deletes all with an undo toast', async () => {
    const spy = vi.fn()
    render(<Harness spy={spy} />)
    await userEvent.click(screen.getByLabelText('Table options'))
    await userEvent.click(menuItem('Delete all'))
    expect(spy.mock.lastCall![0]).toEqual([])
    const t = useToasts.getState().toasts.at(-1)!
    expect(t.message).toBe('Deleted 2 rows')
    t.action!.run()
    expect(spy.mock.lastCall![0].map((r: Row) => r.key)).toEqual(['limit', 'page'])
  })

  it('shows the description column from the table menu', async () => {
    render(<Harness />)
    expect(screen.queryByLabelText('Description, limit')).toBeNull()
    await userEvent.click(screen.getByLabelText('Table options'))
    await userEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Show description' }))
    expect(screen.getByLabelText('Description, limit')).toBeTruthy()
  })

  it('shows the warning from warnFor', () => {
    render(<Harness warnFor={(r) => (r.key === 'limit' ? 'Looks like a credential.' : null)} />)
    const row = screen.getByLabelText('Key, limit').closest('tr')!
    expect(within(row).getByRole('img', { name: 'Looks like a credential.' })).toBeTruthy()
    expect(screen.getAllByRole('img').length).toBe(1)
  })

  it('splits a multi-line key: value paste into rows, and flattens any other paste', () => {
    const spy = vi.fn()
    render(<Harness spy={spy} initial={[]} />)
    fireEvent.paste(screen.getByLabelText('New key'), {
      clipboardData: { getData: () => 'a: 1\n#b: 2' }
    })
    expect(spy.mock.lastCall![0].map((r: Row) => [r.key, r.value, r.enabled])).toEqual([
      ['a', '1', true],
      ['b', '2', false]
    ])
    fireEvent.paste(screen.getByLabelText('Value, a'), { clipboardData: { getData: () => 'x\ny' } })
    expect(spy.mock.lastCall![0][0].value).toBe('1x y')
  })

  it('is read-only on request: no trailing row, no editing items', () => {
    render(<Harness readOnly />)
    expect(screen.queryByLabelText('New key')).toBeNull()
    fireEvent.contextMenu(screen.getByLabelText('Key, limit'))
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Copy key', 'Copy value', 'Copy as "key: value"'])
  })
})

describe('KeyValueTable with a caller value cell', () => {
  it('keeps the same value element when the trailing row becomes a real row', async () => {
    const spy = vi.fn()
    render(
      <Harness
        spy={spy}
        initial={[]}
        valueCell={(row, onValue) => (
          <input aria-label="custom value" data-row-id={row.id} value={row.value} onChange={(e) => onValue(e.target.value)} />
        )}
      />
    )
    const input = screen.getByLabelText('custom value')
    await userEvent.click(input)
    await userEvent.keyboard('abc')
    expect(spy.mock.lastCall![0].map((r: Row) => r.value)).toEqual(['abc'])
    expect(document.activeElement).toBe(input)
  })

  it('leaves a key an editor already handled to the editor', () => {
    const spy = vi.fn()
    render(<Harness spy={spy} />)
    const key = screen.getByLabelText('Key, page')
    key.addEventListener('keydown', (e) => e.preventDefault())
    fireEvent.keyDown(key, { key: 'Backspace', ctrlKey: true })
    expect(spy).not.toHaveBeenCalled()
  })
})
