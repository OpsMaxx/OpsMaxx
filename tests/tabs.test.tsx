// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Tabs, type TabItem } from '../src/renderer/src/components/common/Tabs'

const TABS: TabItem[] = [
  { id: 'params', label: 'Params', count: 2 },
  { id: 'auth', label: 'Auth', dot: 'set' },
  { id: 'headers', label: 'Headers', count: 0 },
  { id: 'body', label: 'Body', dot: 'problem' }
]

function Harness(): React.JSX.Element {
  const [active, setActive] = useState('params')
  return <Tabs tabs={TABS} active={active} onChange={setActive} ariaLabel="Request" idPrefix="req" />
}

const tab = (name: RegExp): HTMLElement => screen.getByRole('tab', { name })

describe('Tabs', () => {
  it('is a tablist with one tab in the Tab order', () => {
    render(<Harness />)
    expect(screen.getByRole('tablist', { name: 'Request' })).toBeTruthy()
    expect(tab(/Params/).getAttribute('aria-selected')).toBe('true')
    expect(tab(/Params/).tabIndex).toBe(0)
    expect(tab(/Auth/).tabIndex).toBe(-1)
    expect(tab(/Params/).id).toBe('req-tab-params')
    expect(tab(/Params/).getAttribute('aria-controls')).toBe('req-panel')
  })

  it('moves and selects with the arrow keys, Home and End, wrapping', async () => {
    render(<Harness />)
    tab(/Params/).focus()
    await userEvent.keyboard('{ArrowRight}')
    expect(document.activeElement).toBe(tab(/Auth/))
    expect(tab(/Auth/).getAttribute('aria-selected')).toBe('true')
    await userEvent.keyboard('{End}')
    expect(document.activeElement).toBe(tab(/Body/))
    await userEvent.keyboard('{ArrowRight}')
    expect(document.activeElement).toBe(tab(/Params/))
    await userEvent.keyboard('{ArrowLeft}')
    expect(document.activeElement).toBe(tab(/Body/))
    await userEvent.keyboard('{Home}')
    expect(document.activeElement).toBe(tab(/Params/))
  })

  it('shows a count only when it is above zero', () => {
    render(<Harness />)
    expect(tab(/Params/).textContent).toBe('Params2')
    expect(tab(/Headers/).textContent).toBe('Headers')
  })

  it('names a dot in words, not only colour', () => {
    render(<Harness />)
    expect(tab(/Auth, set/)).toBeTruthy()
    expect(tab(/Body, has a problem/)).toBeTruthy()
  })
})
