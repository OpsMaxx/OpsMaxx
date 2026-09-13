// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { stubBridge } from './setup/renderer'
import { ActivityBar } from '../src/renderer/src/components/layout/ActivityBar'
import { CommandPalette } from '../src/renderer/src/components/palette/CommandPalette'
import { ISSUES_URL } from '../src/renderer/src/lib/reportBug'
import { useToasts } from '../src/renderer/src/store/toast'

// Reporting a bug was seven steps across two applications, and step one was
// knowing to look in Settings > Advanced. Nothing anywhere in the app said
// "report a bug" or pointed at the issue tracker at all.
//
// So what is asserted here is the whole click, not its parts: the diagnostics
// land on the clipboard AND the issue form opens AND the user is told which of
// those just happened. A test that only checked the copy would have passed on
// the day this feature did not exist.

const DIAGNOSTICS = 'OpsMaxx diagnostics\nversion: 0.36.12\n'

/** The bridge slice this path uses, with both halves recorded. */
function stub(text: string | null = DIAGNOSTICS): {
  write: ReturnType<typeof vi.fn>
  open: ReturnType<typeof vi.fn>
} {
  const write = vi.fn()
  stubBridge({
    clipboard: { write },
    // `null` stands for the two ways the text can be unavailable: an old
    // preload with no `text` method, and a collector that threw.
    ...(text === null ? {} : { diagnostics: { text: vi.fn().mockResolvedValue(text) } })
  })
  const open = vi.fn().mockReturnValue(null)
  vi.spyOn(window, 'open').mockImplementation(open as unknown as typeof window.open)
  return { write, open }
}

const messages = (): string[] => useToasts.getState().toasts.map((t) => t.message)

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('one click reports a bug from the activity bar', () => {
  const button = (): HTMLElement => screen.getByRole('button', { name: /^Report a bug/ })

  it('is on the rail without anything being opened first', () => {
    stub()
    render(<ActivityBar />)
    // The whole point: found by someone who has not opened Settings, does not
    // know the palette exists, and has never seen the crash card.
    expect(button().getAttribute('title')).toContain('copies your diagnostics')
    expect(button().getAttribute('title')).toContain('opens the issue form')
  })

  it('copies the diagnostics and opens the issue form on the one press', async () => {
    const { write, open } = stub()
    render(<ActivityBar />)

    await userEvent.click(button())

    await waitFor(() => expect(write).toHaveBeenCalledWith(DIAGNOSTICS))
    expect(open).toHaveBeenCalledWith(ISSUES_URL, '_blank', 'noopener,noreferrer')
  })

  it('says the diagnostics are on the clipboard and to paste them in', async () => {
    stub()
    render(<ActivityBar />)

    await userEvent.click(button())

    await waitFor(() => expect(messages()).toHaveLength(1))
    const [said] = messages()
    // Both halves of what just happened. A toast that only said "Copied" would
    // leave the browser tab unexplained, and one that only said "Opened" would
    // leave the user retyping their version numbers by hand.
    expect(said).toMatch(/clipboard/i)
    expect(said).toMatch(/paste/i)
    expect(said).toMatch(/issue form/i)
  })

  it('still opens the form when the diagnostics cannot be collected', async () => {
    const { write, open } = stub(null)
    render(<ActivityBar />)

    await userEvent.click(button())

    // A user who pressed this has a bug to report. Losing the version block is
    // a reason to say so, not a reason for the button to do nothing.
    await waitFor(() => expect(open).toHaveBeenCalledWith(ISSUES_URL, '_blank', 'noopener,noreferrer'))
    expect(write).not.toHaveBeenCalled()
    expect(messages()[0]).toMatch(/Settings > Advanced/)
  })
})

describe('the issue form is opened empty', () => {
  // This is a constraint, not a style choice, and it is easy to "improve" away.
  // A pre-filled body puts the diagnostics in the address bar, the browser's
  // history and every proxy log on the way, and GitHub truncates a long URL —
  // so the [config] section, the half that four bugs needed, is exactly the
  // part that would vanish. The clipboard has neither problem.
  it('carries no query string and no fragment', () => {
    const url = new URL(ISSUES_URL)
    expect(url.search).toBe('')
    expect(url.hash).toBe('')
    expect(url.pathname).toBe('/OpsMaxx/OpsMaxx/issues/new/choose')
  })

  it('points at the chooser, not at a template', () => {
    expect(ISSUES_URL).toBe('https://github.com/OpsMaxx/OpsMaxx/issues/new/choose')
  })
})

describe('the palette reaches it too', () => {
  const entry = (container: HTMLElement): HTMLElement => {
    const hit = [...container.querySelectorAll('.palette-item')].find(
      (el) => el.querySelector('.p-title')?.textContent === 'Report a bug'
    )
    expect(hit, 'the palette has no "Report a bug" entry').toBeTruthy()
    return hit as HTMLElement
  }

  it('lists it under Actions', () => {
    stub()
    const { container } = render(<CommandPalette />)
    const groups = [...container.querySelectorAll('.palette-group')].map((el) => el.textContent)
    expect(groups).toContain('Actions')
    expect(entry(container)).toBeTruthy()
  })

  it('does the same one thing the rail button does', async () => {
    const { write, open } = stub()
    const { container } = render(<CommandPalette />)

    await userEvent.click(entry(container))

    await waitFor(() => expect(write).toHaveBeenCalledWith(DIAGNOSTICS))
    expect(open).toHaveBeenCalledWith(ISSUES_URL, '_blank', 'noopener,noreferrer')
  })
})
