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
}

export type WsOpenResult = { ok: true; id: string } | { ok: false; error: string; code?: string }

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
