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
  if (!c) return <p className="hc-note-line">This collection no longer exists.</p>
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
          <span>Certificate settings for {c.name} were changed on another device.</span>
          <button
            type="button"
            className="btn sm"
            onClick={() => setSection('connection')}
          >
            Review
          </button>
        </div>
      )}
      <Tabs
        ariaLabel="Collection settings"
        idPrefix={`hc-col-${c.id}`}
        tabs={[
          { id: 'overview', label: 'Overview' },
          { id: 'variables', label: 'Variables', count: c.variables.filter((v) => v.enabled).length },
          { id: 'auth', label: 'Auth', dot: c.auth.type !== 'none' ? 'set' : undefined },
          { id: 'connection', label: 'Connection', dot: c.insecureTls ? 'problem' : undefined }
        ]}
        active={section}
        onChange={(id) => setSection(id as Section)}
      />
      <div className="hc-coltab-body" role="tabpanel" id={`hc-col-${c.id}-panel`} aria-labelledby={`hc-col-${c.id}-tab-${section}`}>
        {section === 'overview' && (
          <>
            <label className="hc-form-row">
              <span className="ui-label">Name</span>
              <input className="hc-input" value={c.name} onChange={(e) => set({ name: e.target.value })} />
            </label>
            <label className="hc-form-col">
              <span className="ui-label">Description</span>
              <textarea className="hc-input hc-textarea" value={c.description ?? ''} onChange={(e) => set({ description: e.target.value })} />
            </label>
            <p className="hc-note-line">
              {countRequests(c.items)} {countRequests(c.items) === 1 ? 'request' : 'requests'}
            </p>
            {c.importedFrom && (
              <p className="hc-note-line">
                Imported from {c.importedFrom.url ?? c.importedFrom.fileName}{' '}
                <button type="button" className="btn sm" onClick={() => requestImport(c.id)}>
                  Re-import
                </button>
              </p>
            )}
            {c.needsReimport && (
              <p className="hc-warn-line">
                <TriangleAlert size={13} aria-hidden="true" /> This collection’s requests have to be re-imported from its spec.
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
            <p className="hc-note-line">Requests set to Inherit use this.</p>
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
                <span>
                  These connection settings came from another device. Requests in {c.name} are held until you accept them.
                </span>
                <button type="button" className="btn primary sm" onClick={() => useApi.getState().acceptTlsReview(c.id)}>
                  Accept these settings
                </button>
              </div>
            )}
            <label className="hc-form-row">
              <span className="ui-label">Send from</span>
              <RouteSelect value={collectionRoute(c)} onChange={(r) => set(routeFields(r))} />
            </label>
            <label className="hc-form-row">
              <input
                type="checkbox"
                checked={!c.insecureTls}
                onChange={(e) => (e.target.checked ? set({ insecureTls: false }) : setConfirm({ kind: 'tls-off' }))}
              />
              Verify certificates
            </label>
            {c.insecureTls && (
              <p className="hc-warn-line">
                <TriangleAlert size={13} aria-hidden="true" /> Certificates are NOT verified for requests in {c.name}.
              </p>
            )}
            <div className="hc-form-col">
              <span className="ui-label">Custom CA</span>
              {c.caPem ? (
                <p className="hc-note-line">
                  Custom CA set ({certCount(c.caPem)} {certCount(c.caPem) === 1 ? 'certificate' : 'certificates'}).{' '}
                  <button type="button" className="btn ghost sm" onClick={() => set({ caPem: undefined })}>
                    Remove
                  </button>
                </p>
              ) : (
                <p className="hc-note-line">None: certificates are checked against the system’s trusted roots.</p>
              )}
              <div className="hc-form-row">
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => void window.opsmaxx.http.chooseCaFile().then(offerCa, () => setCaError('Could not read that file.'))}
                >
                  Choose file…
                </button>
              </div>
              <textarea
                className="hc-input hc-textarea hc-mono"
                aria-label="Paste a CA certificate (PEM)"
                placeholder="-----BEGIN CERTIFICATE-----"
                value={pasted}
                onChange={(e) => setPasted(e.target.value)}
              />
              <div className="hc-form-row">
                <button type="button" className="btn sm" disabled={!pasted.trim()} onClick={() => offerCa(certificateBlocks(pasted))}>
                  Use pasted certificate
                </button>
              </div>
              {caError && (
                <p className="hc-error-line" role="alert">
                  {caError}
                </p>
              )}
            </div>
            <label className="hc-form-row">
              <span className="ui-label">Default timeout (seconds)</span>
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
          title={`Stop verifying certificates for ${c.name}?`}
          onClose={() => setConfirm(null)}
          confirm={{
            label: 'Stop verifying',
            destructive: true,
            onClick: () => {
              set({ insecureTls: true })
              setConfirm(null)
            }
          }}
        >
          <p>
            Every request in {c.name} will accept any certificate, including one presented by somebody intercepting the
            connection. Adding the server’s CA instead keeps the check.
          </p>
        </Modal>
      )}
      {confirm?.kind === 'ca' && (
        <Modal
          title={`Trust this CA for ${c.name}?`}
          onClose={() => setConfirm(null)}
          confirm={{
            label: 'Trust this CA',
            destructive: true,
            onClick: () => {
              set({ caPem: confirm.pem })
              setPasted('')
              setConfirm(null)
            }
          }}
        >
          <p>
            Requests in {c.name} will accept certificates signed by {certCount(confirm.pem) === 1 ? 'this certificate' : `these ${certCount(confirm.pem)} certificates`}, in addition to the system’s roots.
          </p>
        </Modal>
      )}
    </div>
  )
}
