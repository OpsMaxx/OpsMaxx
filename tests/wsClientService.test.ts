import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import http from 'node:http'
import { WebSocketServer } from 'ws'
import type { AddressInfo } from 'node:net'
import type { WsEvent } from '../src/shared/httpSocket'

/**
 * WebSocket sessions, against a real server.
 *
 * The SSH pool is stubbed — reaching a server is `netTransport`'s job and is
 * covered where the HTTP client covers it. What matters here is the session:
 * that the handshake carries headers the browser could not send, that frames
 * go both ways, that the limits hold, and above all that nothing is left open
 * when a socket ends. A leaked session holds an SSH channel for the life of
 * the app.
 */
vi.mock('../src/main/services/ssh', () => ({
  acquire: vi.fn(),
  release: vi.fn()
}))

const { wsOpen, wsSend, wsClose, wsCloseForOwner, wsCloseAll, socketCount } = await import(
  '../src/main/services/wsClient'
)
const { MAX_SOCKETS, IPC_FRAME_BYTES, NORMAL_CLOSURE } = await import('../src/shared/httpSocket')

let server: http.Server
let wss: WebSocketServer
let url: string
/** Handshake headers the server saw, newest last. */
let seenHeaders: Array<Record<string, string | string[] | undefined>> = []

const ctx = {
  prepare: <T>(t: T): T => t,
  emit: () => {}
}
const direct = { kind: 'direct' as const }

/** Opens a socket and collects everything it emits. */
async function open(
  over: Partial<Parameters<typeof wsOpen>[0]> = {},
  ownerId = 1
): Promise<{ result: Awaited<ReturnType<typeof wsOpen>>; events: WsEvent[] }> {
  const events: WsEvent[] = []
  const result = await wsOpen({ url, via: direct, ...over }, ownerId, {
    prepare: ctx.prepare,
    emit: (_owner, _id, event) => events.push(event)
  })
  return { result, events }
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 60))

beforeAll(async () => {
  server = http.createServer()
  wss = new WebSocketServer({ server })

  wss.on('connection', (socket, req) => {
    seenHeaders.push(req.headers)
    socket.on('message', (data: Buffer, isBinary: boolean) => {
      const text = isBinary ? '' : data.toString('utf8')
      if (text === 'close-me') return socket.close(4001, 'as asked')
      if (text === 'big') return socket.send('y'.repeat(IPC_FRAME_BYTES + 1024))
      if (isBinary) return socket.send(data, { binary: true })
      socket.send(`echo:${text}`)
    })
  })

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  wsCloseAll()
  wss?.close()
  server?.close()
})

beforeEach(() => {
  wsCloseAll()
  seenHeaders = []
})

describe('opening', () => {
  it('connects and reports the session', async () => {
    const { result, events } = await open()
    expect(result.ok).toBe(true)
    expect(events[0]).toMatchObject({ type: 'open' })
    if (result.ok) wsClose(result.id)
  })

  /**
   * The capability that justifies opening sockets in main at all. A browser
   * `new WebSocket(url)` cannot set a single handshake header, which is why
   * browser-based clients put tokens in the query string — where they land in
   * every access log between here and the server.
   */
  it('sends handshake headers the browser could not', async () => {
    const { result } = await open({ headers: { Authorization: 'Bearer s3cr3t' } })
    expect(result.ok).toBe(true)
    await settle()
    expect(seenHeaders.at(-1)?.authorization).toBe('Bearer s3cr3t')
    if (result.ok) wsClose(result.id)
  })

  it('refuses a scheme that is not a WebSocket', async () => {
    const { result } = await open({ url: 'https://example.test' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/ws:\/\/ or wss:\/\//)
  })

  /**
   * The cloud metadata endpoints. A WebSocket to one is the same SSRF shape as
   * a request to one, so it is refused in the same place for the same reason.
   */
  it('refuses a link-local address', async () => {
    const { result } = await open({ url: 'ws://169.254.169.254/' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/link-local/)
  })

  it('reports a refused connection instead of hanging', async () => {
    // Port 1 has nothing on it.
    const { result } = await open({ url: 'ws://127.0.0.1:1/' })
    expect(result.ok).toBe(false)
  })

  it('does not count a failed open against the limit', async () => {
    await open({ url: 'ws://127.0.0.1:1/' })
    expect(socketCount()).toBe(0)
  })
})

describe('frames', () => {
  it('carries text both ways, and logs both halves', async () => {
    const { result, events } = await open()
    expect(result.ok).toBe(true)
    if (!result.ok) return

    wsSend(result.id, 'hello')
    await settle()

    const frames = events.filter((e) => e.type === 'frame')
    // The outgoing frame is echoed back by main so the log is in the order
    // main saw it, rather than the renderer guessing when its own frame went.
    expect(frames.some((f) => f.type === 'frame' && f.frame.direction === 'outgoing')).toBe(true)
    expect(
      frames.some(
        (f) => f.type === 'frame' && f.frame.direction === 'incoming' && f.frame.data === 'echo:hello'
      )
    ).toBe(true)
    wsClose(result.id)
  })

  it('carries binary as bytes rather than mangling it into text', async () => {
    const { result, events } = await open()
    if (!result.ok) return

    const bytes = new Uint8Array([0, 1, 2, 250, 255]).buffer
    wsSend(result.id, bytes)
    await settle()

    const incoming = events.find(
      (e) => e.type === 'frame' && e.frame.direction === 'incoming'
    )
    expect(incoming?.type === 'frame' && incoming.frame.opcode).toBe('binary')
    wsClose(result.id)
  })

  it('truncates an oversized frame rather than dropping it', async () => {
    const { result, events } = await open()
    if (!result.ok) return

    wsSend(result.id, 'big')
    await settle()

    const incoming = events.find(
      (e) => e.type === 'frame' && e.frame.direction === 'incoming'
    )
    // A log cannot render megabytes, but the fact that a large frame ARRIVED
    // is exactly what someone debugging a stream needs to see.
    expect(incoming?.type === 'frame' && incoming.frame.truncated).toBe(true)
    expect(
      incoming?.type === 'frame' && (incoming.frame.data as string).length
    ).toBeLessThanOrEqual(IPC_FRAME_BYTES)
    wsClose(result.id)
  })

  it('refuses to send on a socket that is not open', () => {
    const sent = wsSend('no-such-session', 'hi')
    expect(sent.ok).toBe(false)
    if (!sent.ok) expect(sent.reason).toBe('unknown-session')
  })
})

describe('closing', () => {
  it('reports a close the far end started', async () => {
    const { result, events } = await open()
    if (!result.ok) return

    wsSend(result.id, 'close-me')
    await settle()

    const closed = events.find((e) => e.type === 'close')
    expect(closed).toMatchObject({ type: 'close', code: 4001 })
    expect(socketCount()).toBe(0)
    })

  it('closes on request and forgets the session', async () => {
    const { result } = await open()
    if (!result.ok) return
    expect(socketCount()).toBe(1)

    wsClose(result.id, NORMAL_CLOSURE)
    await settle()
    expect(socketCount()).toBe(0)
  })

  it('is idempotent', async () => {
    const { result } = await open()
    if (!result.ok) return
    wsClose(result.id)
    await settle()
    expect(() => wsClose(result.id)).not.toThrow()
    expect(socketCount()).toBe(0)
  })

  /**
   * The leak that matters. A renderer reload would otherwise strand one SSH
   * channel per socket it had open, for the life of the app.
   */
  it('closes every socket a departing window owned, and only those', async () => {
    const mine = await open({}, 7)
    const theirs = await open({}, 8)
    expect(socketCount()).toBe(2)

    wsCloseForOwner(7)
    await settle()

    expect(socketCount()).toBe(1)
    expect(mine.result.ok && theirs.result.ok).toBe(true)
    wsCloseAll()
  })
})

describe('limits', () => {
  it('refuses past the session ceiling rather than opening channels forever', async () => {
    const opened: string[] = []
    for (let i = 0; i < MAX_SOCKETS; i++) {
      const { result } = await open()
      if (result.ok) opened.push(result.id)
    }
    expect(opened).toHaveLength(MAX_SOCKETS)

    const over = await open()
    expect(over.result.ok).toBe(false)
    if (!over.result.ok) expect(over.result.error).toMatch(/as many as OpsMaxx will hold/)

    wsCloseAll()
    expect(socketCount()).toBe(0)
  })
})
