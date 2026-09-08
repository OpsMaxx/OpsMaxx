import { describe, it, expect } from 'vitest'

import {
  TUNNEL_DEFAULT_LISTEN,
  isDefaultListen,
  listenForKind
} from '../src/shared/tunnel'
import type { TunnelKind } from '../src/shared/tunnel'

// The type toggle changed the visible fields and not the values behind them.
// Switching local → socks swapped 8080 for 1080; switching back left 1080 in
// the box, and the saved record then read "Local forward · 127.0.0.1:1080" —
// a port the user never chose, colliding with any real SOCKS proxy on it.

describe('switching type moves an untouched default', () => {
  it('carries a fresh form from local to socks and back again', () => {
    const toSocks = listenForKind(TUNNEL_DEFAULT_LISTEN.local, 'socks')
    expect(toSocks).toBe(TUNNEL_DEFAULT_LISTEN.socks)
    // The direction that used to be missing. Without it the record saves as a
    // local forward carrying the SOCKS port.
    expect(listenForKind(toSocks, 'local')).toBe(TUNNEL_DEFAULT_LISTEN.local)
  })

  it.each([
    ['local', 'remote'],
    ['local', 'socks'],
    ['remote', 'local'],
    ['remote', 'socks'],
    ['socks', 'local'],
    ['socks', 'remote']
  ] as [TunnelKind, TunnelKind][])('moves %s → %s', (from, to) => {
    expect(listenForKind(TUNNEL_DEFAULT_LISTEN[from], to)).toBe(TUNNEL_DEFAULT_LISTEN[to])
  })

  // Every kind, in both directions, ends on its own default and never on
  // another's. Written as a sweep rather than as six assertions so a fourth
  // kind is covered the day it is added.
  it('never leaves one kind holding another kind default', () => {
    const kinds = Object.keys(TUNNEL_DEFAULT_LISTEN) as TunnelKind[]
    for (const from of kinds) {
      for (const to of kinds) {
        expect(listenForKind(TUNNEL_DEFAULT_LISTEN[from], to)).toBe(TUNNEL_DEFAULT_LISTEN[to])
      }
    }
  })
})

describe('a value the user typed outranks the default', () => {
  // Blanking on every switch would be the other bug: somebody who typed 15432
  // because 5432 is taken loses it by clicking a type button to re-read a label.
  it.each(['127.0.0.1:15432', '0.0.0.0:9000', '5432', '[::1]:8080', 'localhost:3000'])(
    'leaves %s alone',
    (typed) => {
      for (const k of ['local', 'remote', 'socks'] as TunnelKind[]) {
        expect(listenForKind(typed, k)).toBe(typed)
      }
    }
  )

  it('recognises a default whatever surrounding whitespace it arrives with', () => {
    expect(isDefaultListen('  127.0.0.1:8080  ')).toBe(true)
    expect(listenForKind('  127.0.0.1:8080  ', 'socks')).toBe(TUNNEL_DEFAULT_LISTEN.socks)
  })

  it('treats an emptied field as typed, not as a default to overwrite', () => {
    expect(isDefaultListen('')).toBe(false)
    expect(listenForKind('', 'socks')).toBe('')
  })
})

describe('the defaults themselves', () => {
  // A remote forward listens ON THE SERVER. 0.0.0.0 there publishes the port to
  // that server's whole network, and sshd refuses it without GatewayPorts, so
  // the honest default is loopback.
  it('binds every kind to loopback', () => {
    for (const v of Object.values(TUNNEL_DEFAULT_LISTEN)) expect(v.startsWith('127.0.0.1:')).toBe(true)
  })

  it('gives socks its own port, so the two are distinguishable at a glance', () => {
    expect(TUNNEL_DEFAULT_LISTEN.socks).not.toBe(TUNNEL_DEFAULT_LISTEN.local)
  })
})
