import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Plug, PlugZap, Plus, Send, Trash2 } from 'lucide-react'
import { useApp } from '../../store/app'
import { sshTargetFor } from '../../lib/ssh'
import { clsx } from '../../lib/format'
import { bridgeHas } from '../../lib/bridge'
import { resolveSecrets, resolveUrl } from '../../../../shared/apiSecrets'
import { useVault } from '../../store/vault'
import type { HttpVia } from '../../../../shared/httpClient'
import type { WsEvent, WsFrame } from '../../../../shared/httpSocket'
import type { ApiCollection } from '../../types'

/**
 * A WebSocket console.
 *
 * Written here rather than taken from the API client for two reasons, in this
 * order: the client's AsyncAPI channel block is built into its `dist/` but
 * absent from its `exports` map, so it cannot be imported at all
 * (`tests/scalarSurface.test.ts` pins that fact); and what it exports is a
 * session state machine with no UI attached, which is the easy half. A frame
 * log and a send box against OpsMaxx's own CSS is smaller than adapting one.
 *
 * The socket itself is opened in MAIN, over the same route the collection's
 * requests take. That is the part worth having: a browser `new WebSocket()`
 * cannot set a handshake header, cannot be handed a private CA, and cannot
 * reach a service bound to a server's loopback.
 */

type Row = { id: string; enabled: boolean; key: string; value: string }

type State =
  | { kind: 'idle' }
  | { kind: 'connecting' }
  | { kind: 'open'; id: string; protocol: string }
  | { kind: 'closed'; code: number; reason: string; wasClean: boolean }
  | { kind: 'failed'; error: string }

const uid = (): string => `kv-${crypto.randomUUID()}`
const blankRow = (): Row => ({ id: uid(), enabled: true, key: '', value: '' })

/** A frame as the log shows it: bytes become a short hex preview. */
function renderFrame(frame: WsFrame): string {
  if (typeof frame.data === 'string') return frame.data
  const bytes = new Uint8Array(frame.data)
  const hex = [...bytes.slice(0, 64)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(' ')
  return bytes.length > 64 ? `${hex} … (${bytes.length} bytes)` : `${hex} (${bytes.length} bytes)`
}

const time = (at: number): string =>
  new Date(at).toLocaleTimeString(undefined, { hour12: false })

export function WsConsole({ collection }: { collection: ApiCollection }): React.JSX.Element {
  const servers = useApp((s) => s.servers)
  const vaultUnlocked = useVault((s) => s.unlocked)
  const vaultEntries = useVault((s) => s.entries)

  const [url, setUrl] = useState(() => wsUrlFor(collection.baseUrl))
  const [headers, setHeaders] = useState<Row[]>([])
  const [outgoing, setOutgoing] = useState('')
  const [state, setState] = useState<State>({ kind: 'idle' })
  const [frames, setFrames] = useState<WsFrame[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const unsubscribe = useRef<(() => void) | null>(null)
  const logRef = useRef<HTMLDivElement>(null)

  const via = useMemo((): HttpVia | null => {
    if (!collection.viaServerId) return { kind: 'direct' }
    const server = servers.find((s) => s.id === collection.viaServerId)
    // A collection outlives the server it named. Opening directly instead
    // would quietly reach a different machine.
    return server ? { kind: 'server', server: sshTargetFor(server) } : null
  }, [collection.viaServerId, servers])

  const vault = useMemo(
    () => ({
      unlocked: vaultUnlocked,
      read: ({ entryId, field }: { entryId: string; field: 'password' | 'username' }) => {
        const entry = vaultEntries.find((e) => e.id === entryId)
        if (!entry) return null
        return field === 'username' ? entry.username : entry.password
      }
    }),
    [vaultUnlocked, vaultEntries]
  )

  // The subscription outlives any one render, so it is torn down here rather
  // than being left to the socket closing — a component unmounted mid-session
  // would otherwise keep pushing frames into a dead setState.
  useEffect(() => () => unsubscribe.current?.(), [])

  // Newest frame in view, which is what a live log is for.
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [frames])

  const onEvent = useCallback((event: WsEvent): void => {
    if (event.type === 'frame') {
      setFrames((f) => [...f, event.frame])
      return
    }
    if (event.type === 'close') {
      setState({ kind: 'closed', code: event.code, reason: event.reason, wasClean: event.wasClean })
      unsubscribe.current?.()
      unsubscribe.current = null
      return
    }
    if (event.type === 'error') setNotice(event.error)
  }, [])

  const connect = useCallback(async (): Promise<void> => {
    if (state.kind === 'connecting' || state.kind === 'open') return
    setNotice(null)

    if (via === null) {
      setState({
        kind: 'failed',
        error:
          'This collection opens through a server that no longer exists. Point it at another one in the toolbar.'
      })
      return
    }
    // Under `electron-vite dev` the renderer reloads while the process keeps
    // the preload bundle it booted with, so a method added today is undefined
    // for the rest of that session.
    if (!bridgeHas(window.opsmaxx?.httpSocket as Record<string, unknown> | undefined, 'open')) {
      setState({
        kind: 'failed',
        error: 'Restart OpsMaxx to open a socket — this window is newer than the process behind it.'
      })
      return
    }

    let target: string
    let sending: Record<string, string>
    try {
      // Same rule as a request: a `vault:` reference is resolved at the last
      // moment, so the credential is never in anything that gets persisted.
      target = resolveUrl(url, vault)
      sending = resolveSecrets(headerObject(headers), vault)
    } catch (err) {
      setState({ kind: 'failed', error: err instanceof Error ? err.message : String(err) })
      return
    }

    setState({ kind: 'connecting' })
    setFrames([])
    const result = await window.opsmaxx.httpSocket.open({
      url: target,
      headers: sending,
      via,
      insecureTls: collection.insecureTls
    })
    if (!result.ok) {
      setState({ kind: 'failed', error: result.error })
      return
    }
    unsubscribe.current = window.opsmaxx.httpSocket.onEvent(result.id, onEvent)
    setState({ kind: 'open', id: result.id, protocol: '' })
  }, [state.kind, via, url, headers, vault, collection.insecureTls, onEvent])

  const disconnect = useCallback((): void => {
    if (state.kind !== 'open') return
    void window.opsmaxx.httpSocket.close(state.id)
  }, [state])

  const send = useCallback(async (): Promise<void> => {
    if (state.kind !== 'open' || outgoing === '') return
    const result = await window.opsmaxx.httpSocket.send(state.id, outgoing)
    if (!result.ok) {
      setNotice(result.error)
      return
    }
    setNotice(null)
    setOutgoing('')
  }, [state, outgoing])

  const connected = state.kind === 'open'

  return (
    <div className="req-pane">
      <div className="req-bar">
        <input
          className="input req-path mono"
          aria-label="WebSocket URL"
          placeholder="wss://host/socket"
          value={url}
          disabled={connected}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !connected) void connect()
          }}
        />
        <button
          className={clsx('btn', connected ? '' : 'primary', 'req-send')}
          onClick={() => (connected ? disconnect() : void connect())}
          disabled={state.kind === 'connecting' || url.trim() === ''}
        >
          {connected ? <PlugZap size={14} /> : <Plug size={14} />}
          {connected ? 'Disconnect' : state.kind === 'connecting' ? 'Connecting' : 'Connect'}
        </button>
      </div>

      <StatusLine state={state} />
      {notice && <p className="req-blocked">{notice}</p>}

      {/* Headers are editable only while closed: they are sent with the
          handshake, so changing them on a live socket would show a value that
          was never sent. */}
      <div className="req-editor">
        <div className="endpoints-head">
          <span className="ui-section-title">Handshake headers</span>
          <span className="faint">
            Sent with the upgrade request — which is the thing a browser cannot do.
          </span>
        </div>
        <KeyValueEditor rows={headers} onChange={setHeaders} disabled={connected} />
      </div>

      <div className="req-response">
        <div className="req-response-head">
          <span className={clsx('chip', connected ? 'ok' : 'warn')}>
            {connected ? 'Open' : 'Not connected'}
          </span>
          <span className="faint">
            {frames.length} frame{frames.length === 1 ? '' : 's'}
          </span>
          <span className="spacer" />
          <button
            className="btn ghost sm"
            onClick={() => setFrames([])}
            disabled={frames.length === 0}
          >
            <Trash2 size={13} /> Clear
          </button>
        </div>

        <div className="ws-log mono selectable" ref={logRef}>
          {frames.length === 0 && (
            <p className="kv-empty">
              Nothing yet. Frames appear here as they arrive, newest at the bottom.
            </p>
          )}
          {frames.map((frame, i) => (
            <div
              key={`${frame.at}-${i}`}
              className={clsx('ws-frame', `ws-${frame.direction}`)}
            >
              <span className="ws-frame-dir">
                {frame.direction === 'incoming' ? <ArrowDown size={12} /> : <ArrowUp size={12} />}
              </span>
              <span className="faint ws-frame-time">{time(frame.at)}</span>
              <span className="ws-frame-body">
                {renderFrame(frame)}
                {frame.truncated && <span className="chip warn">truncated</span>}
              </span>
            </div>
          ))}
        </div>

        <div className="ws-send">
          <textarea
            className="textarea"
            aria-label="Frame to send"
            rows={2}
            spellCheck={false}
            placeholder={connected ? '{"type":"ping"}' : 'Connect to send a frame'}
            value={outgoing}
            disabled={!connected}
            onChange={(e) => setOutgoing(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                void send()
              }
            }}
          />
          <button
            className="btn primary"
            disabled={!connected || outgoing === ''}
            title="Send (⌘↵)"
            onClick={() => void send()}
          >
            <Send size={14} /> Send
          </button>
        </div>
      </div>
    </div>
  )
}

function StatusLine({ state }: { state: State }): React.JSX.Element | null {
  if (state.kind === 'failed') return <p className="req-blocked">{state.error}</p>
  if (state.kind === 'closed') {
    return (
      <p className="req-note">
        Closed with {state.code}
        {state.reason ? ` — ${state.reason}` : ''}
        {state.wasClean ? '' : ' (the connection dropped rather than closing cleanly)'}
      </p>
    )
  }
  return null
}

function KeyValueEditor({
  rows,
  onChange,
  disabled
}: {
  rows: Row[]
  onChange: (rows: Row[]) => void
  disabled?: boolean
}): React.JSX.Element {
  const set = (id: string, patch: Partial<Row>): void =>
    onChange(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)))

  return (
    <div className="kv-editor">
      {rows.length === 0 && (
        <p className="kv-empty">
          No headers. An <code>Authorization</code> header here is sent with the handshake.
        </p>
      )}
      {rows.map((r) => (
        <div key={r.id} className="kv-row">
          <input
            type="checkbox"
            checked={r.enabled}
            disabled={disabled}
            aria-label={r.key ? `Send ${r.key}` : 'Send this row'}
            onChange={(e) => set(r.id, { enabled: e.target.checked })}
          />
          <input
            className="input sm"
            placeholder="Authorization"
            aria-label="Name"
            disabled={disabled}
            value={r.key}
            onChange={(e) => set(r.id, { key: e.target.value })}
          />
          <input
            className="input sm"
            placeholder="Bearer …"
            aria-label="Value"
            disabled={disabled}
            value={r.value}
            onChange={(e) => set(r.id, { value: e.target.value })}
          />
          <button
            className="icon-btn sm"
            title="Remove"
            aria-label="Remove row"
            disabled={disabled}
            onClick={() => onChange(rows.filter((x) => x.id !== r.id))}
          >
            <Trash2 size={13} />
          </button>
        </div>
      ))}
      <button
        className="btn ghost sm kv-add"
        disabled={disabled}
        onClick={() => onChange([...rows, blankRow()])}
      >
        <Plus size={13} /> Add row
      </button>
    </div>
  )
}

function headerObject(rows: readonly Row[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const r of rows) {
    if (r.enabled && r.key.trim() !== '') out[r.key.trim()] = r.value
  }
  return out
}

/**
 * A sensible starting URL from the collection's base.
 *
 * `http` and `https` map onto `ws` and `wss`, because a service that speaks
 * both almost always does so on the same host and scheme family. Anything
 * else is left alone rather than guessed at.
 */
export function wsUrlFor(baseUrl: string): string {
  const raw = baseUrl.trim()
  if (raw === '') return ''
  if (/^wss?:\/\//i.test(raw)) return raw
  if (/^https:\/\//i.test(raw)) return raw.replace(/^https:\/\//i, 'wss://')
  if (/^http:\/\//i.test(raw)) return raw.replace(/^http:\/\//i, 'ws://')
  return raw
}
