import { useState } from 'react'
import { KeyRound, Type } from 'lucide-react'
import type { Auth } from '../../../../../shared/apiModel'
import type { VariableScopeChain } from '../../../../../shared/apiVariables'
import { VariableInput, type VariableInputProps } from '../fields/VariableInput'
import { VaultValueField } from '../fields/VaultValueField'
import { useT } from '../../../lib/i18n'
import type { MessageKey } from '../../../../../shared/i18n'
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

const TYPES: { type: Auth['type']; labelKey: MessageKey }[] = [
  { type: 'inherit', labelKey: 'http.auth.typeInherit' },
  { type: 'none', labelKey: 'http.auth.typeNone' },
  { type: 'bearer', labelKey: 'http.auth.typeBearer' },
  { type: 'basic', labelKey: 'http.auth.typeBasic' },
  { type: 'apikey', labelKey: 'http.auth.typeApikey' }
]

/** A secret field's name inside a sentence ("Type the password instead"). */
const FIELD_NAME: Record<SecretField, MessageKey> = {
  token: 'http.auth.fieldToken',
  password: 'http.auth.fieldPassword',
  value: 'http.auth.fieldValue'
}

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
  const t = useT()
  const change = (next: Auth): void => {
    if (!readOnly) onChange(next)
  }
  // A scratch request has no collection to inherit from.
  const types = TYPES.filter((x) => x.type !== 'inherit' || collectionName !== undefined || value.type === 'inherit')
  const secret = (field: SecretField, label: string, v: string, set: (next: string) => void): React.JSX.Element => (
    <SecretInput
      label={label}
      fieldName={t(FIELD_NAME[field])}
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
        <span className="ui-label">{t('http.auth.type')}</span>
        <select
          className="hc-select"
          value={value.type}
          disabled={readOnly}
          onChange={(e) => change(blank(e.target.value as Auth['type']))}
        >
          {types.map((x) => (
            <option key={x.type} value={x.type}>
              {t(x.labelKey)}
            </option>
          ))}
        </select>
      </label>

      {value.type === 'inherit' && (
        <p className="hc-note">
          {collectionName
            ? inheritFrom
              ? t('http.auth.usesAuthOn', { auth: inheritFrom, name: collectionName })
              : t('http.auth.usesTheAuthOn', { name: collectionName })
            : t('http.auth.usesCollectionAuth')}
        </p>
      )}
      {value.type === 'none' && <p className="hc-note">{t('http.auth.noCredentials')}</p>}
      {value.type === 'bearer' && secret('token', t('http.auth.token'), value.token, (token) => change({ ...value, token }))}
      {value.type === 'basic' && (
        <>
          <div className="hc-field">
            <span className="ui-label">{t('http.auth.username')}</span>
            <VarField
              readOnly={readOnly}
              value={value.username}
              onChange={(username) => change({ ...value, username })}
              chain={chain}
              ariaLabel={t('http.auth.username')}
            />
          </div>
          {secret('password', t('http.auth.password'), value.password, (password) => change({ ...value, password }))}
        </>
      )}
      {value.type === 'apikey' && (
        <>
          <div className="hc-field">
            <span className="ui-label">{t('http.auth.key')}</span>
            <VarField
              readOnly={readOnly}
              value={value.name}
              onChange={(name) => change({ ...value, name })}
              chain={chain}
              ariaLabel={t('http.auth.keyName')}
              placeholder="X-Api-Key"
            />
          </div>
          {secret('value', t('http.auth.value'), value.value, (v) => change({ ...value, value: v }))}
          <label className="hc-field">
            <span className="ui-label">{t('http.auth.addTo')}</span>
            <select
              className="hc-select"
              value={value.in}
              disabled={readOnly}
              onChange={(e) => change({ ...value, in: e.target.value as 'header' | 'query' })}
            >
              <option value="header">{t('http.auth.addToHeader')}</option>
              <option value="query">{t('http.auth.addToQuery')}</option>
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
  fieldName,
  value,
  onChange,
  chain,
  readOnly,
  stripped,
  onMoveToVault
}: {
  label: string
  fieldName: string
  value: string
  onChange: (v: string) => void
  chain: VariableScopeChain
  readOnly?: boolean
  stripped: boolean
  onMoveToVault?: () => void
}): React.JSX.Element {
  const [vaultMode, setVaultMode] = useState(value.startsWith('vault:'))
  const t = useT()
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
          aria-label={
            vaultMode
              ? t('http.auth.typeInstead', { field: fieldName })
              : t('http.auth.useVaultFor', { field: fieldName })
          }
          title={vaultMode ? t('http.auth.typeValueInstead') : t('http.auth.useVault')}
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
          {t('http.auth.notKept')}{' '}
          <button className="btn quiet sm" onClick={() => void paste()} disabled={readOnly}>
            {t('http.auth.paste')}
          </button>{' '}
          <button className="btn quiet sm" onClick={() => setVaultMode(true)} disabled={readOnly}>
            {t('http.auth.useVaultMenu')}
          </button>
        </p>
      )}
      {!vaultMode && isLiteralSecret(value) && (
        <p className="hc-note hc-warn" role="note">
          {t('http.auth.notSaved')}{' '}
          {onMoveToVault && (
            <button className="btn quiet sm" onClick={onMoveToVault} disabled={readOnly}>
              {t('http.auth.moveToVault')}
            </button>
          )}
        </p>
      )}
    </div>
  )
}
