import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Auth, HttpRequest, Id, RouteKey } from '../../../../../shared/apiModel'
import { resolveTemplate, type VariableScopeChain } from '../../../../../shared/apiVariables'
import { autoHeadersFor } from '../../../../../shared/autoHeaders'
import { useHttp } from '../../../store/http'
import { useApi } from '../../../store/api'
import { useHttpCookies, type JarKey } from '../../../store/httpCookies'
import { useUpdater } from '../../../store/updater'
import { useHttpRuntime } from '../../../store/httpRuntime'
import { useToasts } from '../../../store/toast'
import { liveSpecFor, maskedSentFor, send } from '../../../lib/httpSend'
import { isMac } from '../../../lib/shortcuts'
import { Tabs, type TabItem } from '../../common/Tabs'
import { ProtocolLayout } from '../ProtocolLayout'
import { MoveToVaultDialog } from '../dialogs/MoveToVaultDialog'
import { CodeSnippetDrawer } from '../dialogs/CodeSnippetDrawer'
import { Code2 } from 'lucide-react'
import { ResponsePane, HTTP_FIX_EVENT, tabById, type HttpFixDetail } from '../response/ResponsePane'
import { ResponseStatus } from '../response/ResponseStatus'
import { AuthEditor, deadVaultField } from './AuthEditor'
import { useVault } from '../../../store/vault'
import { BODY_MODES, BodyEditor, beautify, switchBodyMode } from './BodyEditor'
import { HeadersEditor } from './HeadersEditor'
import { ParamsEditor } from './ParamsEditor'
import { RequestSettings } from './RequestSettings'
import { UrlBar, sendTab, useHttpRequest, useScopeChain } from './UrlBar'
import { enabledCount, invalidJson, syncFromUrl } from './requestModel'
import './request.css'

export type RequestTab = 'params' | 'auth' | 'headers' | 'body' | 'settings'

const AUTH_NAMES: Record<Auth['type'], string> = {
  inherit: 'Inherit',
  none: 'No auth',
  bearer: 'Bearer token',
  basic: 'Basic',
  apikey: 'API key'
}

function unresolved(texts: string[], chain: VariableScopeChain): boolean {
  return texts.some((t) => t.includes('{{') && resolveTemplate(t, chain).unresolved.length > 0)
}

/** Which request tabs carry a pre-send problem: an unresolved variable, or JSON that does not parse. */
export function problemsIn(req: HttpRequest, chain: VariableScopeChain): Set<RequestTab> {
  const out = new Set<RequestTab>()
  const on = <T extends { enabled: boolean }>(rows: T[]): T[] => rows.filter((r) => r.enabled)
  if (unresolved([req.url, ...on(req.params).map((r) => r.value), ...req.pathParams.map((r) => r.value)], chain)) {
    out.add('params')
  }
  if (unresolved(on(req.headers).flatMap((r) => [r.key, r.value]), chain)) out.add('headers')
  const a = req.auth
  const authTexts = a.type === 'bearer' ? [a.token] : a.type === 'basic' ? [a.username, a.password] : a.type === 'apikey' ? [a.name, a.value] : []
  if (unresolved(authTexts, chain)) out.add('auth')
  const b = req.body
  const bodyTexts = 'text' in b ? [b.text] : 'rows' in b ? on(b.rows as { enabled: boolean; value: string }[]).map((r) => r.value) : []
  if (invalidJson(req) || unresolved(bodyTexts, chain)) out.add('body')
  return out
}

export interface HttpRequestPaneProps {
  tabId: Id
}

/** The REST tab: URL row, request editors, response, laid out by ProtocolLayout. */
export function HttpRequestPane({ tabId }: HttpRequestPaneProps): React.JSX.Element | null {
  const req = useHttpRequest(tabId)
  const tab = useHttp((s) => tabById(s, tabId))
  const updateDraft = useHttp((s) => s.updateDraft)
  const setSplit = useHttp((s) => s.setSplit)
  const chain = useScopeChain(tab)
  const collection = useApi((s) => (tab?.ref ? (s.collections.find((c) => c.id === tab.ref!.collectionId) ?? null) : null))
  const version = useUpdater((s) => s.capabilities?.currentVersion) ?? '<version>'
  const hasCookies = useHttpCookies((s) => {
    if (!tab) return false
    const route = useApi.getState().effectiveRoute(tab)
    const key: RouteKey =
      route.kind === 'direct' ? 'direct' : route.kind === 'server' ? `server:${route.serverId}` : `vpn:${route.vpnProfileId}`
    const jar: JarKey = `${tab.workspaceId}|${key}`
    return (s.jars[jar]?.length ?? 0) > 0
  })
  const [active, setActive] = useState<RequestTab>('params')
  const codeOpen = useHttp((s) => s.prefs.codeOpen)
  const setPrefs = useHttp((s) => s.setPrefs)
  const lastSentAs = useHttp((s) => {
    const r = s.responses[tabId]
    return r?.status === 'done' ? r.sentAs : null
  })
  /** "Move to vault…": the literal, the entry name to offer, and where the reference goes. */
  const [moving, setMoving] = useState<{ name: string; value: string; apply: (ref: string) => void } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const files = useHttpRuntime((s) => s.files[tabId])
  const push = useToasts((s) => s.push)

  const reqRef = useRef(req)
  reqRef.current = req

  const onChange = useCallback((next: HttpRequest) => updateDraft(tabId, next), [tabId, updateDraft])

  // Fixes this pane owns; the rest bubble on to the workbench.
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const onFix = (e: Event): void => {
      const { action } = (e as CustomEvent<HttpFixDetail>).detail
      const current = useHttp.getState()
      const draft = tabById(current, tabId)?.draft
      if (action === 'raise-timeout') {
        e.stopPropagation()
        setActive('settings')
        setTimeout(() => el.querySelector<HTMLInputElement>('[data-hc-focus="timeout"]')?.focus())
      } else if (action === 'retry-http' && draft?.kind === 'http') {
        e.stopPropagation()
        updateDraft(tabId, syncFromUrl(draft, draft.url.replace(/^\s*https:\/\//i, 'http://')))
        void send(tabId)
      } else if (action === 'send-anyway') {
        e.stopPropagation()
        void send(tabId, { allowUnresolved: true })
      } else if (action === 'choose-vault') {
        // A dead reference in this request's own Auth field is fixed there. One
        // held by a variable bubbles on to the workbench's variables popover.
        const auth = reqRef.current?.auth
        const ids = new Set(useVault.getState().entries.map((v) => v.id))
        if (auth && deadVaultField(auth, ids)) {
          e.stopPropagation()
          setActive('auth')
          setTimeout(() => el.querySelector<HTMLElement>('.hc-auth .hc-vault-value button')?.focus())
        }
      }
    }
    el.addEventListener(HTTP_FIX_EVENT, onFix)
    return () => el.removeEventListener(HTTP_FIX_EVENT, onFix)
  }, [tabId, updateDraft])

  const problems = useMemo(() => (req ? problemsIn(req, chain) : new Set<RequestTab>()), [req, chain])
  const auto = useMemo(
    () => (req ? autoHeadersFor(req, { version, hasCookies, inheritedAuth: collection?.auth }) : []),
    [req, version, hasCookies, collection?.auth]
  )

  if (!req || !tab) return null
  // The drawer's default view: the request as it would go now, masked (a build,
  // never a send). The last send stands in only when it cannot be built, e.g. a
  // route whose server was removed. Rebuilt each render, so edits show at once.
  const sentAs = codeOpen ? (maskedSentFor(tabId) ?? lastSentAs) : null
  const stripped = tab.strippedFields ?? []
  const authSet = req.auth.type !== 'none' && req.auth.type !== 'inherit'
  const dot = (t: RequestTab, set = false): TabItem['dot'] => (problems.has(t) ? 'problem' : set ? 'set' : undefined)
  const tabs: TabItem[] = [
    { id: 'params', label: 'Params', count: enabledCount(req.params), dot: dot('params') },
    { id: 'auth', label: 'Auth', dot: dot('auth', authSet) },
    { id: 'headers', label: 'Headers', count: enabledCount(req.headers), dot: dot('headers') },
    { id: 'body', label: 'Body', dot: dot('body') },
    { id: 'settings', label: 'Settings' }
  ]
  const open = (t: RequestTab): void => {
    setActive(t)
    setSplit(tabId, 'normal')
  }

  const context =
    active === 'body' ? (
      <span className="hc-reqbar">
        <select
          className="hc-select"
          aria-label="Body type"
          value={req.body.mode}
          onChange={(e) => onChange({ ...req, body: switchBodyMode(req.body, e.target.value as HttpRequest['body']['mode']) })}
        >
          {BODY_MODES.map((m) => (
            <option key={m.mode} value={m.mode}>
              {m.label}
            </option>
          ))}
        </select>
        {req.body.mode === 'json' && (
          <button
            className="btn quiet sm"
            title={`Beautify (${isMac() ? '⌥⌘B' : 'Ctrl+Alt+B'})`}
            onClick={() => onChange(beautify(req))}
          >
            Beautify
          </button>
        )}
      </span>
    ) : (
      <span className="hc-reqbar ui-label">
        {active === 'params' ? 'Query parameters' : active === 'auth' ? AUTH_NAMES[req.auth.type] : active === 'headers' ? 'Request headers' : 'Request settings'}
      </span>
    )
  const toolbar = (
    <span className="hc-reqtools">
      {context}
      <span className="hc-grow" />
      <button
        className="btn ghost sm"
        aria-label="Generate code"
        title="Generate code"
        aria-pressed={codeOpen}
        onClick={() => setPrefs({ codeOpen: !codeOpen })}
      >
        <Code2 size={14} />
      </button>
    </span>
  )

  const summary = (
    <span className="hc-reqsum">
      <span>Request</span>
      {tabs.map((t) => (
        <button key={t.id} className="btn quiet sm" onClick={() => open(t.id as RequestTab)}>
          {t.label}
          {t.count ? ` ${t.count}` : ''}
          {t.id === 'auth' && authSet ? ' •' : ''}
          {t.id === 'body' && req.body.mode !== 'none' ? ` ${BODY_MODES.find((m) => m.mode === req.body.mode)?.label}` : ''}
        </button>
      ))}
    </span>
  )

  const editor = (): React.JSX.Element => {
    switch (active) {
      case 'params':
        return <ParamsEditor req={req} onChange={onChange} chain={chain} stripped={stripped} />
      case 'auth':
        return (
          <AuthEditor
            value={req.auth}
            onChange={(auth) => onChange({ ...req, auth })}
            chain={chain}
            collectionName={collection?.name}
            inheritFrom={collection ? AUTH_NAMES[collection.auth.type] : undefined}
            stripped={stripped}
            onMoveToVault={(field, value) =>
              setMoving({
                name: `${collection?.name ?? req.name} · ${field}`,
                value,
                apply: (ref) => {
                  const auth = { ...req.auth, [field]: ref } as Auth
                  onChange({ ...req, auth })
                }
              })
            }
          />
        )
      case 'headers':
        return (
          <HeadersEditor
            rows={req.headers}
            onChange={(headers) => onChange({ ...req, headers })}
            auto={auto}
            chain={chain}
            stripped={stripped}
            onMoveToVault={(rowId, value) =>
              setMoving({
                name: `${collection?.name ?? req.name} · ${req.headers.find((h) => h.id === rowId)?.key ?? 'header'}`,
                value,
                apply: (ref) =>
                  onChange({ ...req, headers: req.headers.map((h) => (h.id === rowId ? { ...h, value: ref } : h)) })
              })
            }
          />
        )
      case 'body':
        return (
          <BodyEditor
            req={req}
            onChange={onChange}
            chain={chain}
            stripped={stripped}
            onSubmit={() => void sendTab(tabId)}
            hasFile={(key) => !!files && Object.hasOwn(files, key)}
            onChooseFile={async (key) => {
              const picked = await window.opsmaxx.http.chooseBodyFile()
              if (!picked) return null
              if ('error' in picked) {
                push(picked.error, 'error')
                return null
              }
              useHttpRuntime.getState().setFile(tabId, key, picked)
              return picked.name
            }}
          />
        )
      case 'settings':
        return <RequestSettings tabId={tabId} req={req} onChange={onChange} collection={collection} />
    }
  }

  return (
    <div className="hc-rest" ref={rootRef}>
      <ProtocolLayout
        tabId={tabId}
        kind="http"
        bar={<UrlBar tabId={tabId} />}
        requestTabs={
          <Tabs
            ariaLabel="Request"
            idPrefix={`${tabId}-req`}
            tabs={tabs}
            active={active}
            onChange={(id) => setActive(id as RequestTab)}
          />
        }
        requestToolbar={toolbar}
        request={
          <div
            className="hc-request-panel"
            role="tabpanel"
            id={`${tabId}-req-panel`}
            aria-labelledby={`${tabId}-req-tab-${active}`}
          >
            {editor()}
            {codeOpen && (
              <div className="hc-code-drawer">
                {sentAs ? (
                  <CodeSnippetDrawer
                    request={req}
                    sent={sentAs}
                    resolveSecrets={() => liveSpecFor(tabId)}
                    onClose={() => setPrefs({ codeOpen: false })}
                  />
                ) : (
                  <p className="hc-note hc-pad">Nothing to generate yet: this request cannot be built.</p>
                )}
              </div>
            )}
          </div>
        }
        response={<ResponsePane tabId={tabId} />}
        requestSummary={summary}
        responseSummary={<ResponseStatus tabId={tabId} />}
      />
      {moving && (
        <MoveToVaultDialog
          defaultName={moving.name}
          value={moving.value}
          onMoved={(ref) => {
            moving.apply(ref)
            setMoving(null)
          }}
          onClose={() => setMoving(null)}
        />
      )}
    </div>
  )
}
