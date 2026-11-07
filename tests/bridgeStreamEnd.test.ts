import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * The bridge against a real HTTP server and the real SDK client transport --
 * only stdio is faked. What is under test lives in how the SDK reads a reply:
 * on an SSE stream, in the background, after send() has resolved. A stream
 * that ends or breaks before the reply was logged by the SDK and nothing else,
 * so the request was never answered. That cannot be shown with the transport
 * mocked out, which is why this is not in mcpBridge.test.ts.
 */

const h = vi.hoisted(() => {
  class FakeStdio {
    static instances: FakeStdio[] = []
    onmessage?: (m: unknown) => void
    onclose?: () => void
    onerror?: (e: Error) => void
    sent: unknown[] = []
    constructor() {
      FakeStdio.instances.push(this)
    }
    async start(): Promise<void> {}
    async send(m: unknown): Promise<void> {
      this.sent.push(m)
    }
    async close(): Promise<void> {}
  }
  return { FakeStdio }
})

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({ StdioServerTransport: h.FakeStdio }))

const { runBridge } = await import('../src/cli/bridge')

// What the fake upstream does with the next POST that carries a request.
type Behaviour = 'reply' | 'end-without-reply' | 'break'
let behaviour: Behaviour = 'reply'
let openStreams: ServerResponse[] = []
let server: Server
let port: number

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const msg = JSON.parse(raw) as { id?: number; method: string }
      if (msg.id === undefined) {
        res.writeHead(202).end()
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.flushHeaders()
      openStreams.push(res)
      setTimeout(() => {
        if (behaviour === 'reply') {
          res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { ok: true } })}\n\n`)
        } else if (behaviour === 'end-without-reply') {
          res.end()
        } else {
          res.socket?.destroy()
        }
      }, 50)
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  port = (server.address() as AddressInfo).port
})

afterAll(() => new Promise<void>((r) => server.close(() => r())))

let exit: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  h.FakeStdio.instances.length = 0
  openStreams = []
  vi.spyOn(console, 'error').mockImplementation(() => {})
  exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
})
afterEach(() => {
  for (const s of openStreams) s.destroy()
  vi.restoreAllMocks()
})

const stdio = (): InstanceType<typeof h.FakeStdio> => h.FakeStdio.instances[h.FakeStdio.instances.length - 1]
const call = (id: number): unknown => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'x' } })

describe('a reply stream that ends before the reply', () => {
  it('passes a real reply through untouched, and adds nothing after it', async () => {
    behaviour = 'reply'
    await runBridge('tok', port)
    stdio().onmessage?.(call(1))
    await vi.waitFor(() => expect(stdio().sent).toHaveLength(1))
    await new Promise((r) => setTimeout(r, 300))
    expect(stdio().sent).toEqual([{ jsonrpc: '2.0', id: 1, result: { ok: true } }])
  })

  it('answers the call when the app closes the stream cleanly without replying', async () => {
    behaviour = 'end-without-reply'
    await runBridge('tok', port)
    stdio().onmessage?.(call(2))
    await vi.waitFor(() => expect(stdio().sent).toHaveLength(1))
    const reply = stdio().sent[0] as { id: number; error: { message: string } }
    expect(reply.id).toBe(2)
    expect(reply.error.message).toContain('closed the connection before this call finished')
    // It may have run. Saying otherwise would invite running it twice.
    expect(reply.error.message).toContain('may already have run')
  })

  it('answers the call when the connection breaks mid-stream', async () => {
    behaviour = 'break'
    await runBridge('tok', port)
    stdio().onmessage?.(call(3))
    await vi.waitFor(() => expect(stdio().sent).toHaveLength(1))
    expect(stdio().sent[0]).toMatchObject({ id: 3, error: { code: -32000 } })
    expect(exit).not.toHaveBeenCalled()
  })

  // OpsMaxx ends a cancelled call's stream on purpose. The client asked for no
  // reply, so it must not get an error for that call either.
  it('stays silent for a call the client cancelled', async () => {
    behaviour = 'end-without-reply'
    await runBridge('tok', port)
    stdio().onmessage?.(call(4))
    stdio().onmessage?.({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 4 } })
    await new Promise((r) => setTimeout(r, 400))
    expect(stdio().sent).toEqual([])
  })
})
