import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ArrowDown, ArrowDownLeft, ArrowUpRight, Info, Pause, Play, Search, Trash2 } from 'lucide-react'
import type { Id } from '../../../../../shared/apiModel'
import { sendWsMessage } from '../../../lib/httpSend'
import { bytes, clsx } from '../../../lib/format'
import { useWsSessions, windowFor, type WsFrame } from '../../../store/wsSessions'
import { ContextMenu, type MenuEntry } from '../../connections/ContextMenu'
import { MessageDetail } from './MessageDetail'
import {
  detailPlacement,
  dirLabel,
  frameText,
  matches,
  newerThan,
  oneLine,
  prettyJson,
  stamp,
  type LogFilter
} from './frames'
import { useT } from '../../../lib/i18n'

export const ROW_H = 28

function DirIcon({ frame }: { frame: WsFrame }): React.JSX.Element {
  if (frame.dir === 'out') return <ArrowUpRight size={13} aria-hidden />
  if (frame.dir === 'in') return <ArrowDownLeft size={13} aria-hidden />
  return frame.error ? <AlertTriangle size={13} aria-hidden /> : <Info size={13} aria-hidden />
}

function saveFrame(frame: WsFrame): void {
  const data = frame.bytes ?? new TextEncoder().encode(frameText(frame)).buffer
  void window.opsmaxx.http.saveResponse(`frame-${frame.id}.${frame.binary ? 'bin' : 'txt'}`, data as ArrayBuffer)
}

export interface LogView {
  filter: LogFilter
  query: string
  /** Id of the newest frame seen when auto-scroll paused; null while following. */
  pausedAt: number | null
}

export const INITIAL_VIEW: LogView = { filter: 'all', query: '', pausedAt: null }

const lastId = (tabId: Id): number => useWsSessions.getState().ringFor(tabId).at(-1)?.id ?? 0

/**
 * The Messages tab: a fixed-height virtualised list and the detail panel.
 * `width` is the log pane's width, measured by the caller; the detail goes
 * beside the rows when there is room and under them otherwise (UX-M10).
 */
export function MessageLog({
  tabId,
  width,
  view,
  onView,
  onLoadIntoComposer
}: {
  tabId: Id
  width: number
  view: LogView
  onView: (patch: Partial<LogView>) => void
  onLoadIntoComposer: (text: string) => void
}): React.JSX.Element {
  const version = useWsSessions((s) => s.sessions[tabId]?.version ?? 0)
  const dropped = useWsSessions((s) => s.sessions[tabId]?.stats.dropped ?? 0)
  const state = useWsSessions((s) => s.sessions[tabId]?.state ?? 'idle')
  const { filter, query, pausedAt } = view
  const [selected, setSelected] = useState<number | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; frame: WsFrame } | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [height, setHeight] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  /** Where auto-scroll last put the list: a scroll event landing there is ours, not the user's. */
  const autoTop = useRef(-1)
  const t = useT()

  const q = query.trim().toLowerCase()
  const frames = useMemo(() => {
    const all = useWsSessions.getState().ringFor(tabId)
    return filter === 'all' && q === '' ? all : all.filter((f) => matches(f, filter, q))
    // `version` is the ring's change signal; the ring itself mutates in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId, version, filter, q])
  const count = frames.length
  const following = pausedAt === null
  const unseen = following ? 0 : newerThan(frames, pausedAt)
  const frame = selected === null ? null : (frames.find((f) => f.id === selected) ?? null)

  useEffect(() => {
    const el = listRef.current
    if (!el) return
    const observer = new ResizeObserver(() => setHeight(el.clientHeight))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => {
    const el = listRef.current
    if (!following || !el) return
    el.scrollTop = el.scrollHeight
    autoTop.current = el.scrollTop
    setScrollTop(el.scrollTop)
  }, [following, count, version])

  const pause = (): void => onView({ pausedAt: lastId(tabId) })
  const follow = (): void => onView({ pausedAt: null })

  const onScroll = (): void => {
    const el = listRef.current
    if (!el) return
    setScrollTop(el.scrollTop)
    if (el.scrollTop === autoTop.current) return
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - ROW_H / 2
    // Scrolling up to read pauses on its own; coming back to the bottom resumes.
    if (atBottom && !following) follow()
    else if (!atBottom && following) pause()
  }

  const clear = (): void => {
    useWsSessions.getState().clear(tabId)
    setSelected(null)
  }

  const entries = (f: WsFrame): MenuEntry[] => {
    const text = frameText(f)
    const pretty = prettyJson(text)
    return [
      { label: t('http.ws.copyMessage'), onClick: () => window.opsmaxx.clipboard.write(text) },
      {
        label: t('http.ws.copyAsPrettyJson'),
        disabled: pretty === null,
        onClick: () => pretty && window.opsmaxx.clipboard.write(pretty)
      },
      { label: t('http.ws.loadIntoComposer'), disabled: f.dir === 'system', onClick: () => onLoadIntoComposer(text) },
      {
        label: t('http.ws.resend'),
        // Resend goes through httpSend, so the production confirm sees it too.
        disabled: f.dir !== 'out' || f.text === undefined || state !== 'open',
        onClick: () => void sendWsMessage(tabId, f.text ?? '')
      },
      {
        label: f.bytes || f.text !== undefined ? t('http.ws.saveFrame') : t('http.ws.saveFirst64k'),
        disabled: f.dir === 'system',
        onClick: () => saveFrame(f)
      },
      { label: '', separator: true },
      { label: t('http.ws.clearLog'), onClick: clear }
    ]
  }

  const placement = detailPlacement(width)
  // Before the first measurement (and always under jsdom) assume a screenful.
  const { start, end } = windowFor(scrollTop, height || 20 * ROW_H, ROW_H, count)
  const selectedIndex = frame ? frames.indexOf(frame) : -1

  const move = (delta: number): void => {
    if (count === 0) return
    const next = frames[Math.max(0, Math.min(count - 1, (selectedIndex === -1 ? count : selectedIndex) + delta))]
    setSelected(next.id)
    const el = listRef.current
    const at = frames.indexOf(next) * ROW_H
    if (el && (at < el.scrollTop || at + ROW_H > el.scrollTop + el.clientHeight)) el.scrollTop = at
  }

  return (
    <div className={clsx('hc-ws-messages', `is-${placement}`)}>
      <div className="hc-ws-logpane">
        {dropped > 0 && (
          <div className="hc-ws-row is-system hc-ws-dropped" role="note">
            <Info size={13} aria-hidden /> {t('http.ws.dropped', { count: dropped, n: dropped.toLocaleString() })}
          </div>
        )}
        <div
          ref={listRef}
          className="hc-ws-list"
          role="listbox"
          aria-label={t('http.ws.messages')}
          tabIndex={0}
          aria-activedescendant={frame ? `hc-ws-${tabId}-${frame.id}` : undefined}
          onScroll={onScroll}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') move(1)
            else if (e.key === 'ArrowUp') move(-1)
            else if (e.key === 'Escape' && frame) setSelected(null)
            else if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
              if (!frame) return
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
              setMenu({ x: r.left + 16, y: r.top + (selectedIndex - start + 1) * ROW_H, frame })
            } else return
            e.preventDefault()
          }}
        >
          {count === 0 ? (
            <p className="hc-ws-empty">
              {q !== '' || filter !== 'all'
                ? t('http.ws.noMatch')
                : state === 'open'
                  ? t('http.ws.connectedEmpty')
                  : t('http.ws.notConnectedEmpty')}
            </p>
          ) : (
            <div className="hc-ws-spacer-rows" style={{ height: count * ROW_H }}>
              {frames.slice(start, end).map((f, i) => (
                <div
                  key={f.id}
                  id={`hc-ws-${tabId}-${f.id}`}
                  role="option"
                  aria-selected={f.id === selected}
                  className={clsx('hc-ws-row', `is-${f.dir}`, f.error && 'is-error', f.id === selected && 'is-selected')}
                  style={{ top: (start + i) * ROW_H }}
                  onClick={() => setSelected(f.id)}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    setSelected(f.id)
                    setMenu({ x: e.clientX, y: e.clientY, frame: f })
                  }}
                >
                  <span className="hc-ws-dir">
                    <DirIcon frame={f} /> {dirLabel(f)}
                  </span>
                  <span className="hc-ws-time mono">{stamp(f.at)}</span>
                  <span className="hc-ws-size mono">{f.dir === 'system' ? '' : bytes(f.size)}</span>
                  <span className="hc-ws-preview mono">{oneLine(f)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        {unseen > 0 && (
          <button type="button" className="btn sm hc-ws-pill" onClick={follow}>
            <ArrowDown size={13} aria-hidden /> {t('http.ws.unseen', { count: unseen })}
          </button>
        )}
      </div>
      {frame && <MessageDetail frame={frame} placement={placement} onClose={() => setSelected(null)} />}
      {menu && <ContextMenu x={menu.x} y={menu.y} entries={entries(menu.frame)} onClose={() => setMenu(null)} />}
    </div>
  )
}

/** Search · Filter · Pause · Clear, on the right of the Messages · Handshake row. */
export function MessageToolbar({
  tabId,
  view,
  onView
}: {
  tabId: Id
  view: LogView
  onView: (patch: Partial<LogView>) => void
}): React.JSX.Element {
  const following = view.pausedAt === null
  const t = useT()
  return (
    <div className="hc-ws-tools">
      <label className="hc-ws-search">
        <Search size={13} aria-hidden />
        <input
          className="input mono"
          type="search"
          placeholder={t('common.search')}
          aria-label={t('http.ws.searchMessages')}
          value={view.query}
          onChange={(e) => onView({ query: e.target.value })}
        />
      </label>
      <select
        className="input"
        aria-label={t('http.ws.filterMessages')}
        value={view.filter}
        onChange={(e) => onView({ filter: e.target.value as LogFilter })}
      >
        <option value="all">{t('http.ws.filterAll')}</option>
        <option value="out">{t('http.ws.dirSent')}</option>
        <option value="in">{t('http.ws.dirReceived')}</option>
        <option value="system">{t('http.ws.dirSystem')}</option>
      </select>
      <button
        type="button"
        className={clsx('btn ghost sm', !following && 'is-on')}
        aria-pressed={!following}
        aria-label={following ? t('http.ws.pauseScroll') : t('http.ws.resumeScroll')}
        title={following ? t('http.ws.pauseScroll') : t('http.ws.resumeScroll')}
        onClick={() => onView({ pausedAt: following ? lastId(tabId) : null })}
      >
        {following ? <Pause size={13} /> : <Play size={13} />}
      </button>
      <button
        type="button"
        className="btn ghost sm"
        aria-label={t('http.ws.clearLog')}
        title={t('http.ws.clearLog')}
        onClick={() => useWsSessions.getState().clear(tabId)}
      >
        <Trash2 size={13} />
      </button>
    </div>
  )
}
