import { useEffect, useMemo, useState } from 'react'
import { Play } from 'lucide-react'
import { EditorView } from '@codemirror/view'
import { redo, undo } from '@codemirror/commands'
import type { HttpRequest, HttpTabState, Id } from '../../../../../shared/apiModel'
import { parseCurl } from '../../../../../shared/curl'
import { maskUrl } from '../../../../../shared/apiUrl'
import { resolveTemplate, type VariableScopeChain } from '../../../../../shared/apiVariables'
import { useHttp } from '../../../store/http'
import { useApi } from '../../../store/api'
import { useToasts } from '../../../store/toast'
import { cancel, send } from '../../../lib/httpSend'
import { isMac } from '../../../lib/shortcuts'
import { SplitButton } from '../../common/SplitButton'
import { ContextMenu, type MenuEntry } from '../../connections/ContextMenu'
import { VariableInput } from '../fields/VariableInput'
import { RouteChip } from '../RouteChip'
import { TlsChip } from '../TlsChip'
import { HTTP_SET_VARIABLE_EVENT, tabById, type SetVariableDetail } from '../response/ResponsePane'
import { suggestedFileName, headerValue } from '../response/bodyWindow'
import { METHODS, METHOD_ABBR, methodToken, syncFromUrl, withResolvedScheme } from './requestModel'
import { urlRowLayout, useWidth } from '../ProtocolLayout'
import './request.css'

export interface UrlBarProps {
  tabId: Id
  /** The empty workbench's ghost row: the first keystroke promotes it. */
  ghost?: boolean
}

/**
 * Copy as cURL, which ⇧⌘C and the tree also reach, so it runs in one place. Dispatched
 * bubbling from the row, like `hc-fix`.
 */
export const HTTP_COMMAND_EVENT = 'hc-command'
export interface HttpCommandDetail {
  tabId: Id
  command: 'copy-curl' | 'copy-curl-secrets' | 'import-curl'
}

/** The request a tab shows: its draft, else the saved request it points at. */
export function useHttpRequest(tabId: Id): HttpRequest | null {
  const tab = useHttp((s) => tabById(s, tabId))
  const saved = useApi((s) =>
    tab?.ref?.requestId ? s.findRequest(tab.ref.collectionId, tab.ref.requestId) : null
  )
  const req = tab?.draft ?? saved
  return req?.kind === 'http' ? req : null
}

const mod = (): string => (isMac() ? '⌘' : 'Ctrl+')

/**
 * Send a REST tab: the scheme a bare host was given is written back into the
 * URL first (§2.11), so what the user sees is what was sent.
 */
export async function sendTab(tabId: Id): Promise<void> {
  const tab = tabById(useHttp.getState(), tabId)
  const draft = tab?.draft
  if (draft?.kind === 'http') {
    const url = withResolvedScheme(draft.url)
    if (url !== draft.url) useHttp.getState().updateDraft(tabId, syncFromUrl(draft, url))
  }
  await send(tabId)
}

const NO_CHAIN: VariableScopeChain = { layers: [] }

/** The tab's variable scopes, recomputed only when the saved data changes. */
export function useScopeChain(tab: HttpTabState | undefined): VariableScopeChain {
  const workspace = useApi((s) => s.workspace)
  const collections = useApi((s) => s.collections)
  return useMemo(
    () => (tab ? useApi.getState().scopeChainFor(tab) : NO_CHAIN),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scopeChainFor reads exactly these
    [tab, workspace, collections]
  )
}

export function UrlBar({ tabId, ghost }: UrlBarProps): React.JSX.Element | null {
  const req = useHttpRequest(tabId)
  const tab = useHttp((s) => tabById(s, tabId))
  const sending = useHttp((s) => s.responses[tabId]?.status === 'sending')
  const updateDraft = useHttp((s) => s.updateDraft)
  const chain = useScopeChain(tab)
  // The empty workbench hands this row its ghost tab, which is not in `tabs`.
  const isGhost = useHttp((s) => !s.tabs.some((t) => t.id === tabId)) || !!ghost
  const tls = useApi((s) => {
    const c = tab?.ref ? s.collections.find((col) => col.id === tab.ref!.collectionId) : undefined
    return !!c && (c.insecureTls || !!c.caPem)
  })
  const push = useToasts((s) => s.push)
  const [rowRef, width] = useWidth<HTMLDivElement>()
  // Unmeasured (0) is not narrow: lay out in full until the row reports a width.
  const layout = urlRowLayout(width || Number.POSITIVE_INFINITY, { tls })
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)

  useEffect(() => {
    // F6 and new-tab focus land on [data-hc-url] (http/focus.ts).
    rowRef.current?.querySelector('.hc-url .cm-content')?.setAttribute('data-hc-url', '')
  })
  useEffect(() => {
    // First run and the empty workbench: the ghost URL is where typing goes.
    if (isGhost) rowRef.current?.querySelector<HTMLElement>('.hc-url .cm-content, .hc-url input')?.focus()
  }, [isGhost, rowRef])

  if (!req || !tab) return null

  const update = (next: HttpRequest): void => updateDraft(tabId, next)
  const command = (c: HttpCommandDetail['command']): void => {
    rowRef.current?.dispatchEvent(
      new CustomEvent<HttpCommandDetail>(HTTP_COMMAND_EVENT, { bubbles: true, detail: { tabId, command: c } })
    )
  }

  const doSend = (): Promise<void> => sendTab(tabId)
  const sendAndDownload = async (): Promise<void> => {
    await doSend()
    const r = useHttp.getState().responses[tabId]
    if (r?.status !== 'done') return
    const name = suggestedFileName(r.sentAs.url, headerValue(r.response.headers, 'content-type'))
    const path = await window.opsmaxx.http.saveResponse(name, r.response.body)
    if (path) push(`Saved to ${path}`, 'ok')
  }

  /** A pasted `curl …` becomes a request: this one when scratch, a new tab when saved (UX-M12). */
  const onPaste = (text: string): boolean => {
    if (!/^\s*curl\s/.test(text)) return false
    const parsed = parseCurl(text)
    if (!parsed.ok) {
      push(`Not imported: ${parsed.error}`, 'error')
      return true
    }
    const notes = parsed.notes.length ? ` · ${parsed.notes.join(' ')}` : ''
    if (!tab.ref) {
      const before = req
      update({ ...parsed.request, id: req.id, name: req.name })
      push(`Imported from cURL${notes}`, 'ok', { label: 'Undo', run: () => updateDraft(tabId, before) })
    } else {
      const newTab = useHttp.getState().openScratch('http', parsed.request)
      push(`Imported into a new tab${notes}`, 'ok', {
        label: 'Replace this request instead',
        run: () => {
          updateDraft(tabId, { ...parsed.request, id: req.id, name: req.name })
          useHttp.getState().closeTab(newTab)
        }
      })
    }
    return true
  }

  const view = (): EditorView | null => {
    const el = rowRef.current?.querySelector<HTMLElement>('.hc-url .cm-editor')
    return el ? EditorView.findFromDOM(el) : null
  }
  const selection = (): string => {
    const v = view()
    return v ? v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to) : ''
  }
  const urlMenu = (): MenuEntry[] => {
    const sel = selection()
    const v = view()
    return [
      { label: 'Undo', shortcut: `${mod()}Z`, disabled: !v, onClick: () => v && undo(v) },
      { label: 'Redo', shortcut: isMac() ? '⇧⌘Z' : 'Ctrl+Shift+Z', disabled: !v, onClick: () => v && redo(v) },
      { label: '', separator: true },
      {
        label: 'Cut',
        disabled: !sel,
        onClick: () => {
          window.opsmaxx.clipboard.write(sel)
          v?.dispatch(v.state.replaceSelection(''))
        }
      },
      { label: 'Copy', disabled: !sel, onClick: () => window.opsmaxx.clipboard.write(sel) },
      {
        label: 'Paste',
        disabled: !v,
        onClick: () =>
          void window.opsmaxx.clipboard.read().then((text) => {
            if (!onPaste(text) && v) v.dispatch(v.state.replaceSelection(text.replace(/\s*\n\s*/g, '')))
          })
      },
      { label: 'Select all', disabled: !v, onClick: () => v?.dispatch({ selection: { anchor: 0, head: v.state.doc.length } }) },
      { label: 'Paste cURL…', onClick: () => useHttp.getState().setOverlay('import') },
      ...(sel
        ? [
            { label: '', separator: true },
            {
              label: 'Set as variable…',
              onClick: () =>
                rowRef.current?.dispatchEvent(
                  new CustomEvent<SetVariableDetail>(HTTP_SET_VARIABLE_EVENT, {
                    bubbles: true,
                    detail: { tabId, name: '', value: sel }
                  })
                )
            }
          ]
        : []),
      { label: '', separator: true },
      {
        label: 'Copy resolved URL',
        // Variables resolved; vault values and sensitive query values masked.
        onClick: () => window.opsmaxx.clipboard.write(maskUrl(resolveTemplate(req.url, chain).text))
      }
    ]
  }

  const methodLabel = (m: string): string => (layout.methodAbbrev ? (METHOD_ABBR[m] ?? m) : m)
  const sendLabel = `Send (${mod()}↵)`

  return (
    <div
      ref={rowRef}
      className="hc-urlbar"
      data-step={layout.step}
      onContextMenu={(e) => {
        if (!(e.target as HTMLElement).closest('.hc-url')) return
        e.preventDefault()
        setMenu({ x: e.clientX, y: e.clientY })
      }}
      onKeyDown={(e) => {
        if ((e.target as HTMLElement).closest('.hc-url') && (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10'))) {
          e.preventDefault()
          const r = (e.target as HTMLElement).getBoundingClientRect()
          setMenu({ x: r.left, y: r.bottom })
        }
      }}
    >
      <select
        className="hc-method"
        aria-label="Method"
        value={req.method}
        style={{ color: `var(${methodToken(req.method)})` }}
        onChange={(e) => update({ ...req, method: e.target.value })}
      >
        {METHODS.map((m) => (
          <option key={m} value={m}>
            {methodLabel(m)}
          </option>
        ))}
      </select>
      <div className="hc-url" style={width ? { flexBasis: layout.urlWidth } : undefined}>
        <VariableInput
          value={req.url}
          onChange={(url) => update(syncFromUrl(req, url))}
          chain={chain}
          ariaLabel="URL"
          placeholder={isGhost ? 'Paste a URL or a curl command' : 'https://api.example.com/path'}
          onSubmit={() => void doSend()}
          onPaste={onPaste}
        />
      </div>
      <RouteChip tabId={tabId} compact={layout.routeIcon} />
      <TlsChip tabId={tabId} compact={layout.tlsIcon} />
      <div className="hc-send">
        <SplitButton
          label={sending ? 'Cancel' : 'Send'}
          icon={sending ? undefined : <Play size={14} />}
          variant={sending ? 'danger' : 'primary'}
          busy={sending}
          iconOnly={layout.sendIcon}
          ariaLabel={sending ? 'Cancel (Esc)' : sendLabel}
          onClick={() => (sending ? cancel(tabId) : void doSend())}
          entries={[
            { label: 'Send and download…', disabled: sending, onClick: () => void sendAndDownload() },
            { label: 'Copy as cURL', shortcut: isMac() ? '⇧⌘C' : 'Ctrl+Shift+C', onClick: () => command('copy-curl') },
            { label: 'Copy as cURL (with secrets)…', onClick: () => command('copy-curl-secrets') }
          ]}
        />
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} entries={urlMenu()} onClose={() => setMenu(null)} />}
    </div>
  )
}
