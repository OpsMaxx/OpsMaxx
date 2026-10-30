import { useState } from 'react'
import { TriangleAlert } from 'lucide-react'
import type { Id } from '../../../../../shared/apiModel'
import { certificateBlocks } from '../../../../../shared/httpClient'
import { useApi } from '../../../store/api'
import { useHttp, type CollectionSection } from '../../../store/http'
import { Tabs } from '../../common/Tabs'
import { Modal } from '../../common/Modal'
import { AuthEditor } from '../request/AuthEditor'
import { VariablesTable } from '../env/VariablesTable'
import { overrides } from '../env/EnvironmentsTab'
import { countRequests } from '../sidebar/treeMenus'
import { requestImport } from '../HttpSidebar'
import { RouteSelect, collectionRoute, routeFields } from './RouteSelect'
import { useT } from '../../../lib/i18n'
import '../nav.css'

type Section = CollectionSection

const certCount = (pem: string): number => pem.match(/-----BEGIN CERTIFICATE-----/g)?.length ?? 0

type Confirm = { kind: 'tls-off' } | { kind: 'ca'; pem: string }

export interface CollectionTabProps {
  tabId: Id
}

/**
 * A collection's settings, as a workbench tab: Overview · Variables · Auth ·
 * Connection (§2.16). It opens on the section the tab was opened for.
 */
export function CollectionTab({ tabId }: CollectionTabProps): React.JSX.Element {
  const collectionId = useHttp((s) => s.tabs.find((t) => t.id === tabId)?.ref?.collectionId)
  const asked = useHttp((s) => s.collectionSection[tabId])
  const c = useApi((s) => s.collections.find((x) => x.id === collectionId))
  const activeEnv = useApi((s) => {
    const ws = c?.workspaceId ?? ''
    const id = Object.hasOwn(s.workspace.activeEnvironment, ws) ? s.workspace.activeEnvironment[ws] : null
    return s.workspace.environments.find((e) => e.id === id)
  })
  const [section, setSection] = useState<Section>(asked ?? 'overview')
  // A later "open on Connection" for a tab that is already open.
  const [seen, setSeen] = useState(asked)
  if (asked !== seen) {
    setSeen(asked)
    if (asked) setSection(asked)
  }
  const [pasted, setPasted] = useState('')
  const [caError, setCaError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const t = useT()
  if (!c) return <p className="hc-note-line">{t('http.collection.gone')}</p>
  const update = useApi.getState().updateCollection
  const set = (patch: Parameters<typeof update>[1]): void => update(c.id, patch)

  const offerCa = (result: { pem: string } | { error: string } | null): void => {
    if (!result) return
    if ('error' in result) return setCaError(result.error)
    setCaError(null)
    setConfirm({ kind: 'ca', pem: result.pem })
  }

  return (
    <div className="hc-coltab">
      {c.tlsReview && (
        <div className="hc-banner" role="status">
          <TriangleAlert size={13} aria-hidden="true" />
          <span>{t('http.collection.tlsReviewBanner', { name: c.name })}</span>
          <button
            type="button"
            className="btn sm"
            onClick={() => setSection('connection')}
          >
            {t('http.collection.review')}
          </button>
        </div>
      )}
      <Tabs
        ariaLabel={t('http.collection.settingsLabel')}
        idPrefix={`hc-col-${c.id}`}
        tabs={[
          { id: 'overview', label: t('http.collection.overview') },
          { id: 'variables', label: t('http.collection.variables'), count: c.variables.filter((v) => v.enabled).length },
          { id: 'auth', label: t('http.collection.auth'), dot: c.auth.type !== 'none' ? 'set' : undefined },
          { id: 'connection', label: t('http.collection.connection'), dot: c.insecureTls ? 'problem' : undefined }
        ]}
        active={section}
        onChange={(id) => setSection(id as Section)}
      />
      <div className="hc-coltab-body" role="tabpanel" id={`hc-col-${c.id}-panel`} aria-labelledby={`hc-col-${c.id}-tab-${section}`}>
        {section === 'overview' && (
          <>
            <label className="hc-form-row">
              <span className="ui-label">{t('http.collection.name')}</span>
              <input className="hc-input" value={c.name} onChange={(e) => set({ name: e.target.value })} />
            </label>
            <label className="hc-form-col">
              <span className="ui-label">{t('http.collection.description')}</span>
              <textarea className="hc-input hc-textarea" value={c.description ?? ''} onChange={(e) => set({ description: e.target.value })} />
            </label>
            <p className="hc-note-line">
              {t('http.collection.requestCount', { count: countRequests(c.items) })}
            </p>
            {c.importedFrom && (
              <p className="hc-note-line">
                {t('http.collection.importedFrom', { source: c.importedFrom.url ?? c.importedFrom.fileName ?? '' })}{' '}
                <button type="button" className="btn sm" onClick={() => requestImport(c.id)}>
                  {t('http.collection.reimport')}
                </button>
              </p>
            )}
            {c.needsReimport && (
              <p className="hc-warn-line">
                <TriangleAlert size={13} aria-hidden="true" /> {t('http.collection.needsReimport')}
              </p>
            )}
          </>
        )}
        {section === 'variables' && (
          <VariablesTable
            variables={c.variables}
            onChange={(variables) => set({ variables })}
            owner={c.name}
            workspaceId={c.workspaceId}
            overriddenBy={activeEnv && overrides(activeEnv)}
          />
        )}
        {section === 'auth' && (
          <>
            <p className="hc-note-line">{t('http.collection.inheritNote')}</p>
            <AuthEditor
              value={c.auth}
              collectionName={c.name}
              onChange={(auth) => {
                if (auth.type !== 'inherit') set({ auth })
              }}
            />
          </>
        )}
        {section === 'connection' && (
          <>
            {c.tlsReview && (
              <div className="hc-banner" role="note">
                <TriangleAlert size={13} aria-hidden="true" />
                <span>{t('http.collection.tlsReviewHeld', { name: c.name })}</span>
                <button type="button" className="btn primary sm" onClick={() => useApi.getState().acceptTlsReview(c.id)}>
                  {t('http.collection.acceptSettings')}
                </button>
              </div>
            )}
            <label className="hc-form-row">
              <span className="ui-label">{t('http.collection.sendFrom')}</span>
              <RouteSelect value={collectionRoute(c)} onChange={(r) => set(routeFields(r))} />
            </label>
            <label className="hc-form-row">
              <input
                type="checkbox"
                checked={!c.insecureTls}
                onChange={(e) => (e.target.checked ? set({ insecureTls: false }) : setConfirm({ kind: 'tls-off' }))}
              />
              {t('http.collection.verifyCertificates')}
            </label>
            {c.insecureTls && (
              <p className="hc-warn-line">
                <TriangleAlert size={13} aria-hidden="true" /> {t('http.collection.notVerified', { name: c.name })}
              </p>
            )}
            <div className="hc-form-col">
              <span className="ui-label">{t('http.collection.customCa')}</span>
              {c.caPem ? (
                <p className="hc-note-line">
                  {t('http.collection.customCaSet', { count: certCount(c.caPem) })}{' '}
                  <button type="button" className="btn ghost sm" onClick={() => set({ caPem: undefined })}>
                    {t('common.remove')}
                  </button>
                </p>
              ) : (
                <p className="hc-note-line">{t('http.collection.noCustomCa')}</p>
              )}
              <div className="hc-form-row">
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => void window.opsmaxx.http.chooseCaFile().then(offerCa, () => setCaError(t('http.collection.readFileFailed')))}
                >
                  {t('http.collection.chooseFile')}
                </button>
              </div>
              <textarea
                className="hc-input hc-textarea hc-mono"
                aria-label={t('http.collection.pasteCa')}
                placeholder="-----BEGIN CERTIFICATE-----"
                value={pasted}
                onChange={(e) => setPasted(e.target.value)}
              />
              <div className="hc-form-row">
                <button type="button" className="btn sm" disabled={!pasted.trim()} onClick={() => offerCa(certificateBlocks(pasted))}>
                  {t('http.collection.usePasted')}
                </button>
              </div>
              {caError && (
                <p className="hc-error-line" role="alert">
                  {caError}
                </p>
              )}
            </div>
            <label className="hc-form-row">
              <span className="ui-label">{t('http.collection.defaultTimeout')}</span>
              <input
                className="hc-input hc-num"
                type="number"
                min={1}
                max={600}
                placeholder="30"
                value={c.timeoutMs ? c.timeoutMs / 1000 : ''}
                onChange={(e) => {
                  const s = Number(e.target.value)
                  set({ timeoutMs: e.target.value && s > 0 ? Math.min(600, s) * 1000 : undefined })
                }}
              />
            </label>
          </>
        )}
      </div>
      {confirm?.kind === 'tls-off' && (
        <Modal
          title={t('http.collection.stopVerifyingTitle', { name: c.name })}
          onClose={() => setConfirm(null)}
          confirm={{
            label: t('http.collection.stopVerifying'),
            destructive: true,
            onClick: () => {
              set({ insecureTls: true })
              setConfirm(null)
            }
          }}
        >
          <p>{t('http.collection.stopVerifyingBody', { name: c.name })}</p>
        </Modal>
      )}
      {confirm?.kind === 'ca' && (
        <Modal
          title={t('http.collection.trustCaTitle', { name: c.name })}
          onClose={() => setConfirm(null)}
          confirm={{
            label: t('http.collection.trustCa'),
            destructive: true,
            onClick: () => {
              set({ caPem: confirm.pem })
              setPasted('')
              setConfirm(null)
            }
          }}
        >
          <p>
            {certCount(confirm.pem) === 1
              ? t('http.collection.trustCaBodyOne', { name: c.name })
              : t('http.collection.trustCaBodyMany', { name: c.name, count: certCount(confirm.pem) })}
          </p>
        </Modal>
      )}
    </div>
  )
}
