import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import https from 'node:https'
import net from 'node:net'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { TLSSocket } from 'node:tls'
import { WebSocketServer } from 'ws'
import { Client, Server, utils } from 'ssh2'

/**
 * wss:// over every route, against a real TLS server.
 *
 * The regression this guards: TLS had been left to an `https.Agent` whose
 * `createConnection` was overridden to return the raw transport — and that
 * method is exactly where Node calls `tls.connect`. So every wss:// handshake
 * went out as plaintext HTTP to a TLS port, while every ws:// test passed.
 *
 * `internal.test` resolves nowhere. The VPN forward and the SSH channel both
 * land on this machine's loopback, and the certificate is only valid for the
 * name, so a handshake that verifies proves SNI named the target host rather
 * than wherever the route happened to terminate.
 */
vi.mock('../src/main/services/ssh', () => ({ acquire: vi.fn(), release: vi.fn() }))
vi.mock('../src/main/services/vpn/manager', () => ({
  vpnStart: vi.fn(async () => ({ ok: true })),
  vpnOpenForward: vi.fn(async () => ({ port: tlsPort, close: () => {} }))
}))

const ssh = await import('../src/main/services/ssh')
const { wsOpen, wsCloseAll } = await import('../src/main/services/wsClient')

const NAME = 'internal.test'
let certDir: string
let caPem: string
let server: https.Server
let tlsPort: number
/** SNI each handshake arrived with, newest last. */
const sni: Array<string | false | null> = []

let sshd: Server
let sshClient: Client
const tcpipDestinations: string[] = []

const ctx = { prepare: <T>(t: T): T => t, emit: () => {} }

async function open(url: string, over: Record<string, unknown> = {}) {
  const result = await wsOpen({ url, via: { kind: 'direct' }, ...over } as never, 1, ctx)
  wsCloseAll()
  return result
}

beforeAll(async () => {
  certDir = mkdtempSync(join(tmpdir(), 'sp-wss-tls-'))
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', join(certDir, 'key.pem'),
    '-out', join(certDir, 'cert.pem'),
    '-days', '1', '-subj', `/CN=${NAME}`,
    '-addext', `subjectAltName=IP:127.0.0.1,DNS:${NAME}`
  ], { stdio: 'ignore' })
  caPem = readFileSync(join(certDir, 'cert.pem'), 'utf8')

  server = https.createServer({ key: readFileSync(join(certDir, 'key.pem')), cert: caPem })
  new WebSocketServer({ server }).on('connection', (_socket, req) => {
    sni.push((req.socket as TLSSocket).servername)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  tlsPort = (server.address() as AddressInfo).port

  // A real sshd answering direct-tcpip, so the wss handshake rides an actual
  // ssh2 channel — a Duplex, not a net.Socket — and every destination is sent
  // to this machine's TLS server whatever name it asked for.
  sshd = new Server({ hostKeys: [utils.generateKeyPairSync('ed25519').private] }, (conn) => {
    conn.on('error', () => undefined)
    conn.on('authentication', (auth) => auth.accept())
    conn.on('ready', () => {
      conn.on('tcpip', (accept, reject, info) => {
        tcpipDestinations.push(`${info.destIP}:${info.destPort}`)
        const socket = net.connect(tlsPort, '127.0.0.1', () => {
          const channel = accept()
          channel.pipe(socket).pipe(channel)
        })
        socket.on('error', () => reject())
      })
    })
  })
  await new Promise<void>((r) => sshd.listen(0, '127.0.0.1', r))
  sshClient = new Client()
  await new Promise<void>((resolve, reject) => {
    sshClient.once('ready', resolve).once('error', reject)
    sshClient.connect({
      host: '127.0.0.1',
      port: (sshd.address() as AddressInfo).port,
      username: 'test'
    })
  })
  vi.mocked(ssh.acquire).mockResolvedValue({ client: sshClient } as never)
})

afterAll(() => {
  wsCloseAll()
  sshClient?.end()
  sshd?.close()
  server?.close()
  if (certDir) rmSync(certDir, { recursive: true, force: true })
})

describe('wss', () => {
  // An IP literal gets no SNI, and must still be checked against the IP the
  // certificate names — not the `localhost` Node falls back to.
  it('handshakes over TLS directly when the private CA is supplied', async () => {
    const result = await open(`wss://127.0.0.1:${tlsPort}/`, { caPem })
    expect(result).toMatchObject({ ok: true })
  })

  it('refuses an untrusted certificate unless the check is skipped', async () => {
    const refused = await open(`wss://127.0.0.1:${tlsPort}/`)
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.error).toMatch(/self[- ]signed/i)

    expect(await open(`wss://127.0.0.1:${tlsPort}/`, { insecureTls: true })).toMatchObject({
      ok: true
    })
  })

  it('sends the target hostname as SNI through a VPN forward on loopback', async () => {
    const result = await open(`wss://${NAME}:${tlsPort}/`, {
      caPem,
      via: { kind: 'vpn', vpnProfileId: 'p1' }
    })
    expect(result).toMatchObject({ ok: true })
    expect(sni.at(-1)).toBe(NAME)
  })

  it('handshakes over TLS inside an SSH channel, with the target as SNI', async () => {
    const result = await open(`wss://${NAME}:4443/`, {
      caPem,
      via: { kind: 'server', server: { id: 's1' } }
    })
    expect(result).toMatchObject({ ok: true })
    expect(tcpipDestinations.at(-1)).toBe(`${NAME}:4443`)
    expect(sni.at(-1)).toBe(NAME)
  })
})
