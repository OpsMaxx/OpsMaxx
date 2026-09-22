// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { stubBridge } from './setup/renderer'
import { Settings } from '../src/renderer/src/components/settings/Settings'
import { useApp } from '../src/renderer/src/store/app'
import { useNav } from '../src/renderer/src/store/nav'
import { TERMINAL_SCHEMES, type TerminalScheme } from '../src/shared/terminalTheme'

// The colour scheme was a <select> of names, which says nothing about what a
// scheme looks like until it is applied and a terminal looked at. It is now a
// radio group of swatches. What must not change is the setting it writes.

const CAMPBELL: TerminalScheme = { ...TERMINAL_SCHEMES[0], id: 'campbell', name: 'Campbell' }

beforeEach(() => {
  stubBridge({
    autoStart: { get: () => Promise.resolve({ supported: false, reason: 'not here' }) },
    updates: { state: () => Promise.resolve(null), onState: () => () => undefined }
  })
  useApp.getState().setSettings({ terminalScheme: '', terminalCustomSchemes: [CAMPBELL] })
  useNav.getState().setSettingsSection('terminal')
})

// Named by the visible row title, not by a label only a screen reader hears.
const group = (): HTMLElement => screen.getByRole('radiogroup', { name: 'Colour scheme' })
const radios = (): HTMLElement[] => within(group()).getAllByRole('radio')
const checked = (): HTMLElement[] => radios().filter((r) => r.getAttribute('aria-checked') === 'true')
/** The card's name, without the "$ ls" drawn in its preview. */
const label = (r: HTMLElement): string | null | undefined => r.querySelector('.scheme-name')?.textContent

describe('terminal colour scheme swatches', () => {
  it('draws a swatch for the app palette, every built-in and every import', () => {
    render(<Settings />)

    const names = radios().map(label)
    expect(names[0]).toBe('App palette')
    for (const s of TERMINAL_SCHEMES) expect(names).toContain(s.name)
    expect(names).toContain('Campbell (imported)')
    expect(radios()).toHaveLength(TERMINAL_SCHEMES.length + 2)
    // Each one is a preview, not just a label.
    for (const r of radios()) expect(r.querySelectorAll('.scheme-chips span')).toHaveLength(6)
  })

  it('sets terminalScheme to the chosen id', () => {
    render(<Settings />)

    fireEvent.click(screen.getByRole('radio', { name: 'Dracula' }))

    expect(useApp.getState().settings.terminalScheme).toBe('dracula')
    expect(checked().map(label)).toEqual(['Dracula'])
  })

  it('is one tab stop, and the arrow keys move the selection', () => {
    render(<Settings />)
    expect(radios().filter((r) => r.tabIndex === 0)).toEqual(checked())

    fireEvent.keyDown(checked()[0], { key: 'ArrowRight' })
    expect(useApp.getState().settings.terminalScheme).toBe(TERMINAL_SCHEMES[0].id)
    expect(document.activeElement).toBe(checked()[0])

    fireEvent.keyDown(checked()[0], { key: 'ArrowLeft' })
    fireEvent.keyDown(checked()[0], { key: 'ArrowLeft' })
    // Wraps: left of the first is the last, which is the import.
    expect(useApp.getState().settings.terminalScheme).toBe('campbell')

    fireEvent.keyDown(checked()[0], { key: 'Home' })
    expect(useApp.getState().settings.terminalScheme).toBe('')

    fireEvent.keyDown(checked()[0], { key: 'End' })
    expect(useApp.getState().settings.terminalScheme).toBe('campbell')
    // ...and right of the last is the first.
    fireEvent.keyDown(checked()[0], { key: 'ArrowRight' })
    expect(useApp.getState().settings.terminalScheme).toBe('')
  })

  // An imported scheme that has since gone: the first card shows as checked,
  // so Space on it has to make that true rather than do nothing.
  it('writes the shown selection when the stored one no longer exists', () => {
    useApp.getState().setSettings({ terminalScheme: 'deleted-import' })
    render(<Settings />)

    expect(checked().map(label)).toEqual(['App palette'])
    fireEvent.keyDown(checked()[0], { key: ' ' })
    expect(useApp.getState().settings.terminalScheme).toBe('')
  })

  it('marks the selection with more than colour', () => {
    useApp.getState().setSettings({ terminalScheme: 'nord' })
    render(<Settings />)

    const [nord] = checked()
    expect(label(nord)).toBe('Nord')
    expect(nord.querySelector('.scheme-name svg')).not.toBeNull()
    expect(radios().filter((r) => r !== nord && r.querySelector('.scheme-name svg'))).toEqual([])
  })
})
