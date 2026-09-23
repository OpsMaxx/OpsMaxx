import { useEffect, useMemo, useRef, useState } from 'react'
import { Copy, Globe, Pencil, Plus, Trash2, TriangleAlert } from 'lucide-react'
import { newId, type Environment, type HostColor, type Id } from '../../../../../shared/apiModel'
import { globalsReviewKey, useApi } from '../../../store/api'
import { useApp } from '../../../store/app'
import { useHttp } from '../../../store/http'
import { Modal } from '../../common/Modal'
import { VariablesTable } from './VariablesTable'
import '../nav.css'

export const HOST_COLORS: HostColor[] = ['blue', 'violet', 'pink', 'jade', 'rust', 'olive']
export const PROD_NAME = /\bprod(uction)?\b/i

/** Focus the workspace's Environments tab, opening it if needed. */
export const openEnvironmentsTab = (): Id => useHttp.getState().openEnvironments()

/** A new environment in this workspace, Production ticked when the name says so. */
export function newEnvironment(workspaceId: Id, name = 'New environment'): Environment {
  return { id: newId('env'), workspaceId, name, color: 'blue', production: PROD_NAME.test(name), variables: [] }
}

const GLOBALS = '__globals'

/** The keys an environment defines, for striking them through in broader scopes. */
export function overrides(env: Environment): { keys: Set<string>; by: string } {
  return { keys: new Set(env.variables.filter((v) => v.enabled && v.key).map((v) => v.key)), by: `environment ${env.name}` }
}

/**
 * Globals and environments for the active workspace (§2.16). The left list
 * picks one; the right side edits it. Deleting an environment asks first.
 */
export interface EnvironmentsTabProps {
  tabId: Id
}

// The tab id is part of the workbench contract; the tab edits the workspace's
// environments, whichever tab shows them.
export function EnvironmentsTab({ tabId }: EnvironmentsTabProps): React.JSX.Element {
  const ws = useApp((s) => s.activeWorkspaceId)
  const all = useApi((s) => s.workspace.environments)
  const envs = useMemo(() => all.filter((e) => e.workspaceId === ws), [all, ws])
  const globals = useApi((s) => (Object.hasOwn(s.workspace.globals, ws) ? s.workspace.globals[ws] : undefined))
  const activeId = useApi((s) => (Object.hasOwn(s.workspace.activeEnvironment, ws) ? s.workspace.activeEnvironment[ws] : null))
  const pending = useApi((s) => s.envReview)
  const globalsKey = globalsReviewKey(ws)
  /** What needs review first: the active environment, else the globals, else any environment. */
  const firstPending = (): string | null =>
    activeId && pending.includes(activeId)
      ? activeId
      : pending.includes(globalsKey)
        ? GLOBALS
        : (envs.find((e) => pending.includes(e.id))?.id ?? null)
  const [selected, setSelected] = useState<string>(() => firstPending() ?? GLOBALS)
  // Coming to this tab with a review pending (the send refusal's fix opens it)
  // shows what is held, rather than wherever the tab was left.
  const shown = useHttp((s) => s.activeTab[ws] === tabId)
  useEffect(() => {
    if (!shown) return
    const next = firstPending()
    if (next) setSelected(next)
    // Only when the tab comes into view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown])
  const [deleting, setDeleting] = useState<Environment | null>(null)
  const nameInput = useRef<HTMLInputElement>(null)
  const env = envs.find((e) => e.id === selected)
  const activeEnv = envs.find((e) => e.id === activeId)
  const api = useApi.getState

  const create = (): void => {
    const e = newEnvironment(ws)
    api().setEnvironment(e)
    setSelected(e.id)
    requestAnimationFrame(() => nameInput.current?.select())
  }
  const rename = (e: Environment, name: string): void =>
    api().setEnvironment({ ...e, name, production: e.production || (PROD_NAME.test(name) && !PROD_NAME.test(e.name)) })

  return (
    <div className="hc-envs">
      <div className="hc-envs-list">
        <div className="hc-envs-tools">
          <button type="button" className="btn sm" onClick={create}>
            <Plus size={13} aria-hidden="true" /> New
          </button>
          <button
            type="button"
            className="hc-icon-btn"
            aria-label="Duplicate environment"
            title="Duplicate environment"
            disabled={!env}
            onClick={() => {
              const id = env && api().duplicateEnvironment(env.id)
              if (id) setSelected(id)
            }}
          >
            <Copy size={13} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="hc-icon-btn"
            aria-label="Rename environment"
            title="Rename environment (F2)"
            disabled={!env}
            onClick={() => nameInput.current?.select()}
          >
            <Pencil size={13} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="hc-icon-btn"
            aria-label="Delete environment"
            title="Delete environment"
            disabled={!env}
            onClick={() => env && setDeleting(env)}
          >
            <Trash2 size={13} aria-hidden="true" />
          </button>
        </div>
        <div role="listbox" aria-label="Environments" className="hc-envs-options">
          <button
            type="button"
            role="option"
            aria-selected={selected === GLOBALS}
            className="hc-envs-option"
            onClick={() => setSelected(GLOBALS)}
          >
            <Globe size={13} aria-hidden="true" /> Globals
            {pending.includes(globalsKey) && <span className="hc-review">review</span>}
          </button>
          {envs.map((e) => (
            <button
              type="button"
              role="option"
              key={e.id}
              aria-selected={selected === e.id}
              className="hc-envs-option"
              onClick={() => setSelected(e.id)}
              onKeyDown={(k) => {
                if (k.key === 'F2') nameInput.current?.select()
              }}
            >
              <span className={`hc-swatch hc-swatch--${e.color}`} aria-hidden="true" />
              {e.name}
              {e.production && <span className="hc-prod">PROD</span>}
              {pending.includes(e.id) && <span className="hc-review">review</span>}
              {e.id === activeId && <span className="hc-envs-active">active</span>}
            </button>
          ))}
        </div>
      </div>
      <div className="hc-envs-detail">
        <ReviewBanner
          reviewKey={env ? env.id : globalsKey}
          pending={pending.includes(env ? env.id : globalsKey)}
          keys={(env ? env.variables : (globals ?? [])).filter((v) => v.key).map((v) => v.key)}
        />
        {env ? (
          <>
            <label className="hc-form-row">
              <span className="ui-label">Name</span>
              <input ref={nameInput} className="hc-input" value={env.name} onChange={(e) => rename(env, e.target.value)} />
            </label>
            <div className="hc-form-row" role="radiogroup" aria-label="Colour">
              <span className="ui-label">Colour</span>
              {HOST_COLORS.map((c) => (
                <label key={c} className="hc-swatch-pick" title={c}>
                  <input
                    type="radio"
                    name="hc-env-color"
                    aria-label={c}
                    checked={env.color === c}
                    onChange={() => api().setEnvironment({ ...env, color: c })}
                  />
                  <span className={`hc-swatch hc-swatch--${c}`} aria-hidden="true" />
                </label>
              ))}
            </div>
            <label className="hc-form-row">
              <input
                type="checkbox"
                checked={env.production}
                onChange={(e) => api().setEnvironment({ ...env, production: e.target.checked })}
              />
              Production — sending a change here asks first
            </label>
            <label className="hc-form-row">
              <input
                type="checkbox"
                checked={env.id === activeId}
                onChange={(e) => api().setActiveEnvironment(ws, e.target.checked ? env.id : null)}
              />
              Active in this workspace
            </label>
            <VariablesTable
              variables={env.variables}
              onChange={(variables) => api().setEnvironment({ ...env, variables })}
              owner={env.name}
              workspaceId={ws}
            />
          </>
        ) : (
          <>
            <p className="hc-note-line">Globals apply to every request in this workspace. A collection or environment variable of the same name wins.</p>
            <VariablesTable
              variables={globals ?? []}
              onChange={(vars) => api().setGlobals(ws, vars)}
              owner="Globals"
              workspaceId={ws}
              overriddenBy={activeEnv && overrides(activeEnv)}
            />
          </>
        )}
      </div>
      {deleting && (
        <Modal
          title={`Delete ${deleting.name}?`}
          onClose={() => setDeleting(null)}
          confirm={{
            label: 'Delete environment',
            destructive: true,
            onClick: () => {
              api().deleteEnvironment(deleting.id)
              setSelected(GLOBALS)
              setDeleting(null)
            }
          }}
        >
          <p>
            Its {deleting.variables.length} {deleting.variables.length === 1 ? 'variable is' : 'variables are'} deleted with it.
            Requests that use them will stop resolving.
          </p>
        </Modal>
      )}
    </div>
  )
}

/**
 * Variables that arrived by sync are held until reviewed: sends that use them
 * refuse (ENV_REVIEW_MESSAGE). The summary names the variables, never their
 * values; the values are in the table below.
 */
function ReviewBanner({ reviewKey, pending, keys }: { reviewKey: string; pending: boolean; keys: string[] }): React.JSX.Element | null {
  if (!pending) return null
  const shown = keys.slice(0, 8)
  return (
    <div className="hc-banner" role="note">
      <TriangleAlert size={13} aria-hidden="true" />
      <span>
        These variables changed on another device. Requests using them are held until you accept.
        {keys.length > 0 && (
          <span className="hc-review-keys">
            {' '}
            {keys.length} {keys.length === 1 ? 'variable' : 'variables'}: {shown.join(', ')}
            {keys.length > shown.length ? `, and ${keys.length - shown.length} more` : ''}.
          </span>
        )}
      </span>
      <button type="button" className="btn primary sm" onClick={() => useApi.getState().acceptEnvReview(reviewKey)}>
        Accept these variables
      </button>
    </div>
  )
}
