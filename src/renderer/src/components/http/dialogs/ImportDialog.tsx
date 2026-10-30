import { useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Field, Modal } from '../../common/Modal'
import { useApp, useWorkspaceServers } from '../../../store/app'
import { useApi } from '../../../store/api'
import { useHttp } from '../../../store/http'
import { clsx } from '../../../lib/format'
import { sshTargetFor } from '../../../lib/ssh'
import { parseCurl } from '../../../../../shared/curl'
import { parseOpenApi } from '../../../../../shared/openapiImport'
import { requestsFromOpenApi, type OpenApi3Doc } from '../../../../../shared/apiOpenApi'
import { stableId, type Id, type Item, type Route } from '../../../../../shared/apiModel'
// `importedFrom.url` syncs: no userinfo and no credential-named query parameter in it.
import { withoutCredentials } from '../../../../../shared/apiUrl'
import type { HttpVia } from '../../../../../shared/httpClient'
import { useT } from '../../../lib/i18n'

/**
 * Import: a cURL command, or an OpenAPI description from a URL or a file.
 *
 * Everything the far end wrote — titles, summaries, notes — is rendered as
 * text nodes. A spec URL is fetched through `http:request` on the route the
 * user picks, like any other request; nothing here reads a file itself, and a
 * picked file's path is reduced to its basename before anything keeps it.
 */
export interface ImportDialogProps {
  onClose: () => void
  initialTab?: 'curl' | 'openapi'
  /** Re-import into this collection: its items are replaced after a confirm. */
  reimportInto?: Id
}

type Parsed = { doc: OpenApi3Doc; externalRefs: number; source: { url?: string; fileName?: string } }

const countRequests = (items: Item[]): number =>
  items.reduce((n, i) => n + (i.kind === 'folder' ? countRequests(i.items) : 1), 0)

/** The route key a `<select>` holds, and back. */
const routeKey = (r: Route): string => (r.kind === 'direct' ? 'direct' : r.kind === 'server' ? `server:${r.serverId}` : `vpn:${r.vpnProfileId}`)
function routeFrom(key: string): Route {
  if (key.startsWith('server:')) return { kind: 'server', serverId: key.slice(7) }
  if (key.startsWith('vpn:')) return { kind: 'vpn', vpnProfileId: key.slice(4) }
  return { kind: 'direct' }
}

export function ImportDialog({ onClose, initialTab = 'curl', reimportInto }: ImportDialogProps): React.JSX.Element {
  const [tab, setTab] = useState<'curl' | 'openapi'>(reimportInto ? 'openapi' : initialTab)
  const t = useT()
  return (
    <Modal title={t('http.import.title')} onClose={onClose} size="lg" cancelLabel={t('common.close')}>
      {!reimportInto && (
        <div className="segment" role="tablist" aria-label={t('http.import.from')}>
          {(['curl', 'openapi'] as const).map((k) => (
            <button
              key={k}
              role="tab"
              aria-selected={tab === k}
              className={clsx('seg-btn', tab === k && 'active')}
              onClick={() => setTab(k)}
            >
              {k === 'curl' ? 'cURL' : 'OpenAPI'}
            </button>
          ))}
        </div>
      )}
      {tab === 'curl' ? <CurlTab onDone={onClose} /> : <OpenApiTab onDone={onClose} reimportInto={reimportInto} />}
    </Modal>
  )
}

function CurlTab({ onDone }: { onDone: () => void }): React.JSX.Element {
  const [text, setText] = useState('')
  const [target, setTarget] = useState('')
  const workspaceId = useApp((s) => s.activeWorkspaceId)
  const collections = useApi(useShallow((s) => s.collectionsIn(workspaceId)))
  const parsed = useMemo(() => (text.trim() ? parseCurl(text) : null), [text])
  const request = parsed?.ok ? parsed.request : null
  const t = useT()

  return (
    <>
      <Field
        label={t('http.import.curlCommand')}
        error={parsed && !parsed.ok ? parsed.error : undefined}
        hint={t('http.import.curlHint')}
      >
        <textarea
          className="input mono"
          rows={8}
          value={text}
          autoFocus
          spellCheck={false}
          aria-label={t('http.import.curlCommand')}
          placeholder="curl https://api.example.com/items -H 'Accept: application/json'"
          onChange={(e) => setText(e.target.value)}
        />
      </Field>
      {request && (
        <div aria-label={t('http.import.preview')}>
          <div className="mono">
            {request.method} {request.url}
          </div>
          <div className="field-hint">
            {request.auth.type !== 'none'
              ? t('http.import.summaryAuth', {
                  count: request.headers.length,
                  mode: request.body.mode,
                  auth: request.auth.type
                })
              : t('http.import.summary', { count: request.headers.length, mode: request.body.mode })}
          </div>
          {parsed?.ok && parsed.notes.length > 0 && (
            <ul aria-label={t('http.import.notes')}>
              {parsed.notes.map((n) => (
                <li key={n} className="field-hint">
                  {n}
                </li>
              ))}
            </ul>
          )}
          <div className="row" style={{ gap: 'var(--sp-2)', marginTop: 'var(--sp-3)' }}>
            <button
              className="btn primary size-28"
              onClick={() => {
                useHttp.getState().openScratch('http', request)
                onDone()
              }}
            >
              {t('http.import.openInNewTab')}
            </button>
            <select
              className="input"
              aria-label={t('http.import.saveToCollection')}
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            >
              <option value="">{t('http.import.saveToOption')}</option>
              {collections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <button
              className="btn secondary size-28"
              disabled={!target}
              onClick={() => {
                useApi.getState().addItem(target, null, request)
                useHttp.getState().openRequest({ collectionId: target, requestId: request.id })
                onDone()
              }}
            >
              {t('common.save')}
            </button>
          </div>
        </div>
      )}
    </>
  )
}

function OpenApiTab({ onDone, reimportInto }: { onDone: () => void; reimportInto?: Id }): React.JSX.Element {
  const workspaceId = useApp((s) => s.activeWorkspaceId)
  const servers = useWorkspaceServers()
  const vpns = useApp(useShallow((s) => s.workspaceVpns()))
  const collections = useApi(useShallow((s) => s.collectionsIn(workspaceId)))
  const into = reimportInto ? collections.find((c) => c.id === reimportInto) : undefined

  const [url, setUrl] = useState(into?.importedFrom?.url ?? '')
  const [route, setRoute] = useState<Route>(
    into?.viaServerId ? { kind: 'server', serverId: into.viaServerId } : into?.vpnProfileId ? { kind: 'vpn', vpnProfileId: into.vpnProfileId } : { kind: 'direct' }
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [parsed, setParsed] = useState<Parsed | null>(null)
  const [name, setName] = useState('')
  const [confirming, setConfirming] = useState(false)
  const t = useT()

  const preview = useMemo(() => (parsed ? requestsFromOpenApi(parsed.doc) : null), [parsed])

  const accept = (text: string, source: Parsed['source']): void => {
    const r = parseOpenApi(text, source)
    if (!r.ok) {
      setError(r.error)
      setParsed(null)
      return
    }
    setError(null)
    setParsed({ doc: r.doc, externalRefs: r.externalRefs, source })
    const info = r.doc.info as { title?: unknown } | undefined
    if (!name) setName(typeof info?.title === 'string' ? info.title.slice(0, 100) : (source.fileName ?? t('http.import.defaultName')))
  }

  const fetchUrl = async (): Promise<void> => {
    let via: HttpVia = { kind: 'direct' }
    if (route.kind === 'server') {
      const server = servers.find((s) => s.id === route.serverId)
      // A route that no longer exists is refused, never quietly sent direct.
      if (!server) return setError(t('http.import.serverGone'))
      via = { kind: 'server', server: sshTargetFor(server) }
    } else if (route.kind === 'vpn') via = { kind: 'vpn', vpnProfileId: route.vpnProfileId }
    setBusy(true)
    setError(null)
    try {
      const res = await window.opsmaxx.http.request({
        url: url.trim(),
        method: 'GET',
        headers: { Accept: 'application/json, application/yaml;q=0.9, */*;q=0.5' },
        via,
        maxRedirects: 5
      })
      if (!res.ok) return setError(res.error)
      if (res.status < 200 || res.status >= 300)
        return setError(t('http.import.serverAnswered', { status: res.status, statusText: res.statusText }))
      if (res.truncated) return setError(t('http.import.tooLarge'))
      accept(new TextDecoder().decode(res.body), { url: withoutCredentials(url.trim()) })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const chooseFile = async (): Promise<void> => {
    setError(null)
    try {
      const chosen = await window.opsmaxx.http.chooseSpecFile()
      if (!chosen) return
      if ('error' in chosen) return setError(chosen.error)
      // Main hands over the basename only: `importedFrom` syncs, and a path is
      // a map of this machine's directories (SEC-L6).
      accept(chosen.text, { fileName: chosen.name })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const commit = (): void => {
    if (!parsed) return
    const api = useApi.getState()
    const id = into ? into.id : api.createCollection(name.trim() || t('http.import.defaultName'), route)
    const { items, baseUrl } = requestsFromOpenApi(parsed.doc, { idSeed: id })
    api.replaceItems(id, items)
    const current = useApi.getState().collections.find((c) => c.id === id)
    const hasBaseUrl = current?.variables.some((v) => v.key === 'baseUrl')
    api.updateCollection(id, {
      importedFrom: { kind: 'openapi', ...parsed.source, at: new Date().toISOString() },
      needsReimport: false,
      ...(hasBaseUrl || !current
        ? {}
        : {
            variables: [
              ...current.variables,
              { id: stableId('var', id, 'baseUrl', '0'), key: 'baseUrl', value: baseUrl ?? '', enabled: true }
            ]
          })
    })
    onDone()
  }

  const count = preview ? countRequests(preview.items) : 0
  // Imported from a file: only its name was kept (SEC-L6), so the way back is
  // picking it again, and that is offered first rather than a blank URL.
  const fileName = into?.importedFrom?.fileName
  return (
    <>
      {fileName && (
        // Not a <Field>: that is a <label>, which would rename the button after itself.
        <div className="field" role="group" aria-label={t('http.import.fromFile')}>
          <span className="field-label">{t('http.import.fromFile')}</span>
          <span className="field-control">
            <button className="btn primary size-28" autoFocus onClick={() => void chooseFile()}>
              {t('http.import.chooseAgain', { file: fileName })}
            </button>
          </span>
          {error ? (
            <span className="field-error" role="alert">
              {error}
            </span>
          ) : (
            <span className="field-hint">
              {t('http.import.importedFromFile', { name: into?.name ?? '', file: fileName })}
            </span>
          )}
        </div>
      )}
      <Field
        label={fileName ? t('http.import.orFromUrl') : t('http.import.fromUrl')}
        error={fileName ? undefined : (error ?? undefined)}
        hint={t('http.import.fromUrlHint')}
      >
        <div className="row" style={{ gap: 'var(--sp-2)' }}>
          <input
            className="input"
            value={url}
            aria-label={t('http.import.openApiUrl')}
            placeholder="https://api.example.com/openapi.json"
            onChange={(e) => setUrl(e.target.value)}
          />
          <button className="btn secondary size-28" disabled={busy || !url.trim()} onClick={() => void fetchUrl()}>
            {busy ? t('http.import.fetching') : t('http.import.fetch')}
          </button>
          {!fileName && (
            <button className="btn secondary size-28" onClick={() => void chooseFile()}>
              {t('http.import.chooseFile')}
            </button>
          )}
        </div>
      </Field>
      <Field label={t('http.import.sendFrom')} hint={t('http.import.sendFromHint')}>
        <select className="input" value={routeKey(route)} onChange={(e) => setRoute(routeFrom(e.target.value))}>
          <option value="direct">{t('http.import.thisMachine')}</option>
          {servers.map((s) => (
            <option key={s.id} value={`server:${s.id}`}>
              {s.name}
            </option>
          ))}
          {vpns.map((v) => (
            <option key={v.id} value={`vpn:${v.id}`}>
              {v.name}
            </option>
          ))}
        </select>
      </Field>

      {parsed && preview && (
        <div aria-label={t('http.import.report')}>
          <div>
            {t('http.import.requestsInFolders', {
              count,
              folders: preview.items.filter((i) => i.kind === 'folder').length
            })}
          </div>
          <div className="field-hint">
            {preview.baseUrl ? t('http.import.baseUrl', { url: preview.baseUrl }) : t('http.import.noBaseUrl')}
          </div>
          {parsed.externalRefs > 0 && (
            <div className="field-hint">{t('http.import.externalRefs', { count: parsed.externalRefs })}</div>
          )}
          {preview.skipped.length > 0 && (
            <ul aria-label={t('http.import.skipped')}>
              {preview.skipped.map((s) => (
                <li key={`${s.method} ${s.path}`} className="field-hint">
                  {s.method} {s.path}: {s.reason}
                </li>
              ))}
            </ul>
          )}
          {!into && (
            <Field label={t('http.import.collectionName')}>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
          )}
          <div className="row" style={{ gap: 'var(--sp-2)', marginTop: 'var(--sp-3)' }}>
            {into && confirming ? (
              <>
                <span className="field-error" role="alert">
                  {t('http.import.replaceConfirm', { name: into.name, count })}
                </span>
                <button className="btn danger size-28" onClick={commit}>
                  {t('http.import.replace')}
                </button>
                <button className="btn secondary size-28" onClick={() => setConfirming(false)}>
                  {t('http.import.keep')}
                </button>
              </>
            ) : (
              <button
                className="btn primary size-28"
                onClick={() => (into ? setConfirming(true) : commit())}
              >
                {into ? t('http.import.reimportInto', { name: into.name }) : t('http.import.createCollection')}
              </button>
            )}
          </div>
        </div>
      )}
    </>
  )
}
