import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { WebSocketServer } from 'ws'
import type { AddressInfo } from 'node:net'
import type { WsEvent, WsOpenResult, WsOpenSpec } from '../src/shared/httpSocket'

// What the server says the instant the handshake completes, and which
// subprotocol it picks, are the two things that used to be lost: main emitted
// both before `ws:open` resolved, and the renderer subscribed after.
vi.mock('../src/main/services/ssh', () => ({ acquire: vi.fn(), release: vi.fn() }))

const { wsOpen, wsSend, wsClose, wsCloseAll, socketCount } = await import('../src/main/services/wsClient')
const { socketBridge, MAX_SOCKETS } = await import('../src/shared/httpSocket')

let server: http.Server
let wss: WebSocketServer
let url: string

beforeAll(async () => {
  server = http.createServer()
  wss = new WebSocketServer({
    server,
    handleProtocols: (offered) => (offered.has('v1') ? 'v1' : false)
  })
  wss.on('connection', (socket, req) => {
    socket.send('hello')
    if (req.url === '/bye') socket.close(1000, 'done')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => {
  wsCloseAll()
  wss.close()
  server.close()
})

/**
 * A stand-in for Electron's IPC with the real ordering: main's `send` for an
 * event reaches the renderer before the `invoke` reply when main sent it
 * first. Nothing listening on the channel at that moment means it is lost.
 */
function fakeIpc(ownerId = 1) {
  const listeners = new Map<string, Set<(e: unknown, ...a: unknown[]) => void>>()
  const deliver = (ch: string, event: WsEvent): void => {
    for (const l of listeners.get(ch) ?? []) l({}, event)
  }
  return {
    on: (ch: string, l: (e: unknown, ...a: unknown[]) => void) => {
      if (!listeners.has(ch)) listeners.set(ch, new Set())
      listeners.get(ch)!.add(l)
    },
    removeListener: (ch: string, l: (e: unknown, ...a: unknown[]) => void) => listeners.get(ch)?.delete(l),
    invoke: async (ch: string, ...args: unknown[]): Promise<unknown> => {
      if (ch === 'ws:open') {
        return wsOpen(args[0] as WsOpenSpec, ownerId, {
          prepare: (t) => t,
          emit: (_o, id, event) => deliver(`ws:event:${id}`, event)
        })
      }
      if (ch === 'ws:send') return wsSend(args[0] as string, args[1] as string, ownerId)
      if (ch === 'ws:close') return wsClose(args[0] as string, undefined, undefined, ownerId)
      throw new Error(ch)
    },
    count: (ch: string) => listeners.get(ch)?.size ?? 0
  }
}

const later = (ms = 80): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('events emitted before ws:open resolves', () => {
  it('returns the negotiated subprotocol in the result', async () => {
    const r = await wsOpen({ url, via: { kind: 'direct' }, protocols: ['v2', 'v1'] }, 1, {
      prepare: (t) => t,
      emit: () => {}
    })
    expect(r).toMatchObject({ ok: true, protocol: 'v1' })
    if (r.ok) wsClose(r.id)
  })

  it('are lost to a plain subscribe-after-open, which is the bug', async () => {
    const ipc = fakeIpc()
    const result = (await ipc.invoke('ws:open', { url, via: { kind: 'direct' }, protocols: ['v1'] })) as WsOpenResult
    await later()
    const events: WsEvent[] = []
    if (result.ok) ipc.on(`ws:event:${result.id}`, (_e, ev) => events.push(ev as WsEvent))
    expect(events).toEqual([])
    if (result.ok) wsClose(result.id)
  })

  it('reach a subscriber that attaches after the open resolved, in order, once', async () => {
    const ipc = fakeIpc()
    const bridge = socketBridge(ipc, () => randomUUID())
    const result = (await bridge.open({ url, via: { kind: 'direct' }, protocols: ['v1'] })) as Extract<WsOpenResult, { ok: true }>
    expect(result.ok).toBe(true)
    // The subscriber is late on purpose: the greeting has long since arrived.
    await later()
    const events: WsEvent[] = []
    bridge.onEvent(result.id, (e) => events.push(e))
    expect(events.map((e) => e.type)).toEqual(['open', 'frame'])
    expect(events[0]).toEqual({ type: 'open', protocol: 'v1' })
    expect(events[1]).toMatchObject({ type: 'frame', frame: { direction: 'incoming', data: 'hello' } })
    // The holding listener is gone; only the subscriber's remains.
    expect(ipc.count(`ws:event:${result.id}`)).toBe(1)
    // Live events still flow after the replay.
    await bridge.send(result.id, 'ping')
    expect(events.at(-1)).toMatchObject({ type: 'frame', frame: { direction: 'outgoing', data: 'ping' } })
    await bridge.close(result.id)
  })

  it('keeps a close that happened before anyone subscribed', async () => {
    const bridge = socketBridge(fakeIpc(), () => randomUUID())
    const result = await bridge.open({ url: `${url}/bye`, via: { kind: 'direct' } })
    await later()
    const events: WsEvent[] = []
    if (result.ok) bridge.onEvent(result.id, (e) => events.push(e))
    expect(events.map((e) => e.type)).toEqual(['open', 'frame', 'close'])
  })

  it('stops holding for a socket that failed to open', async () => {
    const ipc = fakeIpc()
    let id = ''
    const bridge = socketBridge(ipc, () => (id = randomUUID()))
    const result = await bridge.open({ url: 'ws://127.0.0.1:1/', via: { kind: 'direct' } })
    expect(result.ok).toBe(false)
    expect(ipc.count(`ws:event:${id}`)).toBe(0)
  })
})

describe('caller-chosen ids', () => {
  it('refuses a malformed id, and a second open naming one in use', async () => {
    const ctx = { prepare: <T>(t: T): T => t, emit: () => {} }
    expect(await wsOpen({ url, via: { kind: 'direct' }, id: '../x' }, 1, ctx)).toMatchObject({ ok: false })
    const id = randomUUID()
    const first = wsOpen({ url, via: { kind: 'direct' }, id }, 1, ctx)
    // Still mid-handshake: the id is reserved from the start, not from `open`.
    expect(await wsOpen({ url, via: { kind: 'direct' }, id }, 1, ctx)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/already in use/)
    })
    expect(await first).toMatchObject({ ok: true, id })
    wsClose(id)
    await later()
  })

  it('lets only the owning window send to or close a socket', async () => {
    const r = await wsOpen({ url, via: { kind: 'direct' } }, 1, { prepare: (t) => t, emit: () => {} })
    if (!r.ok) throw new Error(r.error)
    expect(wsSend(r.id, 'x', 2)).toMatchObject({ ok: false, reason: 'unknown-session' })
    wsClose(r.id, undefined, undefined, 2)
    await later()
    expect(socketCount()).toBeGreaterThan(0)
    wsClose(r.id, undefined, undefined, 1)
    await later()
  })

  it('counts in-flight handshakes against MAX_SOCKETS', async () => {
    const ctx = { prepare: <T>(t: T): T => t, emit: () => {} }
    const opens = Array.from({ length: MAX_SOCKETS + 2 }, () => wsOpen({ url, via: { kind: 'direct' } }, 1, ctx))
    const results = await Promise.all(opens)
    expect(results.filter((r) => r.ok)).toHaveLength(MAX_SOCKETS)
    wsCloseAll()
  })
})
