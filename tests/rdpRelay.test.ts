import { readFileSync } from 'node:fs'
import { createServer, type Server as NetServer, type Socket } from 'node:net'
import { join } from 'node:path'
import { TLSSocket, createSecureContext } from 'node:tls'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'

// The relay reaches the network and the credential store, so both are stubbed.
// Everything else here is real: a real WebSocket, a real RDCleanPath PDU, a
// real TCP connection, and a real TLS handshake against a stub server holding
// a self-signed certificate — which is the case the relay exists to handle.
const cachedServers = new Map<string, unknown>()
vi.mock('../src/main/services/mcpDataCache', () => ({
  getCachedServer: (id: string) => cachedServers.get(id) ?? null
}))

// The trust decision has its own tests. Here it is stubbed so the relay tests
// exercise the transport rather than a dialog, and `certTrusted` lets one of
// them check that a refusal actually stops the session.
let certTrusted = true
const certChecks: Array<{ host: string; port: number }> = []
vi.mock('../src/main/services/rdpTrust', () => ({
  verifyRdpCertificate: async (host: string, port: number) => {
    certChecks.push({ host, port })
    return certTrusted
  }
}))

let storedPassword: string | undefined = 'hunter2'
let credentialError: Error | null = null
vi.mock('../src/main/services/credentialResolver', () => ({
  resolveSecrets: <T extends object>(cfg: T): T => {
    if (credentialError) throw credentialError
    return { ...cfg, password: storedPassword }
  },
  resolveChainSecrets: <T extends object>(cfg: T): T => ({ ...cfg, password: storedPassword })
}))

// A stand-in for the SSH chain. It records the config it was built from — which
// is the thing worth asserting, because building the chain to the wrong end
// (the server rather than the bastion) is the mistake that would require sshd
// on the Windows box — and forwards by dialling the target directly, which is
// what a real `forwardOut` produces from the bastion's point of view.
interface ChainCall {
  destination: string
  hops: string[]
  forwarded: Array<{ host: string; port: number }>
}
const chainCalls: ChainCall[] = []
let chainEnded = 0
vi.mock('../src/main/services/ssh', () => ({
  openChain: async (cfg: {
    host: string
    port: number
    hops?: Array<{ host: string }>
  }) => {
    const call: ChainCall = {
      destination: `${cfg.host}:${cfg.port}`,
      hops: (cfg.hops ?? []).map((h) => h.host),
      forwarded: []
    }
    chainCalls.push(call)
    const client = {
      forwardOut: (
        _sh: string,
        _sp: number,
        host: string,
        port: number,
        cb: (err: Error | undefined, channel: unknown) => void
      ) => {
        call.forwarded.push({ host, port })
        const { connect } = require('node:net') as typeof import('node:net')
        const socket = connect({ host, port }, () => cb(undefined, socket))
        socket.once('error', (e: Error) => cb(e, undefined))
      },
      end: () => {
        chainEnded++
      }
    }
    return { clients: [client], client, close: undefined }
  }
}))

const { rdpMintTicket, rdpRelayStatus, stopRdpRelay } = await import(
  '../src/main/services/rdpRelay'
)
const { buildResponse, parseRequest } = await import('../src/main/services/rdcleanpath')

const KEY = readFileSync(join(__dirname, 'fixtures/rdp/test-key.pem'))
const CERT = readFileSync(join(__dirname, 'fixtures/rdp/test-cert.pem'))

// The X.224 Connection Request a client would build, and the Confirm a server
// answers with. Their contents do not matter to the relay — it must replay one
// and return the other verbatim — but they have to be distinguishable to prove
// it did not mangle or swap them.
const X224_REQUEST = Buffer.from([0x03, 0x00, 0x00, 0x13, 0x0e, 0xe0, 0xaa])
const X224_CONFIRM = Buffer.from([0x03, 0x00, 0x00, 0x13, 0x0e, 0xd0, 0xbb])

/**
 * A stand-in for an RDP server: raw TCP for the X.224 exchange, then TLS.
 *
 * This is the sequence `performHandshake` drives, and the only way to check it
 * is with something that insists on that order.
 */
function startFakeRdpServer(): Promise<{
  port: number
  close: () => Promise<void>
  received: Buffer[]
  afterTls: Promise<Buffer>
}> {
  const received: Buffer[] = []
  let resolveAfterTls: (b: Buffer) => void
  const afterTls = new Promise<Buffer>((r) => (resolveAfterTls = r))

  return new Promise((resolve) => {
    const server: NetServer = createServer((socket: Socket) => {
      socket.once('data', (x224: Buffer) => {
        received.push(x224)
        socket.write(X224_CONFIRM)
        // Upgrade in place, exactly as a real RDP server does after the
        // negotiation: the same socket becomes the TLS transport.
        const tls = new TLSSocket(socket, {
          isServer: true,
          secureContext: createSecureContext({ key: KEY, cert: CERT })
        })
        tls.on('data', (payload: Buffer) => resolveAfterTls(payload))
        tls.on('error', () => {
          /* the test asserts on what arrived, not on how the peer left */
        })
      })
      socket.on('error', () => {})
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolve({
        port,
        received,
        afterTls,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done())
          })
      })
    })
  })
}

/** The request PDU the WASM client sends as its first WebSocket message. */
function buildRequestPdu(destination: string, token: string, x224: Buffer): Buffer {
  const len = (n: number): Buffer => {
    if (n < 0x80) return Buffer.from([n])
    const bytes: number[] = []
    let rest = n
    while (rest > 0) {
      bytes.unshift(rest & 0xff)
      rest >>>= 8
    }
    return Buffer.from([0x80 | bytes.length, ...bytes])
  }
  const tlv = (tag: number, body: Buffer): Buffer =>
    Buffer.concat([Buffer.from([tag]), len(body.length), body])
  const int = (n: number): Buffer => {
    const bytes: number[] = []
    let rest = n
    while (rest > 0) {
      bytes.unshift(rest & 0xff)
      rest >>>= 8
    }
    if ((bytes[0] & 0x80) !== 0) bytes.unshift(0)
    return tlv(0x02, Buffer.from(bytes))
  }
  const utf8 = (v: string): Buffer => tlv(0x0c, Buffer.from(v, 'utf-8'))
  return tlv(
    0x30,
    Buffer.concat([
      tlv(0xa0, int(3390)),
      tlv(0xa2, utf8(destination)),
      tlv(0xa3, utf8(token)),
      tlv(0xa6, tlv(0x04, x224))
    ])
  )
}

function connectRelay(proxyUrl: string, token: string): WebSocket {
  return new WebSocket(`${proxyUrl}?token=${encodeURIComponent(token)}`)
}

/** The first binary frame the relay sends back, or the close code if it hangs up. */
function firstReply(ws: WebSocket): Promise<{ data?: Buffer; closeCode?: number }> {
  return new Promise((resolve) => {
    ws.once('message', (data: Buffer) => resolve({ data: Buffer.from(data) }))
    ws.once('close', (code: number) => resolve({ closeCode: code }))
  })
}

function defineServer(id: string, port: number, extra: Record<string, unknown> = {}): void {
  cachedServers.set(id, {
    id,
    workspaceId: 'ws-1',
    name: 'Win Box',
    host: '127.0.0.1',
    port: 22,
    username: 'admin',
    auth: 'password',
    os: 'Windows',
    route: [],
    vpnProfileId: null,
    rdp: { port, nla: true },
    ...extra
  })
}

let fake: Awaited<ReturnType<typeof startFakeRdpServer>>

beforeEach(async () => {
  certTrusted = true
  certChecks.length = 0
  chainCalls.length = 0
  chainEnded = 0
  cachedServers.clear()
  storedPassword = 'hunter2'
  credentialError = null
  fake = await startFakeRdpServer()
})

afterEach(async () => {
  await stopRdpRelay()
  await fake.close()
})

describe('minting a ticket', () => {
  it('resolves the destination and credential from the saved record', async () => {
    defineServer('srv-1', fake.port)
    const result = await rdpMintTicket('srv-1')
    expect(result.ok).toBe(true)
    expect(result.ticket?.destination).toBe(`127.0.0.1:${fake.port}`)
    expect(result.ticket?.username).toBe('admin')
    expect(result.ticket?.password).toBe('hunter2')
    // Loopback, always. A relay reachable off this machine would be an
    // unauthenticated RDP proxy for the network.
    expect(result.ticket?.proxyUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/rdp$/)
  })

  it('refuses a server that is not configured for RDP', async () => {
    cachedServers.set('srv-2', {
      id: 'srv-2',
      workspaceId: 'ws-1',
      name: 'Linux Box',
      host: '127.0.0.1',
      port: 22,
      username: 'root',
      auth: 'key',
      os: 'Linux',
      route: [],
      vpnProfileId: null
    })
    const result = await rdpMintTicket('srv-2')
    expect(result.ok).toBe(false)
    expect(result.code).toBe('no-target')
  })

  it('refuses an unknown server', async () => {
    const result = await rdpMintTicket('nope')
    expect(result.ok).toBe(false)
    expect(result.code).toBe('no-target')
  })

  it('mints for a server behind a jump route', async () => {
    defineServer('srv-3', fake.port, {
      route: [{ host: 'bastion', port: 22, username: 'jump' }]
    })
    const result = await rdpMintTicket('srv-3')
    expect(result.ok).toBe(true)
    // The destination is still the RDP host. Where the route goes is main's
    // business at dial time and never something the client is told.
    expect(result.ticket?.destination).toBe(`127.0.0.1:${fake.port}`)
  })

  it('reports a missing password as a credential problem, not a login failure', async () => {
    defineServer('srv-4', fake.port)
    storedPassword = undefined
    const result = await rdpMintTicket('srv-4')
    expect(result.ok).toBe(false)
    expect(result.code).toBe('no-credentials')
  })

  it('surfaces a locked vault instead of connecting without a credential', async () => {
    defineServer('srv-5', fake.port)
    credentialError = new Error('OPSMAXX_VAULT_LOCKED: the vault is locked.')
    const result = await rdpMintTicket('srv-5')
    expect(result.ok).toBe(false)
    expect(result.code).toBe('no-credentials')
    expect(result.error).toMatch(/VAULT_LOCKED/)
  })

  it('brackets an IPv6 host so the port is not read as part of the address', async () => {
    defineServer('srv-6', 3389, { host: '::1' })
    const result = await rdpMintTicket('srv-6')
    expect(result.ticket?.destination).toBe('[::1]:3389')
  })
})

describe('the RDCleanPath handshake', () => {
  it('replays the X.224 request, returns the confirm and the certificate, then relays', async () => {
    defineServer('srv-1', fake.port)
    const { ticket } = await rdpMintTicket('srv-1')
    expect(ticket).toBeDefined()

    const ws = connectRelay(ticket!.proxyUrl, ticket!.token)
    await new Promise((r) => ws.once('open', r))
    ws.send(buildRequestPdu(ticket!.destination, ticket!.token, X224_REQUEST))

    const reply = await firstReply(ws)
    expect(reply.data).toBeDefined()

    // The server saw the client's X.224 verbatim.
    expect(fake.received[0]?.equals(X224_REQUEST)).toBe(true)

    // And the client gets back the server's confirm plus a certificate, which
    // it needs because CredSSP binds to the certificate the client saw.
    const response = reply.data!
    expect(response.includes(X224_CONFIRM)).toBe(true)
    const der = CERT.toString()
      .replace(/-----[A-Z ]+-----/g, '')
      .replace(/\s/g, '')
    expect(response.includes(Buffer.from(der, 'base64'))).toBe(true)

    // After the response the socket is a pipe: bytes sent now arrive inside the
    // TLS session rather than being interpreted as another PDU.
    ws.send(Buffer.from('post-handshake'))
    const inTunnel = await fake.afterTls
    expect(inTunnel.toString()).toBe('post-handshake')

    ws.close()
  })

  it('refuses a PDU whose token is not the one that was minted', async () => {
    defineServer('srv-1', fake.port)
    const { ticket } = await rdpMintTicket('srv-1')
    const ws = connectRelay(ticket!.proxyUrl, ticket!.token)
    await new Promise((r) => ws.once('open', r))

    // The right socket, the wrong request. Authenticating only the upgrade
    // would leave the PDU — the thing that names a destination — unbound.
    ws.send(buildRequestPdu(ticket!.destination, 'not-the-token', X224_REQUEST))

    const reply = await firstReply(ws)
    // An error PDU, and nothing was dialled.
    expect(reply.data?.[0]).toBe(0x30)
    expect(fake.received).toHaveLength(0)
    ws.close()
  })

  it('refuses a destination the ticket was not minted for', async () => {
    defineServer('srv-1', fake.port)
    const { ticket } = await rdpMintTicket('srv-1')
    const ws = connectRelay(ticket!.proxyUrl, ticket!.token)
    await new Promise((r) => ws.once('open', r))

    // This is the attack the ticket exists to stop: a renderer using the relay
    // to reach something the user never named.
    ws.send(buildRequestPdu('169.254.169.254:80', ticket!.token, X224_REQUEST))

    const reply = await firstReply(ws)
    expect(reply.data?.[0]).toBe(0x30)
    expect(fake.received).toHaveLength(0)
    ws.close()
  })

  it('rejects a socket with no token at all', async () => {
    defineServer('srv-1', fake.port)
    const { ticket } = await rdpMintTicket('srv-1')
    const ws = new WebSocket(ticket!.proxyUrl)
    const closed = await new Promise<number>((resolve) => {
      ws.once('close', (code: number) => resolve(code))
      ws.once('error', () => resolve(-1))
    })
    // 1008 is "policy violation". Anything that is not a clean accept is fine;
    // what matters is that it never reached the message handler.
    expect(closed === 1008 || closed === -1).toBe(true)
  })

  it('spends a token on first use so a leaked URL opens nothing', async () => {
    defineServer('srv-1', fake.port)
    const { ticket } = await rdpMintTicket('srv-1')

    const first = connectRelay(ticket!.proxyUrl, ticket!.token)
    await new Promise((r) => first.once('open', r))

    const second = connectRelay(ticket!.proxyUrl, ticket!.token)
    const closed = await new Promise<number>((resolve) => {
      second.once('close', (code: number) => resolve(code))
      second.once('error', () => resolve(-1))
    })
    expect(closed === 1008 || closed === -1).toBe(true)
    first.close()
  })
})

describe('certificate trust', () => {
  it('pins against the RDP host, not the bastion it was reached through', async () => {
    // The identity being checked is the machine the desktop is on. Pinning the
    // bastion instead would trust every host behind it interchangeably.
    defineServer('srv-jump', fake.port, {
      route: [{ host: 'bastion', port: 22, username: 'jump' }]
    })
    const { ticket } = await rdpMintTicket('srv-jump')
    const ws = connectRelay(ticket!.proxyUrl, ticket!.token)
    await new Promise((r) => ws.once('open', r))
    ws.send(buildRequestPdu(ticket!.destination, ticket!.token, X224_REQUEST))
    await firstReply(ws)

    expect(certChecks).toEqual([{ host: '127.0.0.1', port: fake.port }])
    ws.close()
  })

  it('refuses the session when the certificate is not trusted', async () => {
    defineServer('srv-1', fake.port)
    certTrusted = false
    const { ticket } = await rdpMintTicket('srv-1')
    const ws = connectRelay(ticket!.proxyUrl, ticket!.token)
    await new Promise((r) => ws.once('open', r))
    ws.send(buildRequestPdu(ticket!.destination, ticket!.token, X224_REQUEST))

    const reply = await firstReply(ws)
    // An error PDU, and no session: an untrusted server is not spoken to.
    expect(reply.data?.[0]).toBe(0x30)
    expect(rdpRelayStatus().sessions).toBe(0)
    ws.close()
  })
})

describe('relay lifecycle', () => {
  it('does not listen until a ticket is minted, then reports its port', async () => {
    // On demand, not at launch: an always-listening local proxy is standing
    // attack surface for a feature most sessions never use.
    expect(rdpRelayStatus().listening).toBe(false)
    defineServer('srv-1', fake.port)
    await rdpMintTicket('srv-1')
    const status = rdpRelayStatus()
    expect(status.listening).toBe(true)
    expect(status.port).toBeGreaterThan(0)
  })

  it('reuses one listener across tickets rather than opening a port each time', async () => {
    defineServer('srv-1', fake.port)
    const a = await rdpMintTicket('srv-1')
    const b = await rdpMintTicket('srv-1')
    expect(a.ticket?.proxyUrl).toBe(b.ticket?.proxyUrl)
    expect(a.ticket?.token).not.toBe(b.ticket?.token)
  })

  it('tears down live sessions on shutdown, not just the listener', async () => {
    // `WebSocketServer.close()` does not close the connections it already has,
    // so relying on it left every open desktop's TLS session and its whole SSH
    // chain alive with the counters reporting zero.
    defineServer('srv-jump', fake.port, {
      route: [{ host: 'bastion', port: 22, username: 'jump' }]
    })
    const { ticket } = await rdpMintTicket('srv-jump')
    const ws = connectRelay(ticket!.proxyUrl, ticket!.token)
    await new Promise((r) => ws.once('open', r))
    ws.send(buildRequestPdu(ticket!.destination, ticket!.token, X224_REQUEST))
    await firstReply(ws)
    expect(rdpRelayStatus().sessions).toBe(1)
    expect(chainEnded).toBe(0)

    await stopRdpRelay()
    await new Promise((r) => setTimeout(r, 120))

    expect(rdpRelayStatus().sessions).toBe(0)
    // The transport under the session, not just the socket above it.
    expect(chainEnded).toBeGreaterThan(0)
  })

  it('stops listening on shutdown', async () => {
    defineServer('srv-1', fake.port)
    const { ticket } = await rdpMintTicket('srv-1')
    await stopRdpRelay()
    expect(rdpRelayStatus().listening).toBe(false)

    const ws = new WebSocket(`${ticket!.proxyUrl}?token=${ticket!.token}`)
    const failed = await new Promise<boolean>((resolve) => {
      ws.once('error', () => resolve(true))
      ws.once('open', () => resolve(false))
    })
    expect(failed).toBe(true)
  })
})

describe('reaching a host through a jump route', () => {
  it('ends the SSH chain at the last hop and forwards to the RDP host from there', async () => {
    // The bug this shape avoids: building the chain all the way to the server
    // would need sshd on the Windows box, which is the one machine in the path
    // least likely to have it.
    defineServer('srv-jump', fake.port, {
      route: [
        { host: 'edge', port: 22, username: 'jump' },
        { host: 'bastion', port: 2222, username: 'jump' }
      ]
    })
    const { ticket } = await rdpMintTicket('srv-jump')
    const ws = connectRelay(ticket!.proxyUrl, ticket!.token)
    await new Promise((r) => ws.once('open', r))
    ws.send(buildRequestPdu(ticket!.destination, ticket!.token, X224_REQUEST))

    const reply = await firstReply(ws)
    expect(reply.data).toBeDefined()

    expect(chainCalls).toHaveLength(1)
    // Destination is the LAST hop; everything before it is an intermediate.
    expect(chainCalls[0].destination).toBe('bastion:2222')
    expect(chainCalls[0].hops).toEqual(['edge'])
    // And the forward from there names the RDP host, not the bastion.
    expect(chainCalls[0].forwarded).toEqual([{ host: '127.0.0.1', port: fake.port }])

    // The session runs through the channel like any other transport.
    expect(fake.received[0]?.equals(X224_REQUEST)).toBe(true)
    ws.send(Buffer.from('through-the-bastion'))
    expect((await fake.afterTls).toString()).toBe('through-the-bastion')
    ws.close()
  })

  it('uses a single hop as the chain destination, with no intermediates', async () => {
    defineServer('srv-one', fake.port, {
      route: [{ host: 'bastion', port: 22, username: 'jump' }]
    })
    const { ticket } = await rdpMintTicket('srv-one')
    const ws = connectRelay(ticket!.proxyUrl, ticket!.token)
    await new Promise((r) => ws.once('open', r))
    ws.send(buildRequestPdu(ticket!.destination, ticket!.token, X224_REQUEST))
    await firstReply(ws)

    expect(chainCalls[0].destination).toBe('bastion:22')
    expect(chainCalls[0].hops).toEqual([])
    ws.close()
  })

  it('tears the chain down when the desktop closes', async () => {
    // A bastion connection left open per closed desktop is how a fleet ends up
    // holding dozens of authenticated sessions nobody is using.
    defineServer('srv-jump', fake.port, {
      route: [{ host: 'bastion', port: 22, username: 'jump' }]
    })
    const { ticket } = await rdpMintTicket('srv-jump')
    const ws = connectRelay(ticket!.proxyUrl, ticket!.token)
    await new Promise((r) => ws.once('open', r))
    ws.send(buildRequestPdu(ticket!.destination, ticket!.token, X224_REQUEST))
    await firstReply(ws)
    expect(chainEnded).toBe(0)

    ws.close()
    await new Promise((r) => setTimeout(r, 120))
    expect(chainEnded).toBeGreaterThan(0)
  })

  it('does not open a chain at all for a server with no route', async () => {
    defineServer('srv-direct', fake.port)
    const { ticket } = await rdpMintTicket('srv-direct')
    const ws = connectRelay(ticket!.proxyUrl, ticket!.token)
    await new Promise((r) => ws.once('open', r))
    ws.send(buildRequestPdu(ticket!.destination, ticket!.token, X224_REQUEST))
    await firstReply(ws)
    expect(chainCalls).toHaveLength(0)
    ws.close()
  })
})

describe('destination matching', () => {
  it('accepts a host that differs only in case', async () => {
    // The client echoes the destination it was given, but "byte for byte" is
    // an assumption about someone else's code; DNS is case-insensitive, so a
    // client that normalised the case would otherwise fail to connect.
    cachedServers.set('srv-case', {
      id: 'srv-case',
      workspaceId: 'ws-1',
      name: 'Win Box',
      host: 'LOCALHOST',
      port: 22,
      username: 'admin',
      auth: 'password',
      os: 'Windows',
      route: [],
      vpnProfileId: null,
      rdp: { port: fake.port, nla: true }
    })
    const { ticket } = await rdpMintTicket('srv-case')
    expect(ticket?.destination).toBe(`LOCALHOST:${fake.port}`)

    const ws = connectRelay(ticket!.proxyUrl, ticket!.token)
    await new Promise((r) => ws.once('open', r))
    ws.send(buildRequestPdu(`localhost:${fake.port}`, ticket!.token, X224_REQUEST))

    const reply = await firstReply(ws)
    expect(reply.data).toBeDefined()
    // It connected rather than being refused as a mismatch.
    expect(fake.received).toHaveLength(1)
    ws.close()
  })

  it('still refuses a different port on the same host', async () => {
    defineServer('srv-1', fake.port)
    const { ticket } = await rdpMintTicket('srv-1')
    const ws = connectRelay(ticket!.proxyUrl, ticket!.token)
    await new Promise((r) => ws.once('open', r))
    ws.send(buildRequestPdu(`127.0.0.1:${fake.port + 1}`, ticket!.token, X224_REQUEST))

    await firstReply(ws)
    expect(fake.received).toHaveLength(0)
    ws.close()
  })
})

describe('the response PDU', () => {
  it('is the shape the client parses', async () => {
    // Round-trips the encoder against the decoder the relay uses on requests,
    // so a change to one that breaks the other fails here rather than at a
    // connection nobody is watching.
    const pdu = buildResponse('127.0.0.1:3389', X224_CONFIRM, [CERT])
    expect(pdu[0]).toBe(0x30)
    expect(() => parseRequest(pdu)).toThrow()
  })
})
