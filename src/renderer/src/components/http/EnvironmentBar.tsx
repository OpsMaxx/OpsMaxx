import { useState } from 'react'
import { ChevronDown, ChevronRight, KeyRound, Layers, Lock, Plus, Trash2 } from 'lucide-react'
import { clsx } from '../../lib/format'
import { useVault } from '../../store/vault'
import { isVaultReference, parseVaultReference, vaultReference } from '../../../../shared/apiSecrets'
import type { EnvVariable, EnvironmentsView } from './ScalarClient'

/**
 * Environments, and the variables inside them.
 *
 * Written here rather than mounted from the API client for one reason that is
 * not about style: a secret variable has to be able to hold a VAULT REFERENCE
 * instead of a value, and the client has no concept of one. Its own editor
 * would happily show `vault:8f2c…#password` as the value and invite somebody
 * to replace it with a real token — which is exactly the thing that must not
 * end up in a file.
 *
 * So a secret row shows the vault entry's NAME and a lock, never a value and
 * never a masked value. A mask implies a secret is stored here; it is not.
 */

export function EnvironmentBar({
  view,
  onActivate,
  onCreate,
  onDelete,
  onSetVariable,
  onDeleteVariable
}: {
  view: EnvironmentsView
  onActivate: (name: string) => void
  onCreate: (name: string) => void
  onDelete: (name: string) => void
  onSetVariable: (variable: EnvVariable, index?: number) => void
  onDeleteVariable: (index: number) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [naming, setNaming] = useState(false)
  const [draftName, setDraftName] = useState('')

  const create = (): void => {
    const name = draftName.trim()
    // A duplicate would silently replace the existing environment's variables
    // rather than adding anything.
    if (name === '' || view.names.includes(name)) return
    onCreate(name)
    setDraftName('')
    setNaming(false)
    setOpen(true)
  }

  return (
    <div className="env-bar">
      <div className="env-head">
        <button
          className="btn ghost sm env-toggle"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <Layers size={13} /> Environment
        </button>

        {view.names.length > 0 ? (
          <select
            className="input sm env-select"
            aria-label="Active environment"
            value={view.active}
            onChange={(e) => onActivate(e.target.value)}
          >
            {view.names.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        ) : (
          <span className="faint">
            None yet — an environment holds the values <code>{'{{like_this}}'}</code> in a request.
          </span>
        )}

        {naming ? (
          <input
            className="input sm"
            autoFocus
            aria-label="New environment name"
            placeholder="staging"
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onBlur={() => setNaming(false)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') create()
              if (e.key === 'Escape') setNaming(false)
            }}
          />
        ) : (
          <button className="icon-btn" title="New environment" onClick={() => setNaming(true)}>
            <Plus size={15} />
          </button>
        )}

        {view.active !== '' && (
          <button
            className="icon-btn"
            title={`Delete ${view.active}`}
            onClick={() => onDelete(view.active)}
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>

      {open && view.active !== '' && (
        <VariableTable
          variables={view.variables}
          onSet={onSetVariable}
          onDelete={onDeleteVariable}
        />
      )}
    </div>
  )
}

function VariableTable({
  variables,
  onSet,
  onDelete
}: {
  variables: EnvVariable[]
  onSet: (variable: EnvVariable, index?: number) => void
  onDelete: (index: number) => void
}): React.JSX.Element {
  const [newName, setNewName] = useState('')
  const [newValue, setNewValue] = useState('')

  const add = (): void => {
    const name = newName.trim()
    if (name === '') return
    onSet({ name, value: newValue })
    setNewName('')
    setNewValue('')
  }

  return (
    <div className="env-vars">
      {variables.length === 0 && (
        <p className="kv-empty">
          No variables. Add one and use it as <code>{'{{name}}'}</code> in a URL, a header or a body.
        </p>
      )}
      {variables.map((variable, index) => (
        <VariableRow
          key={`${variable.name}-${index}`}
          variable={variable}
          onChange={(next) => onSet(next, index)}
          onDelete={() => onDelete(index)}
        />
      ))}

      <div className="kv-row env-add">
        <input
          className="input sm"
          placeholder="base_url"
          aria-label="New variable name"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <input
          className="input sm"
          placeholder="https://staging.example.test"
          aria-label="New variable value"
          value={newValue}
          onChange={(e) => setNewValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <button className="btn ghost sm" disabled={newName.trim() === ''} onClick={add}>
          <Plus size={13} /> Add
        </button>
      </div>
    </div>
  )
}

function VariableRow({
  variable,
  onChange,
  onDelete
}: {
  variable: EnvVariable
  onChange: (variable: EnvVariable) => void
  onDelete: () => void
}): React.JSX.Element {
  const entries = useVault((s) => s.entries)
  const unlocked = useVault((s) => s.unlocked)
  const [picking, setPicking] = useState(false)

  const reference = parseVaultReference(variable.value)
  const secret = reference !== null
  const entry = reference ? entries.find((e) => e.id === reference.entryId) : undefined

  return (
    <div className={clsx('kv-row', secret && 'env-secret')}>
      <input
        className="input sm"
        aria-label="Variable name"
        value={variable.name}
        onChange={(e) => onChange({ ...variable, name: e.target.value })}
      />

      {secret ? (
        <span className="env-secret-value" title="Read from the vault when a request is sent">
          <Lock size={12} />
          {/*
            The entry's NAME, never the value and never a masked value. A row
            of dots would say "a secret is stored here", and the entire point
            of the reference is that one is not.
          */}
          {entry ? entry.name : <span className="warn">that vault entry no longer exists</span>}
          {!unlocked && entry && <span className="faint"> — vault locked</span>}
        </span>
      ) : (
        <input
          className="input sm"
          aria-label="Variable value"
          value={variable.value}
          onChange={(e) => onChange({ ...variable, value: e.target.value })}
        />
      )}

      {picking ? (
        <select
          className="input sm"
          autoFocus
          aria-label="Vault entry"
          defaultValue=""
          onBlur={() => setPicking(false)}
          onChange={(e) => {
            setPicking(false)
            if (e.target.value === '') return
            onChange({ ...variable, value: vaultReference(e.target.value) })
          }}
        >
          <option value="">Choose an entry…</option>
          {entries.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
      ) : (
        <button
          className={clsx('icon-btn sm', secret && 'active')}
          title={
            secret
              ? 'Stop reading this from the vault'
              : unlocked
                ? 'Read this value from the vault instead of storing it'
                : 'Unlock the vault to store this value in it'
          }
          disabled={!unlocked && !secret}
          onClick={() => (secret ? onChange({ ...variable, value: '' }) : setPicking(true))}
        >
          <KeyRound size={13} />
        </button>
      )}

      <button className="icon-btn sm" title="Remove" aria-label="Remove variable" onClick={onDelete}>
        <Trash2 size={13} />
      </button>
    </div>
  )
}

/** Whether a stored value is a vault reference. Re-exported for the tests. */
export { isVaultReference }
