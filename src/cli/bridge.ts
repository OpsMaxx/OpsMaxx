import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  ErrorCode,
  isJSONRPCErrorResponse,
  isJSONRPCNotification,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  type JSONRPCMessage
} from '@modelcontextprotocol/sdk/types.js'

// Pure protocol relay: an MCP client (Claude Code, Codex, ...) talks stdio to
// this process; every message is forwarded, unmodified, to OpsMaxx's own
// MCP server over the already-existing authenticated HTTP endpoint, and every
// reply is forwarded back. No tool/session/policy logic lives here — that all
// stays exactly where it already is, in mcpServer.ts and the services it
// calls, so a stdio-only client gets the identical security/audit/approval
// path an HTTP client would.
//
// ===========================================================================
// THE TWO LEGS FAIL DIFFERENTLY, AND ONLY ONE OF THEM IS FATAL
// ===========================================================================
//
// This used to shut the whole process down when EITHER leg closed. That was
// wrong on the HTTP side and it is the reason people had to restart their MCP
// client after quitting the app: stdio has no reconnect — the transport IS this
// process's stdin and stdout — so once the bridge exits, the client's server is
// gone until the client itself respawns it. Quitting OpsMaxx for thirty seconds
// cost you a Claude restart.
//
// The HTTP endpoint is stateless (`sessionIdGenerator: undefined`, see
// mcpServer.ts), which means there is no session to lose and nothing to
// re-establish: a POST that works now would have worked before the app
// restarted. So a dropped upstream is not an ending, it is a gap. Drop the
// handle, let the next message dial again.
//
// STDIO closing still exits, and must: the client really has gone.
//
// ---------------------------------------------------------------------------
// WHY A FAILED MESSAGE IS NEVER REPLAYED
// ---------------------------------------------------------------------------
//
// The tempting version of this queues messages while the upstream is down and
// flushes them on reconnect, so an in-flight call survives an app restart. It
// must not, and the reason is that this file cannot tell the difference between
// a POST that never left and a POST the server accepted and ran before the
// connection broke. Half the tools on the other side write to real machines —
// `execute_command`, `patch`, `broadcast` — and a relay that resends on doubt
// runs somebody's command twice. The bridge is deliberately ignorant of which
// tools those are (see the paragraph at the top), so it cannot make the call
// per-message and must therefore never make it at all.
//
// A request that fails gets one honest error instead. The caller retries if it
// wants to, and by then the reconnect above has already happened.
//
// ---------------------------------------------------------------------------
// ...EXCEPT A CONNECTION THAT WAS REFUSED, WHICH IS WAITED OUT
// ---------------------------------------------------------------------------
//
// ECONNREFUSED is the one failure that proves the POST never left: nothing was
// listening, so nothing can have run. Retrying that cannot run anything twice.
// It is also exactly what happens when the MCP client starts before OpsMaxx
// does -- and there the first message is `initialize`. Answering it with an
// error made Claude Desktop mark the server failed for good, so the reconnect
// above only ever helped clients that had started while the app was already up.
// Waiting a while for the app gives the routine case a working server instead.
const REFUSED_WAIT_MS = 30_000
const REFUSED_RETRY_MS = 500

function refusedConnection(err: unknown): boolean {
  return (err as { cause?: { code?: unknown } } | null)?.cause?.code === 'ECONNREFUSED'
}

// A 401 means the app is up and has said no to this token: revoked, expired,
// AI access turned off, or a session that was replaced by connecting again.
// Telling the user to check the app is running sends them to the one thing
// that is fine. The server's own explanation is in the error, so pass it on.
function tokenRejected(err: unknown): string | null {
  if ((err as { code?: unknown } | null)?.code !== 401) return null
  const text = err instanceof Error ? err.message : ''
  const json = text.slice(text.indexOf('{'))
  try {
    const why = (JSON.parse(json) as { error_description?: unknown }).error_description
    if (typeof why === 'string' && why) return `OpsMaxx refused this client's token. ${why}`
  } catch {
    /* fall through to the generic wording */
  }
  return 'OpsMaxx refused this client\'s token — the session was revoked, expired or replaced. In OpsMaxx, use AI & MCP > Overview > Connect for this client again, then restart the client.'
}

// ---------------------------------------------------------------------------
// A CALL WHOSE STREAM ENDS WITHOUT AN ANSWER GETS ONE
// ---------------------------------------------------------------------------
//
// Every reply comes back on an SSE stream that the SDK reads in the background,
// after send() has already resolved. When that stream ends or breaks before the
// reply -- OpsMaxx quit or restarted mid-call -- the SDK logs it and nothing
// else: it only resumes streams that carried event ids, and this server sends
// none. The request was simply never answered, and the client waited on it
// until its own timeout, which for a tool call can be a long time. The bridge
// sees each stream through its own fetch and answers what is left unanswered.
// Honestly: the call may well have run, so the reply says so rather than
// inviting a blind retry.
//
// ponytail: settles on a short timer after the stream ends, so the SDK's parser
// can deliver the last event it already read first. A reply slower than that
// would arrive after the error; the client drops a reply to an id it has
// already settled.
const STREAM_SETTLE_MS = 100

type RequestId = string | number

function requestIdsIn(body: unknown): RequestId[] {
  if (typeof body !== 'string') return []
  try {
    const parsed: unknown = JSON.parse(body)
    return (Array.isArray(parsed) ? parsed : [parsed]).filter(isJSONRPCRequest).map((m) => m.id)
  } catch {
    return []
  }
}

export async function runBridge(token: string, port: number): Promise<void> {
  const server = new StdioServerTransport()
  const url = new URL(`http://127.0.0.1:${port}/mcp`)

  let closing = false
  let client: StreamableHTTPClientTransport | null = null
  let connecting: Promise<StreamableHTTPClientTransport> | null = null
  // Requests delivered upstream whose reply has not come back yet.
  const awaiting = new Set<RequestId>()
  // Requests still inside toUpstream (possibly waiting out a refused
  // connection), and whether the client has cancelled them meanwhile.
  const sending = new Map<RequestId, { cancelled: boolean }>()

  async function watchedFetch(input: string | URL, init?: RequestInit): Promise<Response> {
    const res = await fetch(input, init)
    // A cancel can arrive while this fetch is still waiting for headers; the
    // call is still in `sending` then, marked, and is owed nothing.
    const ids = requestIdsIn(init?.body).filter((id) => !sending.get(id)?.cancelled)
    if (ids.length === 0 || !res.body || !res.headers.get('content-type')?.includes('text/event-stream')) return res
    for (const id of ids) awaiting.add(id)

    const settle = (): void => {
      setTimeout(() => {
        for (const id of ids) if (awaiting.delete(id)) lost(id)
      }, STREAM_SETTLE_MS)
    }
    const reader = res.body.getReader()
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read()
          if (done) {
            controller.close()
            settle()
          } else controller.enqueue(value)
        } catch (err) {
          controller.error(err)
          settle()
        }
      },
      cancel: (reason) => reader.cancel(reason)
    })
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers })
  }

  const options = { requestInit: { headers: { Authorization: `Bearer ${token}` } }, fetch: watchedFetch }

  function lost(id: RequestId): void {
    if (closing) return
    void server.send({
      jsonrpc: '2.0',
      id,
      error: {
        code: ErrorCode.ConnectionClosed,
        message:
          'OpsMaxx closed the connection before this call finished — most likely the app quit or restarted. The call may already have run: check AI & MCP > Audit Log in OpsMaxx before trying it again.'
      }
    })
  }

  function build(): StreamableHTTPClientTransport {
    const c = new StreamableHTTPClientTransport(url, options)
    c.onmessage = (message) => {
      if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) {
        if (message.id !== undefined) awaiting.delete(message.id)
      }
      void server.send(message)
    }
    // Drop the handle and stay alive. Guarded on identity so a close arriving
    // late from a transport we have already replaced cannot discard the new one.
    c.onclose = () => {
      if (client === c) client = null
    }
    c.onerror = (err) => console.error('[opsmaxx bridge] http error:', err.message)
    return c
  }

  function connect(): Promise<StreamableHTTPClientTransport> {
    if (client) return Promise.resolve(client)
    // One dial at a time. Without this, every message that arrives during an
    // outage starts its own transport and the app comes back to a small storm.
    connecting ??= (async () => {
      try {
        const c = build()
        await c.start()
        client = c
        return c
      } finally {
        connecting = null
      }
    })()
    return connecting
  }

  async function toUpstream(message: JSONRPCMessage): Promise<void> {
    const deadline = Date.now() + REFUSED_WAIT_MS
    const id = isJSONRPCRequest(message) ? message.id : undefined
    const state = { cancelled: false }
    if (id !== undefined) sending.set(id, state)
    try {
      for (;;) {
        try {
          const c = await connect()
          await c.send(message)
          return
        } catch (err) {
          if (closing) return
          // Whatever this transport was, it is not usable; the next message dials.
          client = null
          // The one failure that is safe to try again. See REFUSED_WAIT_MS.
          if (refusedConnection(err) && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, REFUSED_RETRY_MS))
            // A call the client gave up on while it waited never reached
            // OpsMaxx, so it is simply not sent. Nothing is owed: a cancelled
            // request gets no reply.
            if (closing || state.cancelled) return
            continue
          }
          refuse(message, err)
          return
        }
      }
    } finally {
      if (id !== undefined && sending.get(id) === state) sending.delete(id)
    }
  }

  // A cancel still goes upstream as it always did, in case its call got there.
  // What changes is everything this side holds for that call: one still waiting
  // to be delivered is dropped, and one awaiting its reply is owed nothing now.
  function noteCancel(message: JSONRPCMessage): void {
    if (!isJSONRPCNotification(message) || message.method !== 'notifications/cancelled') return
    const id = (message.params as { requestId?: RequestId } | undefined)?.requestId
    if (id === undefined) return
    awaiting.delete(id)
    const held = sending.get(id)
    if (held) held.cancelled = true
  }

  function refuse(message: JSONRPCMessage, err: unknown): void {
    const rejected = tokenRejected(err)
    console.error(
      rejected ? '[opsmaxx bridge] token rejected:' : '[opsmaxx bridge] upstream unreachable:',
      err instanceof Error ? err.message : String(err)
    )
    // Only a request is owed a reply. An undeliverable notification is dropped,
    // which is the whole of what makes it a notification.
    if (!isJSONRPCRequest(message)) return
    void server.send({
      jsonrpc: '2.0',
      id: message.id,
      error: {
        code: ErrorCode.ConnectionClosed,
        message:
          rejected ??
          `OpsMaxx is not reachable on port ${port} — check the desktop app is running, and that its MCP port (AI & MCP > Security) is still ${port}; if it changed, connect this client again. The bridge stays up and reconnects on its own, so retrying usually just works.`
      }
    })
  }

  const shutdown = async (): Promise<void> => {
    if (closing) return
    closing = true
    await Promise.allSettled([server.close(), client?.close() ?? Promise.resolve()])
    process.exit(0)
  }

  server.onmessage = (message) => {
    noteCancel(message)
    void toUpstream(message)
  }
  // The only fatal close. See the header.
  server.onclose = () => void shutdown()
  server.onerror = (err) => console.error('[opsmaxx bridge] stdio error:', err.message)

  await server.start()
  // Best effort. A bridge started before the app is up must still be listening
  // on stdio, so the client gets a server now and a working one shortly, rather
  // than a spawn failure it will not retry.
  await connect().catch((err: unknown) => {
    console.error(
      '[opsmaxx bridge] upstream not up yet:',
      err instanceof Error ? err.message : String(err)
    )
  })
}
