// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ModePicker } from '../src/renderer/src/components/ai/ModePicker'
import { useToasts } from '../src/renderer/src/store/toast'

// The one control that sets how much a human is in the loop. Bypass is the
// setting that lifts every refusal, so it must never be one click away.

const open = async (): Promise<void> => userEvent.click(screen.getByTestId('mode-picker'))

describe('ModePicker', () => {
  it('shows the current mode and lists all four, the current one checked', async () => {
    render(<ModePicker value="auto" onChange={() => {}} />)
    expect(screen.getByTestId('mode-picker').textContent).toContain('Auto')
    await open()
    const items = screen.getAllByRole('menuitemradio')
    expect(items.map((i) => i.textContent)).toEqual([
      expect.stringContaining('Read only'),
      expect.stringContaining('Ask first'),
      expect.stringContaining('Auto'),
      expect.stringContaining('Bypass permissions')
    ])
    expect(screen.getByRole('menuitemradio', { name: /Auto/ }).getAttribute('aria-checked')).toBe('true')
  })

  it('changes mode on a click', async () => {
    const onChange = vi.fn()
    render(<ModePicker value="auto" onChange={onChange} />)
    await open()
    await userEvent.click(screen.getByRole('menuitemradio', { name: /Ask first/ }))
    expect(onChange).toHaveBeenCalledWith('ask')
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('picks by digit', async () => {
    const onChange = vi.fn()
    render(<ModePicker value="auto" onChange={onChange} />)
    await open()
    await userEvent.keyboard('1')
    expect(onChange).toHaveBeenCalledWith('readOnly')
  })

  it('closes on Escape without changing anything', async () => {
    const onChange = vi.fn()
    render(<ModePicker value="auto" onChange={onChange} />)
    await open()
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('asks before Bypass, and Cancel leaves the mode alone', async () => {
    const onChange = vi.fn()
    render(<ModePicker value="auto" onChange={onChange} />)
    await open()
    await userEvent.keyboard('4')
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByTestId('bypass-confirm').textContent).toContain('/etc/shadow')
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.queryByTestId('bypass-confirm')).toBeNull()
    // Back on the picker, not lost on the body: the menu item that opened the
    // confirm no longer exists.
    expect(document.activeElement).toBe(screen.getByTestId('mode-picker'))
  })

  it('as the default, says every new session starts in Bypass, including ones with no picker', async () => {
    const onChange = vi.fn()
    render(<ModePicker value="auto" onChange={onChange} defaultScope />)
    await open()
    await userEvent.keyboard('4')
    expect(screen.getByTestId('bypass-confirm').textContent).toMatch(/Every new agent session will start in Bypass/)
    expect(screen.getByTestId('bypass-confirm').textContent).toMatch(/CLI-paired and OAuth/)
    await userEvent.click(screen.getByRole('button', { name: 'Make Bypass the default' }))
    expect(onChange).toHaveBeenCalledWith('bypass')
  })

  it('says so when the change fails, rather than dropping the rejection', async () => {
    const onChange = vi.fn(async () => {
      throw new Error('bridge gone')
    })
    render(<ModePicker value="auto" onChange={onChange} />)
    await open()
    await userEvent.keyboard('2')
    await vi.waitFor(() =>
      expect(useToasts.getState().toasts.map((t) => t.message)).toContain('The mode was not changed: bridge gone')
    )
  })

  it('enables Bypass only through the confirm', async () => {
    const onChange = vi.fn()
    render(<ModePicker value="ask" onChange={onChange} />)
    await open()
    await userEvent.click(screen.getByRole('menuitemradio', { name: /Bypass permissions/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Enable Bypass' }))
    expect(onChange).toHaveBeenCalledWith('bypass')
  })

  it('stays visibly on while in Bypass', () => {
    render(<ModePicker value="bypass" onChange={() => {}} />)
    expect(screen.getByTestId('mode-picker').className).toContain('is-bypass')
  })

  it('says when protected targets cap the mode', async () => {
    render(<ModePicker value="auto" onChange={() => {}} protectedCount={2} />)
    await open()
    expect(screen.getByRole('menu').textContent).toContain('Auto and Bypass are capped at Ask first on 2 protected targets.')
  })

  it('works from inside the approval dialog, which paints above every menu', async () => {
    // Mounted in the approval's own layer, or it would open underneath it; and
    // Escape and outside presses still reach it while an approval is showing.
    const onChange = vi.fn()
    render(
      <div className="scrim approval-scrim">
        <button>Deny</button>
        <ModePicker value="auto" onChange={onChange} />
      </div>
    )
    await open()
    const scrim = document.querySelector('.approval-scrim') as HTMLElement
    expect(screen.getByRole('menu').parentElement).toBe(scrim)
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).toBeNull()
    await open()
    await userEvent.click(screen.getByRole('button', { name: 'Deny' }))
    expect(screen.queryByRole('menu')).toBeNull()
    await open()
    await userEvent.keyboard('4')
    expect(screen.getByTestId('bypass-confirm').closest('.approval-scrim')).toBe(scrim)
    expect(onChange).not.toHaveBeenCalled()
  })
})
