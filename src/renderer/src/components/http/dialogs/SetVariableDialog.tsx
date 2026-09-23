import { useState } from 'react'
import { isSensitiveName, newId, type Id, type Variable } from '../../../../../shared/apiModel'
import { isVaultReference } from '../../../../../shared/apiSecrets'
import type { VariableScope } from '../../../../../shared/apiVariables'
import { useApi } from '../../../store/api'
import { useApp } from '../../../store/app'
import { Field, Modal } from '../../common/Modal'
import { MoveToVaultDialog } from './MoveToVaultDialog'
import '../nav.css'

const NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/

/** A JWT, or an Authorization-style value: what a login response hands back. */
const TOKEN = /^(eyJ[\w-]+\.[\w-]+\.[\w-]*|(Bearer|Basic|Token)\s+\S{8,})$/i

/**
 * Whether a value about to become a variable is a credential: its name says
 * so (isSensitiveName), or it looks like a token. A vault reference is not.
 */
export function looksLikeCredential(name: string, value: string): boolean {
  const v = value.trim()
  if (!v || isVaultReference(v)) return false
  return isSensitiveName(name) || TOKEN.test(v)
}

/** The active environment of a workspace, if any. */
export function activeEnvironment(wsId: Id): Id | null {
  const map = useApi.getState().workspace.activeEnvironment
  return Object.hasOwn(map, wsId) ? map[wsId] : null
}

const upsert = (vars: Variable[], key: string, value: string): Variable[] =>
  vars.some((v) => v.key === key)
    ? vars.map((v) => (v.key === key ? { ...v, value, enabled: true } : v))
    : [...vars, { id: newId('var'), key, value, enabled: true }]

/** Set `key` in one scope, adding it if it is not there. */
export function setVariable(
  scope: VariableScope,
  key: string,
  value: string,
  where: { workspaceId: Id; collectionId?: Id }
): void {
  const api = useApi.getState()
  if (scope === 'global') {
    const globals = Object.hasOwn(api.workspace.globals, where.workspaceId) ? api.workspace.globals[where.workspaceId] : []
    api.setGlobals(where.workspaceId, upsert(globals, key, value))
  } else if (scope === 'collection') {
    const c = api.collections.find((x) => x.id === where.collectionId)
    if (c) api.updateCollection(c.id, { variables: upsert(c.variables, key, value) })
  } else {
    const env = api.workspace.environments.find((e) => e.id === activeEnvironment(where.workspaceId))
    if (env) api.setEnvironment({ ...env, variables: upsert(env.variables, key, value) })
  }
}

/**
 * "Set as variable…" (§2.6): from a URL selection or a response value.
 * Environment is offered only while one is active, collection only for a
 * saved request.
 */
export function SetVariableDialog({
  initialName = '',
  value: initialValue,
  collectionId,
  onClose
}: {
  initialName?: string
  value: string
  collectionId?: Id
  onClose: () => void
}): React.JSX.Element {
  const ws = useApp((s) => s.activeWorkspaceId)
  const envId = useApi((s) => (Object.hasOwn(s.workspace.activeEnvironment, ws) ? s.workspace.activeEnvironment[ws] : null))
  const env = useApi((s) => s.workspace.environments.find((e) => e.id === envId))
  const collection = useApi((s) => s.collections.find((c) => c.id === collectionId))
  const [name, setName] = useState(initialName)
  const [value, setValue] = useState(initialValue)
  const [scope, setScope] = useState<VariableScope>(env ? 'environment' : collection ? 'collection' : 'global')
  const [vaulting, setVaulting] = useState(false)
  const secret = looksLikeCredential(name, value)
  const nameError = name && !NAME.test(name) ? 'Letters, digits, _ . and -, starting with a letter or _.' : null
  const commit = (v: string): void => {
    setVariable(scope, name, v, { workspaceId: ws, collectionId })
    onClose()
  }
  const scopes: { id: VariableScope; label: string; off: boolean }[] = [
    { id: 'environment', label: env ? `Environment (${env.name})` : 'Environment (none active)', off: !env },
    { id: 'collection', label: collection ? `Collection (${collection.name})` : 'Collection (not saved)', off: !collection },
    { id: 'global', label: 'Globals', off: false }
  ]
  return (
    <Modal
      title="Set as variable"
      onClose={onClose}
      confirm={{
        label: 'Set variable',
        disabled: !name || !!nameError,
        onClick: () => commit(value)
      }}
      footer={
        secret ? (
          <button type="button" className="btn" disabled={!name || !!nameError} onClick={() => setVaulting(true)}>
            Store in vault…
          </button>
        ) : undefined
      }
    >
      <Field label="Name" error={nameError}>
        <input className="input hc-mono" value={name} autoFocus onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Value">
        <input className="input hc-mono" value={value} onChange={(e) => setValue(e.target.value)} />
      </Field>
      {secret && (
        <p className="hc-warn-line" role="note">
          This looks like a credential. As a variable it is saved and synced as plain text; Store in vault keeps only a
          reference to it.
        </p>
      )}
      <div role="radiogroup" aria-label="Scope" className="hc-dest-list">
        {scopes.map((s) => (
          <label key={s.id} className="hc-dest">
            <input
              type="radio"
              name="hc-var-scope"
              checked={scope === s.id}
              disabled={s.off}
              onChange={() => setScope(s.id)}
            />{' '}
            {s.label}
          </label>
        ))}
      </div>
      {vaulting && (
        <MoveToVaultDialog
          defaultName={`${scopes.find((x) => x.id === scope)?.label ?? 'Variable'} · ${name}`}
          value={value}
          onClose={() => setVaulting(false)}
          onMoved={(ref) => commit(ref)}
        />
      )}
    </Modal>
  )
}
