import { useMemo, useState } from 'react'
import {
  isSensitiveName,
  newId,
  type ApiCollectionV2,
  type Id,
  type Item,
  type Row,
  type Variable
} from '../../../../../shared/apiModel'
import { isVaultReference } from '../../../../../shared/apiSecrets'
import { VARIABLE_TOKEN } from '../../../lib/codemirror/variables'
import { useApi } from '../../../store/api'
import { KeyValueTable } from '../../common/KeyValueTable'
import { VaultValueField } from '../fields/VaultValueField'
import { MoveToVaultDialog } from '../dialogs/MoveToVaultDialog'

export const CREDENTIAL_WARNING = 'Sent as a credential; saved and synced as plain text. Move it to the vault from the row menu.'

const namesIn = (text: string, into: Set<string>): void => {
  for (const m of text.matchAll(VARIABLE_TOKEN)) into.add(m[1])
}

/**
 * Variable names a workspace's requests send as credentials: referenced
 * from an auth secret field, or from a header or param whose name is
 * sensitive (§3.5).
 */
export function credentialVariables(collections: ApiCollectionV2[]): Set<string> {
  const out = new Set<string>()
  const auth = (a: { type: string; token?: string; password?: string; value?: string }): void => {
    for (const v of [a.token, a.password, a.value]) if (v) namesIn(v, out)
  }
  const rows = (list: Row[]): void => {
    for (const r of list) if (isSensitiveName(r.key)) namesIn(r.value, out)
  }
  const walk = (items: Item[]): void => {
    for (const i of items) {
      if (i.kind === 'folder') walk(i.items)
      else {
        auth(i.auth)
        rows(i.headers)
        if (i.kind !== 'graphql') rows(i.params)
      }
    }
  }
  for (const c of collections) {
    auth(c.auth)
    walk(c.items)
  }
  return out
}

/** A literal (not empty, not a vault reference, not only `{{…}}`). */
export function isLiteral(value: string): boolean {
  return value.replace(VARIABLE_TOKEN, '').trim() !== '' && !isVaultReference(value)
}

const toRow = (v: Variable): Row => ({ id: v.id, enabled: v.enabled, key: v.key, value: v.value })
const toVar = (r: Row): Variable => ({ id: r.id || newId('var'), enabled: r.enabled, key: r.key, value: r.value })

/**
 * Variables for one scope, in a KeyValueTable: a value is typed or read from
 * the vault, and a credential kept as a literal is flagged, with Move to vault
 * in the row menu.
 */
export function VariablesTable({
  variables,
  onChange,
  owner,
  workspaceId,
  overriddenBy
}: {
  variables: Variable[]
  onChange: (vars: Variable[]) => void
  /** Names the vault entry: "<owner> · <key>". */
  owner: string
  workspaceId: Id
  /** Keys a narrower scope also defines, and that scope's name: shown struck through. */
  overriddenBy?: { keys: ReadonlySet<string>; by: string }
}): React.JSX.Element {
  const collections = useApi((s) => s.collections)
  const credentials = useMemo(
    () => credentialVariables(collections.filter((c) => c.workspaceId === workspaceId)),
    [collections, workspaceId]
  )
  const [moving, setMoving] = useState<Row | null>(null)
  const rows = variables.map(toRow)
  const warn = (r: Row): boolean => isLiteral(r.value) && (credentials.has(r.key) || isSensitiveName(r.key))
  return (
    <>
      <KeyValueTable
        kind="vars"
        rows={rows}
        showDescription={false}
        onChange={(next) => onChange(next.map(toVar))}
        valueCell={(row, onValue) => {
          const field = (
            <VaultValueField value={row.value} onChange={onValue} allowLiteral ariaLabel={`Value, ${row.key || 'variable'}`} />
          )
          return overriddenBy?.keys.has(row.key) ? (
            <span className="hc-overridden" title={`Overridden by ${overriddenBy.by}`}>
              {field}
              <span className="hc-sr-only">, overridden by {overriddenBy.by}</span>
            </span>
          ) : (
            field
          )
        }}
        warnFor={(r) => (warn(r) ? CREDENTIAL_WARNING : null)}
        extraRowMenu={(r) => (warn(r) ? [{ label: 'Move to vault…', onClick: () => setMoving(r) }] : [])}
      />
      {moving && (
        <MoveToVaultDialog
          defaultName={`${owner} · ${moving.key}`}
          value={moving.value}
          onClose={() => setMoving(null)}
          onMoved={(ref) => onChange(variables.map((v) => (v.id === moving.id ? { ...v, value: ref } : v)))}
        />
      )}
    </>
  )
}
