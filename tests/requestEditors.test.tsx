// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { EditorView } from '@codemirror/view'
import { stubBridge } from './setup/renderer'

import { AuthEditor, deadVaultField, isLiteralSecret } from '../src/renderer/src/components/http/request/AuthEditor'
import { HeadersEditor, rowWarning } from '../src/renderer/src/components/http/request/HeadersEditor'
import { useHttp } from '../src/renderer/src/store/http'
import { stripLiteralSecrets } from '../src/shared/apiModel'
import { autoHeadersFor } from '../src/shared/autoHeaders'
import { defaults, type Auth, type Row } from '../src/shared/apiModel'

const chain = { layers: [] }

/** Types into a CodeMirror field (VariableInput) the way a keystroke would. */
function typeInto(name: string, text: string): void {
  const view = EditorView.findFromDOM(screen.getByRole('textbox', { name }))!
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, userEvent: 'input.type' })
}
const row = (id: string, key: string, value: string, enabled = true): Row => ({ id, key, value, enabled })

beforeEach(() => stubBridge({ clipboard: { read: vi.fn().mockResolvedValue('pasted'), write: vi.fn() } }))

describe('isLiteralSecret', () => {
  it.each([
    ['', false],
    ['{{token}}', false],
    ['Bearer {{token}}', false],
    ['vault:ent_1#password', false],
    ['Basic vault:ent_1#password', false],
    ['eyJhbGciOi', true],
    ['Bearer eyJ…{{x}}', true],
    ['{{a}}-literal', true]
  ])('%j → %s', (v, want) => expect(isLiteralSecret(v)).toBe(want))
})

describe('deadVaultField', () => {
  it('names the auth secret field whose vault entry is gone, and nothing else', () => {
    const ids = new Set(['ent_ok'])
    expect(deadVaultField({ type: 'bearer', token: 'vault:gone#password' }, ids)).toBe('token')
    expect(deadVaultField({ type: 'basic', username: 'u', password: 'vault:gone#password' }, ids)).toBe('password')
    expect(deadVaultField({ type: 'apikey', name: 'k', value: 'vault:gone#password', in: 'header' }, ids)).toBe('value')
    expect(deadVaultField({ type: 'bearer', token: 'vault:ent_ok#password' }, ids)).toBeNull()
    expect(deadVaultField({ type: 'bearer', token: '{{token}}' }, ids)).toBeNull()
    expect(deadVaultField({ type: 'inherit' }, ids)).toBeNull()
  })
})

describe('AuthEditor', () => {
  const renderAuth = (value: Auth, extra: Partial<Parameters<typeof AuthEditor>[0]> = {}) => {
    const onChange = vi.fn()
    render(<AuthEditor value={value} onChange={onChange} chain={chain} {...extra} />)
    return onChange
  }

  it('a literal bearer token says it is not saved, with Move to vault', () => {
    const onMove = vi.fn()
    renderAuth({ type: 'bearer', token: 'eyJhbGciOi' }, { onMoveToVault: onMove })
    expect(screen.getByText(/Not saved — kept for this session only/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Move to vault…' }))
    expect(onMove).toHaveBeenCalledWith('token', 'eyJhbGciOi')
  })

  it('a template or vault reference is saved, so no note', () => {
    renderAuth({ type: 'bearer', token: '{{token}}' })
    expect(screen.queryByText(/Not saved/)).toBeNull()
  })

  it('shows "Not kept from last session" for a stripped field, with Paste and Use vault', async () => {
    const onChange = renderAuth({ type: 'basic', username: 'u', password: '' }, { stripped: ['auth.password'], collectionName: 'httpbin' })
    expect(screen.getByText(/Not kept from last session/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Paste' }))
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith({ type: 'basic', username: 'u', password: 'pasted' }))
    fireEvent.click(screen.getByRole('button', { name: 'Use vault…' }))
    expect(screen.getByText('No vault entry chosen')).toBeTruthy()
  })

  it('the key button switches a secret to a vault entry', () => {
    renderAuth({ type: 'apikey', name: 'X-Api-Key', value: '', in: 'header' })
    fireEvent.click(screen.getByRole('button', { name: 'Use a vault entry for the value' }))
    expect(screen.getByText('No vault entry chosen')).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: 'Value' })).toBeNull()
  })

  it('a vault reference opens in vault mode', () => {
    renderAuth({ type: 'bearer', token: 'vault:ent_1#password' })
    expect(screen.getByRole('group', { name: 'Token' })).toBeTruthy()
  })

  it('offers Inherit only when there is a collection, and names what it inherits', () => {
    renderAuth({ type: 'none' })
    expect(screen.queryByRole('option', { name: 'Inherit from collection' })).toBeNull()
  })

  it('names the inherited auth', () => {
    renderAuth({ type: 'inherit' }, { collectionName: 'httpbin', inheritFrom: 'Bearer token' })
    expect(screen.getByText('Uses Bearer token set on httpbin.')).toBeTruthy()
  })

  it('switching type starts from a blank auth of that type', () => {
    const onChange = renderAuth({ type: 'none' })
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'basic' } })
    expect(onChange).toHaveBeenCalledWith({ type: 'basic', username: '', password: '' })
  })

  it('typing a token changes the auth', () => {
    const onChange = renderAuth({ type: 'bearer', token: '' })
    typeInto('Token', '{{token}}')
    expect(onChange).toHaveBeenLastCalledWith({ type: 'bearer', token: '{{token}}' })
  })

  it('read-only shows values as text, with nothing to type into', () => {
    renderAuth({ type: 'basic', username: 'ada', password: '{{pw}}' }, { readOnly: true })
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.getByLabelText('Username').textContent).toBe('ada')
    expect((screen.getByRole('combobox') as HTMLSelectElement).disabled).toBe(true)
  })
})

describe('HeadersEditor', () => {
  it('lists auto headers behind "N hidden", each with its reason; an explicit Content-Type wins', () => {
    const rows = [row('r1', 'Content-Type', 'application/vnd.api+json')]
    const auto = autoHeadersFor({ ...defaults.http(), method: 'POST', url: 'https://h.example/x', body: { mode: 'json', text: '{}' } }, { version: '9', hasCookies: false })
    render(<HeadersEditor rows={rows} onChange={vi.fn()} auto={auto} chain={chain} />)
    fireEvent.click(screen.getByRole('button', { name: '4 hidden' }))
    expect(useHttp.getState().prefs.showAutoHeaders).toBe(true)
    const ct = screen.getByRole('row', { name: /Content-Type application\/json/ })
    expect(ct.className).toContain('hc-replaced')
    expect(ct.textContent).toContain('Replaced by your header')
    expect(screen.getByRole('row', { name: /User-Agent/ }).textContent).toContain('OpsMaxx names itself')
  })

  it('warns on a literal credential, and offers Move to vault', () => {
    const onMove = vi.fn()
    render(
      <HeadersEditor
        rows={[row('r1', 'Authorization', 'Bearer eyJ'), row('r2', 'X-Api-Key', 'k'), row('r3', 'Accept', '*/*')]}
        onChange={vi.fn()}
        chain={chain}
        onMoveToVault={onMove}
      />
    )
    expect(screen.getByRole('img', { name: /Not saved — kept for this session only/ })).toBeTruthy()
    expect(screen.getByRole('img', { name: /Looks like a credential/ })).toBeTruthy()
    expect(screen.getAllByRole('img', { name: /credential|Not saved/ })).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: /^Actions for X-Api-Key/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move to vault…' }))
    expect(onMove).toHaveBeenCalledWith('r2', 'k')
  })
})

describe('Description column (T6)', () => {
  it('the table menu toggles prefs.kvDescriptions', () => {
    render(<HeadersEditor rows={[row('r1', 'Accept', '*/*')]} onChange={vi.fn()} chain={chain} />)
    fireEvent.click(screen.getAllByRole('button', { name: 'Table options' })[0])
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Show description/ }))
    expect(useHttp.getState().prefs.kvDescriptions).toBe(true)
  })
})

describe('the stripped paths are the ones stripLiteralSecrets writes', () => {
  it('an Authorization header and a bearer token, stripped at save, both say so on reopen', () => {
    const { value, stripped } = stripLiteralSecrets({
      ...defaults.http(),
      auth: { type: 'bearer', token: 'eyJliteral' },
      headers: [row('h0', 'Accept', '*/*'), row('h1', 'Authorization', 'Basic dXNlcjpwYXNz')]
    })
    render(<HeadersEditor rows={value.headers} onChange={vi.fn()} chain={chain} stripped={stripped} />)
    expect(screen.getByRole('img', { name: /Not kept from last session/ })).toBeTruthy()
    render(<AuthEditor value={value.auth} onChange={vi.fn()} chain={chain} stripped={stripped} />)
    expect(screen.getByText(/Not kept from last session/)).toBeTruthy()
  })
})

describe('rowWarning', () => {
  it('a disabled or templated row gets nothing', () => {
    expect(rowWarning(row('a', 'token', 'x', false), 'params', 0)).toBeNull()
    expect(rowWarning(row('a', 'token', '{{t}}'), 'params', 0)).toBeNull()
  })
  it('names a stripped row by its section and index, as stripLiteralSecrets does', () => {
    expect(rowWarning(row('a', 'Cookie', ''), 'headers', 2, ['headers.2.value'])).toMatch(/Not kept from last session/)
    expect(rowWarning(row('a', 'Cookie', ''), 'headers', 1, ['headers.2.value'])).toBeNull()
  })
  it('a sensitive query param is kept with a warning, never "not saved"', () => {
    expect(rowWarning(row('a', 'access_token', 'abc'), 'params', 0)).toMatch(/Saved and synced as plain text/)
  })
})
