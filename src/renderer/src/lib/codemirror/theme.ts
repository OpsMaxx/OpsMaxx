import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'

/**
 * The editor theme, built from CSS variables so one object serves light and
 * dark: a theme switch changes the variables and CodeMirror never notices.
 *
 * Syntax colours are the `--host-*` ramp, which is at least 4.5:1 on
 * `--bg-input` and `--bg-panel` in both themes.
 */
export function editorTheme(): Extension {
  return [
    EditorView.theme({
      '&': {
        color: 'var(--text)',
        // A host can set --hc-editor-bg (a key-value cell sits flush).
        backgroundColor: 'var(--hc-editor-bg, var(--bg-input))',
        fontSize: 'var(--fs-identifier)',
        height: '100%'
      },
      '&.cm-focused': { outline: 'none' },
      '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.5' },
      '.cm-content': { caretColor: 'var(--text)' },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--text)' },
      '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
        backgroundColor: 'var(--accent-soft)'
      },
      '.cm-activeLine': { backgroundColor: 'var(--row-hover-veil)' },
      '.cm-gutters': {
        backgroundColor: 'var(--hc-editor-bg, var(--bg-input))',
        color: 'var(--text-faint)',
        border: 'none'
      },
      '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text-muted)' },
      '.cm-foldPlaceholder': {
        backgroundColor: 'var(--bg-hover)',
        border: '1px solid var(--border)',
        color: 'var(--text-muted)'
      },
      '.cm-placeholder': { color: 'var(--text-faint)' },
      '.cm-panels': {
        backgroundColor: 'var(--bg-sidebar)',
        color: 'var(--text)',
        borderColor: 'var(--border)'
      },
      '.cm-searchMatch': { backgroundColor: 'var(--warn-soft)', outline: '1px solid var(--warn)' },
      '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--accent-soft)' },
      '.cm-tooltip': {
        backgroundColor: 'var(--bg-elevated)',
        color: 'var(--text)',
        border: '1px solid var(--border-strong)',
        borderRadius: 'var(--r-sm)'
      },
      '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
        backgroundColor: 'var(--bg-active)',
        color: 'var(--text)'
      }
    }),
    syntaxHighlighting(
      HighlightStyle.define([
        { tag: [t.keyword, t.operatorKeyword, t.modifier], color: 'var(--host-violet)' },
        { tag: [t.string, t.special(t.string)], color: 'var(--host-jade)' },
        { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--host-rust)' },
        { tag: [t.propertyName, t.definition(t.propertyName)], color: 'var(--host-blue)' },
        { tag: [t.tagName, t.typeName], color: 'var(--host-pink)' },
        { tag: [t.attributeName, t.variableName], color: 'var(--host-olive)' },
        { tag: [t.comment, t.meta], color: 'var(--text-faint)', fontStyle: 'italic' },
        { tag: t.invalid, color: 'var(--danger)' }
      ])
    )
  ]
}
