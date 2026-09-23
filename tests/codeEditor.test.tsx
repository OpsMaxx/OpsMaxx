// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { createRef } from 'react'
import { render } from '@testing-library/react'
import { runScopeHandlers, type EditorView } from '@codemirror/view'
import {
  CodeEditor,
  EDITOR_HARD_WRAP,
  EDITOR_MAX_CHARS,
  capForEditor,
  flattenPaste
} from '../src/renderer/src/components/common/CodeEditor'

const key = (view: EditorView, init: KeyboardEventInit): boolean =>
  runScopeHandlers(view, new KeyboardEvent('keydown', init), 'editor')

function mount(props: Partial<Parameters<typeof CodeEditor>[0]> = {}): { view: EditorView; onChange: ReturnType<typeof vi.fn> } {
  const ref = createRef<EditorView>()
  const onChange = vi.fn()
  render(<CodeEditor value="ab" language="json" ariaLabel="Body" onChange={onChange} editorRef={ref} {...props} />)
  return { view: ref.current!, onChange }
}

describe('CodeEditor', () => {
  it('sends Mod-Enter to onSubmit instead of inserting a line', () => {
    const onSubmit = vi.fn()
    const { view } = mount({ onSubmit })
    expect(key(view, { key: 'Enter', ctrlKey: true })).toBe(true)
    expect(onSubmit).toHaveBeenCalledOnce()
    expect(view.state.doc.toString()).toBe('ab')
  })

  it('does not capture Tab, so focus can leave the editor', () => {
    const { view } = mount()
    expect(key(view, { key: 'Tab' })).toBe(false)
    expect(key(view, { key: 'Tab', shiftKey: true })).toBe(false)
  })

  it('labels the content for assistive technology', () => {
    const { view } = mount()
    expect(view.contentDOM.getAttribute('aria-label')).toBe('Body')
    expect(view.contentDOM.getAttribute('aria-multiline')).toBe('true')
  })

  it('reports user edits and follows the value prop without echoing it', () => {
    const ref = createRef<EditorView>()
    const onChange = vi.fn()
    const { rerender } = render(<CodeEditor value="a" language="text" ariaLabel="x" onChange={onChange} editorRef={ref} />)
    ref.current!.dispatch({ changes: { from: 1, insert: 'b' } })
    expect(onChange).toHaveBeenLastCalledWith('ab')
    onChange.mockClear()
    rerender(<CodeEditor value="changed elsewhere" language="text" ariaLabel="x" onChange={onChange} editorRef={ref} />)
    expect(ref.current!.state.doc.toString()).toBe('changed elsewhere')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('keeps a single-line editor on one line, and Enter submits', () => {
    const onSubmit = vi.fn()
    const { view } = mount({ singleLine: true, onSubmit, value: 'x' })
    view.dispatch({ changes: { from: 1, insert: '\ny' } })
    expect(view.state.doc.toString()).toBe('x')
    expect(key(view, { key: 'Enter' })).toBe(true)
    expect(onSubmit).toHaveBeenCalledOnce()
  })

  it('makes an over-cap text read-only and hard-wrapped', () => {
    const big = 'x'.repeat(EDITOR_MAX_CHARS + 10)
    const { view } = mount({ value: big })
    expect(view.state.readOnly).toBe(true)
    const capped = capForEditor(big)
    expect(capped.capped).toBe(true)
    expect(capped.text.replace(/\n/g, '').length).toBe(EDITOR_MAX_CHARS)
    expect(Math.max(...capped.text.split('\n').map((l) => l.length))).toBe(EDITOR_HARD_WRAP)
    expect(capForEditor('small')).toEqual({ text: 'small', capped: false })
  })
})

describe('flattenPaste', () => {
  it('joins lines, drops blanks and shell continuations', () => {
    expect(flattenPaste('a\r\n\n  b\t c  \\\n d\n')).toBe('a b  c d')
    expect(flattenPaste('one line')).toBe('one line')
  })
})
