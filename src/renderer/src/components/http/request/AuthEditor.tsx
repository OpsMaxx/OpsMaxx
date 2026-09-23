import { useState } from 'react'
import { KeyRound, Type } from 'lucide-react'
import type { Auth } from '../../../../../shared/apiModel'
import type { VariableScopeChain } from '../../../../../shared/apiVariables'
import { VariableInput, type VariableInputProps } from '../fields/VariableInput'
import { VaultValueField } from '../fields/VaultValueField'
import './request.css'

export interface AuthEditorProps {
  value: Auth
  onChange: (auth: Auth) => void
  /** What Inherit resolves to, for the "Inherits …" line. */
  inheritFrom?: string
  readOnly?: boolean
  collectionName?: string
  /** For `{{var}}` colouring in the fields. */
  chain?: VariableScopeChain
  /** Fields stripped at the last save (`auth.token`, …), shown as "Not kept from last session". */
  stripped?: string[]
  /** "Move to vault…" on a literal secret; absent hides the button. */
  onMoveToVault?: (field: SecretField, value: string) => void
}

export type SecretField = 'token' | 'password' | 'value'

const EMPTY_CHAIN: VariableScopeChain = { layers: [] }

/**
 * A VariableInput, or its value as plain text when the editor is read-only
 * (a connected WebSocket's settings). VariableInput has no read-only mode, and
 * a field that took keystrokes it then dropped would look like it saved them.
 */
export function VarField({ readOnly, ...props }: VariableInputProps & { readOnly?: boolean }): React.JSX.Element {
  return readOnly ? (
    <span className="hc-ro-value" aria-label={props.ariaLabel}>
      {props.value}
    </span>
  ) : (
    <VariableInput {...props} />
  )
}

/**
 * True when a value would be stripped at save: something is left after taking
 * out every `{{name}}`, every `vault:` reference, and a leading auth scheme.
 * `Bearer {{token}}` is a template and is kept; `Bearer eyJ…` is a secret.
 */
export function isLiteralSecret(value: string): boolean {
  const rest = value
    .replace(/\{\{[^{}]*\}\}/g, '')
    .replace(/vault:[A-Za-z0-9_-]+#(?:password|username)/g, '')
    .replace(/^\s*(?:Bearer|Basic|Token)\b/i, '')
  return rest.trim() !== ''
}

/**
 * The auth secret field holding a vault reference to an entry that no longer
 * exists, if any: that is where "Choose another vault entry" should land.
 */
export function deadVaultField(auth: Auth, entryIds: ReadonlySet<string>): SecretField | null {
  const field: SecretField | null =
    auth.type === 'bearer' ? 'token' : auth.type === 'basic' ? 'password' : auth.type === 'apikey' ? 'value' : null
  if (!field) return null
  const id = /vault:([A-Za-z0-9_-]+)#/.exec((auth as unknown as Record<SecretField, string>)[field])?.[1]
  return id && !entryIds.has(id) ? field : null
}

const TYPES: { type: Auth['type']; label: string }[] = [
  { type: 'inherit', label: 'Inherit from collection' },
  { type: 'none', label: 'No auth' },
  { type: 'bearer', label: 'Bearer token' },
  { type: 'basic', label: 'Basic' },
  { type: 'apikey', label: 'API key' }
]

function blank(type: Auth['type']): Auth {
  switch (type) {
    case 'bearer':
      return { type, token: '' }
    case 'basic':
      return { type, username: '', password: '' }
    case 'apikey':
      return { type, name: '', value: '', in: 'header' }
    default:
      return { type }
  }
}

export function AuthEditor({
  value,
  onChange,
  inheritFrom,
  readOnly,
  collectionName,
  chain = EMPTY_CHAIN,
  stripped = [],
  onMoveToVault
}: AuthEditorProps): React.JSX.Element {
  const change = (next: Auth): void => {
    if (!readOnly) onChange(next)
  }
  // A scratch request has no collection to inherit from.
  const types = TYPES.filter((t) => t.type !== 'inherit' || collectionName !== undefined || value.type === 'inherit')
  const secret = (field: SecretField, label: string, v: string, set: (next: string) => void): React.JSX.Element => (
    <SecretInput
      label={label}
      value={v}
      onChange={set}
      chain={chain}
      readOnly={readOnly}
      stripped={stripped.includes(`auth.${field}`)}
      onMoveToVault={onMoveToVault && (() => onMoveToVault(field, v))}
    />
  )

  return (
    <div className="hc-auth">
      <label className="hc-field">
        <span className="ui-label">Type</span>
        <select
          className="hc-select"
          value={value.type}
          disabled={readOnly}
          onChange={(e) => change(blank(e.target.value as Auth['type']))}
        >
          {types.map((t) => (
            <option key={t.type} value={t.type}>
              {t.label}
            </option>
          ))}
        </select>
      </label>

      {value.type === 'inherit' && (
        <p className="hc-note">
          {collectionName
            ? `Uses ${inheritFrom ?? 'the auth'} set on ${collectionName}.`
            : 'Uses the auth set on the collection.'}
        </p>
      )}
      {value.type === 'none' && <p className="hc-note">This request sends no credentials.</p>}
      {value.type === 'bearer' && secret('token', 'Token', value.token, (token) => change({ ...value, token }))}
      {value.type === 'basic' && (
        <>
          <div className="hc-field">
            <span className="ui-label">Username</span>
            <VarField
              readOnly={readOnly}
              value={value.username}
              onChange={(username) => change({ ...value, username })}
              chain={chain}
              ariaLabel="Username"
            />
          </div>
          {secret('password', 'Password', value.password, (password) => change({ ...value, password }))}
        </>
      )}
      {value.type === 'apikey' && (
        <>
          <div className="hc-field">
            <span className="ui-label">Key</span>
            <VarField
              readOnly={readOnly}
              value={value.name}
              onChange={(name) => change({ ...value, name })}
              chain={chain}
              ariaLabel="Key name"
              placeholder="X-Api-Key"
            />
          </div>
          {secret('value', 'Value', value.value, (v) => change({ ...value, value: v }))}
          <label className="hc-field">
            <span className="ui-label">Add to</span>
            <select
              className="hc-select"
              value={value.in}
              disabled={readOnly}
              onChange={(e) => change({ ...value, in: e.target.value as 'header' | 'query' })}
            >
              <option value="header">Header</option>
              <option value="query">Query parameter</option>
            </select>
          </label>
        </>
      )}
    </div>
  )
}

/**
 * A secret field: typed (with `{{vars}}`) or a vault entry, switched by the
 * key button. A typed literal is sent but never saved, and says so.
 */
function SecretInput({
  label,
  value,
  onChange,
  chain,
  readOnly,
  stripped,
  onMoveToVault
}: {
  label: string
  value: string
  onChange: (v: string) => void
  chain: VariableScopeChain
  readOnly?: boolean
  stripped: boolean
  onMoveToVault?: () => void
}): React.JSX.Element {
  const [vaultMode, setVaultMode] = useState(value.startsWith('vault:'))
  const lower = label.toLowerCase()
  const paste = async (): Promise<void> => onChange(await window.opsmaxx.clipboard.read())

  return (
    <div className="hc-field">
      <span className="ui-label">{label}</span>
      <div className="hc-secret">
        <div className="hc-secret-input">
          {vaultMode ? (
            <VaultValueField value={value} onChange={onChange} allowLiteral={false} ariaLabel={label} />
          ) : (
            <VarField readOnly={readOnly} value={value} onChange={onChange} chain={chain} ariaLabel={label} />
          )}
        </div>
        <button
          className="btn ghost sm"
          disabled={readOnly}
          aria-pressed={vaultMode}
          aria-label={vaultMode ? `Type the ${lower} instead` : `Use a vault entry for the ${lower}`}
          title={vaultMode ? 'Type a value instead' : 'Use a vault entry'}
          onClick={() => {
            setVaultMode(!vaultMode)
            onChange('')
          }}
        >
          {vaultMode ? <Type size={14} /> : <KeyRound size={14} />}
        </button>
      </div>
      {stripped && value === '' && (
        <p className="hc-note hc-warn" role="note">
          Not kept from last session.{' '}
          <button className="btn quiet sm" onClick={() => void paste()} disabled={readOnly}>
            Paste
          </button>{' '}
          <button className="btn quiet sm" onClick={() => setVaultMode(true)} disabled={readOnly}>
            Use vault…
          </button>
        </p>
      )}
      {!vaultMode && isLiteralSecret(value) && (
        <p className="hc-note hc-warn" role="note">
          Not saved — kept for this session only.{' '}
          {onMoveToVault && (
            <button className="btn quiet sm" onClick={onMoveToVault} disabled={readOnly}>
              Move to vault…
            </button>
          )}
        </p>
      )}
    </div>
  )
}
