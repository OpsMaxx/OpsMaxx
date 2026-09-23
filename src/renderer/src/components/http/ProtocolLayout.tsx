import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import {
  DEFAULT_PREFS,
  type HttpLayoutPrefs,
  type HttpTabState,
  type Id,
  type RequestKind,
  type SplitState
} from '../../../../shared/apiModel'
import { SplitPane } from '../common/SplitPane'
import { ContextMenu } from '../connections/ContextMenu'
import { useHttp } from '../../store/http'
import { useApi } from '../../store/api'
import { useApp } from '../../store/app'
import { clsx } from '../../lib/format'
import { keyLabel, withKey } from './hotkeys'
import { focusUrl } from './focus'
import { layoutMenuEntries } from './tabs/layoutMenu'
import './http.css'

// One grid for every protocol (§2.2): URL row, then the request and response
// halves in a SplitPane that is side by side or stacked by width, and that can
// collapse either half to a 32px bar that keeps its live summary. Nothing is
// ever 0px (§2.4).

export interface ProtocolLayoutProps {
  tabId: Id
  kind: RequestKind
  bar: ReactNode
  requestTabs: ReactNode
  requestToolbar?: ReactNode
  request: ReactNode
  response: ReactNode
  /** Shown in the request half's collapsed bar. */
  requestSummary: ReactNode
  /** Shown in the response half's collapsed bar. */
  responseSummary: ReactNode
}

/** One pane's floor side by side; two of them plus the splitter is what "Side by side" needs. */
export const SIDE_MIN = 280
const SPLITTER = 4
/** `auto` goes side by side at this width and wider. */
export const AUTO_SIDE_BY_SIDE = 800
const STACKED_MIN = 96

export type Orientation = 'horizontal' | 'vertical'

/**
 * Side by side (`horizontal`) or stacked (`vertical`) for a workbench `width`.
 * An explicit side by side that cannot fit renders stacked, and says so through
 * `forced` so the Layout menu can annotate it.
 */
export function orientationFor(
  width: number,
  pref: HttpLayoutPrefs['orientation']
): { orientation: Orientation; forced: boolean } {
  if (pref === 'vertical') return { orientation: 'vertical', forced: false }
  if (pref === 'horizontal') {
    const fits = width >= 2 * SIDE_MIN + SPLITTER
    return { orientation: fits ? 'horizontal' : 'vertical', forced: !fits }
  }
  return {
    orientation: width >= AUTO_SIDE_BY_SIDE ? 'horizontal' : 'vertical',
    forced: false
  }
}

/** The request half's share for a protocol in an orientation (§2.2's six numbers). */
export function ratioFor(prefs: HttpLayoutPrefs, kind: RequestKind, orientation: Orientation): number {
  return prefs.ratios[kind][orientation === 'horizontal' ? 'h' : 'v']
}

/** The prefs patch that stores a dragged ratio for one protocol and orientation. */
export function withRatio(
  prefs: HttpLayoutPrefs,
  kind: RequestKind,
  orientation: Orientation,
  ratio: number
): Pick<HttpLayoutPrefs, 'ratios'> {
  const key = orientation === 'horizontal' ? 'h' : 'v'
  return {
    ratios: {
      ...prefs.ratios,
      [kind]: { ...prefs.ratios[kind], [key]: ratio }
    }
  }
}

// §2.1's URL row, in px. The URL is shrunk last, and never below `urlMin`.
const ROW = {
  chrome: 32, // padding and the gaps
  method: 76,
  methodAbbrev: 60,
  route: 160,
  icon: 32,
  tls: 128,
  send: 104,
  sendIcon: 40,
  /** What the URL keeps before anything else gives way. */
  urlComfort: 280,
  urlMin: 120
}

export interface UrlRowLayout {
  /** How many of §2.1's steps 1–4 were applied. */
  step: 0 | 1 | 2 | 3 | 4
  routeIcon: boolean
  sendIcon: boolean
  /** The TLS chip as an icon. There is deliberately no way to remove it. */
  tlsIcon: boolean
  methodAbbrev: boolean
  urlWidth: number
}

/**
 * The URL row's degradation (§2.1) for a row `width`, as a pure function so the
 * order is a unit test rather than something seen only at 448px. Steps apply
 * one at a time until the URL keeps its comfortable width; after step 4 the URL
 * itself shrinks, to 120px. Below that the workbench scrolls (its 440px floor).
 */
export function urlRowLayout(width: number, opts: { tls: boolean }): UrlRowLayout {
  const fixed = (step: number): number =>
    ROW.chrome +
    (step >= 4 ? ROW.methodAbbrev : ROW.method) +
    (step >= 1 ? ROW.icon : ROW.route) +
    (step >= 2 ? ROW.sendIcon : ROW.send) +
    (opts.tls ? (step >= 3 ? ROW.icon : ROW.tls) : 0)
  let step = 0
  while (step < 4 && width - fixed(step) < ROW.urlComfort) step++
  return {
    step: step as UrlRowLayout['step'],
    routeIcon: step >= 1,
    sendIcon: step >= 2,
    tlsIcon: step >= 3,
    methodAbbrev: step >= 4,
    urlWidth: Math.max(ROW.urlMin, Math.min(ROW.urlComfort, width - fixed(step)))
  }
}

/** The width of an element, kept current. 0 until measured, and always 0 in jsdom. */
export function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const node = ref.current
    if (!node) return
    setWidth(node.getBoundingClientRect().width)
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    ro.observe(node)
    return () => ro.disconnect()
  }, [])
  return [ref, width]
}

const PROD_TAG = /^prod(uction)?$/i

/**
 * Whether this tab sends to production (§2.11, §2.18): the active environment
 * is flagged, or the effective route's server is tagged prod/production.
 */
export function isProductionTarget(tab: HttpTabState): boolean {
  const api = useApi.getState()
  const { activeEnvironment, environments } = api.workspace
  const envId = Object.hasOwn(activeEnvironment, tab.workspaceId) ? activeEnvironment[tab.workspaceId] : null
  if (environments.some((e) => e.id === envId && e.production)) return true
  const route = api.effectiveRoute(tab)
  if (route.kind !== 'server') return false
  const server = useApp.getState().servers.find((s) => s.id === route.serverId)
  return !!server?.tags?.some((t) => PROD_TAG.test(t))
}

export function useIsProduction(tabId: Id): boolean {
  const tab = useHttp((s) => s.tabs.find((t) => t.id === tabId) ?? Object.values(s.ghost).find((g) => g.id === tabId))
  // Subscribed so the rule follows environment, collection-route and server-tag changes.
  useApi((s) => s.workspace)
  useApi((s) => s.collections)
  useApp((s) => s.servers)
  return tab ? isProductionTarget(tab) : false
}

const collapsedSide = (split: SplitState): 'a' | 'b' | null =>
  split === 'request-collapsed' ? 'a' : split === 'response-collapsed' ? 'b' : null

const splitFor = (side: 'a' | 'b' | null): SplitState =>
  side === 'a' ? 'request-collapsed' : side === 'b' ? 'response-collapsed' : 'normal'

export function ProtocolLayout(props: ProtocolLayoutProps): React.JSX.Element {
  const { tabId, kind } = props
  // The ghost (§2.10) renders through this same tree, so promoting it on the
  // first keystroke changes what is below the URL row and nothing above it:
  // the URL editor keeps its element, its focus and its caret.
  const ghost = useHttp((s) => !s.tabs.some((t) => t.id === tabId))
  const split = useHttp((s) => s.tabs.find((t) => t.id === tabId)?.split ?? 'normal')
  const prefs = useHttp((s) => s.prefs)
  const setSplit = useHttp((s) => s.setSplit)
  const setPrefs = useHttp((s) => s.setPrefs)
  const production = useIsProduction(tabId)
  const [rootRef, width] = useWidth<HTMLDivElement>()
  const { orientation, forced } = orientationFor(width, prefs.orientation)
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null)
  const restore = (): void => setSplit(tabId, 'normal')

  return (
    <div ref={rootRef} className={clsx('hc-protocol', `hc-${orientation}`)}>
      <div className={clsx('hc-urlrow', production && 'hc-prod')} data-hc-region="url">
        {props.bar}
      </div>
      {ghost ? (
        <EmptyWorkbench />
      ) : (
        <SplitPane
          orientation={orientation}
          ratio={ratioFor(prefs, kind, orientation)}
          onRatio={(r) => setPrefs(withRatio(prefs, kind, orientation, r))}
          min={orientation === 'horizontal' ? [SIDE_MIN, SIDE_MIN] : [STACKED_MIN, STACKED_MIN]}
          collapsed={collapsedSide(split)}
          onCollapse={(side) => setSplit(tabId, splitFor(side))}
          label="Resize request and response"
          // Double-click restores §2.2's default; right-click, Shift+F10 or the ContextMenu key opens the Layout menu (§2.5).
          defaultRatio={DEFAULT_PREFS.ratios[kind][orientation === 'horizontal' ? 'h' : 'v']}
          onMenu={setMenuAt}
          collapsedA={
            // A click anywhere restores; a summary label's own click also opens its tab.
            <div className="hc-collapsed-bar" onClick={restore}>
              <span className="hc-collapsed-title">Request</span>
              <span className="hc-collapsed-summary">{props.requestSummary}</span>
              <RestoreButton label={withKey('Show request', 'http-toggle-request')} onClick={restore} down />
            </div>
          }
          collapsedB={
            <div className="hc-collapsed-bar" onClick={restore}>
              <span className="hc-collapsed-summary">{props.responseSummary}</span>
              <RestoreButton label={withKey('Show response', 'http-toggle-response')} onClick={restore} />
            </div>
          }
        >
          <section className="hc-request" aria-label="Request">
            <div className="hc-tabrow" data-hc-region="request-tabs">
              {props.requestTabs}
            </div>
            {props.requestToolbar && <div className="hc-toolbar">{props.requestToolbar}</div>}
            <div className="hc-pane-body">{props.request}</div>
          </section>
          <section className="hc-response" aria-label="Response" data-hc-region="response">
            {props.response}
          </section>
        </SplitPane>
      )}
      {menuAt && (
        <ContextMenu
          x={menuAt.x}
          y={menuAt.y}
          entries={layoutMenuEntries({ tabId, kind, forced })}
          onClose={() => setMenuAt(null)}
        />
      )}
    </div>
  )
}

function RestoreButton({
  label,
  onClick,
  down
}: {
  label: string
  onClick: () => void
  down?: boolean
}): React.JSX.Element {
  return (
    <button
      className="icon-btn xs"
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
    >
      {down ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
    </button>
  )
}

/**
 * The ▾ ▴ collapse controls for a response status row. The protocol panes (C,
 * D) render it at the right of their status row.
 */
export function SplitToggles({ tabId }: { tabId: Id }): React.JSX.Element {
  const split = useHttp((s) => s.tabs.find((t) => t.id === tabId)?.split ?? 'normal')
  const setSplit = useHttp((s) => s.setSplit)
  const toggle = (to: SplitState): void => setSplit(tabId, split === to ? 'normal' : to)
  const response = withKey(`${split === 'response-collapsed' ? 'Show' : 'Collapse'} response`, 'http-toggle-response')
  const request = withKey(`${split === 'request-collapsed' ? 'Show' : 'Collapse'} request`, 'http-toggle-request')
  return (
    <span className="hc-split-toggles">
      <button
        className={clsx('icon-btn xs', split === 'response-collapsed' && 'active')}
        aria-label={response}
        aria-pressed={split === 'response-collapsed'}
        title={response}
        onClick={() => toggle('response-collapsed')}
      >
        <ChevronDown size={14} />
      </button>
      <button
        className={clsx('icon-btn xs', split === 'request-collapsed' && 'active')}
        aria-label={request}
        aria-pressed={split === 'request-collapsed'}
        title={request}
        onClick={() => toggle('request-collapsed')}
      >
        <ChevronUp size={14} />
      </button>
    </span>
  )
}

/** Below the ghost's live URL row: what to do first, and the other ways in (§2.3). */
function EmptyWorkbench(): React.JSX.Element {
  const open = (kind: RequestKind): void => {
    useHttp.getState().openScratch(kind)
    focusUrl()
  }
  const newTab = keyLabel('new-terminal')
  const region = keyLabel('http-focus-region')
  return (
    <div className="hc-empty-body">
      <div className="hc-empty-title">Send a request</div>
      <div>Requests leave from this machine or through any server’s SSH connection.</div>
      <div className="hc-empty-actions">
        <button className="btn" onClick={() => open('ws')}>
          New WebSocket
        </button>
        <button className="btn" onClick={() => open('graphql')}>
          New GraphQL
        </button>
        <button className="btn" onClick={() => useHttp.getState().openImport()}>
          Import…
        </button>
        <span className="faint">
          {[newTab && `${newTab} new tab`, region && `${region} move focus`].filter(Boolean).join(' · ')}
        </span>
      </div>
    </div>
  )
}
