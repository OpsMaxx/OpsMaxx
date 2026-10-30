import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Loader2, Plug, PlugZap } from 'lucide-react'
import { protocolKeptOnSave, type Id, type Row, type WsRequest } from '../../../../../shared/apiModel'
import { splitUrl, withParams } from '../../../../../shared/apiUrl'
import { presentError, type FixAction } from '../../../../../shared/httpErrors'
import type { VariableScopeChain } from '../../../../../shared/apiVariables'
import { openSocket } from '../../../lib/httpSend'
import { clsx } from '../../../lib/format'
import { isMac } from '../../../lib/shortcuts'
import { useApi } from '../../../store/api'
import { useHttp } from '../../../store/http'
import { shownProtocol, useWsSessions, type WsSession } from '../../../store/wsSessions'
import { KeyValueTable } from '../../common/KeyValueTable'
import { Tabs } from '../../common/Tabs'
import { UnlockVaultButton } from '../../common/UnlockVaultButton'
import { ContextMenu, type MenuEntry } from '../../connections/ContextMenu'
import { VariableInput } from '../fields/VariableInput'
import { ProtocolLayout, SplitToggles, urlRowLayout, useWidth } from '../ProtocolLayout'
import { AuthEditor } from '../request/AuthEditor'
import { HeadersEditor } from '../request/HeadersEditor'
import {
  HTTP_FIX_EVENT,
  HTTP_SET_VARIABLE_EVENT,
  unresolvedInOrigin,
  type HttpFixDetail,
  type SetVariableDetail
} from '../response/ResponsePane'
import { RouteChip } from '../RouteChip'
import { TlsChip } from '../TlsChip'
import { Composer, ComposerToolbar } from './Composer'
import { INITIAL_VIEW, MessageLog, MessageToolbar, type LogView } from './MessageLog'
import { isLive, submitWs, updateWs, wsRequestOf } from './wsActions'
import { t as tr, useT } from '../../../lib/i18n'
import { Trans } from '../../../lib/Trans'
import './ws.css'

type Section = 'message' | 'params' | 'auth' | 'headers' | 'settings'

const EMPTY_CHAIN: VariableScopeChain = { layers: [] }

const enabledCount = (rows: Row[]): number => rows.filter((r) => r.enabled && r.key !== '').length

const clock = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000))
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`
}

/** Re-renders once a second while `on`: the connected clock. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!on) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [on])
  return now
}

/** The connection as a line of text: the status row, the collapsed bar and the live region. */
export function statusText(session: WsSession | undefined, now: number): string {
  const s = session
  switch (s?.state) {
    case 'connecting':
      return tr('http.ws.connecting')
    case 'open':
      return tr('http.ws.connected', {
        clock: clock(now - (s.openedAt ?? now)),
        count: s.stats.sent + s.stats.received
      })
    case 'closing':
      return tr('http.ws.disconnecting')
    case 'closed':
      return s.close?.wasClean === false
        ? s.close.reason
          ? tr('http.ws.closedCodeReason', { code: s.close.code, reason: s.close.reason })
          : tr('http.ws.closedCode', { code: s.close.code })
        : s.close
          ? tr('http.ws.disconnectedCode', { code: s.close.code })
          : tr('http.ws.disconnected')
    case 'error':
      return s.failure?.message ?? tr('http.ws.couldNotConnect')
    default:
      return s?.failure?.class === 'prod-declined' ? s.failure.message : tr('http.ws.notConnected')
  }
}

/** What the polite live region says: the connection's state, never a frame (UX-m6). */
export function announcement(session: WsSession | undefined): string {
  switch (session?.state) {
    case 'open':
      return tr('http.ws.announceConnected')
    case 'closed':
      return session.close
        ? tr('http.ws.announceClosedCode', { code: session.close.code })
        : tr('http.ws.announceClosed')
    case 'error':
      return session.failure?.message ?? tr('http.ws.announceFailed')
    default:
      return ''
  }
}

const isFailure = (s: WsSession | undefined): boolean =>
  s?.state === 'error' || (s?.state === 'closed' && s.close?.wasClean === false)

function dotClass(s: WsSession | undefined): string {
  if (s?.state === 'open') return 'is-ok'
  if (isFailure(s)) return 'is-alarm'
  if (s?.state === 'connecting' || s?.state === 'closing') return 'is-watch'
  return 'is-unknown'
}

export function WsRequestPane({ tabId }: { tabId: Id }): React.JSX.Element | null {
  const tab = useHttp((s) => s.tabs.find((t) => t.id === tabId))
  const collections = useApi((s) => s.collections)
  const workspace = useApi((s) => s.workspace)
  const session = useWsSessions((s) => s.sessions[tabId])
  const kvDescriptions = useHttp((s) => s.prefs.kvDescriptions)
  const [section, setSection] = useState<Section>('message')
  const [view, setView] = useState<LogView>(INITIAL_VIEW)
  const [responseTab, setResponseTab] = useState<'messages' | 'handshake'>('messages')
  const [menu, setMenu] = useState<{ x: number; y: number; entries: MenuEntry[] } | null>(null)
  const [responseRef, responseWidth] = useWidth<HTMLDivElement>()
  const [barRef, barWidth] = useWidth<HTMLDivElement>()
  const state = session?.state ?? 'idle'
  const live = isLive(state)
  const now = useNow(state === 'open')
  const t = useT()

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const req = useMemo(() => wsRequestOf(tab), [tab, collections])
  const chain = useMemo(
    () => (tab ? useApi.getState().scopeChainFor(tab) : EMPTY_CHAIN),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tab?.ref?.collectionId, collections, workspace]
  )
  const collection = collections.find((c) => c.id === tab?.ref?.collectionId)

  if (!tab || !req) return null

  const setUrl = (url: string): void => updateWs(tabId, { url, params: splitUrl(url).query })
  const setParams = (params: Row[]): void => updateWs(tabId, { params, url: withParams(req.url, params) })
  const openSection = (s: Section): void => {
    setSection(s)
    if (tab.split === 'request-collapsed') useHttp.getState().setSplit(tabId, 'normal')
  }

  const reqP = `${tabId}-ws`
  const resP = `${tabId}-ws-response`

  // §2.1's degradation, from S's pure function; unmeasured (and in jsdom) nothing degrades.
  const tls = !!collection && (collection.insecureTls || !!collection.caPem)
  const step = barWidth > 0 ? urlRowLayout(barWidth, { tls }).step : 0

  const bar = (
    <div className="hc-ws-bar" ref={barRef} data-step={step}>
      <span className="hc-ws-badge" aria-label={t('http.ws.badge')}>
        WS
      </span>
      <div className="hc-ws-url">
        {live ? (
          <span className="hc-ws-url-locked mono" title={t('http.ws.disconnectToEdit')} aria-label={t('http.ws.url')}>
            {req.url}
          </span>
        ) : (
          <VariableInput
            value={req.url}
            onChange={setUrl}
            chain={chain}
            placeholder="wss://host/socket"
            ariaLabel={t('http.ws.url')}
            onSubmit={() => void submitWs(tabId)}
          />
        )}
      </div>
      <RouteChip tabId={tabId} compact={step >= 1} />
      <TlsChip tabId={tabId} compact={step >= 3} />
      <ConnectButton tabId={tabId} session={session} disabled={req.url.trim() === ''} iconOnly={step >= 2} />
    </div>
  )

  const requestTabs = (
    <Tabs
      ariaLabel={t('http.layout.request')}
      idPrefix={reqP}
      active={section}
      onChange={(id) => setSection(id as Section)}
      tabs={[
        { id: 'message', label: t('http.ws.tabMessage') },
        { id: 'params', label: t('http.request.params'), count: enabledCount(req.params) },
        {
          id: 'auth',
          label: t('http.request.auth'),
          dot: req.auth.type === 'none' || req.auth.type === 'inherit' ? undefined : 'set'
        },
        { id: 'headers', label: t('http.request.headers'), count: enabledCount(req.headers) },
        { id: 'settings', label: t('http.request.settings') }
      ]}
    />
  )

  const locked = live && section !== 'message'
  const requestToolbar =
    section === 'message' ? (
      <ComposerToolbar tabId={tabId} />
    ) : locked ? (
      <p className="hc-ws-locked-note">{t('http.ws.lockedNote')}</p>
    ) : undefined

  const body: ReactNode =
    section === 'message' ? (
      <Composer tabId={tabId} />
    ) : section === 'params' ? (
      <KeyValueTable
        rows={req.params}
        onChange={setParams}
        kind="params"
        showDescription={kvDescriptions}
        onShowDescription={(on) => useHttp.getState().setPrefs({ kvDescriptions: on })}
        readOnly={live}
      />
    ) : section === 'auth' ? (
      <AuthEditor
        value={req.auth}
        onChange={(auth) => updateWs(tabId, { auth })}
        readOnly={live}
        inheritFrom={collection?.name}
        collectionName={collection?.name}
      />
    ) : section === 'headers' ? (
      <HeadersEditor rows={req.headers} onChange={(headers) => updateWs(tabId, { headers })} readOnly={live} chain={chain} />
    ) : (
      <WsSettings
        tabId={tabId}
        req={req}
        readOnly={live}
        stripped={tab.strippedFields ?? []}
        onProtocols={(protocols) => updateWs(tabId, { protocols })}
      />
    )
  const request = (
    <div className="hc-ws-panel" role="tabpanel" id={`${reqP}-panel`} aria-labelledby={`${reqP}-tab-${section}`}>
      {body}
    </div>
  )

  const failure = state === 'error' ? session?.failure : undefined
  // The fix is presented from the class, with this tab's context, so a build
  // failure reported by the send layer gets the same button as one from main.
  const fixOf = failure ? presentError(failure.class, failure.message, { scratch: !tab.ref }).fix : undefined
  const bubble = (e: React.MouseEvent<HTMLElement>, action: FixAction): void => {
    e.currentTarget.dispatchEvent(
      new CustomEvent<HttpFixDetail>(HTTP_FIX_EVENT, { bubbles: true, detail: { tabId, action } })
    )
  }
  const fix = !fixOf ? null : fixOf.action === 'unlock' ? (
    <UnlockVaultButton reason={t('http.ws.unlockReason')} onUnlocked={() => void openSocket(tabId)} />
  ) : fixOf.action === 'disconnect-idle' ? (
    <button type="button" className="btn sm" onClick={(e) => setMenu({ x: e.clientX, y: e.clientY, entries: otherSockets(tabId) })}>
      {fixOf.label}
    </button>
  ) : fixOf.action === 'retry-http' ? (
    /^wss:/i.test(req.url) ? (
      <button
        type="button"
        className="btn sm"
        onClick={() => {
          updateWs(tabId, { url: req.url.replace(/^wss:/i, 'ws:') })
          void openSocket(tabId)
        }}
      >
        {t('http.ws.retryWs')}
      </button>
    ) : null
  ) : fixOf.action === 'choose-vault' ? (
    <button type="button" className="btn sm" onClick={() => openSection('auth')}>
      {fixOf.label}
    </button>
  ) : fixOf.action === 'raise-timeout' || fixOf.action === 'send-anyway' ? null : (
    // route-menu, add-ca, save-then-ca, add-variable, restart: the workbench's.
    <button type="button" className="btn sm" onClick={(e) => bubble(e, fixOf.action)}>
      {fixOf.label}
    </button>
  )
  const connectAnyway =
    failure?.class === 'unresolved-variable' && !unresolvedInOrigin(req.url, failure.unresolved ?? []) ? (
      <button type="button" className="btn ghost sm" onClick={() => void openSocket(tabId, { allowUnresolved: true })}>
        {t('http.ws.connectAnyway')}
      </button>
    ) : null

  const text = statusText(session, now)
  const response = (
    <div className="hc-ws-response" ref={responseRef}>
      <div className="hc-ws-status">
        <span className={clsx('state-dot', dotClass(session))} aria-hidden />
        <span className={clsx('hc-ws-status-text', isFailure(session) && 'is-failure')}>{text}</span>
        {fix}
        {connectAnyway}
        {(state === 'closed' || state === 'error') && (
          <button type="button" className="btn ghost sm" onClick={() => void openSocket(tabId)}>
            {t('http.ws.reconnect')}
          </button>
        )}
        <span className="hc-ws-spacer" />
        <SplitToggles tabId={tabId} />
      </div>
      <Tabs
        ariaLabel={t('http.layout.response')}
        idPrefix={resP}
        active={responseTab}
        onChange={(id) => setResponseTab(id as 'messages' | 'handshake')}
        tabs={[
          { id: 'messages', label: t('http.ws.messages') },
          { id: 'handshake', label: t('http.ws.handshake') }
        ]}
        trailing={
          responseTab === 'messages' ? (
            <MessageToolbar tabId={tabId} view={view} onView={(p) => setView((v) => ({ ...v, ...p }))} />
          ) : undefined
        }
      />
      <div className="hc-ws-panel" role="tabpanel" id={`${resP}-panel`} aria-labelledby={`${resP}-tab-${responseTab}`}>
        {responseTab === 'messages' ? (
          <MessageLog
            tabId={tabId}
            width={responseWidth}
            view={view}
            onView={(p) => setView((v) => ({ ...v, ...p }))}
            onLoadIntoComposer={(text) => {
              useWsSessions.getState().setComposer(tabId, { text })
              openSection('message')
            }}
          />
        ) : (
          <Handshake session={session} />
        )}
      </div>
      <div className="hc-ws-live" aria-live="polite" role="status">
        {announcement(session)}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} entries={menu.entries} onClose={() => setMenu(null)} />}
    </div>
  )

  const requestSummary = (
    <span className="hc-ws-summary">
      {t('http.layout.request')} ·{' '}
      <button type="button" className="btn ghost sm" onClick={() => openSection('message')}>
        {t('http.ws.tabMessage')}
      </button>
      <button type="button" className="btn ghost sm" onClick={() => openSection('params')}>
        {t('http.request.params')} {enabledCount(req.params)}
      </button>
      <button type="button" className="btn ghost sm" onClick={() => openSection('auth')}>
        {t('http.request.auth')}
        {req.auth.type !== 'none' && req.auth.type !== 'inherit' ? ' •' : ''}
      </button>
      <button type="button" className="btn ghost sm" onClick={() => openSection('headers')}>
        {t('http.request.headers')} {enabledCount(req.headers)}
      </button>
    </span>
  )

  return (
    <ProtocolLayout
      tabId={tabId}
      kind="ws"
      bar={bar}
      requestTabs={requestTabs}
      requestToolbar={requestToolbar}
      request={request}
      response={response}
      requestSummary={requestSummary}
      responseSummary={
        <span className="hc-ws-summary">
          <span className={clsx('state-dot', dotClass(session))} aria-hidden />
          {text}
        </span>
      }
    />
  )
}

function ConnectButton({
  tabId,
  session,
  disabled,
  iconOnly
}: {
  tabId: Id
  session: WsSession | undefined
  disabled: boolean
  /** §2.1 step 2: the label goes, the name stays in aria-label and the tooltip. */
  iconOnly: boolean
}): React.JSX.Element {
  const state = session?.state ?? 'idle'
  const t = useT()
  if (state === 'open' || state === 'closing') {
    return (
      <button
        type="button"
        className="btn danger hc-ws-connect"
        disabled={state === 'closing'}
        onClick={() => useWsSessions.getState().disconnect(tabId)}
        aria-label={iconOnly ? t('http.ws.disconnect') : undefined}
        title={iconOnly ? t('http.ws.disconnect') : undefined}
      >
        <PlugZap size={14} aria-hidden />{' '}
        {!iconOnly && (state === 'closing' ? t('http.ws.disconnecting') : t('http.ws.disconnect'))}
      </button>
    )
  }
  const connecting = state === 'connecting'
  return (
    <button
      type="button"
      className="btn primary hc-ws-connect"
      disabled={disabled || connecting}
      aria-busy={connecting}
      aria-label={iconOnly ? t('http.ws.connectKey', { key: isMac() ? '⌘↵' : 'Ctrl+Enter' }) : undefined}
      title={iconOnly ? t('http.ws.connectKey', { key: isMac() ? '⌘↵' : 'Ctrl+Enter' }) : undefined}
      onClick={() => void openSocket(tabId)}
    >
      {connecting ? <Loader2 size={14} className="hc-ws-spin" aria-hidden /> : <Plug size={14} aria-hidden />}
      {!iconOnly && (connecting ? t('http.ws.connecting') : t('http.ws.connect'))}
    </button>
  )
}

/** Subprotocols, sent as `Sec-WebSocket-Protocol`. A comma list as typed. */
function WsSettings({
  tabId,
  req,
  readOnly,
  stripped,
  onProtocols
}: {
  tabId: Id
  req: WsRequest
  readOnly: boolean
  /** The tab's strippedFields: `protocols.<i>` is a subprotocol the last save did not keep. */
  stripped: string[]
  onProtocols: (protocols: string[]) => void
}): React.JSX.Element {
  // The field keeps what was typed, so "a, " survives long enough to type "b".
  const [text, setText] = useState(() => req.protocols.join(', '))
  const t = useT()
  const set = (protocols: string[]): void => {
    setText(protocols.join(', '))
    onProtocols(protocols)
  }
  const lost = req.protocols.findIndex((p, i) => p === '' && stripped.includes(`protocols.${i}`))
  // Exactly what the save strip drops: a credential, a token, anything that is not a protocol name.
  const secret = req.protocols.find((p) => p !== '' && !protocolKeptOnSave(p))

  const paste = async (): Promise<void> => {
    const pasted = (await window.opsmaxx.clipboard.read()).trim()
    if (pasted) set(req.protocols.map((p, i) => (i === lost ? pasted : p)))
  }
  const asVariable = (e: React.MouseEvent<HTMLElement>, value: string): void => {
    e.currentTarget.dispatchEvent(
      new CustomEvent<SetVariableDetail>(HTTP_SET_VARIABLE_EVENT, {
        bubbles: true,
        detail: { tabId, name: 'subprotocol', value }
      })
    )
  }

  return (
    <div className="hc-ws-settings">
      <label className="hc-ws-field">
        <span className="ui-label">{t('http.ws.subprotocols')}</span>
        <input
          className="input mono"
          aria-label={t('http.ws.subprotocols')}
          placeholder="graphql-ws, v2.json"
          value={text}
          readOnly={readOnly}
          onChange={(e) => {
            setText(e.target.value)
            onProtocols(
              e.target.value
                .split(',')
                .map((p) => p.trim())
                .filter((p) => p !== '')
            )
          }}
        />
        <span className="hc-ws-hint">{t('http.ws.subprotocolsHint')}</span>
      </label>
      {lost !== -1 && (
        <p className="hc-ws-warn" role="note">
          <Trans
            i18nKey="http.ws.lostProtocol"
            values={{ n: lost + 1, example: '{{variable}}' }}
            components={{
              button: <button type="button" className="btn ghost sm" disabled={readOnly} onClick={() => void paste()} />
            }}
          />
        </p>
      )}
      {secret !== undefined && (
        <p className="hc-ws-warn" role="note">
          <Trans
            i18nKey="http.ws.secretProtocol"
            values={{ example: '{{subprotocol}}' }}
            components={{
              button: (
                <button type="button" className="btn ghost sm" disabled={readOnly} onClick={(e) => asVariable(e, secret)} />
              )
            }}
          />
        </p>
      )}
    </div>
  )
}

function Handshake({ session }: { session: WsSession | undefined }): React.JSX.Element {
  const t = useT()
  const sent = session?.sent
  const protocol = session?.protocol
  if (!sent && protocol === undefined) return <p className="hc-ws-empty">{t('http.ws.handshakeEmpty')}</p>
  // Subprotocols can carry a bearer token (Kubernetes does). What was offered
  // is in the sent headers, masked by the build; what the server chose is
  // masked here by the same rule.
  return (
    <div className="hc-ws-handshake selectable">
      {protocol !== undefined && (
        <p className="hc-ws-note">
          {t('http.ws.subprotocol', { protocol: protocol === '' ? t('http.ws.noneChosen') : shownProtocol(protocol) })}
        </p>
      )}
      {sent && (
        <>
          <p className="hc-ws-note mono">{t('http.ws.handshakeLine', { url: sent.url, route: sent.route.label })}</p>
          <table className="hc-ws-headers">
            <tbody>
              {sent.headers.map(([name, value], i) => (
                <tr key={`${name}-${i}`}>
                  <th className="mono">{name}</th>
                  <td className="mono">{value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  )
}

/** The socket-cap fix: every other open socket, one click to close it. */
function otherSockets(tabId: Id): MenuEntry[] {
  const { sessions, disconnect } = useWsSessions.getState()
  const { tabs } = useHttp.getState()
  const open = Object.entries(sessions).filter(([id, s]) => id !== tabId && s.state === 'open')
  if (open.length === 0) return [{ label: tr('http.ws.noOtherSocket'), disabled: true }]
  return open.map(([id]) => {
    const req = wsRequestOf(tabs.find((x) => x.id === id))
    return { label: tr('http.ws.disconnectNamed', { name: req?.name ?? tr('http.ws.webSocket') }), onClick: () => disconnect(id) }
  })
}
