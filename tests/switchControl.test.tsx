// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { useState } from 'react'
import { stubBridge } from './setup/renderer'
import { Switch } from '../src/renderer/src/components/common/Switch'
import { Settings } from '../src/renderer/src/components/settings/Settings'
import { AddDatabaseModal } from '../src/renderer/src/components/databases/AddDatabaseModal'
import { useApp } from '../src/renderer/src/store/app'
import { useNav } from '../src/renderer/src/store/nav'
import { MODULES, moduleEnabled } from '../src/shared/modules'

/**
 * The on/off switch, from the keyboard.
 *
 * `.switch` was a bare `<span onClick>` at every call site, so no module could
 * be switched without a mouse and a screen reader heard nothing at all. It is
 * one component now; these pin that it is a real control and that no call site
 * has gone back to drawing its own.
 */

function Labelled(): React.JSX.Element {
  const [on, setOn] = useState(false)
  return (
    <label>
      <Switch checked={on} onChange={setOn} />
      Follow
    </label>
  )
}

describe('Switch', () => {
  it('is a focusable switch that Space and Enter toggle', async () => {
    const onChange = vi.fn()
    render(<Switch checked={false} label="Compression" onChange={onChange} />)
    const sw = screen.getByRole('switch', { name: 'Compression' })
    expect(sw.getAttribute('aria-checked')).toBe('false')
    await userEvent.tab()
    expect(document.activeElement).toBe(sw)
    await userEvent.keyboard(' ')
    await userEvent.keyboard('{Enter}')
    expect(onChange.mock.calls).toEqual([[true], [true]])
  })

  it('does nothing and takes no focus when disabled', async () => {
    const onChange = vi.fn()
    render(<Switch checked label="Webhook" disabled onChange={onChange} />)
    await userEvent.tab()
    expect(document.activeElement).toBe(document.body)
    await userEvent.click(screen.getByRole('switch'))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('is its wrapping label\'s control: the words beside it toggle it, once', async () => {
    render(<Labelled />)
    const sw = screen.getByRole('switch', { name: 'Follow' })
    await userEvent.click(screen.getByText('Follow'))
    expect(sw.getAttribute('aria-checked')).toBe('true')
    await userEvent.click(sw)
    expect(sw.getAttribute('aria-checked')).toBe('false')
  })
})

describe('Settings modules', () => {
  beforeEach(() => {
    stubBridge({
      autoStart: { get: () => Promise.resolve({ supported: false, reason: 'not here' }) },
      updates: { state: () => Promise.resolve(null), onState: () => () => undefined }
    })
    useNav.getState().setSettingsSection('modules')
  })

  it('toggles a module from the keyboard', async () => {
    render(<Settings />)
    const m = MODULES[0]
    const sw = screen.getByRole('switch', { name: m.label })
    const before = sw.getAttribute('aria-checked')
    sw.focus()
    await userEvent.keyboard(' ')
    expect(sw.getAttribute('aria-checked')).not.toBe(before)
    expect(String(moduleEnabled(useApp.getState().settings.modules, m.id))).toBe(sw.getAttribute('aria-checked'))
    // Every module row has one, named after it.
    for (const mod of MODULES) expect(within(document.body).getByRole('switch', { name: mod.label })).toBeTruthy()
  })
})

describe('names', () => {
  it('names the database TLS switch for the setting, not for its state', () => {
    stubBridge({ db: { test: vi.fn() } })
    render(<AddDatabaseModal />)
    // The words beside it are "Enabled"/"Disabled"; a switch called
    // "Disabled, off" tells nobody what it controls.
    expect(screen.getByRole('switch', { name: 'TLS / SSL' })).toBeTruthy()
  })
})

describe('no hand-drawn switches left', () => {
  const root = join(__dirname, '..', 'src', 'renderer', 'src')
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f)
      return statSync(p).isDirectory() ? files(p) : p.endsWith('.tsx') ? [p] : []
    })

  it('draws `.switch` only through the shared component', () => {
    const offenders = files(root)
      .filter((p) => !p.endsWith(join('common', 'Switch.tsx')))
      .filter((p) => /clsx\(\s*'switch'|className="switch[ "]/.test(readFileSync(p, 'utf8')))
    expect(offenders).toEqual([])
  })
})
