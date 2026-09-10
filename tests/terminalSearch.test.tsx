// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { TerminalSearch } from '../src/renderer/src/components/terminal/TerminalSearch'

/**
 * Find in the terminal.
 *
 * Reported as "search and filter not working in ssh and local terminals". The
 * search bar itself was fine — match count, case/word/regex, Enter and
 * Shift+Enter, Escape. What was broken is that the only VISIBLE way to reach
 * it was a button with no onClick:
 *
 *     <button className="icon-btn" title="Search"><Search size={15} /></button>
 *
 * So it opened from a keyboard shortcut and nowhere else, and the one
 * affordance pointing at it did nothing — which reads as a broken feature
 * rather than a missing binding.
 */

const addon = (): { findNext: ReturnType<typeof vi.fn>; findPrevious: ReturnType<typeof vi.fn>; clearDecorations: ReturnType<typeof vi.fn>; onDidChangeResults: ReturnType<typeof vi.fn> } => ({
  findNext: vi.fn(() => true),
  findPrevious: vi.fn(() => true),
  clearDecorations: vi.fn(),
  onDidChangeResults: vi.fn(() => ({ dispose: vi.fn() }))
})

const renderBar = (over: Record<string, unknown> = {}) => {
  const a = addon()
  const onClose = vi.fn()
  render(
    <TerminalSearch
      search={{ current: a } as never}
      onClose={onClose}
      {...over}
    />
  )
  return { a, onClose }
}

const field = (): HTMLElement => screen.getByPlaceholderText(/Find in terminal/i)

describe('the toolbar button that reaches it', () => {
  const PANEL = readFileSync(
    resolve(__dirname, '..', 'src/renderer/src/components/panel/WorkspacePanel.tsx'),
    'utf8'
  )

  it('actually does something when clicked', () => {
    // The bug, in one assertion: a Search button with no handler.
    expect(PANEL).not.toMatch(/<button className="icon-btn" title="Search">/)
    expect(PANEL).toContain('requestTerminalFind(')
  })

  /**
   * A split tab has more than one terminal and the toolbar sits above all of
   * them, so the request has to name which one — the active pane, not the tab.
   */
  it('aims at the active pane rather than the tab', () => {
    expect(PANEL).toMatch(/requestTerminalFind\(\s*panes\[active\.id\]\?\.activePaneId/)
  })
})

describe('searching', () => {
  it('searches as you type, rather than only on Enter', () => {
    const { a } = renderBar()
    fireEvent.change(field(), { target: { value: 'error' } })
    expect(a.findNext).toHaveBeenCalledWith('error', expect.anything())
  })

  it('goes forward on Enter and back on Shift+Enter', () => {
    const { a } = renderBar()
    fireEvent.change(field(), { target: { value: 'x' } })
    a.findNext.mockClear()
    fireEvent.keyDown(field(), { key: 'Enter' })
    expect(a.findNext).toHaveBeenCalled()
    fireEvent.keyDown(field(), { key: 'Enter', shiftKey: true })
    expect(a.findPrevious).toHaveBeenCalled()
  })

  it('closes on Escape, clearing what it highlighted', () => {
    const { a, onClose } = renderBar()
    fireEvent.keyDown(field(), { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
    expect(a.clearDecorations).toHaveBeenCalled()
  })

  // Emptying the box must take the highlights with it, or the terminal keeps
  // wearing marks for a search that is no longer being made.
  it('clears the highlights when the box is emptied', () => {
    const { a } = renderBar()
    fireEvent.change(field(), { target: { value: 'x' } })
    a.clearDecorations.mockClear()
    fireEvent.change(field(), { target: { value: '' } })
    expect(a.clearDecorations).toHaveBeenCalled()
  })
})

describe('the iTerm behaviours', () => {
  /**
   * A selection becomes the thing you are looking for, so selecting an error
   * and hitting find needs no retyping.
   */
  it('seeds the field from the terminal selection', () => {
    renderBar({ seed: 'connection refused' })
    expect((field() as HTMLInputElement).value).toBe('connection refused')
  })

  it('starts empty when nothing is selected', () => {
    renderBar()
    expect((field() as HTMLInputElement).value).toBe('')
  })

  // Asking again while open re-focuses and re-selects, the way every editor's
  // find does — without it, pressing the magnifier twice appears to do
  // nothing the second time.
  it('re-selects the field when asked again', () => {
    const a = addon()
    const { rerender } = render(
      <TerminalSearch search={{ current: a } as never} onClose={vi.fn()} focusNonce={1} seed="a" />
    )
    const input = field() as HTMLInputElement
    input.setSelectionRange(1, 1)
    rerender(
      <TerminalSearch search={{ current: a } as never} onClose={vi.fn()} focusNonce={2} seed="a" />
    )
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe(1)
  })
})
