import { describe, it, expect } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { hostnameOf, loopbackRefusal, refuseNonLoopback } from '../src/main/services/loopbackGuard'

/**
 * DNS rebinding against the three loopback servers.
 *
 * Binding to 127.0.0.1 keeps other machines out. It does not keep a web page
 * out: the attacker's domain is made to resolve to 127.0.0.1 with a short TTL,
 * script on their page fetches `http://their-domain:5178/...`, the browser
 * treats it as same-origin — same host, same port as the page — so no CORS
 * preflight is sent, and the request arrives from 127.0.0.1 because it really
 * did come from there.
 *
 * The headers are what give it away, and there are two independent tells.
 */

function request(headers: Record<string, string | undefined>): Parameters<typeof loopbackRefusal>[0] {
  return { headers } as Parameters<typeof loopbackRefusal>[0]
}

describe('what a loopback port accepts', () => {
  it('accepts a local client dialling a loopback name', () => {
    for (const host of ['127.0.0.1:5178', 'localhost:5178', '[::1]:5178', 'LOCALHOST:5178', '127.0.0.1']) {
      expect(loopbackRefusal(request({ host }))).toBeNull()
    }
  })

  it('refuses a request whose Host is the attacker’s domain', () => {
    // The rebound request. It arrived on 127.0.0.1 and the socket cannot tell;
    // the Host header carries the name the browser actually dialled.
    expect(loopbackRefusal(request({ host: 'rebind.attacker.example:5178' }))).toBe('host')
  })

  it('refuses any request carrying an Origin at all', () => {
    // The stronger half, and deliberately blunt. Browsers send Origin; the
    // editors, CLIs and scripts that legitimately talk to these ports do not.
    // An allowlist of permitted origins is the version of this that somebody
    // eventually widens.
    expect(loopbackRefusal(request({ host: '127.0.0.1:5178', origin: 'https://attacker.example' }))).toBe(
      'origin'
    )
    // Including "null", which is what a sandboxed iframe or a data: URL sends,
    // and which an allowlist written in a hurry would treat as absent.
    expect(loopbackRefusal(request({ host: '127.0.0.1:5178', origin: 'null' }))).toBe('origin')
    // And including the empty string, which is present and therefore refused:
    // `origin: ''` is a header that was sent.
    expect(loopbackRefusal(request({ host: '127.0.0.1:5178', origin: '' }))).toBe('origin')
  })

  it('refuses an Origin even when the Host is loopback', () => {
    // The case the Host check alone misses: the user's own dev server on
    // http://localhost:3000 is a real configuration, and a page served from it
    // dials a loopback Host legitimately. Origin is what separates that page
    // from a local process.
    expect(loopbackRefusal(request({ host: 'localhost:5177', origin: 'http://localhost:3000' }))).toBe(
      'origin'
    )
  })

  it('refuses a request with no Host at all', () => {
    // HTTP/1.1 requires one. A client that omits it is not one of the three
    // this serves, and guessing on its behalf is how the check gets bypassed.
    expect(loopbackRefusal(request({}))).toBe('host')
  })

  it('is not fooled by a hostname that merely starts with a loopback name', () => {
    // `127.0.0.1.attacker.example` resolves to whatever the attacker likes and
    // is not a loopback name. A `startsWith` check would pass it.
    for (const host of [
      '127.0.0.1.attacker.example',
      'localhost.attacker.example:5178',
      'notlocalhost:5178',
      'localhost.',
      '0.0.0.0:5178',
      '127.0.0.2:5178'
    ]) {
      expect(loopbackRefusal(request({ host }))).toBe('host')
    }
  })
})

describe('splitting a Host header', () => {
  it('keeps an IPv6 literal’s brackets', () => {
    expect(hostnameOf('[::1]:5178')).toBe('[::1]')
    expect(hostnameOf('[fe80::1]:80')).toBe('[fe80::1]')
  })

  it('leaves something it cannot parse alone, so it fails the membership test', () => {
    // Host is attacker-controlled. Anything clever here is somewhere for a
    // bypass to live; failing closed is the whole requirement.
    expect(hostnameOf('[unterminated')).toBe('[unterminated')
    expect(loopbackRefusal(request({ host: '[unterminated' }))).toBe('host')
  })
})

describe('the refusal a person actually sees', () => {
  it('names the header, over a real socket', async () => {
    const server = createServer((req, res) => {
      if (refuseNonLoopback(req, res)) return
      res.writeHead(200).end('served')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port

    try {
      const rebound = await fetch(`http://127.0.0.1:${port}/`, {
        headers: { host: 'rebind.attacker.example' }
      })
      // fetch will not let us override Host, so this proves the happy path
      // rather than the refusal; the Origin case below is the one a browser
      // can actually produce.
      expect(rebound.status).toBe(200)

      const withOrigin = await fetch(`http://127.0.0.1:${port}/`, {
        headers: { origin: 'https://attacker.example' }
      })
      expect(withOrigin.status).toBe(403)
      const body = await withOrigin.text()
      // The person who hits this in practice is not an attacker: it is
      // somebody whose editor sends an Origin for reasons of its own, and a
      // bare 403 sends them to the issue tracker.
      expect(body).toContain('Origin')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})

describe('every loopback server runs the check', () => {
  it('and none of them forgot', async () => {
    // A guard applied to two of three servers is a guard with a hole, and the
    // hole is invisible: each server's own tests still pass.
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    for (const [file, needle] of [
      ['src/main/services/credProxy.ts', 'refuseNonLoopback(req, res)'],
      ['src/main/services/mcpServer.ts', 'refuseNonLoopback(req, res)'],
      ['src/main/services/rdpRelay.ts', 'loopbackUpgradeAllowed(req)']
    ] as const) {
      const src = readFileSync(resolve(__dirname, '..', file), 'utf8')
      expect(src, `${file} does not run the loopback check`).toContain(needle)
    }
  })
})
