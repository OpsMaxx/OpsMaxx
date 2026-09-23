import { create } from 'zustand'
import {
  isProtocolName,
  maskProtocol,
  protocolCarriesCredential,
  type Id,
  type SentView,
  type TransportErrorClass
} from '../../../shared/apiModel'
import { classifyTransportError, type ClassifiedError } from '../../../shared/httpErrors'
import { MAX_SOCKETS, type WsEvent, type WsFrame as WireFrame, type WsOpenSpec } from '../../../shared/httpSocket'
import { bridgeHas } from '../lib/bridge'
import { useHttp } from './http'

// Live WebSocket sessions, one per tab. Frames are kept in a module-level ring
// rather than in store state: at 5,000 frames per tab a copy-on-write array
// would cost more than the frames. The store holds only what renders, and a
// flood reaches React once per animation frame, as one version bump.
//
// This module owns the socket and the ring and nothing else. Building the spec
// and the production confirm are lib/httpSend's, which calls `connect`, `send`
// and `fail` here; nothing here imports it back.

export type WsConnState = 'idle' | 'connecting' | 'open' | 'closing' | 'closed' | 'error'

export interface WsStats {
  sent: number
  received: number
  bytesIn: number
  bytesOut: number
  /** Frames evicted by the ring caps, or since the log was last cleared. */
  dropped: number
}

export interface WsFailure extends ClassifiedError {
  code?: string
  unresolved?: string[]
}

export interface WsSession {
  state: WsConnState
  socketId?: string
  /** Bumped on every ring flush, so a log re-renders without copying the ring. */
  version: number
  stats: WsStats
  /** Why the last connect failed. Cleared by the next connect. */
  failure?: WsFailure
  openedAt?: number
  close?: { code: number; reason: string; wasClean: boolean }
  /** The upgrade request as sent, masked: the Handshake tab. */
  sent?: SentView
  /** The subprotocol the server chose, or '' for none. */
  protocol?: string
}

export interface WsFrame {
  id: number
  dir: 'in' | 'out' | 'system'
  /** A system row that reports a failure: ⚠ Error rather than ⓘ System. */
  error?: boolean
  at: number
  /** Bytes on the wire (or as far as main shipped them; see `truncated`). */
  size: number
  /** Full content only for frames of 64 KiB or less. */
  text?: string
  bytes?: ArrayBuffer
  /** The whole frame when it fits in 64 KiB, else its head; hex for binary. */
  preview: string
  binary?: boolean
  /** Main cut the frame at `IPC_FRAME_BYTES` before it reached the renderer. */
  truncated?: boolean
}

export const MAX_FRAMES = 5_000
export const MAX_RING_BYTES = 32 * 1024 * 1024
export const FULL_FRAME_BYTES = 64 * 1024

export interface Ring {
  frames: WsFrame[]
  /** Evicted frames still at the front of `frames`, spliced off lazily. */
  head: number
  bytes: number
  nextId: number
  stats: WsStats
}

/** What the composer holds. In memory only, like the log: a WsRequest has no field for it. */
export interface WsComposer {
  text: string
  format: 'text' | 'json'
  clearOnSend: boolean
}

export const EMPTY_COMPOSER: WsComposer = { text: '', format: 'text', clearOnSend: false }

interface WsSessionsState {
  sessions: Record<Id, WsSession>
  composers: Record<Id, WsComposer>
  setComposer: (tabId: Id, patch: Partial<WsComposer>) => void
  /** `sent` is the masked view of the upgrade request, for the Handshake tab. */
  connect: (tabId: Id, spec: WsOpenSpec, sent?: SentView) => Promise<void>
  send: (tabId: Id, message: string | ArrayBuffer) => Promise<void>
  disconnect: (tabId: Id) => void
  /** A connect that never reached main: a build failure, reported by lib/httpSend. */
  fail: (tabId: Id, failure: { errorClass: TransportErrorClass; message: string; unresolved?: string[] }) => void
  /** Empties the log; the connection and the traffic counters are untouched. */
  clear: (tabId: Id) => void
  ringFor: (tabId: Id) => readonly WsFrame[]
}

const rings = new Map<Id, Ring>()
/** Per tab with a socket (or a connect in flight): how to let go of it. */
const live = new Map<Id, { socketId?: string; release: () => void }>()
const pending = new Set<Id>()
let flushScheduled = false

export function resetWsSessionsForTests(): void {
  for (const { release } of [...live.values()]) release()
  live.clear()
  rings.clear()
  pending.clear()
  flushScheduled = false
}

const zeroStats = (): WsStats => ({ sent: 0, received: 0, bytesIn: 0, bytesOut: 0, dropped: 0 })
const idle = (): WsSession => ({ state: 'idle', version: 0, stats: zeroStats() })

export function newRing(): Ring {
  return { frames: [], head: 0, bytes: 0, nextId: 1, stats: zeroStats() }
}

function ringOf(tabId: Id): Ring {
  let ring = rings.get(tabId)
  if (!ring) {
    ring = newRing()
    rings.set(tabId, ring)
  }
  return ring
}

/** The bytes a frame holds in memory, which is what the 32 MiB cap counts. */
const keptBytes = (f: WsFrame): number => Math.min(f.size, FULL_FRAME_BYTES)

const encoder = new TextEncoder()

/** Native: a JS loop over a 256 KiB frame costs milliseconds, which a flood multiplies. */
export const utf8Length = (text: string): number => encoder.encode(text).length

function hexPreview(bytes: Uint8Array): string {
  const head = [...bytes.subarray(0, 64)].map((b) => b.toString(16).padStart(2, '0')).join(' ')
  return bytes.length > 64 ? `${head} …` : head
}

/** A frame from main, cut down to what the ring keeps. Pure. */
export function toFrame(wire: WireFrame, id: number): WsFrame {
  const dir = wire.direction === 'incoming' ? 'in' : 'out'
  if (typeof wire.data === 'string') {
    const size = utf8Length(wire.data)
    const whole = size <= FULL_FRAME_BYTES
    return {
      id,
      dir,
      at: wire.at,
      size,
      text: whole ? wire.data : undefined,
      // Characters, not bytes: a 64 Ki-character head can be up to 256 KiB,
      // bounded by main's 256 KiB IPC cut. The byte cap counts it as 64 KiB.
      preview: whole ? wire.data : wire.data.slice(0, FULL_FRAME_BYTES),
      truncated: wire.truncated
    }
  }
  const size = wire.data.byteLength
  return {
    id,
    dir,
    at: wire.at,
    size,
    binary: true,
    bytes: size <= FULL_FRAME_BYTES ? wire.data : undefined,
    preview: hexPreview(new Uint8Array(wire.data)),
    truncated: wire.truncated
  }
}

/**
 * Appends to the ring and evicts oldest-first until both caps hold. Eviction
 * only advances `head`; the splice happens once, when the ring is next read,
 * so a flood costs one splice per animation frame rather than one per frame.
 */
export function pushFrame(ring: Ring, frame: WsFrame): void {
  ring.frames.push(frame)
  ring.bytes += keptBytes(frame)
  while (ring.frames.length - ring.head > MAX_FRAMES || ring.bytes > MAX_RING_BYTES) {
    ring.bytes -= keptBytes(ring.frames[ring.head])
    ring.head++
    ring.stats.dropped++
  }
}

export function compact(ring: Ring): readonly WsFrame[] {
  if (ring.head > 0) {
    ring.frames.splice(0, ring.head)
    ring.head = 0
  }
  return ring.frames
}

function requestFrame(cb: () => void): void {
  const raf = globalThis.requestAnimationFrame as ((cb: () => void) => number) | undefined
  if (raf) raf(cb)
  else setTimeout(cb, 16)
}

function flush(): void {
  flushScheduled = false
  if (pending.size === 0) return
  const tabs = [...pending]
  pending.clear()
  useWsSessions.setState((s) => {
    const sessions = { ...s.sessions }
    for (const tabId of tabs) {
      const was = sessions[tabId] ?? idle()
      sessions[tabId] = { ...was, version: was.version + 1, stats: { ...ringOf(tabId).stats } }
    }
    return { sessions }
  })
}

function scheduleFlush(tabId: Id): void {
  pending.add(tabId)
  if (flushScheduled) return
  flushScheduled = true
  requestFrame(flush)
}

function append(tabId: Id, frame: Omit<WsFrame, 'id'>): void {
  const ring = ringOf(tabId)
  pushFrame(ring, { ...frame, id: ring.nextId++ })
  scheduleFlush(tabId)
}

function system(tabId: Id, text: string, error = false): void {
  append(tabId, { dir: 'system', error, at: Date.now(), size: 0, preview: text, text })
}

function patch(tabId: Id, next: Partial<WsSession>): void {
  useWsSessions.setState((s) => ({
    sessions: { ...s.sessions, [tabId]: { ...(s.sessions[tabId] ?? idle()), ...next } }
  }))
}

function onFrame(tabId: Id, wire: WireFrame): void {
  const ring = ringOf(tabId)
  const frame = toFrame(wire, ring.nextId++)
  if (frame.dir === 'in') {
    ring.stats.received++
    ring.stats.bytesIn += frame.size
  } else {
    ring.stats.sent++
    ring.stats.bytesOut += frame.size
  }
  pushFrame(ring, frame)
  scheduleFlush(tabId)
}

function onEvent(tabId: Id, event: WsEvent): void {
  if (event.type === 'frame') return onFrame(tabId, event.frame)
  if (event.type === 'error') return system(tabId, event.error, true)
  if (event.type === 'open') return
  live.get(tabId)?.release()
  const reason = event.reason ? ` · ${event.reason}` : ''
  system(tabId, `${event.wasClean ? 'Disconnected' : 'Closed'} (${event.code})${reason}`, !event.wasClean)
  patch(tabId, {
    state: 'closed',
    socketId: undefined,
    close: { code: event.code, reason: event.reason, wasClean: event.wasClean }
  })
  if (!event.wasClean) useHttp.getState().revealResponse(tabId)
}

function classify(message: string, code?: string): ClassifiedError {
  // Main's refusal at the socket cap carries no code; its sentence is the signal.
  if (message.includes(`${MAX_SOCKETS} open sockets`)) {
    return {
      class: 'socket-cap',
      message: `${MAX_SOCKETS} WebSockets are open, the most OpsMaxx allows`,
      fix: { label: 'Disconnect idle sockets…', action: 'disconnect-idle' }
    }
  }
  return classifyTransportError(message, code)
}

function failWith(tabId: Id, failure: WsFailure): void {
  patch(tabId, { state: 'error', socketId: undefined, failure })
  system(tabId, failure.message, true)
  // The reason is what the user needs to see next, even in a collapsed response (§2.4).
  useHttp.getState().revealResponse(tabId)
}

export const useWsSessions = create<WsSessionsState>((set, get) => ({
  sessions: {},
  composers: {},

  setComposer: (tabId, next) =>
    set((s) => ({ composers: { ...s.composers, [tabId]: { ...(s.composers[tabId] ?? EMPTY_COMPOSER), ...next } } })),

  connect: async (tabId, spec, sent) => {
    if (live.has(tabId)) return
    // Under `electron-vite dev` the renderer reloads while the process keeps
    // the preload bundle it booted with, so the bridge can be older than us.
    const bridge = window.opsmaxx?.httpSocket as Record<string, unknown> | undefined
    if (!bridgeHas(bridge, 'open') || !bridgeHas(bridge, 'onEvent')) {
      return failWith(tabId, {
        class: 'bridge-stale',
        message: 'Restart OpsMaxx to open a socket: this window is newer than the process behind it.',
        fix: { label: 'Restart OpsMaxx…', action: 'restart' }
      })
    }

    let stopEvents = (): void => {}
    const entry: { socketId?: string; release: () => void } = {
      release: () => {
        stopEvents()
        if (live.get(tabId) === entry) live.delete(tabId)
      }
    }
    live.set(tabId, entry)

    patch(tabId, { state: 'connecting', failure: undefined, close: undefined, sent, protocol: undefined })
    // Deliberately no URL: a resolved URL can carry a vault value in its query.
    system(tabId, 'Connecting…')
    const result = await window.opsmaxx.httpSocket.open(spec)
    // The tab closed while the handshake was in flight (forgetTab released it).
    if (live.get(tabId) !== entry) {
      if (result.ok) void window.opsmaxx.httpSocket.close(result.id)
      return
    }
    if (!result.ok) {
      entry.release()
      return failWith(tabId, { ...classify(result.error, result.code), code: result.code })
    }
    entry.socketId = result.id
    stopEvents = window.opsmaxx.httpSocket.onEvent(result.id, (event) => onEvent(tabId, event))
    patch(tabId, { state: 'open', socketId: result.id, openedAt: Date.now(), protocol: result.protocol })
    system(tabId, result.protocol ? `Connected · subprotocol ${shownProtocol(result.protocol)}` : 'Connected')
  },

  send: async (tabId, message) => {
    const socketId = live.get(tabId)?.socketId
    if (!socketId || get().sessions[tabId]?.state !== 'open') {
      return system(tabId, 'Not connected: that message was not sent.', true)
    }
    // Main echoes the frame back as an outgoing event, so the log shows it in
    // the order main put it on the wire rather than the order we asked.
    const result = await window.opsmaxx.httpSocket.send(socketId, message)
    if (!result.ok) system(tabId, result.error, true)
  },

  disconnect: (tabId) => {
    const socketId = live.get(tabId)?.socketId
    if (!socketId) return
    patch(tabId, { state: 'closing' })
    void window.opsmaxx.httpSocket.close(socketId)
  },

  fail: (tabId, { errorClass, message, unresolved }) => {
    // Declining the production confirm is the user's choice, not a transport
    // error: the tab stays idle, nothing turns red and the response stays as it was.
    if (errorClass === 'prod-declined') {
      return patch(tabId, { state: 'idle', failure: { class: errorClass, message: 'Not connected — production confirm declined' } })
    }
    failWith(tabId, { class: errorClass, message, unresolved })
  },

  clear: (tabId) => {
    const ring = rings.get(tabId)
    if (!ring) return
    ring.frames = []
    ring.head = 0
    ring.bytes = 0
    ring.stats.dropped = 0
    scheduleFlush(tabId)
  },

  ringFor: (tabId) => {
    const ring = rings.get(tabId)
    return ring ? compact(ring) : []
  }
}))

/**
 * The subprotocol the server chose, as it may be shown. The Timeline's rule:
 * a plain protocol name as is, a credential-shaped one with its token masked,
 * and anything else (a server echoing a vault-resolved raw token) as •••. The
 * value came off the wire, so it is never a {{reference}}.
 */
export function shownProtocol(protocol: string): string {
  if (isProtocolName(protocol) && !protocolCarriesCredential(protocol)) return protocol
  return protocolCarriesCredential(protocol) ? maskProtocol(protocol) : '•••'
}

/**
 * A socket belongs to its tab: when the tab leaves the strip, its socket is
 * closed (a handshake still in flight is closed when it lands) and its ring,
 * session and composer are freed. One subscription for every tab, rather than
 * a listener per connect, so a socket that already closed on its own does not
 * take the cleanup of its 32 MiB ring with it.
 */
function forgetTab(tabId: Id): void {
  const entry = live.get(tabId)
  if (entry?.socketId) void window.opsmaxx?.httpSocket?.close?.(entry.socketId)
  entry?.release()
  rings.delete(tabId)
  pending.delete(tabId)
  const { sessions, composers } = useWsSessions.getState()
  if (!(tabId in sessions) && !(tabId in composers)) return
  useWsSessions.setState((s) => {
    const { [tabId]: _gone, ...rest } = s.sessions
    const { [tabId]: _draft, ...composersLeft } = s.composers
    return { sessions: rest, composers: composersLeft }
  })
}

useHttp.subscribe((s, prev) => {
  if (s.tabs === prev.tabs) return
  const open = new Set(s.tabs.map((t) => t.id))
  for (const t of prev.tabs) if (!open.has(t.id)) forgetTab(t.id)
})

/**
 * The rows a fixed-height list should render: `start` inclusive, `end`
 * exclusive, with `overscan` rows either side. Pure.
 */
export function windowFor(
  scrollTop: number,
  height: number,
  rowH: number,
  count: number,
  overscan = 8
): { start: number; end: number } {
  if (count === 0 || rowH <= 0) return { start: 0, end: 0 }
  const first = Math.floor(Math.max(0, scrollTop) / rowH)
  const start = Math.max(0, Math.min(count, first - overscan))
  const end = Math.min(count, first + Math.ceil(Math.max(0, height) / rowH) + overscan)
  return { start, end: Math.max(start, end) }
}
