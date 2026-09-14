import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * The stdio-to-HTTP MCP relay (src/cli/bridge.ts).
 *
 * It used to exit when EITHER leg closed, which meant quitting the desktop app
 * killed the bridge, and stdio has no reconnect -- so the user's MCP client was
 * left with a dead server until they restarted the client itself. These pin the
 * asymmetry that replaced it: the HTTP leg is a gap to be re-dialled, the stdio
 * leg is the client going away.
 */

const h = vi.hoisted(() => {
  class FakeStdio {
    static instances: FakeStdio[] = []
    onmessage?: (m: unknown) => void
    onclose?: () => void
    onerror?: (e: Error) => void
    sent: unknown[] = []
    started = false
    constructor() {
      FakeStdio.instances.push(this)
    }
    async start(): Promise<void> {
      this.started = true
    }
    async send(m: unknown): Promise<void> {
      this.sent.push(m)
    }
    async close(): Promise<void> {}
  }

  class FakeHttp {
    static instances: FakeHttp[] = []
    static failStart = false
    static failSend = false
    onmessage?: (m: unknown) => void
    onclose?: () => void
    onerror?: (e: Error) => void
    sent: unknown[] = []
    closed = false
    constructor(
      public url: URL,
      public opts: { requestInit?: { headers?: Record<string, string> } }
    ) {
      FakeHttp.instances.push(this)
    }
    async start(): Promise<void> {
      if (FakeHttp.failStart) throw new Error('connect ECONNREFUSED 127.0.0.1:7777')
    }
    async send(m: unknown): Promise<void> {
      if (FakeHttp.failSend) throw new Error('socket hang up')
      this.sent.push(m)
    }
    async close(): Promise<void> {
      this.closed = true
    }
  }

  return { FakeStdio, FakeHttp }
})

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({ StdioServerTransport: h.FakeStdio }))
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: h.FakeHttp
}))

const { runBridge } = await import('../src/cli/bridge')

const REQUEST = { jsonrpc: '2.0' as const, id: 7, method: 'tools/call', params: {} }
const NOTIFICATION = { jsonrpc: '2.0' as const, method: 'notifications/cancelled', params: {} }

let exit: ReturnType<typeof vi.spyOn>

function stdio(): InstanceType<typeof h.FakeStdio> {
  return h.FakeStdio.instances[h.FakeStdio.instances.length - 1]
}

beforeEach(() => {
  h.FakeStdio.instances.length = 0
  h.FakeHttp.instances.length = 0
  h.FakeHttp.failStart = false
  h.FakeHttp.failSend = false
  vi.spyOn(console, 'error').mockImplementation(() => {})
  exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
})

afterEach(() => vi.restoreAllMocks())

describe('when the desktop app is not reachable', () => {
  it('still comes up, listening on stdio', async () => {
    h.FakeHttp.failStart = true
    // Must not reject: a spawn failure is the one thing the MCP client will not
    // retry, and the app being down at spawn time is routine.
    await expect(runBridge('tok', 7777)).resolves.toBeUndefined()
    expect(stdio().started).toBe(true)
    expect(exit).not.toHaveBeenCalled()
  })

  it('answers a request it could not deliver, rather than hanging', async () => {
    h.FakeHttp.failStart = true
    await runBridge('tok', 7777)
    stdio().onmessage?.(REQUEST)
    await vi.waitFor(() => expect(stdio().sent).toHaveLength(1))
    expect(stdio().sent[0]).toMatchObject({ jsonrpc: '2.0', id: 7, error: { code: -32000 } })
  })

  it('drops an undeliverable notification, because nothing is owed a reply', async () => {
    h.FakeHttp.failStart = true
    await runBridge('tok', 7777)
    stdio().onmessage?.(NOTIFICATION)
    await vi.waitFor(() => expect(console.error).toHaveBeenCalled())
    expect(stdio().sent).toEqual([])
  })

  it('dials once for a burst, not once per message', async () => {
    h.FakeHttp.failStart = true
    await runBridge('tok', 7777)
    const dialled = h.FakeHttp.instances.length
    stdio().onmessage?.({ ...REQUEST, id: 1 })
    stdio().onmessage?.({ ...REQUEST, id: 2 })
    stdio().onmessage?.({ ...REQUEST, id: 3 })
    await vi.waitFor(() => expect(stdio().sent).toHaveLength(3))
    // One new transport for the burst. Without the in-flight guard the app comes
    // back to a small storm of them.
    expect(h.FakeHttp.instances.length - dialled).toBe(1)
  })
})

describe('when the app goes away and comes back', () => {
  it('does not exit, and re-dials on the next message', async () => {
    await runBridge('tok', 7777)
    const first = h.FakeHttp.instances[0]
    expect(first.sent).toEqual([])

    // The app quits.
    first.onclose?.()
    expect(exit).not.toHaveBeenCalled()

    // The next message gets a fresh transport and goes through.
    stdio().onmessage?.(REQUEST)
    await vi.waitFor(() => expect(h.FakeHttp.instances[1]?.sent).toEqual([REQUEST]))
    expect(stdio().sent).toEqual([])
  })

  it('re-dials after a send fails mid-flight', async () => {
    await runBridge('tok', 7777)
    h.FakeHttp.failSend = true
    stdio().onmessage?.(REQUEST)
    await vi.waitFor(() => expect(stdio().sent).toHaveLength(1))

    h.FakeHttp.failSend = false
    stdio().onmessage?.({ ...REQUEST, id: 8 })
    await vi.waitFor(() =>
      expect(h.FakeHttp.instances[1]?.sent).toEqual([{ ...REQUEST, id: 8 }])
    )
  })

  it('never replays the message that failed', async () => {
    // Half the tools on the other side write to real machines, and this file
    // cannot tell a POST that never left from one the server ran before the
    // connection broke. Resending on doubt runs somebody's command twice.
    await runBridge('tok', 7777)
    h.FakeHttp.failSend = true
    stdio().onmessage?.(REQUEST)
    await vi.waitFor(() => expect(stdio().sent).toHaveLength(1))

    h.FakeHttp.failSend = false
    stdio().onmessage?.({ ...REQUEST, id: 8 })
    await vi.waitFor(() =>
      expect(h.FakeHttp.instances[1]?.sent).toEqual([{ ...REQUEST, id: 8 }])
    )
    for (const t of h.FakeHttp.instances) {
      expect(t.sent).not.toContainEqual(REQUEST)
    }
  })

  it('ignores a late close from a transport already replaced', async () => {
    await runBridge('tok', 7777)
    const first = h.FakeHttp.instances[0]
    first.onclose?.()
    stdio().onmessage?.(REQUEST)
    await vi.waitFor(() => expect(h.FakeHttp.instances[1]?.sent).toHaveLength(1))

    // The dead one finally reports in. It must not discard its replacement.
    first.onclose?.()
    stdio().onmessage?.({ ...REQUEST, id: 9 })
    await vi.waitFor(() => expect(h.FakeHttp.instances[1].sent).toHaveLength(2))
    expect(h.FakeHttp.instances).toHaveLength(2)
  })
})

describe('when the MCP client goes away', () => {
  it('exits, because stdio has nothing to reconnect to', async () => {
    await runBridge('tok', 7777)
    stdio().onclose?.()
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0))
  })
})

describe('the relay itself', () => {
  it('forwards both ways unmodified, with the bearer token', async () => {
    await runBridge('tok', 7777)
    const http = h.FakeHttp.instances[0]
    expect(http.url.toString()).toBe('http://127.0.0.1:7777/mcp')
    expect(http.opts.requestInit?.headers?.Authorization).toBe('Bearer tok')

    stdio().onmessage?.(REQUEST)
    await vi.waitFor(() => expect(http.sent).toEqual([REQUEST]))

    const reply = { jsonrpc: '2.0' as const, id: 7, result: {} }
    http.onmessage?.(reply)
    await vi.waitFor(() => expect(stdio().sent).toEqual([reply]))
  })
})
