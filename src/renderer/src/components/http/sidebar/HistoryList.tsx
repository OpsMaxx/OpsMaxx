import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MoreHorizontal } from 'lucide-react'
import type { HistoryEntry } from '../../../../../shared/httpHistory'
import { useHttp } from '../../../store/http'
import { useApp } from '../../../store/app'
import { toast } from '../../../store/toast'
import { requestFromHistory, sendAgainFromHistory } from '../../../lib/httpSend'
import { ContextMenu, type MenuEntry } from '../../connections/ContextMenu'
import { Modal } from '../../common/Modal'
import { SaveRequestDialog } from '../dialogs/SaveRequestDialog'
import { MethodBadge } from './CollectionTree'
import { historyMenu, historySourceExists, type HistoryActions } from './treeMenus'

export const HISTORY_PAGE = 50

const DAY = 24 * 60 * 60 * 1000

/** "Today", "Yesterday", or the date, for the entry's local day. */
export function dayLabel(at: number, now = Date.now()): string {
  const start = (t: number): number => new Date(new Date(t).toDateString()).getTime()
  const days = Math.round((start(now) - start(at)) / DAY)
  return days === 0 ? 'Today' : days === 1 ? 'Yesterday' : new Date(at).toLocaleDateString()
}

/** Entries grouped by day, newest first, keeping their order within a day. */
export function groupByDay(entries: HistoryEntry[], now = Date.now()): { label: string; entries: HistoryEntry[] }[] {
  const out: { label: string; entries: HistoryEntry[] }[] = []
  for (const e of entries) {
    const label = dayLabel(e.at, now)
    const last = out.at(-1)
    if (last?.label === label) last.entries.push(e)
    else out.push({ label, entries: [e] })
  }
  return out
}

/**
 * Open a history entry as a scratch tab that keeps its route id (never "direct"
 * by default). History stores a redacted template, so every masked value is
 * listed in the tab's strippedFields, and the send layer refuses while any of
 * them still holds the mask: "•••" is never sent as a credential (M-a).
 */
export function openHistoryAsNew(e: HistoryEntry): void {
  const { request, strippedFields } = requestFromHistory(e)
  useHttp.getState().openScratch(e.kind, request, { route: e.route, strippedFields })
}

const time = (at: number): string => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

type Menu = { x: number; y: number; entries: MenuEntry[] }

/**
 * Sent requests, newest first, grouped by day. Kept by main (sealed with the
 * keyring, or in memory only); the filter is a plain substring match there.
 */
export function HistoryList({ query }: { query: string }): React.JSX.Element {
  const [entries, setEntries] = useState<HistoryEntry[]>([])
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [more, setMore] = useState(false)
  const [menu, setMenu] = useState<Menu | null>(null)
  const [saving, setSaving] = useState<HistoryEntry | null>(null)
  const [clearing, setClearing] = useState(false)
  const ws = useApp((s) => s.activeWorkspaceId)
  const [sealed, setSealed] = useState(true)
  const seq = useRef(0)

  useEffect(() => {
    let live = true
    void window.opsmaxx.httpHistory
      .sealed?.()
      .then((on) => live && setSealed(on))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])

  const load = useCallback(
    async (before?: number): Promise<void> => {
      const mine = ++seq.current
      if (before === undefined) setState('loading')
      try {
        // Main keeps a page to this workspace's entries (historyInWorkspace), before paging.
        const page = await window.opsmaxx.httpHistory.list({
          limit: HISTORY_PAGE,
          before,
          query: query.trim() || undefined,
          workspaceId: ws
        })
        if (mine !== seq.current) return
        setEntries((prev) => (before === undefined ? page : [...prev, ...page]))
        setMore(page.length === HISTORY_PAGE)
        setState('ready')
      } catch {
        if (mine === seq.current) setState('error')
      }
    },
    [query, ws]
  )

  useEffect(() => {
    const t = setTimeout(() => void load(), query ? 200 : 0)
    return () => clearTimeout(t)
  }, [load, query])

  const actions: HistoryActions = {
    sendAgain: (e) => void sendAgainFromHistory(e).catch(() => toast('Could not send the request again.', 'error')),
    openRequest: (e) => e.requestRef && useHttp.getState().openRequest(e.requestRef, { preview: false }),
    openAsNew: openHistoryAsNew,
    saveToCollection: (e) => setSaving(e),
    remove: (e) => {
      void window.opsmaxx.httpHistory
        .remove(e.id)
        .then(() => setEntries((prev) => prev.filter((x) => x.id !== e.id)))
        .catch(() => toast('Could not delete that history entry.', 'error'))
    }
  }

  const groups = useMemo(() => groupByDay(entries), [entries])
  const open = (e: HistoryEntry): void => (historySourceExists(e) ? actions.openRequest(e) : actions.openAsNew(e))

  return (
    <div className="hc-history">
      <div className="hc-history-head">
        <span className="ui-label">Recent requests</span>
        <button
          type="button"
          className="hc-icon-btn"
          aria-label="History options"
          title="History options"
          aria-haspopup="menu"
          onClick={(e) => {
            const b = e.currentTarget.getBoundingClientRect()
            setMenu({
              x: b.left,
              y: b.bottom,
              entries: [{ label: 'Clear all history…', danger: true, disabled: entries.length === 0, onClick: () => setClearing(true) }]
            })
          }}
        >
          <MoreHorizontal size={13} aria-hidden="true" />
        </button>
      </div>
      {!sealed && (
        <p className="hc-history-note" role="note">
          History is kept for this session only — this machine has no OS keyring.
        </p>
      )}
      {state === 'loading' && (
        <div className="hc-history-skeleton" aria-busy="true" aria-label="Loading history">
          <div />
          <div />
          <div />
        </div>
      )}
      {state === 'error' && (
        <div className="hc-history-note" role="alert">
          Could not read history.{' '}
          <button type="button" className="btn sm" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}
      {state === 'ready' && entries.length === 0 && (
        <p className="hc-history-note">
          {query ? `No history matches “${query}”.` : 'Requests you send appear here. History stays on this device.'}
        </p>
      )}
      {state === 'ready' &&
        groups.map((g) => (
          <section key={g.label} aria-label={g.label}>
            <h3 className="ui-label hc-history-day">{g.label}</h3>
            <ul className="hc-history-list">
              {g.entries.map((e) => (
                <li
                  key={e.id}
                  className="hc-history-row"
                  onContextMenu={(ev) => {
                    ev.preventDefault()
                    setMenu({ x: ev.clientX, y: ev.clientY, entries: historyMenu(e, actions) })
                  }}
                >
                  <button
                    type="button"
                    className="hc-history-open"
                    onClick={() => open(e)}
                    onKeyDown={(ev) => {
                      if ((ev.key === 'F10' && ev.shiftKey) || ev.key === 'ContextMenu') {
                        ev.preventDefault()
                        const b = ev.currentTarget.getBoundingClientRect()
                        setMenu({ x: b.left + 16, y: b.bottom, entries: historyMenu(e, actions) })
                      }
                    }}
                  >
                    <MethodBadge request={{ kind: e.kind, method: e.request.kind === 'http' ? e.request.method : undefined }} />
                    <span className="hc-history-url hc-mono">{e.request.url || e.request.name}</span>
                    {e.response ? (
                      <span className={`hc-status hc-status--${Math.floor(e.response.status / 100)}xx`}>{e.response.status}</span>
                    ) : e.errorClass ? (
                      <span className="hc-status hc-status--error">Error</span>
                    ) : null}
                    <span className="hc-history-time">{time(e.at)}</span>
                  </button>
                  <button
                    type="button"
                    tabIndex={-1}
                    className="hc-icon-btn hc-tree-more"
                    aria-label={`Actions for ${e.request.url || e.request.name}`}
                    title="Actions"
                    onClick={(ev) => {
                      const b = ev.currentTarget.getBoundingClientRect()
                      setMenu({ x: b.left, y: b.bottom, entries: historyMenu(e, actions) })
                    }}
                  >
                    <MoreHorizontal size={13} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      {state === 'ready' && more && (
        <button type="button" className="btn ghost sm hc-history-more" onClick={() => void load(entries.at(-1)?.at)}>
          Show older
        </button>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} entries={menu.entries} onClose={() => setMenu(null)} />}
      {saving && (
        <SaveRequestDialog
          request={saving.request}
          route={saving.route}
          onClose={() => setSaving(null)}
          onSaved={(ref) => useHttp.getState().openRequest(ref, { preview: false })}
        />
      )}
      {clearing && (
        <Modal
          title="Clear all history?"
          onClose={() => setClearing(false)}
          confirm={{
            label: 'Clear history',
            destructive: true,
            onClick: () => {
              setClearing(false)
              void window.opsmaxx.httpHistory
                .clear()
                .then(() => setEntries([]))
                .catch(() => toast('Could not clear history.', 'error'))
            }
          }}
        >
          <p>Every request in history is removed from this device. This cannot be undone.</p>
        </Modal>
      )}
    </div>
  )
}
