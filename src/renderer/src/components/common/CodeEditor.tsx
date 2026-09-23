import { useEffect, useRef, type Ref } from 'react'
import { Annotation, Compartment, EditorState, Prec, type Extension } from '@codemirror/state'
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder as placeholderExt
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { bracketMatching, codeFolding, foldGutter, foldKeymap, indentOnInput } from '@codemirror/language'
import { search, searchKeymap } from '@codemirror/search'
import type { VariableScopeChain } from '../../../../shared/apiVariables'
import { editorTheme } from '../../lib/codemirror/theme'
import { languageFor } from '../../lib/codemirror/languages'
import { variableCard, variableDecorations } from '../../lib/codemirror/variables'
import './primitives.css'

export interface CodeEditorProps {
  value: string
  onChange?: (value: string) => void
  language: 'json' | 'xml' | 'html' | 'yaml' | 'text' | Extension
  readOnly?: boolean
  singleLine?: boolean
  wrap?: boolean
  variables?: VariableScopeChain
  onSubmit?: () => void
  /** Return true to take the paste over. */
  onPaste?: (text: string) => boolean
  lint?: Extension
  foldable?: boolean
  placeholder?: string
  ariaLabel: string
  editorRef?: Ref<EditorView>
}

/** The most CodeMirror is ever handed: 2 MiB (§2.11, ARCH-M8). */
export const EDITOR_MAX_CHARS = 2 * 1024 * 1024
/** Above the cap, lines are hard-wrapped at this length. */
export const EDITOR_HARD_WRAP = 4 * 1024

/**
 * The editor's backstop against a text it cannot lay out. Callers that know
 * the size up front (the response pane) window it themselves and say so; this
 * only guarantees CodeMirror never receives more, whoever forgot. A capped
 * editor is read-only, so the window can never be saved over the original.
 */
export function capForEditor(text: string): { text: string; capped: boolean } {
  if (text.length <= EDITOR_MAX_CHARS) return { text, capped: false }
  const out: string[] = []
  for (const line of text.slice(0, EDITOR_MAX_CHARS).split('\n')) {
    if (line.length <= EDITOR_HARD_WRAP) out.push(line)
    else for (let i = 0; i < line.length; i += EDITOR_HARD_WRAP) out.push(line.slice(i, i + EDITOR_HARD_WRAP))
  }
  return { text: out.join('\n'), capped: true }
}

/**
 * A multi-line paste made fit for a one-line field: shell `\` continuations
 * removed, each line trimmed, blank lines dropped, the rest joined by a space.
 */
export function flattenPaste(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\\\n/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\t/g, ' ').trim())
    .filter(Boolean)
    .join(' ')
}

/** Marks a document replacement that came from the `value` prop, not the user. */
const External = Annotation.define<boolean>()

function languageExt(language: CodeEditorProps['language']): Extension {
  return typeof language === 'string' ? languageFor(language) : language
}

function variableExt(chain: VariableScopeChain | undefined): Extension {
  return chain ? [variableDecorations(chain), variableCard(chain)] : []
}

function ariaAttrs(label: string, singleLine: boolean): Extension {
  return EditorView.contentAttributes.of({
    'aria-label': label,
    'aria-multiline': singleLine ? 'false' : 'true'
  })
}

function setRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (typeof ref === 'function') ref(value)
  else if (ref) (ref as { current: T | null }).current = value
}

/**
 * CodeMirror 6, behind the props every HTTP editor shares.
 *
 * Tab is never bound (no `indentWithTab`), so Tab always leaves the editor.
 * Mod-Enter is bound at `Prec.highest` because `defaultKeymap` maps it to
 * insertBlankLine, and ⌘↵ means Send everywhere in the HTTP client.
 */
export function CodeEditor(props: CodeEditorProps): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  // The latest props, read by the handlers built once at mount.
  const latest = useRef(props)
  latest.current = props
  const parts = useRef({
    language: new Compartment(),
    readOnly: new Compartment(),
    wrap: new Compartment(),
    variables: new Compartment(),
    lint: new Compartment(),
    placeholder: new Compartment(),
    aria: new Compartment()
  }).current

  const shown = capForEditor(props.value)
  const readOnly = !!props.readOnly || shown.capped
  const { language, wrap, variables, lint, placeholder, ariaLabel } = props
  const singleLine = !!props.singleLine

  useEffect(() => {
    const p = latest.current
    const extensions: Extension[] = [
      Prec.highest(
        keymap.of([
          {
            key: 'Mod-Enter',
            run: () => {
              const submit = latest.current.onSubmit
              if (!submit) return false
              submit()
              return true
            }
          },
          // A one-line field has no newline to insert; Enter submits.
          ...(singleLine
            ? [
                {
                  key: 'Enter',
                  run: () => {
                    latest.current.onSubmit?.()
                    return true
                  }
                }
              ]
            : [])
        ])
      ),
      history(),
      drawSelection(),
      search({ top: true }),
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, ...(p.foldable ? foldKeymap : [])]),
      editorTheme(),
      bracketMatching(),
      indentOnInput(),
      EditorView.domEventHandlers({
        paste: (e, view) => {
          const text = e.clipboardData?.getData('text/plain') ?? ''
          if (latest.current.onPaste?.(text)) {
            e.preventDefault()
            return true
          }
          if (singleLine && /[\r\n]/.test(text)) {
            e.preventDefault()
            view.dispatch(view.state.replaceSelection(flattenPaste(text)), { userEvent: 'input.paste' })
            return true
          }
          return false
        }
      }),
      EditorView.updateListener.of((u) => {
        if (!u.docChanged || u.transactions.some((tr) => tr.annotation(External))) return
        latest.current.onChange?.(u.state.doc.toString())
      }),
      parts.language.of(languageExt(p.language)),
      parts.readOnly.of(EditorState.readOnly.of(readOnly)),
      parts.wrap.of(p.wrap ? EditorView.lineWrapping : []),
      parts.variables.of(variableExt(p.variables)),
      parts.lint.of(p.lint ?? []),
      parts.placeholder.of(p.placeholder ? placeholderExt(p.placeholder) : []),
      parts.aria.of(ariaAttrs(p.ariaLabel, singleLine))
    ]
    if (singleLine) {
      // A backstop for what the paste handler never sees, such as a drop.
      extensions.push(
        EditorState.transactionFilter.of((tr) =>
          tr.docChanged && tr.newDoc.lines > 1 && !tr.annotation(External) ? [] : tr
        )
      )
    } else {
      extensions.push(lineNumbers(), highlightActiveLine(), highlightActiveLineGutter())
    }
    if (p.foldable) extensions.push(codeFolding(), foldGutter())

    const view = new EditorView({
      state: EditorState.create({ doc: shown.text, extensions }),
      parent: host.current!
    })
    viewRef.current = view
    setRef(p.editorRef, view)
    return () => {
      setRef(latest.current.editorRef, null)
      view.destroy()
      viewRef.current = null
    }
    // Built once. singleLine and foldable are fixed for an editor's life; every
    // other prop is applied through a compartment below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The document follows `value` only when it differs from what the editor
  // holds. The user's own typing was reported through onChange and comes back
  // equal, so this fires only for an external change.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (current === shown.text) return
    view.dispatch({
      changes: { from: 0, to: current.length, insert: shown.text },
      selection: { anchor: Math.min(view.state.selection.main.head, shown.text.length) },
      annotations: External.of(true)
    })
  }, [shown.text])

  const reconfigure = (part: Compartment, ext: Extension): void => {
    viewRef.current?.dispatch({ effects: part.reconfigure(ext) })
  }
  useEffect(() => reconfigure(parts.language, languageExt(language)), [parts, language])
  useEffect(() => reconfigure(parts.readOnly, EditorState.readOnly.of(readOnly)), [parts, readOnly])
  useEffect(() => reconfigure(parts.wrap, wrap ? EditorView.lineWrapping : []), [parts, wrap])
  useEffect(() => reconfigure(parts.variables, variableExt(variables)), [parts, variables])
  useEffect(() => reconfigure(parts.lint, lint ?? []), [parts, lint])
  useEffect(
    () => reconfigure(parts.placeholder, placeholder ? placeholderExt(placeholder) : []),
    [parts, placeholder]
  )
  useEffect(() => reconfigure(parts.aria, ariaAttrs(ariaLabel, singleLine)), [parts, ariaLabel, singleLine])

  return (
    <div
      ref={host}
      className={singleLine ? 'hc-code hc-code--single' : 'hc-code'}
      data-capped={shown.capped || undefined}
    />
  )
}
