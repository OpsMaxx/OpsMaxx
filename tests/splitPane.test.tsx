// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { SplitPane, clampRatio } from '../src/renderer/src/components/common/SplitPane'

function Harness(props: { onMenu?: (at: { x: number; y: number }) => void; start?: 'a' | 'b' | null }): React.JSX.Element {
  const [ratio, setRatio] = useState(0.5)
  const [collapsed, setCollapsed] = useState<'a' | 'b' | null>(props.start ?? null)
  return (
    <SplitPane
      orientation="horizontal"
      ratio={ratio}
      onRatio={setRatio}
      min={[100, 100]}
      collapsed={collapsed}
      onCollapse={setCollapsed}
      collapsedA={<span>request bar</span>}
      collapsedB={<span>response bar</span>}
      label="Resize request and response"
      defaultRatio={0.4}
      onMenu={props.onMenu}
    >
      {[<div key="a">request</div>, <div key="b">response</div>]}
    </SplitPane>
  )
}

const sep = (): HTMLElement => screen.getByRole('separator', { name: 'Resize request and response' })
const now = (): string | null => sep().getAttribute('aria-valuenow')

describe('SplitPane', () => {
  it('is a focusable separator with orientation and a value', () => {
    render(<Harness />)
    expect(sep().getAttribute('aria-orientation')).toBe('vertical')
    expect(sep().tabIndex).toBe(0)
    expect(now()).toBe('50')
  })

  it('moves 5% per arrow key', () => {
    render(<Harness />)
    fireEvent.keyDown(sep(), { key: 'ArrowRight' })
    expect(now()).toBe('55')
    fireEvent.keyDown(sep(), { key: 'ArrowLeft' })
    fireEvent.keyDown(sep(), { key: 'ArrowLeft' })
    expect(now()).toBe('45')
  })

  it('respects the minimum sizes of both panes', () => {
    expect(clampRatio(0.05, 1000, [300, 100])).toBe(0.3)
    expect(clampRatio(0.99, 1000, [100, 296])).toBe(0.7)
    // A container too small for both minimums does not invert the range.
    expect(clampRatio(0.5, 300, [200, 200])).toBe(0.5)
    // No size (a test DOM): only the 5–95% bounds apply.
    expect(clampRatio(0, 0, [300, 300])).toBe(0.05)
    const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 400, 300))
    render(<Harness />)
    for (let i = 0; i < 10; i++) fireEvent.keyDown(sep(), { key: 'ArrowRight' })
    expect(now()).toBe(String(Math.round((1 - 104 / 400) * 100)))
    spy.mockRestore()
  })

  it('collapses with Home and End, keeps the pane mounted, and shows its bar', () => {
    render(<Harness />)
    fireEvent.keyDown(sep(), { key: 'End' })
    expect(now()).toBe('100')
    expect(screen.getByText('response bar')).toBeTruthy()
    expect(screen.getByText('response').closest('[hidden]')).not.toBeNull()
    fireEvent.keyDown(sep(), { key: 'Home' })
    expect(now()).toBe('0')
    expect(screen.getByText('request bar')).toBeTruthy()
    expect(screen.queryByText('response bar')).toBeNull()
    // An arrow from a collapsed state restores.
    fireEvent.keyDown(sep(), { key: 'ArrowRight' })
    expect(now()).toBe('50')
  })

  it('resets to the default ratio on double-click', () => {
    render(<Harness start="b" />)
    fireEvent.doubleClick(sep())
    expect(now()).toBe('40')
  })

  it('opens the caller menu on right-click and Shift+F10', () => {
    const onMenu = vi.fn()
    render(<Harness onMenu={onMenu} />)
    fireEvent.contextMenu(sep(), { clientX: 10, clientY: 20 })
    expect(onMenu).toHaveBeenLastCalledWith({ x: 10, y: 20 })
    fireEvent.keyDown(sep(), { key: 'F10', shiftKey: true })
    expect(onMenu).toHaveBeenCalledTimes(2)
  })
})

describe('SplitPane focus', () => {
  it('moves focus out of a pane as it collapses, to that pane’s bar', () => {
    function Focusable(): React.JSX.Element {
      const [collapsed, setCollapsed] = useState<'a' | 'b' | null>(null)
      return (
        <SplitPane
          orientation="vertical"
          ratio={0.5}
          onRatio={() => {}}
          min={[0, 0]}
          collapsed={collapsed}
          onCollapse={setCollapsed}
          collapsedB={<button>Show response</button>}
          label="split"
        >
          {[<button key="a">in request</button>, <button key="b" onClick={() => setCollapsed('b')}>in response</button>]}
        </SplitPane>
      )
    }
    render(<Focusable />)
    const inside = screen.getByText('in response')
    inside.focus()
    fireEvent.click(inside)
    expect(document.activeElement).toBe(screen.getByText('Show response'))
  })
})
