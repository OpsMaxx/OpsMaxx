import { useMemo } from 'react'
import { Lock } from 'lucide-react'
import type { Id } from '../../../../../shared/apiModel'
import type { VariableScope } from '../../../../../shared/apiVariables'
import { isVaultReference } from '../../../../../shared/apiSecrets'
import { VARIABLE_TOKEN, lookupVariable } from '../../../lib/codemirror/variables'
import { useApi } from '../../../store/api'
import { useHttp } from '../../../store/http'
import { Popover } from '../../common/Popover'
import { setVariable } from '../dialogs/SetVariableDialog'
import { vaultLabel } from '../fields/VaultValueField'

/** Every `{{name}}` a request refers to, in order of first use. */
export function referencedVariables(value: unknown): string[] {
  const seen = new Set<string>()
  for (const m of JSON.stringify(value ?? '').matchAll(VARIABLE_TOKEN)) seen.add(m[1])
  return [...seen]
}

const SCOPE: Record<VariableScope, string> = { environment: 'environment', collection: 'collection', global: 'global' }

/**
 * "Variables in this request…": each variable the tab uses, what it resolves
 * to (a vault entry by name, never its value), where from, and an inline
 * edit. An unresolved one offers where to add it.
 */
export function VariablesPopover({
  tabId,
  anchor,
  onClose
}: {
  tabId: Id
  anchor: DOMRect | null
  onClose: () => void
}): React.JSX.Element | null {
  const tab = useHttp((s) => s.tabs.find((t) => t.id === tabId) ?? Object.values(s.ghost).find((g) => g.id === tabId))
  const collections = useApi((s) => s.collections)
  const workspace = useApi((s) => s.workspace)
  const request = tab?.draft ?? (tab?.ref?.requestId ? useApi.getState().findRequest(tab.ref.collectionId, tab.ref.requestId) : null)
  // Recomputed when anything it reads from changes.
  const chain = useMemo(
    () => (tab ? useApi.getState().scopeChainFor(tab) : { layers: [] }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tab, collections, workspace]
  )
  if (!tab) return null
  const names = referencedVariables(request)
  const where = { workspaceId: tab.workspaceId, collectionId: tab.ref?.collectionId }
  const hasEnv = chain.layers.some((l) => l.scope === 'environment')
  return (
    <Popover anchor={anchor} open={anchor !== null} onClose={onClose} ariaLabel="Variables in this request">
      <div className="hc-vars-pop">
        <h3 className="ui-label">Variables in this request</h3>
        {names.length === 0 && <p className="hc-note-line">This request uses no variables.</p>}
        <ul>
          {names.map((name) => {
            const hit = lookupVariable(chain, name)
            return (
              <li key={name} className="hc-vars-row">
                <span className="hc-mono hc-vars-name">{`{{${name}}}`}</span>
                {!hit ? (
                  <span className="hc-vars-add">
                    <span className="hc-vars-missing">Not defined. Add to:</span>
                    {hasEnv && (
                      <button type="button" className="btn ghost sm" onClick={() => setVariable('environment', name, '', where)}>
                        environment
                      </button>
                    )}
                    {tab.ref && (
                      <button type="button" className="btn ghost sm" onClick={() => setVariable('collection', name, '', where)}>
                        collection
                      </button>
                    )}
                    <button type="button" className="btn ghost sm" onClick={() => setVariable('global', name, '', where)}>
                      global
                    </button>
                  </span>
                ) : isVaultReference(hit.value) ? (
                  <span className="hc-vars-value">
                    <Lock size={12} aria-hidden="true" /> {vaultLabel(hit.value)?.name}
                  </span>
                ) : (
                  <input
                    className="hc-input hc-mono hc-vars-value"
                    aria-label={`Value of ${name}, from ${SCOPE[hit.scope]}`}
                    value={hit.value}
                    onChange={(e) => setVariable(hit.scope, name, e.target.value, where)}
                  />
                )}
                {hit && <span className="hc-vars-scope">{SCOPE[hit.scope]}</span>}
              </li>
            )
          })}
        </ul>
      </div>
    </Popover>
  )
}
