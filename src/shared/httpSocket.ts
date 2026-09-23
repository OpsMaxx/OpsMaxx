import type { HttpVia } from './httpClient'

/**
 * The WebSocket client's wire contract between renderer and main.
 *
 * Sockets are opened in main for the same three reasons requests are
 * (`shared/httpClient.ts`), and one more that is specific to WebSockets:
 *
 *   - A self-signed or privately-signed certificate is what most internal
 *     services present, and the browser refuses one outright.
 *   - A socket opened from the renderer leaves from this machine. Opened
 *     through a server's SSH connection it reaches something bound to that
 *     host's loopback — which is the whole reason this client lives inside
 *     OpsMaxx.
 *   - CORS and mixed-content rules do not apply to a handshake that never goes
 *     through the browser stack.
 *   - **The browser cannot set handshake headers.** `new WebSocket(url)` has no
 *     way to send an `Authorization` header, which is why every browser-based
 *     WebSocket client ends up shoving tokens into the query string, where they
 *     land in access logs. Node can send real headers, so this one does.
 */

export interface WsOpenSpec {
  /** `ws://` or `wss://`. */
  url: string
  /** Subprotocols for `Sec-WebSocket-Protocol`. */
  protocols?: string[]
  /** Handshake headers. The reason this is worth doing in main at all. */
  headers?: Record<string, string>
  via: HttpVia
  /** Skip certificate verification for THIS socket. Never remembered implicitly. */
  insecureTls?: boolean
  /** A PEM bundle to trust for THIS socket, in addition to the system roots. */
  caPem?: string
  /**
   * The socket's id, chosen by the preload BEFORE the handshake so it can be
   * listening on `ws:event:<id>` before main emits anything. `socketBridge`
   * sets it; a caller never needs to. Absent means main picks one.
   */
  id?: string
}

/** `protocol` is the subprotocol the server chose, '' when none. */
export type WsOpenResult =
  | { ok: true; id: string; protocol: string }
  | { ok: false; error: string; code?: string }

/** The shape an id chosen outside main must have: what `randomUUID` produces, loosely. */
export const WS_ID = /^[A-Za-z0-9-]{8,64}$/

export type WsFrameDirection = 'incoming' | 'outgoing'
export type WsFrameOpcode = 'text' | 'binary'

export interface WsFrame {
  direction: WsFrameDirection
  opcode: WsFrameOpcode
  /** Text as a string; binary as bytes. */
  data: string | ArrayBuffer
  /** Epoch milliseconds, stamped in main so ordering survives a slow renderer. */
  at: number
  /** True when the frame was larger than `IPC_FRAME_BYTES` and was cut short. */
  truncated?: boolean
}

export type WsEvent =
  | { type: 'open'; protocol: string }
  | { type: 'frame'; frame: WsFrame }
  | { type: 'close'; code: number; reason: string; wasClean: boolean }
  | { type: 'error'; error: string }

export type WsSendResult =
  | { ok: true }
  | { ok: false; error: string; reason?: 'backpressure' | 'closed' | 'unknown-session' }

export interface HttpSocketBridge {
  open(spec: WsOpenSpec): Promise<WsOpenResult>
  send(id: string, data: string | ArrayBuffer): Promise<WsSendResult>
  close(id: string, code?: number, reason?: string): Promise<void>
  /** Every event for one socket. Returns the unsubscribe. */
  onEvent(id: string, cb: (event: WsEvent) => void): () => void
}

/**
 * How many sockets one window may hold open at once.
 *
 * Each can be sitting on an SSH channel, and behind that a pooled connection
 * to a bastion. A runaway caller should hit a wall here rather than opening
 * channels until the far end stops accepting them — which is a failure that
 * lands on every other feature using that server, not just this one.
 */
export const MAX_SOCKETS = 16

/**
 * The largest frame the socket will accept from the far end. `ws` defaults to
 * 100 MiB, which is a denial-of-service budget rather than a limit.
 */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024

/**
 * The largest frame shipped whole to the renderer.
 *
 * A frame bigger than this is truncated with a flag rather than dropped: a
 * message log cannot usefully render eight megabytes, and the fact that a
 * large frame ARRIVED is the part worth seeing.
 */
export const IPC_FRAME_BYTES = 256 * 1024

/**
 * Outgoing bytes allowed to sit unsent before `send` starts refusing.
 *
 * Refusing is the point. Buffering without limit turns a far end that has
 * stopped reading into main-process memory growth with nothing on screen to
 * explain it; an error the renderer can show says the connection is not
 * keeping up, which is true and actionable.
 */
export const HIGH_WATER_BYTES = 4 * 1024 * 1024

/** Close codes this client originates. 1000 is a normal, deliberate close. */
export const NORMAL_CLOSURE = 1000

/** Events held for a socket nobody has subscribed to yet, at most. */
export const MAX_EARLY_EVENTS = 1000
/** How long events are held after the socket closed, for a subscriber that is late. */
export const EARLY_EVENTS_AFTER_CLOSE_MS = 30_000

/** The slice of `ipcRenderer` the bridge uses. */
export interface SocketIpc {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  on(channel: string, listener: (e: unknown, ...args: unknown[]) => void): unknown
  removeListener(channel: string, listener: (e: unknown, ...args: unknown[]) => void): unknown
}

/**
 * The renderer's side of `httpSocket`, race-free.
 *
 * Main emits `open`, and often the server's greeting frame, in the same turn
 * the handshake completes — before `ws:open`'s reply reaches the renderer, and
 * so before a caller that subscribes after `await open()` is listening. Those
 * events went nowhere: the negotiated subprotocol was always lost, and a
 * greeting sent on connect could be too.
 *
 * So the id is chosen HERE, a listener on `ws:event:<id>` is registered before
 * the handshake is requested, and whatever arrives before the caller's
 * `onEvent` is held and replayed to it, in order, synchronously on subscribe.
 * No change for callers: `open` then `onEvent` now simply sees everything.
 */
export function socketBridge(ipc: SocketIpc, newId: () => string): HttpSocketBridge {
  const early = new Map<string, { events: WsEvent[]; stop: () => void }>()
  const forget = (id: string): void => {
    early.get(id)?.stop()
    early.delete(id)
  }

  return {
    open: async (spec) => {
      const id = newId()
      const events: WsEvent[] = []
      const ch = `ws:event:${id}`
      const hold = (_e: unknown, ...args: unknown[]): void => {
        const event = args[0] as WsEvent
        if (events.length < MAX_EARLY_EVENTS) events.push(event)
        // Nobody subscribed and the socket is gone: drop it after a grace
        // period rather than holding it for the life of the window.
        if (event.type === 'close') setTimeout(() => early.get(id)?.events === events && forget(id), EARLY_EVENTS_AFTER_CLOSE_MS)
      }
      ipc.on(ch, hold)
      early.set(id, { events, stop: () => ipc.removeListener(ch, hold) })
      let result: WsOpenResult
      try {
        result = (await ipc.invoke('ws:open', { ...spec, id })) as WsOpenResult
      } catch (err) {
        forget(id)
        throw err
      }
      if (!result.ok) forget(id)
      return result
    },
    send: (id, data) => ipc.invoke('ws:send', id, data) as Promise<WsSendResult>,
    close: (id, code, reason) => ipc.invoke('ws:close', id, code, reason) as Promise<void>,
    onEvent: (id, cb) => {
      const ch = `ws:event:${id}`
      const h = (_e: unknown, ...args: unknown[]): void => cb(args[0] as WsEvent)
      // Live listener first, then the replay, in one synchronous turn: nothing
      // can arrive between the two, so nothing is delivered twice or missed.
      ipc.on(ch, h)
      const held = early.get(id)
      if (held) {
        forget(id)
        for (const event of held.events) cb(event)
      }
      return () => {
        ipc.removeListener(ch, h)
      }
    }
  }
}
