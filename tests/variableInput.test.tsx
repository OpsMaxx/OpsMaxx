// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { runScopeHandlers, EditorView } from '@codemirror/view'
import { VariableInput } from '../src/renderer/src/components/http/fields/VariableInput'
import { lookupVariable, variableAt } from '../src/renderer/src/lib/codemirror/variables'
import type { VariableScopeChain } from '../src/shared/apiVariables'

const v = (key: string, value: string, enabled = true) => ({ id: `var_${key}`, key, value, enabled })
const chain: VariableScopeChain = {
  layers: [
    { scope: 'global', name: 'Globals', variables: [v('baseUrl', 'https://g.example'), v('token', 'g')] },
    { scope: 'collection', name: 'httpbin', variables: [v('baseUrl', 'https://c.example'), v('off', 'x', false)] },
    { scope: 'environment', name: 'staging', variables: [v('baseUrl', 'https://e.example')] }
  ]
}

function view(): EditorView {
  const el = document.querySelector('.cm-editor') as HTMLElement
  return EditorView.findFromDOM(el)!
}

describe('variable lookup', () => {
  it('takes the narrowest enabled definition and names what it overrides', () => {
    expect(lookupVariable(chain, 'baseUrl')).toMatchObject({
      scope: 'environment',
      value: 'https://e.example',
      overridden: ['global', 'collection']
    })
    expect(lookupVariable(chain, 'token')?.scope).toBe('global')
    expect(lookupVariable(chain, 'off')).toBeNull()
    expect(variableAt('a {{ x }} b', 4)).toEqual({ name: 'x', from: 2, to: 9 })
    expect(variableAt('a {{x}} b', 0)).toBeNull()
  })
})

describe('VariableInput', () => {
  it('colours resolved tokens by scope and marks unresolved ones', () => {
    render(<VariableInput value="{{baseUrl}}/{{token}}/{{missing}}" onChange={() => {}} chain={chain} ariaLabel="URL" />)
    const marks = [...document.querySelectorAll('.hc-var')].map((e) => [e.textContent, e.className])
    expect(marks).toEqual([
      ['{{baseUrl}}', 'hc-var hc-var--environment'],
      ['{{token}}', 'hc-var hc-var--global'],
      ['{{missing}}', 'hc-var hc-var--unresolved']
    ])
  })

  it('opens the variable card on Mod-i with the caret in a token, as text', () => {
    render(<VariableInput value="{{baseUrl}}/x" onChange={() => {}} chain={chain} ariaLabel="URL" />)
    const ed = view()
    ed.dispatch({ selection: { anchor: 3 } })
    expect(runScopeHandlers(ed, new KeyboardEvent('keydown', { key: 'i', ctrlKey: true }), 'editor')).toBe(true)
    const card = document.querySelector('.hc-var-card')!
    expect(card.textContent).toContain('https://e.example')
    expect(card.textContent).toContain('From environment staging')
    expect(card.textContent).toContain('overrides global, collection')
    expect(runScopeHandlers(ed, new KeyboardEvent('keydown', { key: 'Escape' }), 'editor')).toBe(true)
    expect(document.querySelector('.hc-var-card')).toBeNull()
  })

  it('says where an unresolved variable is missing', () => {
    render(<VariableInput value="{{nope}}" onChange={() => {}} chain={chain} ariaLabel="URL" />)
    const ed = view()
    ed.dispatch({ selection: { anchor: 2 } })
    runScopeHandlers(ed, new KeyboardEvent('keydown', { key: 'i', ctrlKey: true }), 'editor')
    expect(document.querySelector('.hc-var-card')!.textContent).toContain('Not defined in staging')
  })

  it('marks an invalid field for assistive technology', () => {
    render(<VariableInput value="x" onChange={() => {}} chain={chain} ariaLabel="URL" invalid />)
    expect(view().contentDOM.getAttribute('aria-invalid')).toBe('true')
  })
})
