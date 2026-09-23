import { EditorView } from '@codemirror/view'
import type { VariableScopeChain } from '../../../../../shared/apiVariables'
import { CodeEditor } from '../../common/CodeEditor'

export interface VariableInputProps {
  value: string
  onChange: (value: string) => void
  chain: VariableScopeChain
  placeholder?: string
  ariaLabel: string
  onSubmit?: () => void
  /** Return true to take the paste over. */
  onPaste?: (text: string) => boolean
  invalid?: boolean
}

const INVALID = EditorView.contentAttributes.of({ 'aria-invalid': 'true' })

/**
 * A one-line field that understands `{{var}}`: tokens are coloured by the
 * scope that resolves them and underlined when nothing does, and the variable
 * card opens on hover, on ⌘I, or after the caret rests in a token.
 */
export function VariableInput(props: VariableInputProps): React.JSX.Element {
  return (
    <div className={props.invalid ? 'hc-var-input is-invalid' : 'hc-var-input'}>
      <CodeEditor
        value={props.value}
        onChange={props.onChange}
        language="text"
        singleLine
        variables={props.chain}
        placeholder={props.placeholder}
        ariaLabel={props.ariaLabel}
        onSubmit={props.onSubmit}
        onPaste={props.onPaste}
        lint={props.invalid ? INVALID : undefined}
      />
    </div>
  )
}
