import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ErrorCode, isJSONRPCRequest, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'

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
export async function runBridge(token: string, port: number): Promise<void> {
  const server = new StdioServerTransport()
  const url = new URL(`http://127.0.0.1:${port}/mcp`)
  const options = { requestInit: { headers: { Authorization: `Bearer ${token}` } } }

  let closing = false
  let client: StreamableHTTPClientTransport | null = null
  let connecting: Promise<StreamableHTTPClientTransport> | null = null

  function build(): StreamableHTTPClientTransport {
    const c = new StreamableHTTPClientTransport(url, options)
    c.onmessage = (message) => void server.send(message)
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
    try {
      const c = await connect()
      await c.send(message)
    } catch (err) {
      if (closing) return
      // Whatever this transport was, it is not usable; the next message dials.
      client = null
      refuse(message, err)
    }
  }

  function refuse(message: JSONRPCMessage, err: unknown): void {
    console.error(
      '[opsmaxx bridge] upstream unreachable:',
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
          'OpsMaxx is not reachable — check the desktop app is running. The bridge stays up and reconnects on its own, so retrying usually just works.'
      }
    })
  }

  const shutdown = async (): Promise<void> => {
    if (closing) return
    closing = true
    await Promise.allSettled([server.close(), client?.close() ?? Promise.resolve()])
    process.exit(0)
  }

  server.onmessage = (message) => void toUpstream(message)
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
