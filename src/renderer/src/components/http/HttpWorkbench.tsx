import { useEffect, useRef, useState } from 'react'
import { COLLECTION_GONE_SERVER_ID, type HttpRequest, type Id, type Route } from '../../../../shared/apiModel'
import { Modal } from '../common/Modal'
import { registerHttpHotkeys, useHttp } from '../../store/http'
import { useApp } from '../../store/app'
import { useApi } from '../../store/api'
import { useHttpRuntime } from '../../store/httpRuntime'
import { flushSave } from '../../store/persist'
import { cancel, copyAsCurl } from '../../lib/httpSend'
import { copyCurl, httpHotkeyHandlers } from './hotkeys'
import { orientationFor, useWidth } from './ProtocolLayout'
import { useTabOrGhost } from './RouteChip'
import { HttpTabStrip } from './tabs/HttpTabStrip'
import { closeNow, planClose } from './tabs/closing'
import { focusUrl } from './focus'
import { UpgradeBanner } from './UpgradeBanner'
import { recoverOldData } from './paletteCommands'
import { CookiesPopover } from './CookiesPopover'
import { HttpRequestPane } from './request/HttpRequestPane'
import { WsRequestPane } from './ws/WsRequestPane'
import { GraphQlRequestPane } from './gql/GraphQlRequestPane'
import { CollectionTab } from './collection/CollectionTab'
import { EnvironmentsTab } from './env/EnvironmentsTab'
import { EnvironmentPicker } from './env/EnvironmentPicker'
import { SaveRequestDialog } from './dialogs/SaveRequestDialog'
import { ImportDialog } from './dialogs/ImportDialog'
import { SetVariableDialog } from './dialogs/SetVariableDialog'
import {
  HTTP_FIX_EVENT,
  HTTP_SET_VARIABLE_EVENT,
  type HttpFixDetail,
  type SetVariableDetail
} from './response/ResponsePane'
import { HTTP_COMMAND_EVENT, type HttpCommandDetail } from './request/UrlBar'
import './http.css'

/**
 * The HTTP client (§3.7): the request-tab strip over the active tab's surface.
 * With no tab open the surface is the workspace's ghost scratch tab, a live URL
 * row with focus in it (§2.10), which the first edit promotes in place.
 */
export function HttpWorkbench(): React.JSX.Element {
  const ws = useApp((s) => s.activeWorkspaceId)
  const activeId = useHttp((s) => {
    const id = s.activeTab[ws]
    return id && s.tabs.some((t) => t.id === id) ? id : null
  })
  const ghostId = useHttp((s) => s.ghost[ws]?.id ?? null)
  const overlay = useHttp((s) => s.overlay)
  const pendingClose = useHttp((s) => s.pendingClose)
  const importTarget = useHttp((s) => s.importTarget)
  const orientationPref = useHttp((s) => s.prefs.orientation)
  const [rootRef, width] = useWidth<HTMLDivElement>()
  const [setVariable, setSetVariable] = useState<SetVariableDetail | null>(null)
  const [curlSecrets, setCurlSecrets] = useState<Id | null>(null)
  const widthNow = useRef(width)
  widthNow.current = width

  useEffect(() => {
    useHttp.getState().ensureGhost(ws)
  }, [ws])

  useEffect(() => registerHttpHotkeys(httpHotkeyHandlers({ width: () => widthNow.current })), [])

  // First run and an emptied strip: focus waits in the ghost's URL.
  const empty = activeId === null
  useEffect(() => {
    // Only on screen: the view stays mounted behind other activities, and a
    // workspace switch in a terminal must not pull focus into a hidden editor.
    if (empty && useApp.getState().activity === 'http') focusUrl()
  }, [empty, ghostId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented || useApp.getState().activity !== 'http') return
      const http = useHttp.getState()
      const id = http.activeTab[useApp.getState().activeWorkspaceId]
      if (!id || http.responses[id]?.status !== 'sending') return
      // Esc belongs to whatever is open over the workbench first.
      if (document.querySelector('[role="menu"], [role="dialog"], .scrim')) return
      e.preventDefault()
      cancel(id)
    }
    const onPaste = (e: ClipboardEvent): void => {
      // ⌘V with nothing editable focused, in an empty workbench, goes to the ghost's URL.
      const http = useHttp.getState()
      const wsId = useApp.getState().activeWorkspaceId
      const el = document.activeElement as HTMLElement | null
      if (useApp.getState().activity !== 'http' || http.activeTab[wsId]) return
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return
      const text = e.clipboardData?.getData('text/plain').trim()
      const ghost = http.ghost[wsId]
      if (!text || !ghost?.draft) return
      e.preventDefault()
      http.updateDraft(ghost.id, { ...(ghost.draft as HttpRequest), url: text })
      focusUrl()
    }
    window.addEventListener('keydown', onKey)
    document.addEventListener('paste', onPaste)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.removeEventListener('paste', onPaste)
    }
  }, [])

  // Requests from inside the panes for things the workbench hosts: error-state
  // fixes that act outside the pane (the pane handles its own and stops them),
  // the URL row's commands, and "Set as variable…" from the URL or the body.
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const onFix = (e: Event): void => {
      const { tabId, action } = (e as CustomEvent<HttpFixDetail>).detail ?? {}
      if (tabId && runFix(tabId, action)) e.stopPropagation()
    }
    const onCommand = (e: Event): void => {
      const { tabId, command } = (e as CustomEvent<HttpCommandDetail>).detail ?? {}
      if (command === 'import-curl') useHttp.getState().openImport()
      else if (tabId && command === 'copy-curl') void copyCurl(tabId)
      else if (tabId && command === 'copy-curl-secrets') setCurlSecrets(tabId)
      else return
      e.stopPropagation()
    }
    const onSetVariable = (e: Event): void => {
      const detail = (e as CustomEvent<SetVariableDetail>).detail
      if (!detail) return
      e.stopPropagation()
      setSetVariable(detail)
    }
    root.addEventListener(HTTP_FIX_EVENT, onFix)
    root.addEventListener(HTTP_COMMAND_EVENT, onCommand)
    root.addEventListener(HTTP_SET_VARIABLE_EVENT, onSetVariable)
    return () => {
      root.removeEventListener(HTTP_FIX_EVENT, onFix)
      root.removeEventListener(HTTP_COMMAND_EVENT, onCommand)
      root.removeEventListener(HTTP_SET_VARIABLE_EVENT, onSetVariable)
    }
  }, [rootRef])

  const shown = activeId ?? ghostId
  const close = (): void => useHttp.getState().setOverlay(null)
  return (
    <div className="hc-workbench" ref={rootRef}>
      <UpgradeBanner onRecover={recoverOldData} />
      <HttpTabStrip
        // §2.1: on a narrow strip the picker shrinks to its swatch and PROD badge.
        envPicker={<EnvironmentPicker tabId={shown ?? undefined} compact={width > 0 && width < COMPACT_STRIP} />}
        forced={orientationFor(width, orientationPref).forced}
      />
      <div className="hc-surface">{shown && <Surface key={shown} tabId={shown} />}</div>
      {pendingClose && <ClosePrompt ids={pendingClose} />}
      {overlay === 'cookies' && <CookiesPopover onClose={close} />}
      {overlay === 'import' && <ImportDialog onClose={close} reimportInto={importTarget ?? undefined} />}
      {overlay === 'save' && activeId && <SaveHost tabId={activeId} onClose={close} />}
      {setVariable && (
        <SetVariableDialog
          initialName={setVariable.name}
          value={setVariable.value}
          collectionId={useHttp.getState().tabs.find((t) => t.id === setVariable.tabId)?.ref?.collectionId}
          onClose={() => setSetVariable(null)}
        />
      )}
      <ProductionPrompt />
      {curlSecrets && (
        <Modal
          title="Copy as cURL with secrets?"
          subtitle="Vault values and credentials go onto the clipboard as plain text, where any app can read them."
          onClose={() => setCurlSecrets(null)}
          confirm={{
            label: 'Copy with secrets',
            destructive: true,
            onClick: () => {
              void copyAsCurl(curlSecrets, { secrets: 'include' })
              setCurlSecrets(null)
            }
          }}
        >
          {null}
        </Modal>
      )}
    </div>
  )
}

/** Below this strip width the environment picker is compact. */
const COMPACT_STRIP = 640

/** B's Save dialog, for the active tab's request and the route it sends from. */
function SaveHost({ tabId, onClose }: { tabId: Id; onClose: () => void }): React.JSX.Element | null {
  const tab = useHttp((s) => s.tabs.find((t) => t.id === tabId))
  const request = useHttp((s) => s.requestFor(tabId))
  if (!tab || !request) return null
  const route = useApi.getState().effectiveRoute(tab)
  return (
    <SaveRequestDialog
      request={request}
      // A request whose collection was deleted has no route of its own: its
      // placeholder must not be saved, or synced, as a server route.
      route={isCollectionGone(route) ? { kind: 'direct' } : route}
      onSaved={(ref) => useHttp.getState().attachRef(tabId, ref)}
      onClose={onClose}
    />
  )
}

const isCollectionGone = (route: Route): boolean =>
  route.kind === 'server' && route.serverId === COLLECTION_GONE_SERVER_ID

/** The production confirm (§2.18). A's send layer raises it; this answers it. */
function ProductionPrompt(): React.JSX.Element | null {
  const prompt = useHttpRuntime((s) => s.prompt)
  const [skip, setSkip] = useState(false)
  if (!prompt) return null
  const answer = (send: boolean): void => {
    useHttpRuntime.getState().answer(send, send && skip)
    setSkip(false)
  }
  return (
    <Modal
      title={`Send ${prompt.action} to production (${prompt.target}${prompt.via ? `, via ${prompt.via}` : ''})?`}
      onClose={() => answer(false)}
      confirm={{ label: 'Send', onClick: () => answer(true), destructive: true }}
    >
      <label className="row">
        <input type="checkbox" checked={skip} onChange={(e) => setSkip(e.target.checked)} /> {prompt.skipLabel}
      </label>
    </Modal>
  )
}

/** One tab's content, chosen by what the tab holds. Keyed by tab id, so a promoted ghost keeps its tree. */
function Surface({ tabId }: { tabId: Id }): React.JSX.Element | null {
  const tab = useTabOrGhost(tabId)
  const kind = useHttp((s) => s.requestFor(tabId)?.kind ?? null)
  if (!tab) return null
  if (tab.kind === 'collection') return tab.ref ? <CollectionTab tabId={tabId} /> : null
  if (tab.kind === 'environments') return <EnvironmentsTab tabId={tabId} />
  if (kind === 'ws') return <WsRequestPane tabId={tabId} />
  if (kind === 'graphql') return <GraphQlRequestPane tabId={tabId} />
  if (kind === 'http') return <HttpRequestPane tabId={tabId} />
  return (
    <div className="hc-empty-body">
      <div className="hc-empty-title">This request no longer exists</div>
      <div>It was deleted from its collection, here or on another device.</div>
      <div className="hc-empty-actions">
        <button className="btn" onClick={() => closeNow([tabId])}>
          Close tab
        </button>
      </div>
    </div>
  )
}

/** One prompt for every tab a close would lose something from (§2.9, UX-m7). */
function ClosePrompt({ ids }: { ids: Id[] }): React.JSX.Element {
  const plan = planClose(ids)
  const cancelClose = (): void => useHttp.getState().setPendingClose(null)
  if (plan.dirty.length === 0) {
    return (
      <Modal
        title={plan.prompt ?? 'Close?'}
        subtitle="The connection closes with the tab."
        onClose={cancelClose}
        confirm={{ label: 'Disconnect and close', onClick: () => closeNow(ids), destructive: true }}
      >
        {null}
      </Modal>
    )
  }
  const saveAll = (): void => {
    const http = useHttp.getState()
    // A tab whose saved request was deleted or moved cannot save in place: it
    // stays open, and goes to the Save dialog, rather than closing with its edits.
    const failed = plan.dirty.filter((id) => !http.saveInPlace(id))
    closeNow(ids.filter((id) => !failed.includes(id)))
    if (failed.length) {
      http.activateTab(failed[0])
      http.setOverlay('save')
    }
  }
  return (
    <Modal
      title={plan.prompt ?? 'Save changes?'}
      subtitle={`Your changes are lost if you don’t save them.${plan.connected.length ? ' The connection closes with the tab.' : ''}`}
      onClose={cancelClose}
      footer={
        <button className="btn" onClick={() => closeNow(ids)}>
          {plan.dirty.length === 1 ? 'Don’t save' : 'Discard'}
        </button>
      }
      confirm={{ label: plan.dirty.length === 1 ? 'Save' : 'Save all', onClick: saveAll }}
    >
      {null}
    </Modal>
  )
}

/**
 * The §2.8 fixes that act outside the response pane. Returns false for the
 * ones this root does not own (the pane's own, and D's disconnect-idle).
 */
export function runFix(tabId: Id, action: string): boolean {
  const http = useHttp.getState()
  const tab = http.tabs.find((t) => t.id === tabId)
  switch (action) {
    case 'route-menu':
      document.querySelector<HTMLElement>('[data-hc-route-chip]')?.click()
      return true
    case 'add-ca':
      if (!tab?.ref) return false
      http.openCollectionTab(tab.ref.collectionId, 'connection')
      return true
    case 'save-then-ca': {
      // The Save dialog first; once the scratch tab is a saved request, its collection's Connection tab.
      http.activateTab(tabId)
      http.setOverlay('save')
      const off = useHttp.subscribe((s) => {
        const saved = s.tabs.find((t) => t.id === tabId)?.ref
        if (saved) {
          off()
          useHttp.getState().openCollectionTab(saved.collectionId, 'connection')
        } else if (s.overlay !== 'save') off()
      })
      return true
    }
    case 'add-variable':
      // The environment picker's "Variables in this request…" is where a value is added.
      http.setOverlay('env')
      return true
    case 'review-env':
      // The Environments tab opens on whatever is held (B's EnvironmentsTab).
      http.openEnvironments()
      return true
    case 'review-collection':
      if (!tab?.ref) return false
      http.openCollectionTab(tab.ref.collectionId, 'connection')
      return true
    case 'restart':
      // Pending edits first: the relaunch would otherwise take the last 400 ms of them with it.
      void flushSave().finally(() => window.opsmaxx?.backup?.relaunch?.())
      return true
    case 'choose-vault':
      // The environment picker's "Variables in this request…" is where a
      // vault-backed value is re-chosen; the Auth tab shows its own field.
      http.setOverlay('env')
      return true
    default:
      return false
  }
}
