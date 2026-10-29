// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ImagePasteConfirm } from '../src/renderer/src/components/terminal/PasteConfirm'

// Ctrl+V and then a reflexive Enter must not send a screenshot nobody looked
// at to a server. Cancel holds the focus, so that Enter declines.

const image = { png: new Uint8Array(2048), width: 800, height: 600, preview: 'data:image/png;base64,' }

describe('copying a clipboard image to a server', () => {
  it('starts with Cancel focused, not the upload', () => {
    render(<ImagePasteConfirm image={image} server="web" onConfirm={vi.fn()} onCancel={vi.fn()} />)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }))
  })

  it('takes an Enter straight after the paste as Cancel', async () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    render(<ImagePasteConfirm image={image} server="web" onConfirm={onConfirm} onCancel={onCancel} />)
    await userEvent.keyboard('{Enter}')
    expect(onConfirm).not.toHaveBeenCalled()
    expect(onCancel).toHaveBeenCalled()
  })

  it('still uploads when the button is pressed on purpose', async () => {
    const onConfirm = vi.fn()
    render(<ImagePasteConfirm image={image} server="web" onConfirm={onConfirm} onCancel={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: /Copy and paste path/ }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })
})
