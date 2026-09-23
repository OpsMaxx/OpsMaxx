import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Copy, Download, Loader2, MoreHorizontal, Search, WrapText } from 'lucide-react'
import type { EditorView } from '@codemirror/view'
import { openSearchPanel } from '@codemirror/search'
import { foldAll, unfoldAll } from '@codemirror/language'
import type { HttpTabState, Id, ResponseState, SentView } from '../../../../../shared/apiModel'
import { presentError, type FixAction } from '../../../../../shared/httpErrors'
import type { HttpResponseOk } from '../../../../../shared/httpClient'
import { useHttp } from '../../../store/http'
import { useToasts } from '../../../store/toast'
import { isMac } from '../../../lib/shortcuts'
import { clsx } from '../../../lib/format'
import { Tabs } from '../../common/Tabs'
import { UnlockVaultButton } from '../../common/UnlockVaultButton'
import { ContextMenu, type MenuEntry } from '../../connections/ContextMenu'
import { SplitToggles } from '../ProtocolLayout'
import { BodyViewer } from './BodyViewer'
import { ResponseStatus, useElapsed, useResponse } from './ResponseStatus'
import { CookiesView, HeadersView, TimelineView } from './ResponseTables'
import { decodeText, headerValue, jsonNodeAt, suggestedFileName } from './bodyWindow'
import './response.css'

/** Reads `useHttp((s) => s.responses[tabId])` itself. */
export interface ResponsePaneProps {
  tabId: Id
}

/**
 * A fix button whose handler lives outside the response pane dispatches this,
 * bubbling, from the button. The protocol pane handles what it owns (timeout,
 * retry over http, send anyway) and stops it; the workbench handles the rest.
 */
export const HTTP_FIX_EVENT = 'hc-fix'
export interface HttpFixDetail {
  tabId: Id
  action: FixAction
}

/** "Set as variable…" from the body; whoever hosts the dialog opens it pre-filled. */
export const HTTP_SET_VARIABLE_EVENT = 'hc-set-variable'
export interface SetVariableDetail {
  tabId: Id
  name: string
  value: string
}

type ResponseTab = 'body' | 'headers' | 'cookies' | 'timeline'
const mod = (): string => (isMac() ? '⌘' : 'Ctrl+')

export function tabById(s: { tabs: HttpTabState[]; ghost: Record<Id, HttpTabState> }, id: Id): HttpTabState | undefined {
  return s.tabs.find((t) => t.id === id) ?? Object.values(s.ghost).find((t) => t.id === id)
}

/** The one sentence a screen reader hears per send. Never per frame, never per keystroke. */
function announcement(r: ResponseState): string {
  if (r.status === 'done') {
    return `${r.response.status} ${r.response.statusText}, ${Math.round(r.response.durationMs)} milliseconds`
  }
  if (r.status === 'error' && r.errorClass !== 'prod-declined') return presentError(r.errorClass, r.message).message
  return ''
}

/**
 * An unresolved variable in the scheme or host would send the request
 * somewhere the user never named, so "Send anyway" is not offered for it.
 */
export function unresolvedInOrigin(url: string, names: string[]): boolean {
  const scheme = /^[^/]*:\/\//.exec(url)?.[0] ?? ''
  const origin = scheme + url.slice(scheme.length).split(/[/?#]/)[0]
  return names.some((n) => origin.includes(`{{${n}}}`))
}

/** GraphQL's `errors[].message`, from a 200 whose body reports failures. */
export function graphqlErrors(text: string): string[] {
  try {
    const parsed = JSON.parse(text) as { errors?: { message?: unknown }[] }
    return Array.isArray(parsed.errors) ? parsed.errors.map((e) => String(e?.message ?? 'Unknown error')) : []
  } catch {
    return []
  }
}

function dispatch<T>(el: HTMLElement | null, type: string, detail: T): void {
  el?.dispatchEvent(new CustomEvent<T>(type, { bubbles: true, detail }))
}

export function ResponsePane({ tabId }: ResponsePaneProps): React.JSX.Element {
  const r = useResponse(tabId)
  return (
    <div className="hc-resp">
      <div className="hc-response-status">
        <ResponseStatus tabId={tabId} />
        <span className="hc-grow" />
        <SplitToggles tabId={tabId} />
      </div>
      {r.status === 'done' ? (
        <DoneView tabId={tabId} response={r.response} sent={r.sentAs} />
      ) : (
        <div className="hc-response-state">
          <StateView tabId={tabId} r={r} />
        </div>
      )}
      <div className="hc-sr" aria-live="polite">
        {announcement(r)}
      </div>
    </div>
  )
}

function StateView({ tabId, r }: { tabId: Id; r: Exclude<ResponseState, { status: 'done' }> }): React.JSX.Element | null {
  const elapsed = useElapsed(r.status === 'sending' ? r.startedAt : null)
  const tab = useHttp((s) => tabById(s, tabId))

  if (r.status === 'idle') return <p className="hc-state-hint">Send the request to see the response · {mod()}↵</p>
  if (r.status === 'sending') {
    return (
      <p className="hc-state-hint">
        <Loader2 size={16} className="spin" aria-hidden /> Waiting for response · {elapsed} · Esc cancels
      </p>
    )
  }
  if (r.errorClass === 'prod-declined') return null

  const draft = tab?.draft
  const shown = presentError(r.errorClass, r.message, {
    scratch: !tab?.ref,
    timeoutMs: draft && draft.kind !== 'ws' ? draft.settings.timeoutMs : undefined
  })
  const canSendAnyway =
    r.errorClass === 'unresolved-variable' && !unresolvedInOrigin(draft?.url ?? '', r.unresolved ?? [])
  const fix = (action: FixAction, label: string, primary: boolean): React.JSX.Element => (
    <button
      className={clsx('btn sm', primary && 'primary')}
      onClick={(e) => dispatch<HttpFixDetail>(e.currentTarget, HTTP_FIX_EVENT, { tabId, action })}
    >
      {label}
    </button>
  )

  return (
    <div className="hc-error" role="alert">
      <p className="hc-error-title">
        <AlertTriangle size={16} aria-hidden /> {shown.message}
      </p>
      {shown.detail && <p className="hc-error-detail">{shown.detail}</p>}
      <div className="hc-error-actions">
        {shown.fix?.action === 'unlock' ? (
          <UnlockVaultButton reason="This request uses a value from the vault." className="btn sm primary" />
        ) : (
          shown.fix && fix(shown.fix.action, shown.fix.label, true)
        )}
        {canSendAnyway && fix('send-anyway', 'Send anyway', false)}
      </div>
    </div>
  )
}

function DoneView({ tabId, response, sent }: { tabId: Id; response: HttpResponseOk; sent: SentView }): React.JSX.Element {
  const [tab, setTab] = useState<ResponseTab>('body')
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [narrow, setNarrow] = useState(false)
  const editorRef = useRef<EditorView>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const wrap = useHttp((s) => s.prefs.wrap)
  const setPrefs = useHttp((s) => s.setPrefs)
  const httpTab = useHttp((s) => tabById(s, tabId))
  const push = useToasts((s) => s.push)
  const contentType = headerValue(response.headers, 'content-type')
  const fullText = useMemo(() => decodeText(new Uint8Array(response.body), contentType), [response, contentType])
  const kind = httpTab?.draft?.kind
  const gqlErrors = useMemo(() => (kind === 'graphql' ? graphqlErrors(fullText) : []), [kind, fullText])

  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    // The tools fold into ⋯ below 700px (UX-m12).
    const ro = new ResizeObserver(([entry]) => setNarrow(entry.contentRect.width < 700))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const copy = (text: string, what: string): void => {
    window.opsmaxx.clipboard.write(text)
    push(`${what} copied`, 'ok')
  }
  const save = async (): Promise<void> => {
    const path = await window.opsmaxx.http.saveResponse(suggestedFileName(sent.url, contentType), response.body)
    if (path) push(`Saved to ${path}`, 'ok')
  }
  const withView = (fn: (v: EditorView) => unknown) => (): void => {
    if (editorRef.current) fn(editorRef.current)
  }
  const selection = (): string => {
    const v = editorRef.current
    if (!v) return ''
    const { from, to } = v.state.selection.main
    return v.state.sliceDoc(from, to)
  }
  /** The selection, else the JSON value under the caret. */
  const target = (): { key?: string; value: string } | null => {
    const v = editorRef.current
    if (!v) return null
    const sel = selection()
    return sel ? { value: sel } : jsonNodeAt(v.state.doc.toString(), v.state.selection.main.head)
  }

  const bodyMenu = (): MenuEntry[] => {
    const node = target()
    return [
      { label: 'Copy', disabled: selection() === '', onClick: () => copy(selection(), 'Selection') },
      {
        label: 'Select all',
        onClick: withView((v) => {
          v.dispatch({ selection: { anchor: 0, head: v.state.doc.length } })
          v.focus()
        })
      },
      { label: 'Find…', shortcut: `${mod()}F`, onClick: withView(openSearchPanel) },
      { label: 'Wrap lines', checked: wrap, onClick: () => setPrefs({ wrap: !wrap }) },
      { label: 'Fold all', onClick: withView(foldAll) },
      { label: 'Unfold all', onClick: withView(unfoldAll) },
      { label: '', separator: true },
      { label: 'Copy value', disabled: !node, onClick: () => node && copy(node.value, 'Value') },
      {
        label: 'Set as variable…',
        disabled: !node,
        onClick: () =>
          node &&
          dispatch<SetVariableDetail>(rootRef.current, HTTP_SET_VARIABLE_EVENT, {
            tabId,
            name: node.key ?? '',
            value: node.value
          })
      },
      { label: '', separator: true },
      { label: 'Copy response', onClick: () => copy(fullText, 'Response') },
      { label: 'Save response to file…', onClick: () => void save() }
    ]
  }

  const tools =
    tab !== 'body' ? null : (
      <span className="hc-tools">
        <button
          className="btn ghost sm"
          aria-label={`Find (${mod()}F)`}
          title={`Find (${mod()}F)`}
          onClick={withView(openSearchPanel)}
        >
          <Search size={14} />
        </button>
        {!narrow && (
          <>
            <button
              className="btn ghost sm"
              aria-label="Wrap lines"
              title="Wrap lines"
              aria-pressed={wrap}
              onClick={() => setPrefs({ wrap: !wrap })}
            >
              <WrapText size={14} />
            </button>
            <button
              className="btn ghost sm"
              aria-label="Copy response"
              title="Copy response"
              onClick={() => copy(fullText, 'Response')}
            >
              <Copy size={14} />
            </button>
            <button
              className="btn ghost sm"
              aria-label="Save response to file"
              title="Save response to file"
              onClick={() => void save()}
            >
              <Download size={14} />
            </button>
          </>
        )}
        <button
          className="btn ghost sm"
          aria-label="More body actions"
          title="More body actions"
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect()
            setMenu({ x: rect.left, y: rect.bottom })
          }}
        >
          <MoreHorizontal size={14} />
        </button>
      </span>
    )

  return (
    <div className="hc-response-done" ref={rootRef}>
      <Tabs
        ariaLabel="Response"
        idPrefix={`${tabId}-resp`}
        active={tab}
        onChange={(id) => setTab(id as ResponseTab)}
        tabs={[
          { id: 'body', label: 'Body' },
          { id: 'headers', label: 'Headers', count: Object.keys(response.headers).length },
          { id: 'cookies', label: 'Cookies', count: response.setCookie?.length ?? 0 },
          { id: 'timeline', label: 'Timeline' }
        ]}
        trailing={tools}
      />
      {gqlErrors.length > 0 && tab === 'body' && (
        <div className="hc-strip hc-danger" role="note">
          {gqlErrors.length} error{gqlErrors.length === 1 ? '' : 's'} · first: {gqlErrors[0]}
        </div>
      )}
      <div
        className="hc-response-panel"
        role="tabpanel"
        id={`${tabId}-resp-panel`}
        aria-labelledby={`${tabId}-resp-tab-${tab}`}
        onContextMenu={(e) => {
          if (tab !== 'body') return
          e.preventDefault()
          setMenu({ x: e.clientX, y: e.clientY })
        }}
        onKeyDown={(e) => {
          if (tab === 'body' && (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10'))) {
            e.preventDefault()
            const rect = e.currentTarget.getBoundingClientRect()
            setMenu({ x: rect.left + 24, y: rect.top + 24 })
          }
        }}
      >
        {tab === 'body' && (
          <BodyViewer
            response={response}
            wrap={wrap}
            editorRef={editorRef}
            onSave={() => void save()}
            onCopyAll={() => copy(fullText, 'Response')}
          />
        )}
        {tab === 'headers' && <HeadersView headers={response.headers} />}
        {tab === 'cookies' && (
          <CookiesView response={response} sent={sent} workspaceId={httpTab?.workspaceId ?? ''} />
        )}
        {tab === 'timeline' && <TimelineView sent={sent} response={response} />}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} entries={bodyMenu()} onClose={() => setMenu(null)} />}
    </div>
  )
}
