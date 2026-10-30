import { useEffect, useMemo, useRef, useState } from 'react'
import { Copy, Globe, Pencil, Plus, Trash2, TriangleAlert } from 'lucide-react'
import { newId, type Environment, type HostColor, type Id } from '../../../../../shared/apiModel'
import { globalsReviewKey, useApi } from '../../../store/api'
import { useApp } from '../../../store/app'
import { useHttp } from '../../../store/http'
import { Modal } from '../../common/Modal'
import { VariablesTable } from './VariablesTable'
import { t as tr, useT } from '../../../lib/i18n'
import type { MessageKey } from '../../../../../shared/i18n'
import '../nav.css'

export const HOST_COLORS: HostColor[] = ['blue', 'violet', 'pink', 'jade', 'rust', 'olive']
const COLOR_NAME: Record<HostColor, MessageKey> = {
  blue: 'http.envs.color.blue',
  violet: 'http.envs.color.violet',
  pink: 'http.envs.color.pink',
  jade: 'http.envs.color.jade',
  rust: 'http.envs.color.rust',
  olive: 'http.envs.color.olive'
}
export const PROD_NAME = /\bprod(uction)?\b/i

/** Focus the workspace's Environments tab, opening it if needed. */
export const openEnvironmentsTab = (): Id => useHttp.getState().openEnvironments()

/** A new environment in this workspace, Production ticked when the name says so. */
export function newEnvironment(workspaceId: Id, name = tr('http.envs.newName')): Environment {
  return { id: newId('env'), workspaceId, name, color: 'blue', production: PROD_NAME.test(name), variables: [] }
}

const GLOBALS = '__globals'

/** The keys an environment defines, for striking them through in broader scopes. */
export function overrides(env: Environment): { keys: Set<string>; by: string } {
  return {
    keys: new Set(env.variables.filter((v) => v.enabled && v.key).map((v) => v.key)),
    by: tr('http.envs.overriddenByEnv', { name: env.name })
  }
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
  const t = useT()

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
            <Plus size={13} aria-hidden="true" /> {t('http.envs.new')}
          </button>
          <button
            type="button"
            className="hc-icon-btn"
            aria-label={t('http.envs.duplicate')}
            title={t('http.envs.duplicate')}
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
            aria-label={t('http.envs.rename')}
            title={t('http.envs.renameTitle')}
            disabled={!env}
            onClick={() => nameInput.current?.select()}
          >
            <Pencil size={13} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="hc-icon-btn"
            aria-label={t('http.envs.delete')}
            title={t('http.envs.delete')}
            disabled={!env}
            onClick={() => env && setDeleting(env)}
          >
            <Trash2 size={13} aria-hidden="true" />
          </button>
        </div>
        <div role="listbox" aria-label={t('http.envs.label')} className="hc-envs-options">
          <button
            type="button"
            role="option"
            aria-selected={selected === GLOBALS}
            className="hc-envs-option"
            onClick={() => setSelected(GLOBALS)}
          >
            <Globe size={13} aria-hidden="true" /> {t('http.envs.globals')}
            {pending.includes(globalsKey) && <span className="hc-review">{t('http.envs.review')}</span>}
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
              {e.production && <span className="hc-prod">{t('http.envs.prod')}</span>}
              {pending.includes(e.id) && <span className="hc-review">{t('http.envs.review')}</span>}
              {e.id === activeId && <span className="hc-envs-active">{t('http.envs.active')}</span>}
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
              <span className="ui-label">{t('http.envs.name')}</span>
              <input ref={nameInput} className="hc-input" value={env.name} onChange={(e) => rename(env, e.target.value)} />
            </label>
            <div className="hc-form-row" role="radiogroup" aria-label={t('http.envs.colour')}>
              <span className="ui-label">{t('http.envs.colour')}</span>
              {HOST_COLORS.map((c) => (
                <label key={c} className="hc-swatch-pick" title={t(COLOR_NAME[c])}>
                  <input
                    type="radio"
                    name="hc-env-color"
                    aria-label={t(COLOR_NAME[c])}
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
              {t('http.envs.production')}
            </label>
            <label className="hc-form-row">
              <input
                type="checkbox"
                checked={env.id === activeId}
                onChange={(e) => api().setActiveEnvironment(ws, e.target.checked ? env.id : null)}
              />
              {t('http.envs.activeInWorkspace')}
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
            <p className="hc-note-line">{t('http.envs.globalsNote')}</p>
            <VariablesTable
              variables={globals ?? []}
              onChange={(vars) => api().setGlobals(ws, vars)}
              owner={t('http.envs.globals')}
              workspaceId={ws}
              overriddenBy={activeEnv && overrides(activeEnv)}
            />
          </>
        )}
      </div>
      {deleting && (
        <Modal
          title={t('http.envs.deleteTitle', { name: deleting.name })}
          onClose={() => setDeleting(null)}
          confirm={{
            label: t('http.envs.delete'),
            destructive: true,
            onClick: () => {
              api().deleteEnvironment(deleting.id)
              setSelected(GLOBALS)
              setDeleting(null)
            }
          }}
        >
          <p>{t('http.envs.deleteBody', { count: deleting.variables.length })}</p>
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
  const t = useT()
  if (!pending) return null
  const shown = keys.slice(0, 8)
  return (
    <div className="hc-banner" role="note">
      <TriangleAlert size={13} aria-hidden="true" />
      <span>
        {t('http.envs.reviewBanner')}
        {keys.length > 0 && (
          <span className="hc-review-keys">
            {' '}
            {keys.length > shown.length
              ? t('http.envs.reviewKeysMore', {
                  count: keys.length,
                  names: shown.join(', '),
                  more: keys.length - shown.length
                })
              : t('http.envs.reviewKeys', { count: keys.length, names: shown.join(', ') })}
          </span>
        )}
      </span>
      <button type="button" className="btn primary sm" onClick={() => useApi.getState().acceptEnvReview(reviewKey)}>
        {t('http.envs.acceptVariables')}
      </button>
    </div>
  )
}
