// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { stubBridge } from './setup/renderer'
import { runShortcut } from '../src/renderer/src/hooks/useHotkeys'
import { resolveBindings } from '../src/renderer/src/lib/shortcuts'
import { useApp } from '../src/renderer/src/store/app'
import { useOnboarding } from '../src/renderer/src/store/onboarding'
import { OnboardingTour } from '../src/renderer/src/components/onboarding/OnboardingTour'
import { ShortcutManager } from '../src/renderer/src/components/settings/ShortcutManager'

// While an approval is on screen, focus is on its buttons rather than a
// terminal, so every key reached the document-level handlers underneath it.
// Ctrl+K opened the command palette beneath the scrim and took focus into it,
// so the next Enter went to a palette nobody could see; Close Tab closed a tab
// behind the question. The approval's presence is what the guards read, so a
// bare `.approval-scrim` stands in for the dialog here.

let scrim: HTMLElement | null = null
const showApproval = (): void => {
  scrim = document.createElement('div')
  scrim.className = 'scrim approval-scrim'
  document.body.append(scrim)
}
const hideApproval = (): void => {
  scrim?.remove()
  scrim = null
}

beforeEach(() => stubBridge({}))
afterEach(hideApproval)

/** A key event for the combo bound to `id`, as the dispatcher would see it. */
function press(id: string): KeyboardEvent {
  const combo = resolveBindings(useApp.getState().settings.shortcuts).get(id)
  expect(combo, `${id} must have a binding`).toBeTruthy()
  const parts = combo!.split('+')
  const key = parts[parts.length - 1]
  return new KeyboardEvent('keydown', {
    key: key.length === 1 ? key.toLowerCase() : key,
    ctrlKey: parts.includes('Ctrl'),
    shiftKey: parts.includes('Shift'),
    altKey: parts.includes('Alt')
  })
}

describe('app shortcuts while an approval is up', () => {
  it('does not open the palette or close a tab under it', () => {
    const togglePalette = vi.fn()
    const closeTab = vi.fn()
    useApp.setState({ togglePalette, closeTab, activeTabId: 't1' })
    showApproval()

    expect(runShortcut(press('palette'), 'app')).toBe(false)
    expect(runShortcut(press('close-tab'), 'app')).toBe(false)

    expect(togglePalette).not.toHaveBeenCalled()
    expect(closeTab).not.toHaveBeenCalled()
  })

  it('still zooms, which is for reading the dialog', () => {
    const zoomTerminal = vi.fn()
    useApp.setState({ zoomTerminal })
    showApproval()

    expect(runShortcut(press('zoom-in'), 'app')).toBe(true)
    expect(zoomTerminal).toHaveBeenCalledWith(1)
  })

  it('fires them again once it has gone', () => {
    const togglePalette = vi.fn()
    useApp.setState({ togglePalette })

    expect(runShortcut(press('palette'), 'app')).toBe(true)
    expect(togglePalette).toHaveBeenCalled()
  })
})

describe('the walkthrough while an approval is up', () => {
  it('ignores Escape, which was meant for the question', () => {
    render(<OnboardingTour />)
    // Opened after mount: on a fresh profile the tour's own first-run check
    // closes it in favour of the setup card.
    act(() => useOnboarding.getState().start())
    expect(useOnboarding.getState().open).toBe(true)
    showApproval()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(useOnboarding.getState().open).toBe(true)

    hideApproval()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(useOnboarding.getState().open).toBe(false)
  })
})

describe('the shortcut recorder while an approval is up', () => {
  it('lets Tab and Enter through to the approval instead of recording them', () => {
    const before = useApp.getState().settings.shortcuts
    render(<ShortcutManager />)
    fireEvent.click(screen.getAllByTitle('Click, then press keys')[0])
    expect(screen.getByText('Press keys…')).toBeTruthy()
    showApproval()

    // fireEvent returns false when a handler called preventDefault.
    expect(fireEvent.keyDown(window, { key: 'Tab', code: 'Tab' })).toBe(true)
    expect(fireEvent.keyDown(window, { key: 'Enter', code: 'Enter' })).toBe(true)

    expect(useApp.getState().settings.shortcuts).toEqual(before)
    expect(screen.getByText('Press keys…')).toBeTruthy()
  })
})
